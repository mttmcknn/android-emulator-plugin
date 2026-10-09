import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DevicePins } from '../runtime/core/lib/device-pins.mjs';

function fixture(t, { existing = {}, createdAvds = {}, owners } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-pins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (owners !== undefined) fs.writeFileSync(path.join(dir, 'pins.json'), JSON.stringify({ owners }));
  let nextPort = 5600;
  const leases = {
    leases: { ...existing }, createdAvds,
    started: [], attached: [], removed: [], updates: [],
    get(id) { return this.leases[id] ?? null; },
    async start(id, options) {
      this.started.push({ id, options });
      const existing = this.get(id);
      if (existing) {
        if (options.avd && options.avd !== existing.avd) throw new Error('Already running another AVD');
        return existing;
      }
      await this.beforeStart?.(id, options);
      return this.leases[id] = { threadId: id, kind: 'emulator', avd: options.avd ?? 'Default_Phone', serial: `emulator-${nextPort += 2}`, state: 'ready' };
    },
    attach(id, device) {
      this.attached.push({ id, device });
      assert.equal(Object.values(this.leases).some(lease => lease.serial === device.serial || (device.hardwareId && lease.hardwareId === device.hardwareId)), false, 'attaching must not create a duplicate live device');
      return this.leases[id] = { threadId: id, kind: 'physical', serial: device.serial, hardwareId: device.hardwareId, avd: device.label, label: device.label, state: 'ready' };
    },
    remove(id) { this.removed.push(id); delete this.leases[id]; },
    update(id, patch) { this.updates.push({ id, patch }); Object.assign(this.leases[id], patch); },
  };
  const pins = new DevicePins({ dir, leases });
  return { dir, leases, pins, persisted: () => JSON.parse(fs.readFileSync(path.join(dir, 'pins.json'), 'utf8')).owners };
}

const phone = (serial = 'USB_TEST', hardwareId = 'HARDWARE_TEST') => ({ serial, hardwareId, state: 'device', label: 'Example Phone' });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function moveRequest(pins, device = phone(), from = 'chat-a', to = 'chat-b') {
  const original = await pins.pin(from, device);
  const pending = await pins.pin(to, device);
  assert.ok(pending.confirmationRequired);
  return { original, requestId: pending.confirmationRequired.requestId, pending };
}

test('legacy leases and created AVD ownership migrate without requiring a running device', t => {
  const { pins, persisted } = fixture(t, {
    existing: { 'legacy-chat': { serial: 'emulator-5602', avd: 'Saved_Phone', state: 'ready' } },
    createdAvds: { Kept_Phone: { threadId: 'creator-chat', keep: true } },
  });
  assert.deepEqual(pins.ids('legacy-chat'), ['legacy-chat']);
  assert.deepEqual(pins.ids('creator-chat'), []);
  assert.deepEqual(pins.allIds('creator-chat'), ['creator-chat']);
  assert.equal(pins.resolve('legacy-chat'), 'legacy-chat');
  assert.deepEqual(persisted(), { 'legacy-chat': 'legacy-chat', 'creator-chat': 'creator-chat' });
});

test('persisted owners remain authoritative across reload and legacy migration', t => {
  const { dir, leases, pins, persisted } = fixture(t, {
    existing: { 'root-chat': { kind: 'physical', serial: 'USB_TEST', state: 'ready' } },
    owners: { 'root-chat': 'recipient-chat' },
  });
  const extra = pins.allocate('recipient-chat');
  assert.notEqual(extra, 'root-chat');
  const restored = new DevicePins({ dir, leases });
  assert.equal(restored.owner('root-chat'), 'recipient-chat');
  assert.deepEqual(restored.ids('root-chat'), []);
  assert.equal(restored.resolve('recipient-chat'), 'root-chat');
  assert.throws(() => restored.resolve('root-chat', undefined, { allowEmpty: true }), /Choose a device pinned to this chat/);
  assert.deepEqual(persisted(), { 'root-chat': 'recipient-chat', [extra]: 'recipient-chat' });
});

test('multiple pins require an explicit owned target and refuse cross-chat or stale IDs', async t => {
  const { pins, leases } = fixture(t);
  const first = await pins.start('chat-a', { avd: 'Phone' });
  const second = await pins.start('chat-a', { avd: 'Tablet' });
  assert.notEqual(first.id, second.id);
  assert.throws(() => pins.resolve('chat-a'), /multiple pinned devices/);
  assert.equal(pins.resolve('chat-a', first.id), first.id);
  assert.equal(pins.resolve('chat-a', second.id), second.id);
  assert.throws(() => pins.resolve('chat-b', first.id), /not pinned to this chat/);
  assert.throws(() => pins.resolve('chat-a', ''), /not pinned to this chat/);
  leases.remove(second.id);
  assert.throws(() => pins.resolve('chat-a', second.id), /not pinned to this chat/);
  assert.equal(pins.resolve('chat-a'), first.id);
  assert.throws(() => pins.resolve('empty-chat'), /No device is pinned/);
  assert.equal(pins.resolve('empty-chat', undefined, { allowEmpty: true }), 'empty-chat');
});

test('same AVD starts reuse one pin unless a new instance is explicitly requested', async t => {
  const { pins } = fixture(t);
  const first = await pins.start('chat-a', { avd: 'Phone' });
  const reused = await pins.start('chat-a', { avd: 'Phone' });
  assert.equal(first.id, reused.id);
  assert.equal(first.lease, reused.lease);
  const additional = await pins.start('chat-a', { avd: 'Phone', newInstance: true });
  assert.notEqual(additional.id, first.id);
  await assert.rejects(pins.start('chat-a', { avd: 'Phone' }), /Several emulators match/);
  assert.equal((await pins.start('chat-a', { avd: 'Phone', deviceId: first.id })).id, first.id);
  await assert.rejects(pins.start('chat-b', { deviceId: first.id }), /not pinned to this chat/);
});

test('an explicitly invalid start target cannot fall back to starting or choosing another device', async t => {
  const { pins, leases } = fixture(t);
  for (const deviceId of ['', null, 0, false]) {
    await assert.rejects(pins.start('chat-a', { deviceId }), /not pinned to this chat/);
  }
  assert.deepEqual(leases.started, []);
  assert.deepEqual(pins.allIds('chat-a'), []);
});

test('concurrent ordinary starts serialize and reuse the first completed launch', async t => {
  const { pins, leases } = fixture(t);
  const entered = deferred();
  const boot = deferred();
  leases.beforeStart = async () => { entered.resolve(); await boot.promise; };
  const first = pins.start('chat-a', { avd: 'Phone' });
  await entered.promise;
  const second = pins.start('chat-a', { avd: 'Phone' });
  assert.equal(leases.started.length, 1);
  boot.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  assert.deepEqual(pins.ids('chat-a'), [a.id]);
  assert.equal(pins.starts.size, 0);
});

test('concurrent new-instance starts remain distinct and another chat is not blocked by a boot', async t => {
  const { pins, leases } = fixture(t);
  const entered = deferred();
  const boot = deferred();
  leases.beforeStart = async id => { if (id === 'chat-a') { entered.resolve(); await boot.promise; } };
  const first = pins.start('chat-a', { avd: 'Phone', newInstance: true });
  await entered.promise;
  const second = pins.start('chat-a', { avd: 'Phone', newInstance: true });
  const other = await pins.start('chat-b', { avd: 'Phone' });
  assert.equal(other.id, 'chat-b');
  boot.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(pins.ids('chat-a'), [a.id, b.id]);
});

test('a failed launch does not poison the next queued start', async t => {
  const { pins, leases } = fixture(t);
  let launches = 0;
  leases.beforeStart = async () => { if (++launches === 1) throw new Error('Launch failed'); };
  const first = pins.start('chat-a', { avd: 'Phone' });
  const retry = pins.start('chat-a', { avd: 'Phone' });
  await assert.rejects(first, /Launch failed/);
  const running = await retry;
  assert.deepEqual(pins.ids('chat-a'), [running.id]);
  assert.equal(pins.starts.size, 0);
});

test('pinning one transport is idempotent and rejects USB/wireless duplicates for the same owner', async t => {
  const { pins, leases } = fixture(t);
  const original = await pins.pin('chat-a', phone());
  assert.equal((await pins.pin('chat-a', phone())).id, original.id);
  await assert.rejects(pins.pin('chat-a', phone('192.0.2.1:5555')), /already pinned through another connection/);
  assert.equal(leases.attached.length, 1);
  const pending = await pins.pin('chat-b', phone('192.0.2.1:5555'));
  assert.equal(pending.confirmationRequired.id, original.id);
  assert.equal(pending.confirmationRequired.ownerThreadId, 'chat-a');
  assert.equal(leases.attached.length, 1);
  assert.equal(pins.owner(original.id), 'chat-a');
});

test('unknown hardware identity does not merge separate devices and unavailable transports cannot pin', async t => {
  const { pins, leases } = fixture(t);
  const a = await pins.pin('chat-a', phone('FIRST_DEVICE', null));
  const b = await pins.pin('chat-a', phone('SECOND_DEVICE', null));
  assert.notEqual(a.id, b.id);
  await assert.rejects(pins.pin('chat-b', { ...phone(), state: 'unauthorized' }), /allow USB debugging/);
  await assert.rejects(pins.pin('chat-b', { ...phone(), state: 'offline' }), /unavailable/);
  assert.equal(leases.attached.length, 2);
});

test('emulator start never reuses a connected-phone pin', async t => {
  const { pins, leases } = fixture(t);
  const connected = await pins.pin('chat-a', phone());
  await assert.rejects(pins.start('chat-a', { deviceId: connected.id }), /connected phone/);
  assert.deepEqual(leases.started, []);
  const emulator = await pins.start('chat-a', { avd: 'Phone' });
  assert.notEqual(emulator.id, connected.id);
  assert.equal(leases.get(connected.id), connected.lease);
  assert.equal(emulator.lease.kind, 'emulator');
});

test('confirmed transfer creates a fresh recipient scope and preserves the previous scope ownership', async t => {
  const { dir, pins, leases, persisted } = fixture(t);
  const { original, requestId } = await moveRequest(pins);
  assert.deepEqual(pins.ids('chat-b'), []);
  const moved = pins.transfer('chat-b', requestId, phone());
  assert.notEqual(moved.id, original.id, 'a move must not expose old captures/navigation through the previous pin ID');
  assert.equal(moved.from, 'chat-a');
  assert.equal(leases.get(original.id), null);
  assert.equal(pins.owner(original.id), 'chat-a');
  assert.equal(pins.owner(moved.id), 'chat-b');
  assert.equal(moved.lease.serial, original.lease.serial);
  assert.deepEqual(pins.ids('chat-a'), []);
  assert.deepEqual(pins.ids('chat-b'), [moved.id]);
  assert.throws(() => pins.resolve('chat-b', original.id), /not pinned to this chat/);
  assert.throws(() => pins.transfer('chat-b', requestId, phone()), /expired|owner changed/);
  const restored = new DevicePins({ dir, leases });
  assert.equal(restored.owner(original.id), 'chat-a');
  assert.equal(restored.owner(moved.id), 'chat-b');
  assert.deepEqual(persisted(), { [original.id]: 'chat-a', [moved.id]: 'chat-b' });
});

test('transfer can change a handset transport only after confirming its matching identity', async t => {
  const { pins, leases } = fixture(t);
  const original = await pins.pin('chat-a', phone());
  const wireless = phone('192.0.2.1:5555');
  const { confirmationRequired } = await pins.pin('chat-b', wireless);
  const moved = pins.transfer('chat-b', confirmationRequired.requestId, wireless);
  assert.notEqual(moved.id, original.id);
  assert.equal(moved.lease.serial, wireless.serial);
  assert.equal(moved.lease.hardwareId, wireless.hardwareId);
  assert.equal(leases.get(original.id), null);
  assert.equal(Object.keys(leases.leases).length, 1);
});

test('moving a device into a chat with an existing pin preserves that pin and requires subsequent targeting', async t => {
  const { pins, leases } = fixture(t);
  const existing = await pins.start('chat-b', { avd: 'Phone' });
  const { original, requestId } = await moveRequest(pins);
  const moved = pins.transfer('chat-b', requestId, phone());
  assert.notEqual(moved.id, existing.id);
  assert.notEqual(moved.id, original.id);
  assert.equal(leases.get(existing.id), existing.lease);
  assert.deepEqual(pins.ids('chat-b'), [existing.id, moved.id]);
  assert.throws(() => pins.resolve('chat-b'), /multiple pinned devices/);
  assert.equal(pins.resolve('chat-b', moved.id), moved.id);
});

test('expired transfer requests cannot move a device and are single use', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const { pins } = fixture(t);
  const { original, requestId } = await moveRequest(pins);
  t.mock.timers.tick(120_001);
  assert.throws(() => pins.transfer('chat-b', requestId, phone()), /expired|owner changed/);
  assert.equal(pins.owner(original.id), 'chat-a');
  assert.equal(pins.requests.has(requestId), false);
  assert.deepEqual(pins.ids('chat-a'), [original.id]);
});

test('transfer requests reject the wrong destination, ownership changes, and missing leases', async t => {
  for (const scenario of ['wrong destination', 'owner changed', 'lease gone']) {
    await t.test(scenario, async t => {
      const { pins, leases } = fixture(t);
      const { original, requestId } = await moveRequest(pins);
      if (scenario === 'owner changed') pins.owners[original.id] = 'chat-c';
      if (scenario === 'lease gone') leases.remove(original.id);
      assert.throws(() => pins.transfer(scenario === 'wrong destination' ? 'chat-c' : 'chat-b', requestId, phone()), /expired|owner changed/);
      assert.equal(pins.requests.has(requestId), false);
      assert.equal(leases.attached.length, 1);
      assert.deepEqual(pins.ids('chat-b'), []);
    });
  }
});

test('transfer revalidates connection state, serial, and hardware identity before changing ownership', async t => {
  for (const [name, device] of Object.entries({
    missing: null,
    offline: { ...phone(), state: 'offline' },
    unauthorized: { ...phone(), state: 'unauthorized' },
    changedSerial: phone('OTHER_SERIAL'),
    changedHardware: phone('USB_TEST', 'OTHER_HARDWARE'),
    missingHardware: phone('USB_TEST', null),
  })) {
    await t.test(name, async t => {
      const { pins, leases, persisted } = fixture(t);
      const { original, requestId } = await moveRequest(pins);
      const before = persisted();
      assert.throws(() => pins.transfer('chat-b', requestId, device), /connection changed/);
      assert.equal(pins.owner(original.id), 'chat-a');
      assert.equal(leases.get(original.id), original.lease);
      assert.deepEqual(persisted(), before);
      assert.equal(leases.attached.length, 1);
      assert.throws(() => pins.transfer('chat-b', requestId, phone()), /expired|owner changed/);
    });
  }
});

test('a completed move invalidates competing confirmation requests for the original scope', async t => {
  const { pins } = fixture(t);
  const { requestId } = await moveRequest(pins);
  const competing = await pins.pin('chat-c', phone());
  const moved = pins.transfer('chat-b', requestId, phone());
  assert.throws(() => pins.transfer('chat-c', competing.confirmationRequired.requestId, phone()), /expired|owner changed/);
  assert.equal(pins.owner(moved.id), 'chat-b');
  assert.deepEqual(pins.ids('chat-c'), []);
});

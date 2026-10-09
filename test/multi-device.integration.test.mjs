import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startDaemon } from '../runtime/core/daemon.mjs';
import { panelMetadata } from '../runtime/hosts/codex/tools.mjs';
import { Captures } from '../runtime/core/lib/captures.mjs';

class Leases extends EventEmitter {
  leases = {}; createdAvds = {}; serial = 5600;
  get(id) { return this.leases[id]; }
  touch() {} ownedAvds() { return []; } async avds() { return ['Phone', 'Tablet']; } async sweep() {}
  update(id, patch) { Object.assign(this.leases[id], patch); this.emit('change', id); }
  remove(id) { delete this.leases[id]; this.emit('change', id); }
  async stop(id) { this.remove(id); return true; }
  async start(id, { avd = 'Phone' }) {
    if (!this.leases[id]) this.leases[id] = { threadId: id, kind: 'emulator', avd, serial: `emulator-${this.serial += 2}`, state: 'ready' };
    this.emit('change', id); return this.leases[id];
  }
  attach(id, device) {
    this.leases[id] = { threadId: id, kind: 'physical', serial: device.serial, hardwareId: device.hardwareId, label: device.label, avd: device.label, state: 'ready' };
    this.emit('change', id); return this.leases[id];
  }
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-device-'));
  const leases = new Leases(); const inputs = []; const mirrors = [];
  const state = { devices: [{ serial: 'usb-phone', label: 'Connected Pixel', hardwareId: 'hardware-one', state: 'device' }], key: null };
  const service = await startDaemon({ dir, panelMetadata, createLeases: () => leases,
    createConnectedDevices: () => ({ list: async () => state.devices }),
    readSessions: async ids => new Map(ids.map(id => [id, { title: `Chat ${id}`, state: 'active', cwd: '/project' }])),
    providers: {
      device: [{ id: 'fixture', create: (serial, options) => ({ screenSize: async () => ({ width: 100, height: 200 }), key: async key => { inputs.push({ serial, kind: options.kind, key }); await state.key?.(); return key; } }) }],
      connection: [{ id: 'fixture', create: ({ serial }) => {
        const mirror = new EventEmitter(); mirror.serial = serial; mirror.session = { width: 100, height: 200 };
        mirror.start = async () => {}; mirror.stop = () => { mirror.stopped = true; }; mirror.requestKeyFrame = () => {};
        mirrors.push(mirror); return mirror;
      } }],
    }, log() {},
  });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8');
  const call = async (threadId, tool, args = {}) => (await fetch(`http://127.0.0.1:${service.port}/api/call`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ threadId, tool, args }) })).json();
  const select = async (threadId, deviceId) => call(threadId, 'emulator_backends', { deviceId, action: 'select', set: { device: 'fixture', connection: 'fixture' } });
  const pane = async (threadId, channel, tool, args) => {
    const id = `${tool}-${Math.random()}`; const session = `workspace-${threadId}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await call(threadId, 'emulator_stream', { ...channel, session, wait: true, ...(attempt ? {} : { send: [{ t: 'call', id, tool, args }] }) });
      assert.equal(r.ok, true, r.error);
      const result = r.result.structuredContent.messages.find(item => item.j?.id === id)?.j;
      if (result) return result;
    }
    throw new Error('Missing panel reply');
  };
  return { call, select, pane, state, inputs, mirrors, leases, dir };
}

test('multiple devices stream independently and ambiguous or foreign agent targets are refused', { timeout: 10_000 }, async t => {
  const { call, select, inputs, mirrors } = await fixture(t);
  const first = (await call('A', 'emulator_start', { avd: 'Phone' })).result.structuredContent.emulator;
  const second = (await call('A', 'emulator_start', { avd: 'Tablet' })).result.structuredContent.emulator;
  assert.notEqual(first.id, second.id);
  assert.equal(JSON.parse((await call('A', 'emulator_status', { deviceId: first.id })).result.text).emulator.id, first.id);
  assert.equal((await call('A', 'emulator_status', { deviceId: '' })).ok, false);
  assert.equal((await call('A', 'emulator_key', { key: 'HOME' })).ok, false);
  assert.equal((await call('B', 'emulator_key', { deviceId: first.id, key: 'HOME' })).ok, false);
  assert.equal(inputs.length, 0);
  await select('A', first.id); await select('A', second.id);
  assert.equal((await call('A', 'emulator_key', { deviceId: second.id, key: 'HOME' })).ok, true);
  assert.equal(inputs[0].serial, second.serial);
  const inventory = (await call('A', 'emulator_devices')).result;
  for (const device of [first, second]) {
    const channel = inventory.meta.panels[device.id].channel;
    assert.equal((await call('B', 'emulator_stream', { ...channel, session: 'foreign' })).ok, false);
    assert.equal((await call('A', 'emulator_stream', { ...channel, session: device.id, wait: true })).ok, true);
  }
  assert.deepEqual(mirrors.map(m => m.serial).sort(), [first.serial, second.serial].sort());
  const diagnostics = (await call('A', 'emulator_diagnostics')).result.structuredContent;
  assert.equal(diagnostics.display.viewers, 2);
  assert.equal(diagnostics.display.encoderActive, true);
  assert.equal(diagnostics.display.videoSessionReady, true);
  await call('A', 'emulator_stop', { deviceId: first.id });
  assert.equal(mirrors.find(m => m.serial === first.serial).stopped, true);
  assert.equal(mirrors.find(m => m.serial === second.serial).stopped, undefined);
  assert.equal((await call('A', 'emulator_key', { deviceId: second.id, key: 'HOME' })).ok, true);
});

test('physical transfer requires pane confirmation and cannot reuse old keys, captures, or input', { timeout: 10_000 }, async t => {
  const { call, pane, select, inputs, dir, leases, mirrors } = await fixture(t);
  const phone = (await call('A', 'emulator_pin', { serial: 'usb-phone' })).result.structuredContent.emulator;
  await select('A', phone.id);
  const oldChannel = (await call('A', 'emulator_devices')).result.meta.panels[phone.id].channel;
  await call('A', 'emulator_stream', { ...oldChannel, session: 'old', wait: true });
  const capture = new Captures(dir).create(phone.id, { png: Buffer.from('old private image'), serial: phone.serial });
  const conflict = (await call('B', 'emulator_pin', { serial: phone.serial })).result.structuredContent.confirmationRequired;
  assert.equal(conflict.ownerTitle, 'Chat A');
  assert.equal((await call('B', 'emulator_transfer', { requestId: conflict.requestId, confirmed: true })).ok, false);
  const channelB = (await call('B', 'emulator_panel')).result.meta.panel.channel;
  assert.equal((await pane('B', channelB, 'emulator_transfer', { requestId: conflict.requestId })).ok, false);
  const moved = await pane('B', channelB, 'emulator_transfer', { requestId: conflict.requestId, confirmed: true });
  assert.equal(moved.ok, true, moved.error);
  const next = moved.result.structuredContent.devices[0];
  assert.notEqual(next.id, phone.id);
  assert.equal(leases.get(phone.id), undefined);
  assert.equal(mirrors[0].stopped, true);
  assert.equal((await call('A', 'emulator_stream', { ...oldChannel, session: 'late' })).ok, false);
  assert.equal((await call('A', 'emulator_key', { deviceId: phone.id, key: 'HOME' })).ok, false);
  assert.equal((await call('B', 'emulator_capture', { deviceId: next.id, action: 'context', captureId: capture.id })).ok, false);
  assert.equal(inputs.length, 0);
  assert.equal((await pane('B', channelB, 'emulator_transfer', { requestId: conflict.requestId, confirmed: true })).ok, false);
  const diagnostics = (await call('A', 'emulator_diagnostics')).result.structuredContent;
  assert.equal(diagnostics.device.state, 'unassigned');
});

test('busy devices cannot move; disconnect keeps ownership and does not select a different device', { timeout: 10_000 }, async t => {
  const { call, pane, select, state, inputs } = await fixture(t);
  const phone = (await call('A', 'emulator_pin', { serial: 'usb-phone' })).result.structuredContent.emulator;
  await select('A', phone.id);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  state.key = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const action = call('A', 'emulator_key', { deviceId: phone.id, key: 'HOME' }); await started;
  const request = (await call('B', 'emulator_pin', { serial: phone.serial })).result.structuredContent.confirmationRequired;
  const channelB = (await call('B', 'emulator_panel')).result.meta.panel.channel;
  const busy = await pane('B', channelB, 'emulator_transfer', { requestId: request.requestId, confirmed: true });
  assert.equal(busy.ok, false); assert.match(busy.error, /busy/);
  const stop = await call('A', 'emulator_stop', { deviceId: phone.id });
  assert.equal(stop.ok, false); assert.match(stop.error, /active operation/);
  release(); assert.equal((await action).ok, true); state.key = null;
  state.devices = [];
  const inventory = (await call('A', 'emulator_devices')).result.structuredContent;
  assert.equal(inventory.devices[0].state, 'disconnected');
  assert.equal(inventory.devices[0].id, phone.id);
  assert.equal((await call('A', 'emulator_key', { deviceId: phone.id, key: 'HOME' })).ok, false);
  assert.equal(inputs.length, 1);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Backends } from '../runtime/core/backends.mjs';
import { startDaemon } from '../runtime/core/daemon.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWVQAAAAASUVORK5CYII=', 'base64');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-backends-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const capture = (id, work = async () => png) => ({ id, label: id, version: 'test', capture: work });

test('backend selections persist per opaque session; unavailable or unknown implementations never replace a selection', async t => {
  const dir = temporary(t);
  const providers = { capture: [capture('candidate'), { ...capture('missing'), probe: async () => ({ available: false, reason: 'Dependency missing.' }) }] };
  const backends = new Backends({ dir, providers });
  await backends.check({ capture: 'candidate' });
  backends.select('__proto__', { capture: 'candidate' });
  assert.equal(new Backends({ dir, providers }).selection('__proto__').capture, 'candidate');
  assert.equal(backends.selection('other').capture, 'adb');
  await assert.rejects(backends.check({ capture: 'missing' }), /Dependency missing/);
  await assert.rejects(backends.check({ capture: 'unknown' }), /Unknown capture/);
  await assert.rejects(backends.check({ unknown: 'candidate' }), /Unknown unknown/);
  assert.equal(backends.selection('__proto__').capture, 'candidate');
  assert.throws(() => new Backends({ dir, providers: { capture: [capture('adb')] } }), /Duplicate/);
});

test('backend metrics keep bounded numeric durations and propagate failures without replay', async t => {
  const b = new Backends({ dir: temporary(t) });
  const backend = b.get('A', 'capture');
  for (let i = 0; i < 140; i++) await b.measure('A', 'capture', backend, async () => png);
  let calls = 0;
  await assert.rejects(b.measure('A', 'capture', backend, async () => { calls++; throw new Error('private screen text'); }), /private screen text/);
  const report = b.snapshot('A');
  assert.equal(calls, 1);
  assert.equal(report[0].count, 141);
  assert.equal(report[0].errors, 1);
  assert.equal(report[0].windowSamples, 128);
  const failed = capture('failed');
  await assert.rejects(b.measure('A', 'capture', failed, async () => { throw new Error('failed'); }));
  assert.equal(b.snapshot('A').find(row => row.backend === 'failed').p50Ms, undefined);
  assert.ok(!JSON.stringify(report).includes('private screen text'));
  assert.ok(!JSON.stringify(report).includes(png.toString('base64')));
  assert.deepEqual(b.snapshot('B'), []);
});

class Leases extends EventEmitter {
  constructor() {
    super(); this.createdAvds = {};
    this.leases = Object.fromEntries(['A', 'B'].map(threadId => [threadId, { threadId, serial: `device-${threadId}`, avd: 'Nonexistent_Test_AVD', state: 'ready' }]));
  }
  get(id) { return this.leases[id]; }
  touch() {} async avds() { return []; } ownedAvds() { return []; } async sweep() {}
}

async function service(t, providers, selections) {
  const dir = temporary(t);
  if (selections) fs.writeFileSync(path.join(dir, 'backends.json'), JSON.stringify(selections));
  const service = await startDaemon({ dir, providers, createLeases: () => new Leases(), log() {} });
  t.after(() => service.close());
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
  const call = async (threadId, tool, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${service.port}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ threadId, tool, args }) });
    const body = await response.json();
    if (!body.ok) throw new Error(body.error);
    return body.result;
  };
  return { call, service };
}

function connections(id, instances) {
  return { id, label: id, version: 'test', create: options => {
    const instance = new class extends EventEmitter {
      constructor() { super(); this.options = options; this.keys = []; }
      async start() { this.session = { width: 10, height: 20 }; this.emit('session', this.session); this.frame(); }
      frame() { this.emit('packet', { config: false, key: true, pts: 0n, data: Buffer.from('frame') }); }
      requestKeyFrame() {} pressKey(key) { this.keys.push(key); }
      stop() { this.stopped = true; }
    }(); instances.push(instance); return instance;
  } };
}

test('live backend switching routes only the owning chat, rejects active work, and excludes late frames from a replaced connection', async t => {
  const instances = [], captures = [];
  let release, entered;
  const begun = new Promise(resolve => { entered = resolve; });
  const providers = { connection: [connections('first', instances), connections('second', instances)], capture: [
    capture('candidate', async serial => { captures.push(serial); return png; }),
    capture('held', serial => { captures.push(serial); entered(); return new Promise(resolve => { release = () => resolve(png); }); }),
  ] };
  const { call, service: daemon } = await service(t, providers);
  const channels = {};
  for (const thread of ['A', 'B']) {
    await call(thread, 'emulator_backends', { action: 'select', set: { connection: 'first', capture: 'candidate' } });
    const inventory = await call(thread, 'emulator_devices');
    channels[thread] = { ...inventory.meta.panels[thread].channel, session: thread };
    await call(thread, 'emulator_stream', channels[thread]);
    await call(thread, 'emulator_screenshot');
  }
  assert.deepEqual(captures, ['device-A', 'device-B']);
  assert.equal(instances.length, 2);
  await call('A', 'emulator_backends', { action: 'select', set: { connection: 'second' } });
  assert.equal(instances[0].stopped, true);
  assert.equal(instances[1].stopped, undefined);
  assert.equal(instances[2].options.serial, 'device-A');
  const before = (await call('A', 'emulator_backends', { action: 'metrics' })).text;
  instances[0].frame();
  assert.equal((await call('A', 'emulator_backends', { action: 'metrics' })).text, before);
  await call('A', 'emulator_stream', { ...channels.A, send: [{ t: 'key', key: 'HOME' }] });
  assert.deepEqual(instances[2].keys, [3]);
  assert.deepEqual(instances[1].keys, []);
  await call('A', 'emulator_backends', { action: 'select', set: { capture: 'held' } });
  const inFlight = call('A', 'emulator_screenshot');
  await begun;
  await assert.rejects(call('A', 'emulator_backends', { action: 'select', set: { capture: 'candidate' } }), /active operation/);
  release(); await inFlight;
  await call('A', 'emulator_backends', { action: 'select', set: { capture: 'candidate' } });
  assert.equal(JSON.parse((await call('B', 'emulator_status')).text).backends.connection, 'first');
  await daemon.close();
  assert.ok(instances.every(instance => instance.stopped));
});

test('device and recording implementations are selected independently, and active recordings prevent replacement', async t => {
  const deviceCalls = [], recordings = [];
  const providers = {
    device: [{ id: 'candidate', version: 'test', label: 'test device', create: serial => ({ serial,
      uiNodes: async () => { deviceCalls.push(serial); return []; },
    }) }],
    recording: [{ id: 'candidate', version: 'test', label: 'test recorder', create: () => {
      const active = new Map();
      const recorder = { async start(serial, owner) { active.set(serial, owner); }, isRecording: serial => active.has(serial),
        discardThread(owner) { for (const [serial, thread] of active) if (thread === owner) active.delete(serial); } };
      recordings.push(recorder); return recorder;
    } }],
  };
  const { call } = await service(t, providers);
  await call('A', 'emulator_backends', { action: 'select', set: { device: 'candidate', recording: 'candidate' } });
  await call('A', 'emulator_ui_tree');
  assert.deepEqual(deviceCalls, ['device-A']);
  await call('A', 'emulator_record', { action: 'start' });
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0].isRecording('device-A'), true);
  await assert.rejects(call('A', 'emulator_backends', { action: 'select', set: { recording: 'screenrecord' } }), /recording/);
  assert.equal(recordings[0].isRecording('device-A'), true);
  assert.equal(JSON.parse((await call('B', 'emulator_backends', { action: 'metrics' })).text).selected.recording, 'screenrecord');
  recordings[0].discardThread('A');
  await call('A', 'emulator_backends', { action: 'select', set: { recording: 'screenrecord' } });
});


test('metrics retain the version observed for each selected backend instead of mixing CLI upgrades', async t => {
  let version = '1.0.1';
  const b = new Backends({ dir: temporary(t), providers: { capture: [{ ...capture('candidate'), probe: async () => ({ available: true, version }) }] } });
  for (const next of ['1.0.1', '1.0.2']) {
    version = next;
    await b.check({ capture: 'candidate' });
    b.select('A', { capture: 'candidate' });
    await b.measure('A', 'capture', b.get('A', 'capture'), async () => png);
  }
  assert.deepEqual(b.snapshot('A').map(row => row.version), ['1.0.1', '1.0.2']);
});


test('an explicitly selected replacement recovers a removed persisted backend without silent fallback', async t => {
  const { call } = await service(t, {}, { A: { recording: 'removed' } });
  await assert.rejects(call('A', 'emulator_record', { action: 'start' }), /Unknown recording backend/);
  await call('A', 'emulator_backends', { action: 'select', set: { recording: 'screenrecord' } });
  const metrics = JSON.parse((await call('A', 'emulator_backends', { action: 'metrics' })).text);
  assert.equal(metrics.selected.recording, 'screenrecord');
});

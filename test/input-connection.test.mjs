import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Mirror } from '../runtime/core/lib/mirror.mjs';

const daemon = fs.readFileSync(new URL('../runtime/core/daemon.mjs', import.meta.url), 'utf8');
const handler = daemon.slice(daemon.indexOf('  async emulator_type('), daemon.indexOf('  async emulator_observe('));

test('agent typing uses control-only input without a viewer, and reuses existing video without stopping it', async () => {
  const created = [], calls = [], stopped = [];
  const context = vm.createContext({
    clearTimeout() {},
    Mirror: class {
      constructor(options) { this.options = options; created.push(this); }
      async start() {} stop() { stopped.push(this); }
    },
    Device: class { constructor(serial) { this.serial = serial; } },
    typeIntoDevice: async (device, connection) => { calls.push({ device, connection }); return { verified: true, characters: 2 }; },
  });
  vm.runInContext(`
    const mirrors = new Map(), inputConnections = new Map(), typing = new Set();
    function requireLease(thread) { if (thread !== 'owner') throw new Error('Wrong owner'); return { serial: 'emulator-owned' }; }
    function log() {} async function agentEvent() {} function scheduleMirrorIdle() {}
    function deviceFor(_thread, serial) { return new Device(serial); }
    const backends = { get: () => ({ create: options => new Mirror(options) }) };
    const tools = { ${handler} };
  `, context);
  await vm.runInContext("tools.emulator_type('owner', {text: 'ok'})", context);
  assert.equal(created.length, 1);
  assert.equal(created[0].options.video, false);
  assert.equal(created[0].options.serial, 'emulator-owned');
  assert.equal(stopped[0], created[0]);
  assert.equal(vm.runInContext('inputConnections.size + typing.size + mirrors.size', context), 0);
  vm.runInContext("mirrors.set('owner', { mirror: { visible: true }, ready: Promise.resolve() })", context);
  await vm.runInContext("tools.emulator_type('owner', {text: 'ok'})", context);
  assert.equal(created.length, 1, 'reuse visible encoder instead of starting another connection');
  assert.equal(calls[1].connection.visible, true);
  assert.equal(stopped.length, 1, 'visible stream stays alive');
});

test('failed input startup is cleaned up, and stopped mirrors cannot start late resources', async () => {
  let stops = 0;
  const context = vm.createContext({
    Mirror: class { async start() { throw new Error('startup failed'); } stop() { stops++; } },
    Device: class { constructor(serial) { this.serial = serial; } },
  });
  vm.runInContext(`
    const mirrors = new Map(), inputConnections = new Map(), typing = new Set();
    function requireLease() { return { serial: 'owned' }; }
    function log() {} function scheduleMirrorIdle() {}
    function deviceFor(_thread, serial) { return new Device(serial); }
    const backends = { get: () => ({ create: options => new Mirror(options) }) };
    const tools = { ${handler} };
  `, context);
  await assert.rejects(vm.runInContext("tools.emulator_type('owner', {})", context), /startup failed/);
  assert.equal(stops, 1);
  assert.equal(vm.runInContext('inputConnections.size + typing.size', context), 0);
  const mirror = new Mirror({ serial: 'test', log() {}, video: false });
  mirror.stop();
  await assert.rejects(mirror.start(), /closed during startup/);
  assert.equal(mirror.process, null);
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Device } from '../runtime/core/lib/device.mjs';
import { collectDiagnostics, leaseDiagnostics } from '../runtime/core/lib/diagnostics.mjs';

const exec = promisify(execFile);
const sdkModule = new URL('../runtime/core/lib/sdk.mjs', import.meta.url).href;
const diagnosticsModule = new URL('../runtime/core/lib/diagnostics.mjs', import.meta.url).href;

function sdkFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-sdk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = { ...process.env, HOME: root, ANDROID_HOME: root, ANDROID_SDK_ROOT: root };
  const executable = relative => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A fake executable echoes its argument boundaries; it never accesses ADB.
    fs.writeFileSync(file, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o700 });
    return file;
  };
  const run = async source => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', source], { env: environment })).stdout);
  return { root, executable, run };
}

test('Platform Tools alone support selected-device ADB and do not report a missing SDK', async t => {
  const fixture = sdkFixture(t);
  const adb = fixture.executable('platform-tools/adb');
  const result = await fixture.run(`
    import { sdk, adb, requireEmulator } from ${JSON.stringify(sdkModule)};
    import { collectDiagnostics } from ${JSON.stringify(diagnosticsModule)};
    let emulatorError;
    try { requireEmulator(); } catch (error) { emulatorError = error.message; }
    const diagnostics = await collectDiagnostics({ dir: process.env.HOME, webDir: process.env.HOME });
    console.log(JSON.stringify({ sdk: sdk(), command: await adb('PHYSICAL_TEST', ['shell', 'getprop', 'sys.boot_completed']), emulatorError, diagnostics: diagnostics.structuredContent }));
  `);
  assert.equal(result.sdk.adb, adb);
  assert.equal(result.sdk.emulator, null);
  assert.equal(result.command.code, 0);
  assert.equal(result.command.stdout, '-s\nPHYSICAL_TEST\nshell\ngetprop\nsys.boot_completed\n');
  assert.match(result.emulatorError, /Install it with Android Studio or sdkmanager/);
  assert.deepEqual(result.diagnostics.sdk, { emulator: false, adb: true });
  assert.equal(result.diagnostics.findings.some(finding => ['AE_SDK_MISSING', 'AE_EMULATOR_MISSING'].includes(finding.code)), false);
});

test('emulator validation returns the optional executable and missing Platform Tools are diagnosed separately', async t => {
  const fixture = sdkFixture(t);
  const missing = await fixture.run(`
    import { sdk } from ${JSON.stringify(sdkModule)};
    try { sdk(); } catch (error) { console.log(JSON.stringify(error.message)); }
  `);
  assert.match(missing, /Android SDK Platform Tools not found/);
  fixture.executable('platform-tools/adb');
  const emulator = fixture.executable('emulator/emulator');
  const found = await fixture.run(`
    import { sdk, requireEmulator } from ${JSON.stringify(sdkModule)};
    console.log(JSON.stringify({ emulator: sdk().emulator, required: requireEmulator() }));
  `);
  assert.deepEqual(found, { emulator, required: emulator });
});

test('physical settings reject every emulator-only option before any mixed settings mutate the device', async () => {
  const device = new Device('PHYSICAL_TEST', { kind: 'physical' });
  const commands = [];
  device.shell = async command => commands.push(command);
  device.emu = async args => commands.push(args);
  for (const [name, value] of Object.entries({ location: { latitude: 1, longitude: 2 }, battery: { level: 50 }, rotate: 'right', posture: 'folded' })) {
    await assert.rejects(device.applySettings({ darkMode: true, fontScale: 1.5, [name]: value }), new RegExp(`Physical devices.*${name}`));
  }
  assert.deepEqual(commands, []);
});

test('physical direct console, snapshot, and rotation operations reject without ADB', async () => {
  const device = new Device('PHYSICAL_TEST', { kind: 'physical' });
  await assert.rejects(device.emu(['kill']), /unavailable on physical devices/);
  await assert.rejects(device.snapshots('list'), /unavailable on physical devices/);
  await assert.rejects(device.snapshots('save', 'checkpoint'), /unavailable on physical devices/);
  await assert.rejects(device.rotate('right'), /unavailable on physical devices/);
});

test('physical capture, input, apps, and ordinary settings preserve explicit device targeting', async () => {
  const captured = [];
  const commands = [];
  const png = Buffer.from('capture fixture');
  const device = new Device('PHYSICAL_TEST', { kind: 'physical', capture: async serial => { captured.push(serial); return png; } });
  device.shell = async command => { commands.push(command); return { stdout: '' }; };
  assert.equal(await device.screenshot(), png);
  await device.tap(20, 30);
  await device.key('BACK');
  await device.app({ action: 'stop', packageName: 'com.example.app' });
  assert.deepEqual(await device.applySettings({ darkMode: true, fontScale: 1.5 }), ['dark mode on', 'font scale 1.5']);
  assert.deepEqual(captured, ['PHYSICAL_TEST']);
  assert.deepEqual(commands, ['input tap 20 30', 'input keyevent 4', "am force-stop 'com.example.app'", 'cmd uimode night yes', 'settings put system font_scale 1.5']);
});

test('default emulator devices retain console settings', async () => {
  const device = new Device('emulator-test');
  const commands = [];
  device.emu = async args => commands.push(args);
  await device.applySettings({ location: { latitude: 1, longitude: 2 }, battery: { level: 50 }, rotate: 'right', posture: 'folded' });
  assert.deepEqual(commands, [['posture', '1'], ['geo', 'fix', '2', '1'], ['power', 'capacity', '50'], ['rotate']]);
});

test('physical diagnostics retain safe transport serials and connection states without probing a PID', () => {
  for (const serial of ['PHYSICAL_TEST', '192.0.2.1:5555', '[2001:db8::1]:5555', 'adb-PHYSICAL_TEST-service._adb-tls-connect._tcp']) {
    for (const state of ['ready', 'disconnected', 'offline', 'unauthorized']) {
      assert.deepEqual(leaseDiagnostics({ kind: 'physical', serial, state, pid: process.pid, privateField: 'secret' }), {
        kind: 'physical', serial, state, processRunning: null,
      });
    }
  }
  for (const serial of ['https://private/?token=secret', 'device\nsecret', 'x'.repeat(256)]) {
    assert.equal(leaseDiagnostics({ kind: 'physical', serial, state: 'private state' }).serial, null);
  }
  assert.equal(leaseDiagnostics({ kind: 'physical', serial: 'PHYSICAL_TEST', state: 'private state' }).state, 'unknown');
  assert.equal(leaseDiagnostics({ serial: 'emulator-5602', state: 'ready', pid: process.pid }).processRunning, true);
});

test('helper diagnostics cannot report emulator process liveness or private fields for physical pins', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    const body = request.url === '/health'
      ? { ok: true, pid: process.pid, capabilities: { diagnostics: true } }
      : { ok: true, result: { structuredContent: { schemaVersion: 1,
        device: { kind: 'physical', serial: 'PHYSICAL_TEST', state: 'offline', processRunning: false, privateField: 'secret' },
        display: {}, privateField: 'secret',
      } } };
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await collectDiagnostics({ dir: directory, webDir: directory, threadId: 'this-chat', info: { pid: process.pid, port: server.address().port, token: 'secret' } });
  assert.deepEqual(result.structuredContent.device, { kind: 'physical', serial: 'PHYSICAL_TEST', state: 'offline', processRunning: null, source: 'helper' });
  assert.equal(result.structuredContent.findings.some(finding => finding.code === 'AE_DEVICE_EXITED'), false);
  assert.doesNotMatch(JSON.stringify(result), /secret|privateField/);
});

function savedDiagnosticsFixture(t, leases, owners) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-pin-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'leases.json'), JSON.stringify({ leases }));
  if (owners !== undefined) fs.writeFileSync(path.join(directory, 'pins.json'), JSON.stringify({ owners }));
  const read = async threadId => collectDiagnostics({ dir: directory, webDir: directory, threadId });
  return { directory, read };
}

test('saved diagnostics follow pin ownership and hide a transferred root-key lease from its previous chat', async t => {
  const { read } = savedDiagnosticsFixture(t, {
    'chat-a': { kind: 'physical', serial: 'TRANSFERRED_DEVICE', state: 'ready', hardwareId: 'private-hardware' },
    'pin-a': { kind: 'physical', serial: 'CURRENT_DEVICE', state: 'offline', privateField: 'secret' },
  }, { 'chat-a': 'chat-b', 'pin-a': 'chat-a', 'stale-pin': 'chat-a' });
  const current = await read('chat-a');
  assert.equal(current.structuredContent.device.serial, 'CURRENT_DEVICE');
  assert.doesNotMatch(JSON.stringify(current), /TRANSFERRED_DEVICE|private-hardware|secret|chat-b/);
  const nextOwner = await read('chat-b');
  assert.equal(nextOwner.structuredContent.device.serial, 'TRANSFERRED_DEVICE');
  assert.doesNotMatch(JSON.stringify(nextOwner), /CURRENT_DEVICE|private-hardware|secret/);
});

test('saved diagnostics report several owned pins explicitly and do not expose other owners', async t => {
  const { read } = savedDiagnosticsFixture(t, {
    'pin-a': { kind: 'physical', serial: 'FIRST_DEVICE', state: 'disconnected', hardwareId: 'private-hardware' },
    'pin-b': { serial: 'emulator-5602', state: 'ready', pid: process.pid, privateField: 'secret' },
    'pin-c': { kind: 'physical', serial: 'OTHER_DEVICE', state: 'ready' },
  }, { 'pin-a': 'chat-a', 'pin-b': 'chat-a', 'pin-c': 'chat-b' });
  const result = await read('chat-a');
  assert.equal(result.structuredContent.device.state, 'multiple');
  assert.deepEqual(result.structuredContent.device.devices.map(device => device.serial), ['FIRST_DEVICE', 'emulator-5602']);
  assert.match(result.text, /FIRST_DEVICE/);
  assert.match(result.text, /emulator-5602/);
  assert.doesNotMatch(JSON.stringify(result), /OTHER_DEVICE|chat-b|private-hardware|secret/);
});

test('saved diagnostics use legacy keys only when pins state is absent and fail closed on invalid ownership', async t => {
  const { directory, read } = savedDiagnosticsFixture(t, { 'chat-a': { kind: 'physical', serial: 'ROOT_DEVICE', state: 'ready' } });
  assert.equal((await read('chat-a')).structuredContent.device.serial, 'ROOT_DEVICE');
  fs.writeFileSync(path.join(directory, 'pins.json'), JSON.stringify({ owners: {} }));
  const unassigned = await read('chat-a');
  assert.equal(unassigned.structuredContent.device.state, 'unassigned');
  assert.doesNotMatch(JSON.stringify(unassigned), /ROOT_DEVICE/);
  for (const contents of ['malformed', JSON.stringify({ owners: [] }), JSON.stringify({ owners: null })]) {
    fs.writeFileSync(path.join(directory, 'pins.json'), contents);
    const invalid = await read('chat-a');
    assert.equal(invalid.structuredContent.device.state, 'unknown');
    assert.doesNotMatch(JSON.stringify(invalid), /ROOT_DEVICE/);
  }
});

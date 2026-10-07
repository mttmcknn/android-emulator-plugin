import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// All SDK commands and device data stay in this throwaway directory.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-delete-'));
const home = path.join(root, 'avd');
const sdk = path.join(root, 'sdk');
const adbState = path.join(root, 'adb.json');
const write = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};
write(path.join(sdk, 'emulator', 'emulator'), '');
write(path.join(sdk, 'platform-tools', 'adb'), `#!${process.execPath}
const fs = require('node:fs');
const devices = JSON.parse(fs.readFileSync(${JSON.stringify(adbState)}, 'utf8'));
if (process.argv[2] === 'devices') {
  console.log('List of devices attached');
  for (const [serial, device] of Object.entries(devices)) console.log(serial + '\\t' + device.state);
} else {
  const device = devices[process.argv[3]];
  if (!device?.name) process.exit(1);
  console.log(device.name + '\\nOK');
}
`);
fs.chmodSync(path.join(sdk, 'platform-tools', 'adb'), 0o755);
process.env.ANDROID_HOME = sdk;
process.env.ANDROID_AVD_HOME = home;
const { deleteAvd } = await import('../runtime/core/lib/avds.mjs');
const { LeaseManager } = await import('../runtime/core/lib/leases.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test.beforeEach(() => write(adbState, '{}'));

function device(name, location = path.join(home, `${name}.avd`)) {
  write(path.join(home, `${name}.ini`), `path=${location}\n`);
  write(path.join(location, 'config.ini'), `AvdId=${name}\n`);
  write(path.join(location, 'userdata.img'), 'saved data');
  return location;
}

function manager() {
  const leases = new LeaseManager({ dir: fs.mkdtempSync(path.join(root, 'state-')), log() {} });
  leases.avds = async () => fs.readdirSync(home).filter(file => file.endsWith('.ini')).map(file => file.slice(0, -4));
  return leases;
}

test('confirmed panel deletion can remove an external AVD in a custom location without following nested links', async () => {
  const location = device('Custom', path.join(root, 'custom', 'Custom.avd'));
  const other = device('Untouched');
  fs.symlinkSync(other, path.join(location, 'linked-device'));
  await manager().deleteSaved('Custom');
  assert.equal(fs.existsSync(location), false);
  assert.equal(fs.existsSync(path.join(home, 'Custom.ini')), false);
  assert.equal(fs.readFileSync(path.join(other, 'userdata.img'), 'utf8'), 'saved data');
});

test('unsafe definitions are refused without deleting data', () => {
  const target = device('Target');
  const linked = path.join(home, 'Linked.avd');
  fs.symlinkSync(target, linked);
  write(path.join(home, 'Linked.ini'), `path=${linked}\n`);
  assert.throws(() => deleteAvd('Linked'), /symbolic link/);
  write(path.join(home, 'Mismatch.ini'), `path=${target}\n`);
  assert.throws(() => deleteAvd('Mismatch'), /does not match/);
  assert.throws(() => deleteAvd('Target'), /shares this data/);
  assert.throws(() => deleteAvd('../Target'), /Invalid AVD/);
  assert.throws(() => deleteAvd(undefined), /Invalid AVD/);
  assert.equal(fs.readFileSync(path.join(target, 'userdata.img'), 'utf8'), 'saved data');
  assert.equal(fs.existsSync(path.join(home, 'Target.ini')), true);
});

test('deletion refuses external, leased, starting and unidentified running emulators', async () => {
  const location = device('Busy');
  const leases = manager();
  write(adbState, JSON.stringify({ 'emulator-5554': { state: 'device', name: 'Busy' } }));
  assert.ok((await leases.inUseAvds()).has('Busy'));
  await assert.rejects(leases.deleteSaved('Busy'), /running or starting/);
  write(adbState, '{}');
  leases.leases.other = { threadId: 'other', avd: 'Busy', pid: process.pid, readOnly: true };
  await assert.rejects(leases.deleteSaved('Busy'), /running or starting/);
  delete leases.leases.other;
  leases.reservedAvds.add('Busy');
  await assert.rejects(leases.deleteSaved('Busy'), /running or starting/);
  leases.reservedAvds.clear();
  write(adbState, JSON.stringify({ 'emulator-5554': { state: 'offline' } }));
  await assert.rejects(leases.deleteSaved('Busy'), /Cannot identify running emulator/);
  assert.equal(fs.readFileSync(path.join(location, 'userdata.img'), 'utf8'), 'saved data');
  assert.equal(leases.deletingAvds.size, 0);
});

test('a pending deletion prevents a new start; a start reservation blocks deletion after the ADB check', async () => {
  const location = device('Racing');
  const leases = manager();
  let release;
  let reached;
  const checking = new Promise(resolve => { reached = resolve; });
  leases.devices = () => { reached(); return new Promise(resolve => { release = resolve; }); };
  const deleting = leases.deleteSaved('Racing');
  await checking;
  leases.devices = async () => [];
  await assert.rejects(leases.start('new-chat', { avd: 'Racing' }), /being deleted/);
  leases.reservedAvds.add('Racing');
  release([]);
  await assert.rejects(deleting, /running or starting/);
  assert.equal(fs.existsSync(location), true);
  assert.equal(leases.deletingAvds.size, 0);
});

test('agent and archive cleanup remain owner-scoped and tolerate data already removed in Studio', async () => {
  device('External');
  const leases = manager();
  await assert.rejects(leases.deleteOwned('chat', 'External'), /not created by this thread/);
  leases.createdAvds.Missing = { threadId: 'chat', keep: false };
  await leases.deleteOwned('chat', 'Missing');
  assert.equal(leases.createdAvds.Missing, undefined);
  assert.equal(fs.existsSync(path.join(home, 'External.ini')), true);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Captures } from '../runtime/core/lib/captures.mjs';
import { LeaseManager } from '../runtime/core/lib/leases.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWVQAAAAASUVORK5CYII=', 'base64');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emulator-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('core runs without any host or MCP adapter and isolates identical session IDs across integrations', async t => {
  const root = temporary(t);
  // Copy only core: any accidental adapter/packaging import fails here.
  fs.cpSync(new URL('../runtime/core', import.meta.url), path.join(root, 'core'), { recursive: true });
  const sdk = path.join(root, 'sdk');
  for (const [file, body] of [['emulator/emulator', 'printf "Test_Device\\n"'], ['platform-tools/adb', 'printf "List of devices attached\\n"']]) {
    const executable = path.join(sdk, file);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const previousSdk = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
  t.after(() => { if (previousSdk === undefined) delete process.env.ANDROID_HOME; else process.env.ANDROID_HOME = previousSdk; });
  const { startDaemon } = await import(pathToFileURL(path.join(root, 'core/daemon.mjs')));
  const services = [];
  t.after(async () => { await Promise.all(services.map(service => service.close())); });
  const instances = [];
  let unsubscribed = 0;
  for (const name of ['first', 'second']) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const capture = new Captures(dir).create('same-session', { png, serial: `emulator-${name}` });
    const service = await startDaemon({ dir, log() {}, appearance: {
      read: () => ({ mode: 'dark' }), subscribe: () => () => { unsubscribed++; },
    } });
    services.push(service);
    const token = fs.readFileSync(path.join(dir, 'token'), 'utf8');
    const request = async (tool, args = {}, accessToken = token) => {
      const response = await fetch(`http://127.0.0.1:${service.port}/api/call`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ threadId: 'same-session', tool, args }),
      });
      return { status: response.status, ...await response.json() };
    };
    instances.push({ ...service, token, capture, request });
  }
  const [first, second] = instances;
  assert.notEqual(first.port, second.port);
  const panel = await first.request('emulator_panel');
  assert.ok(panel.result.meta.panel.channel.key);
  assert.equal(panel.result.meta['openai/widgetSessionId'], undefined, 'the core does not invent host registration metadata');
  const browser = await fetch(panel.result.meta.panel.panelUrl);
  assert.equal(browser.status, 200);
  assert.match(await browser.text(), /emulator-theme/);
  assert.equal(await (await fetch(`http://127.0.0.1:${first.port}/host/panel.js`)).text(), '');
  const own = await first.request('emulator_capture', { action: 'context', captureId: first.capture.id });
  assert.equal(own.result.images[0].data, png.toString('base64'));
  const foreign = await second.request('emulator_capture', { action: 'context', captureId: first.capture.id });
  assert.equal(foreign.ok, false);
  assert.equal((await second.request('emulator_panel', {}, first.token)).status, 401);
  await Promise.all(services.map(service => service.close()));
  assert.equal(unsubscribed, 2);
});

test('lifecycle cleanup uses supplied session state and never treats unknown sessions as deleted', async t => {
  const dir = temporary(t);
  let states = new Map();
  const leases = new LeaseManager({ dir, log() {}, readSessions: async ids => {
    assert.deepEqual([...ids].sort(), ['opaque-session', 'other-session']);
    return states;
  } });
  const record = { pid: process.pid, state: 'ready', startedAt: '2000-01-01T00:00:00Z' };
  leases.leases = { 'opaque-session': { ...record }, 'other-session': { ...record } };
  const stopped = [];
  leases.stop = async id => { stopped.push(id); leases.remove(id); };
  await leases.sweep({ idleMs: 0, isWatched: () => false });
  assert.deepEqual(stopped, []);
  states = new Map([['opaque-session', { state: 'archived' }], ['other-session', { state: 'active' }]]);
  await leases.sweep({ idleMs: 0, isWatched: () => false, isBusy: id => id === 'opaque-session' });
  assert.deepEqual(stopped, []);
  await leases.sweep({ idleMs: 0, isWatched: () => false });
  assert.deepEqual(stopped, ['opaque-session']);
  assert.ok(leases.leases['other-session']);
});


test('opaque session IDs cannot collide with JavaScript object prototype properties', t => {
  const dir = temporary(t);
  const leases = new LeaseManager({ dir, log() {} });
  assert.equal(leases.get('constructor'), null);
  leases.leases['__proto__'] = { pid: process.pid, state: 'ready', serial: 'emulator-owned' };
  leases.save();
  const reopened = new LeaseManager({ dir, log() {} });
  assert.equal(reopened.get('__proto__').serial, 'emulator-owned');
  assert.equal(reopened.get('constructor'), null);
  reopened.remove('__proto__');
  assert.equal(reopened.get('__proto__'), null);
});

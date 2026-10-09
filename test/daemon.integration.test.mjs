import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scopedKey } from '../runtime/core/lib/panel-access.mjs';
import { Captures } from '../runtime/core/lib/captures.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemon = path.join(repo, 'runtime/hosts/codex/daemon.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitFor(check, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
        if (Date.now() >= deadline) return reject(new Error('Timed out waiting for helper state.'));
        setTimeout(poll, intervalMs);
      } catch (error) {
        reject(error);
      }
      return undefined;
    };
    poll();
  });
}

function executable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function startDaemon(env) {
  const child = spawn(process.execPath, [daemon], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function api(port, token, threadId, tool, args = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ threadId, tool, args }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function websocketStatus(port, thread, key) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(
        `GET /ws?thread=${encodeURIComponent(thread)}&k=${encodeURIComponent(key)} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      );
    });
    socket.once('data', (data) => {
      socket.destroy();
      const status = Number(data.toString('ascii', 0, data.indexOf('\r\n')).split(' ')[1]);
      resolve(status);
    });
  });
}

function resultMessage(messages, id) {
  return messages.map(({ j }) => j).find((message) => message?.t === 'result' && message.id === id);
}

async function streamResult(port, token, threadId, args, id) {
  let next = { ...args, wait: true };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await api(port, token, threadId, 'emulator_stream', next);
    const result = resultMessage(response.result.structuredContent.messages, id);
    if (result) return result;
    // A just-opened pane can drain its asynchronous status update before its action reply arrives.
    next = { thread: args.thread, key: args.key, workspace: args.workspace, session: args.session, wait: true };
  }
  throw new Error(`No stream result for ${id}.`);
}

test('daemon keeps one owner and scopes panel, recording, and manager capabilities', { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emulator-plugin-daemon-'));
  const state = path.join(root, 'state');
  const sdk = path.join(root, 'sdk');
  const port = await freePort();
  executable(
    path.join(sdk, 'emulator', 'emulator'),
    `#!${process.execPath}
if (process.argv[2] === '-list-avds') {
  const fs = require('node:fs');
  console.log(fs.readdirSync(process.env.ANDROID_AVD_HOME).filter(file => file.endsWith('.ini')).map(file => file.slice(0, -4)).join('\\n'));
}
`,
  );
  executable(path.join(sdk, 'platform-tools', 'adb'), '#!/bin/sh\nexit 0\n');
  const env = {
    ...process.env,
    ANDROID_HOME: sdk,
    ANDROID_USER_HOME: path.join(root, 'android'),
    ANDROID_AVD_HOME: path.join(root, 'android', 'avd'),
    CODEX_HOME: path.join(root, 'codex'),
    EMULATOR_FOR_CODEX_STATE_DIR: state,
    EMULATOR_FOR_CODEX_PORT: String(port),
    HOME: root,
  };
  fs.mkdirSync(state, { recursive: true });
  for (const name of ['Launcher_AVD', 'Manager_AVD']) {
    const data = path.join(env.ANDROID_AVD_HOME, `${name}.avd`);
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.ini'), `AvdId=${name}\n`);
    fs.writeFileSync(path.join(env.ANDROID_AVD_HOME, `${name}.ini`), `path=${data}\n`);
  }
  const savedLeases = JSON.stringify({ leases: {
    'diagnostic-a': { serial: 'emulator-5602', state: 'ready', pid: 2147483647, secret: 'private-owned-field' },
    'diagnostic-b': { serial: 'emulator-5698', state: 'ready', pid: 2147483647, secret: 'private-other-field' },
  }, createdAvds: {} });
  fs.writeFileSync(path.join(state, 'leases.json'), savedLeases);
  const captureStore = new Captures(state);
  const captured = captureStore.create('thread-a', { png: Buffer.from('captured fixture'), serial: 'emulator-5602' });
  const children = [startDaemon(env), startDaemon(env)];
  t.after(async () => {
    await Promise.all(children.map(stop));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const info = await waitFor(async () => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(state, 'daemon.json'), 'utf8'));
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await health.json();
      return body.ok && body.pid === value.pid ? value : null;
    } catch {
      return null;
    }
  });
  await waitFor(() => children.some((child) => child.exitCode !== null));
  assert.equal(children.filter((child) => child.exitCode === null).length, 1);
  assert.equal(children.find((child) => child.exitCode === null).pid, info.pid);

  const token = fs.readFileSync(path.join(state, 'token'), 'utf8').trim();
  const diagnostic = (await api(port, token, 'diagnostic-a', 'emulator_diagnostics')).result.structuredContent;
  assert.equal(diagnostic.device.serial, 'emulator-5602');
  assert.equal(diagnostic.device.processRunning, false);
  assert.equal(diagnostic.display.viewers, 0);
  assert.equal(diagnostic.display.encoderActive, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-|emulator-5698|diagnostic-b/);
  assert.equal(fs.readFileSync(path.join(state, 'leases.json'), 'utf8'), savedLeases, 'diagnosing an exited emulator must not remove its lease');
  assert.equal((await api(port, token, undefined, 'emulator_diagnostics')).ok, false);
  const ownCapture = await api(port, token, 'thread-a', 'emulator_capture', { action: 'context', captureId: captured.id });
  assert.equal(ownCapture.ok, true);
  assert.equal(ownCapture.result.images[0].data, Buffer.from('captured fixture').toString('base64'));
  assert.equal((await api(port, token, 'thread-b', 'emulator_capture', { action: 'copy', captureId: captured.id })).ok, false);
  const download = new URL(ownCapture.result.meta.capture.downloadUrl);
  assert.equal((await fetch(download)).status, 200);
  download.pathname = download.pathname.replace('thread-a', 'thread-b');
  assert.equal((await fetch(download)).status, 401);
  const metaA = (await api(port, token, 'thread-a', 'emulator_panel')).result.meta;
  const metaB = (await api(port, token, 'thread-b', 'emulator_panel')).result.meta;
  const reopenedA = (await api(port, token, 'thread-a', 'emulator_panel')).result.meta;
  assert.ok(metaA['openai/widgetSessionId']);
  assert.equal(reopenedA['openai/widgetSessionId'], metaA['openai/widgetSessionId']);
  assert.notEqual(metaA['openai/widgetSessionId'], metaB['openai/widgetSessionId']);
  const panelA = metaA.panel;
  const panelB = metaB.panel;
  const manager = (await api(port, token, 'thread-a', 'emulator_manager')).result.meta.panel;
  assert.equal(manager.channel.thread, 'manager');
  assert.notEqual(new URL(panelA.panelUrl).searchParams.get('k'), token);

  const panelAKey = panelA.channel.key;
  const panelBUrl = new URL(panelB.panelUrl);
  panelBUrl.searchParams.set('k', panelAKey);
  assert.equal((await fetch(panelBUrl)).status, 401);
  assert.equal(await websocketStatus(port, 'thread-b', panelAKey), 401);

  const privateWithPanelKey = await fetch(`http://127.0.0.1:${port}/api/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${panelAKey}` },
    body: JSON.stringify({ threadId: 'thread-b', tool: 'emulator_status', args: {} }),
  });
  assert.equal(privateWithPanelKey.status, 401);

  const recordings = path.join(state, 'recordings');
  fs.mkdirSync(recordings, { recursive: true });
  fs.writeFileSync(path.join(recordings, 'a.mp4'), 'A');
  fs.writeFileSync(path.join(recordings, 'b.mp4'), 'B');
  const recordingAKey = scopedKey(token, 'recording:a.mp4');
  const recordingA = await fetch(`http://127.0.0.1:${port}/recordings/a.mp4?k=${recordingAKey}`);
  assert.equal(recordingA.status, 200);
  assert.equal(await recordingA.text(), 'A');
  assert.equal((await fetch(`http://127.0.0.1:${port}/recordings/b.mp4?k=${recordingAKey}`)).status, 401);

  const blocked = await streamResult(port, token, 'thread-a', {
    ...panelA.channel,
    session: 'normal-pane',
    send: [{ t: 'call', id: 'blocked-manager', tool: 'manager_overview' }],
  }, 'blocked-manager');
  assert.equal(blocked?.ok, false);
  assert.match(blocked?.error ?? '', /Open Android Emulators/);

  const allowed = await streamResult(port, token, 'manager', {
    thread: manager.channel.thread,
    key: manager.channel.key,
    session: 'manager-pane',
    send: [{ t: 'call', id: 'allowed-manager', tool: 'manager_overview' }],
  }, 'allowed-manager');
  assert.equal(allowed?.ok, true);

  // Both user-facing surfaces require confirmation and can delete an idle Studio AVD.
  for (const [channel, session, action, avd] of [
    [panelA.channel, 'normal-pane', 'emulator_delete_avd', 'Launcher_AVD'],
    [manager.channel, 'manager-pane', 'manager_delete', 'Manager_AVD'],
  ]) {
    const request = { ...channel, session };
    const unconfirmed = await streamResult(port, token, channel.thread, {
      ...request, send: [{ t: 'call', id: `${action}-unconfirmed`, tool: action, args: { avd } }],
    }, `${action}-unconfirmed`);
    assert.equal(unconfirmed.ok, false);
    assert.match(unconfirmed.error, /Confirm device deletion/);
    assert.equal(fs.existsSync(path.join(env.ANDROID_AVD_HOME, `${avd}.avd`)), true);
    const deleted = await streamResult(port, token, channel.thread, {
      ...request, send: [{ t: 'call', id: action, tool: action, args: { avd, confirmed: true } }],
    }, action);
    assert.equal(deleted.ok, true, deleted.error);
    assert.equal(fs.existsSync(path.join(env.ANDROID_AVD_HOME, `${avd}.avd`)), false);
    assert.equal(fs.existsSync(path.join(env.ANDROID_AVD_HOME, `${avd}.ini`)), false);
    if (action === 'emulator_delete_avd') assert.ok(!deleted.result.avds.includes(avd));
    else assert.ok(!deleted.result.devices.some(device => device.name === avd));
  }

  // Closing a pane is terminal for that session, including calls that arrive after its final bye.
  for (const session of ['normal-pane', 'never-opened-pane']) {
    const args = { ...panelA.channel, session };
    await api(port, token, 'thread-a', 'emulator_stream', { ...args, send: [{ t: 'bye' }] });
    const late = await api(port, token, 'thread-a', 'emulator_stream', {
      ...args, wait: true, send: [{ t: 'call', id: 'late-call', tool: 'emulator_status' }],
    });
    assert.equal(late.ok, false);
    assert.match(late.error, /display session has closed/, 'expired sessions must request a fresh connection');
  }

  const idleStatus = JSON.parse((await api(port, token, 'thread-a', 'emulator_status')).result.text);
  assert.deepEqual(idleStatus.display, { viewers: 0, streaming: false });

  const mismatch = await api(port, token, 'thread-b', 'emulator_stream', {
    ...panelA.channel,
    session: 'mismatched-caller',
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /belongs to a different thread/);
});

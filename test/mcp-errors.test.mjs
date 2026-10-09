import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { errorDetails, diagnosticError } from '../runtime/core/lib/errors.mjs';
import { HELPER_VERSION } from '../runtime/hosts/codex/config.mjs';

function client(t, state) {
  const child = spawn(process.execPath, [new URL('../runtime/hosts/codex/mcp.mjs', import.meta.url).pathname], {
    env: { ...process.env, EMULATOR_FOR_CODEX_STATE_DIR: state }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 0;
  const pending = new Map();
  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    const result = JSON.parse(line);
    pending.get(result.id)?.(result);
    pending.delete(result.id);
  });
  t.after(async () => {
    reader.close();
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(state, { recursive: true, force: true });
  });
  return (method, params = {}) => new Promise(resolve => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

test('panel resources load without starting a helper; missing chat/files have stable codes', { timeout: 5000 }, async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-error-resource-'));
  const request = client(t, state);
  const uri = 'ui://android-emulator-plugin/panel.html';
  const resource = await request('resources/read', { uri });
  assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.result.contents[0].text, /AE_PANEL_INIT/);
  assert.equal(fs.existsSync(path.join(state, 'daemon.json')), false, 'HTML loading cannot depend on helper health');
  const missingThread = (await request('tools/call', { name: 'show_device_panel' })).result;
  assert.equal(missingThread.structuredContent.error.code, 'AE_THREAD_REQUIRED');
  assert.equal(missingThread.isError, true);
  assert.match(missingThread.content[0].text, /AE_THREAD_REQUIRED/);
  const runtime = fs.readdirSync(path.join(state, 'runtimes'))[0];
  fs.unlinkSync(path.join(state, 'runtimes', runtime, 'core', 'web', 'app.js'));
  const missingFiles = await request('resources/read', { uri });
  assert.equal(missingFiles.error.code, -32603, 'preserve JSON-RPC numeric error contract');
  assert.equal(missingFiles.error.data.code, 'AE_RESOURCE_LOAD');
});

test('lost helper reply has a diagnostic code and never replays the action', { timeout: 5000 }, async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-error-helper-'));
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, pid: process.pid, version: HELPER_VERSION }));
    calls++;
    res.end('invalid reply');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ pid: process.pid, port: server.address().port }));
  fs.writeFileSync(path.join(state, 'token'), 'test-token-never-in-errors');
  const request = client(t, state);
  const response = await request('tools/call', { name: 'check_device_status', _meta: { threadId: 'test-thread' } });
  assert.equal(response.result.structuredContent.error.code, 'AE_HELPER_CONNECT');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(response), /test-token|127\.0\.0\.1/);
});


test('public diagnostic metadata never includes arbitrary exception or argument text', () => {
  for (const error of [new Error('secret tool argument'), diagnosticError('AE_HELPER_CONNECT', 'http://127.0.0.1/?key=secret')]) {
    assert.doesNotMatch(JSON.stringify(errorDetails(error)), /secret|127\.0\.0\.1/);
  }
});

test('agent diagnostics work without a helper or chat identity and preserve saved leases', { timeout: 5000 }, async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-diagnostics-mcp-'));
  const saved = JSON.stringify({ leases: {
    'test-thread': { serial: 'emulator-5602', state: 'ready', pid: process.pid, secret: 'private-owned-field' },
    'other-thread': { serial: 'emulator-5698', state: 'ready', secret: 'private-other-field' },
  } });
  fs.writeFileSync(path.join(state, 'leases.json'), saved);
  const request = client(t, state);
  const listing = await request('tools/list');
  assert.equal(listing.result.tools.find(tool => tool.name === 'diagnose_device_issues').annotations.readOnlyHint, true);
  const result = (await request('tools/call', { name: 'diagnose_device_issues', _meta: { threadId: 'test-thread' } })).result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.helper.status, 'not_found');
  assert.equal(result.structuredContent.device.serial, 'emulator-5602');
  assert.equal(result.structuredContent.device.source, 'saved_state');
  assert.equal(result.structuredContent.device.processRunning, true);
  assert.equal(result.structuredContent.display, null);
  assert.doesNotMatch(JSON.stringify(result), /private-|other-thread|emulator-5698/);
  const missing = (await request('tools/call', { name: 'diagnose_device_issues' })).result;
  assert.equal(missing.structuredContent.chatBound, false);
  assert.equal(missing.structuredContent.device.source, 'unavailable');
  assert.ok(missing.structuredContent.findings.some(item => item.code === 'AE_THREAD_REQUIRED'));
  assert.doesNotMatch(JSON.stringify(missing), /emulator-5602|private-/);
  assert.equal(fs.existsSync(path.join(state, 'daemon.json')), false);
  assert.equal(fs.readFileSync(path.join(state, 'leases.json'), 'utf8'), saved);
});

test('capture tools return labeled image samples to the agent and keep download keys out of content', { timeout: 5000 }, async t => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-capture-mcp-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, pid: process.pid, version: HELPER_VERSION }));
    res.end(JSON.stringify({ ok: true, result: {
      text: 'Saved video with timestamped samples',
      images: [{ title: 'Frame at 0.00s', data: 'frame-zero', mimeType: 'image/png' }, { title: 'Frame at 1.00s', data: 'frame-one', mimeType: 'image/png' }],
      structuredContent: { capture: { id: 'capture-id', file: '/owned/video.mp4' } },
      meta: { capture: { downloadUrl: 'http://localhost/private?key=hidden-download-key' } },
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(state, 'daemon.json'), JSON.stringify({ pid: process.pid, port: server.address().port }));
  fs.writeFileSync(path.join(state, 'token'), 'private-token');
  const request = client(t, state);
  const response = (await request('tools/call', { name: 'view_or_copy_captures', arguments: { action: 'context', captureId: 'capture-id' }, _meta: { threadId: 'test-chat' } })).result;
  assert.deepEqual(response.content.map(block => block.type), ['text', 'text', 'image', 'text', 'image']);
  assert.equal(response.content[3].text, 'Frame at 1.00s');
  assert.equal(response.structuredContent.capture.file, '/owned/video.mp4');
  assert.doesNotMatch(JSON.stringify([response.content, response.structuredContent]), /hidden-download-key|private-token/);
});

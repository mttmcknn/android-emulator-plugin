import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectDiagnostics } from '../runtime/hosts/codex/diagnostics.mjs';
import { hostDiagnostics, parseHostFailures } from '../runtime/hosts/codex/host-diagnostics.mjs';
import { HELPER_VERSION, PLUGIN_VERSION } from '../runtime/hosts/codex/config.mjs';

const now = Date.parse('2026-10-02T18:00:00.000Z');
const init = number => `${String(number).padStart(8, '0')}-0000-0000-0000-000000000000`;
const event = (id, kind, fields = '', time = '2026-10-02T17:00:00.000Z') => `${time} [info] mcp_app_sandbox.${kind} initId=${init(id)} ${fields}\n`;

test('host diagnostics correlate emulator events and exclude other chats, stale events, and raw log content', () => {
  const lines = [
    event(1, 'sandbox_requested', 'server=emulator'),
    event(1, 'render_process_gone', 'reason=launch-failed exitCode=1003 error=https://private/?key=secret'),
    event(1, 'render_process_gone', 'reason=launch-failed exitCode=1003'),
    event(1, 'init_failed', 'server=emulator stage=handshake'),
    event(2, 'sandbox_requested', 'server=emulator threadId=this-chat'),
    event(2, 'render_process_gone', 'reason=secret-reason exitCode=secret-exit'),
    event(3, 'sandbox_requested', 'server=emulator threadId=other-chat'),
    event(3, 'render_process_gone', 'reason=crashed exitCode=13'),
    event(4, 'sandbox_requested', 'server=unrelated'),
    event(4, 'render_process_gone', 'reason=crashed exitCode=14'),
    event(5, 'render_process_gone', 'reason=crashed exitCode=15'), // no attributable source
    event(6, 'init_failed', 'server=emulator', '2026-10-01T16:00:00.000Z'),
    event(7, 'init_failed', 'server=emulator', '2026-10-03T16:00:00.000Z'),
    event(8, 'sandbox_requested', 'server=emulator'),
    event(8, 'render_process_gone', 'reason=clean-exit exitCode=0'),
  ];
  const report = parseHostFailures([lines.slice(0, 2).join(''), lines.slice(2).join('')], { now, threadId: 'this-chat' });
  assert.equal(report.events.length, 3);
  assert.deepEqual(report.events[0], { time: '2026-10-02T17:00:00.000Z', code: 'AE_HOST_RENDERER', scope: 'host_unattributed', reason: 'launch-failed', exitCode: 1003 });
  assert.equal(report.events[1].code, 'AE_HOST_HANDSHAKE');
  assert.equal(report.events[2].scope, 'this_chat');
  assert.equal(report.events[2].reason, 'unknown');
  assert.equal(report.events[2].exitCode, null);
  assert.doesNotMatch(JSON.stringify(report), /secret|private|other-chat|initId|https:/);
  assert.equal(parseHostFailures([lines.join('')], { now }).events.length, 2, 'missing chat identity must not expose identified chat events');
});

test('host diagnostics bound file tails and event counts, and distinguish unavailable logs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-host-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const date = new Date(now);
  const folder = path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const log = path.join(folder, 'codex-desktop-test.log');
  fs.writeFileSync(log, event(50, 'init_failed', 'server=emulator') + 'x'.repeat(1024 * 1024) + '\n' +
    Array.from({ length: 8 }, (_, i) => event(i, 'init_failed', 'server=emulator')).join(''));
  fs.utimesSync(log, new Date(now), new Date(now));
  const report = await hostDiagnostics({ root, now, platform: 'darwin' });
  assert.equal(report.status, 'checked');
  assert.equal(report.filesRead, 1);
  assert.equal(report.tailLimited, true);
  assert.equal(report.events.length, 5);
  assert.equal(report.omittedEvents, 3, 'the event outside the bounded tail is not read');
  assert.equal((await hostDiagnostics({ root: path.join(root, 'absent'), now, platform: 'darwin' })).status, 'unavailable');
  assert.equal((await hostDiagnostics({ root, now, platform: 'linux' })).status, 'unsupported');
});

test('diagnostics never upgrade a helper and only request a read-only chat snapshot when supported', { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-helper-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ['index.html', 'app.js', 'app.css']) fs.writeFileSync(path.join(dir, file), 'fixture');
  let helperVersion = '1.2.2';
  let malformed = false;
  let oversized = null;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    calls.push(req.url);
    if (oversized === req.url) return res.end(JSON.stringify({ private: 'x'.repeat(70 * 1024) }));
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, pid: process.pid, version: helperVersion, pluginVersion: helperVersion === HELPER_VERSION ? PLUGIN_VERSION : '0.2.2' }));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), { threadId: 'this-chat', tool: 'emulator_diagnostics', args: {} });
    assert.equal(req.headers.authorization, 'Bearer private-access-key');
    if (malformed) return res.end('private malformed reply');
    res.end(JSON.stringify({ ok: true, result: { structuredContent: {
      schemaVersion: 1,
      device: { state: 'ready', serial: 'emulator-5602', processRunning: true, privateField: 'secret-device-content' },
      display: { viewers: 2, encoderActive: true, videoSessionReady: true, retryPending: false, consecutiveFailures: 0, inputActive: false, panelUrl: 'http://private/?key=secret' },
      otherThreads: ['private-other-chat'],
    } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { dir, webDir: dir, info: { pid: process.pid, port: server.address().port, token: 'private-access-key' }, threadId: 'this-chat', hostOptions: { platform: 'linux' } };
  const old = (await collectDiagnostics(options)).structuredContent;
  assert.equal(old.helper.snapshot, 'unsupported');
  assert.ok(old.findings.some(f => f.code === 'AE_VERSION_MISMATCH'));
  assert.deepEqual(calls, ['/health'], 'do not shut down or upgrade an old helper');
  helperVersion = HELPER_VERSION;
  const current = await collectDiagnostics(options);
  assert.equal(current.structuredContent.device.source, 'helper');
  assert.equal(current.structuredContent.device.serial, 'emulator-5602');
  assert.equal(current.structuredContent.display.viewers, 2);
  assert.equal(current.structuredContent.findings.some(f => ['AE_VERSION_MISMATCH', 'AE_DIAGNOSTICS_PARTIAL'].includes(f.code)), false);
  assert.doesNotMatch(JSON.stringify(current), /private|secret/);
  malformed = true;
  const partial = await collectDiagnostics(options);
  assert.equal(partial.structuredContent.helper.status, 'reachable');
  assert.equal(partial.structuredContent.helper.snapshot, 'unavailable');
  assert.ok(partial.structuredContent.findings.some(f => f.code === 'AE_DIAGNOSTICS_PARTIAL'));
  assert.doesNotMatch(JSON.stringify(partial), /private|secret/);
  assert.deepEqual(calls, ['/health', '/health', '/api/call', '/health', '/api/call']);
  malformed = false;
  oversized = '/api/call';
  const largeSnapshot = await collectDiagnostics(options);
  assert.equal(largeSnapshot.structuredContent.helper.snapshot, 'unavailable');
  assert.equal(largeSnapshot.structuredContent.display, null);
  oversized = '/health';
  const largeHealth = await collectDiagnostics(options);
  assert.equal(largeHealth.structuredContent.helper.status, 'unreachable');
  assert.ok(JSON.stringify(largeHealth).length < 8000);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startDaemon } from '../runtime/core/daemon.mjs';
import { HELPER_VERSION } from '../runtime/hosts/codex/config.mjs';
import { panelMetadata, PANEL_URI, TOOL_NAMES } from '../runtime/hosts/codex/tools.mjs';

class Leases extends EventEmitter {
  leases = {};
  starts = [];
  get(id) { return this.leases[id]; }
  touch() {}
  async avds() { return ['Test']; }
  async sweep() {}
  async create(_id, { name = 'Created' }) { return { name, profile: 'Pixel', image: 'Android' }; }
  async start(id, options) {
    this.starts.push(options);
    if (options.avd === 'Broken') throw new Error('Emulator could not boot.');
    return this.leases[id] ??= { avd: options.avd ?? 'Test', serial: `owned-${id}`, state: 'ready', readOnly: true };
  }
}

async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-startup-panel-')));
  const leases = new Leases();
  const service = await startDaemon({ dir, helperVersion: HELPER_VERSION, panelMetadata, createLeases: () => leases, log() {} });
  const child = spawn(process.execPath, [new URL('../runtime/hosts/codex/mcp.mjs', import.meta.url).pathname], {
    env: { ...process.env, EMULATOR_FOR_CODEX_STATE_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let id = 0;
  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  t.after(async () => {
    reader.close();
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = (method, params) => new Promise(resolve => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { leases, request, call: (threadId, name, args = {}) => request('tools/call', { name, arguments: args, _meta: { threadId } }) };
}

test('startup returns a loadable panel through MCP and reuses the chat panel identity', { timeout: 10_000 }, async t => {
  const { call, request } = await fixture(t);
  const first = await call('A', 'start_emulator');
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.emulator.serial, 'owned-A');
  assert.equal(first._meta.ui.resourceUri, PANEL_URI);
  assert.equal(first._meta['openai/widgetSessionId'], 'android-emulator:A');
  assert.equal(first._meta.panel.channel.thread, 'A');
  assert.ok(first._meta.panel.channel.key);
  const visible = JSON.stringify({ content: first.content, structuredContent: first.structuredContent });
  assert.ok(!visible.includes(first._meta.panel.channel.key));
  assert.doesNotMatch(visible, /127\.0\.0\.1|panelUrl/);

  const resource = await request('resources/read', { uri: first._meta.ui.resourceUri });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.contents[0].text, /data-view="device"/);
  const names = resource.contents[0].text.match(/<script type="application\/json" id="codex-tool-names">(.*?)<\/script>/);
  assert.ok(names, 'The panel receives the host tool names before its scripts run.');
  assert.deepEqual(JSON.parse(names[1]), TOOL_NAMES);
  assert.deepEqual((await call('A', 'start_emulator'))._meta, first._meta);
  assert.deepEqual((await call('A', 'show_device_panel'))._meta, first._meta);
  const other = await call('B', 'start_emulator');
  assert.notEqual(other._meta['openai/widgetSessionId'], first._meta['openai/widgetSessionId']);
  assert.notEqual(other._meta.panel.channel.key, first._meta.panel.channel.key);
});

test('create opens the same panel only when it starts the device', { timeout: 10_000 }, async t => {
  const { call, leases } = await fixture(t);
  const saved = await call('A', 'create_emulator', { name: 'Saved', start: false });
  assert.equal(saved._meta, undefined);
  assert.equal(leases.starts.length, 0);
  const started = await call('A', 'create_emulator', { name: 'New' });
  assert.equal(started.structuredContent.emulator.avd, 'New');
  assert.match(started.structuredContent.created, /Created New/);
  assert.deepEqual(started._meta, (await call('A', 'show_device_panel'))._meta);
  assert.deepEqual(leases.starts, [{ avd: 'New' }]);
});

test('failed startup, missing chat context, and tool discovery never request an extra panel', { timeout: 10_000 }, async t => {
  const { call, request } = await fixture(t);
  for (const name of ['start_emulator', 'create_emulator']) {
    const failed = await call('A', name, { avd: 'Broken', name: 'Broken' });
    assert.equal(failed.isError, true);
    assert.equal(failed._meta, undefined);
    assert.match(failed.content[0].text, /could not boot/);
    const missing = await request('tools/call', { name });
    assert.equal(missing.structuredContent.error.code, 'AE_THREAD_REQUIRED');
    assert.equal(missing._meta, undefined);
  }
  const { tools } = await request('tools/list');
  for (const name of ['start_emulator', 'create_emulator']) {
    assert.equal(tools.find(tool => tool.name === name)._meta?.ui?.resourceUri, undefined);
  }
  assert.deepEqual(tools.filter(tool => tool._meta?.['openai/ui']?.entrypoints?.some(e => e.type === 'thread')).map(tool => tool.name), ['show_device_panel']);
});

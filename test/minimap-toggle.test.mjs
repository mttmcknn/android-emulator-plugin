import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startDaemon } from '../runtime/core/daemon.mjs';
import { createNavigationDependencies } from '../runtime/core/backends/navigation-dependencies.mjs';
import { NavigationControl } from '../runtime/core/lib/navigation-control.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const node = { text: 'Settings', description: '', resourceId: 'com.example:id/settings', className: 'Button', center: [10, 10], bounds: [0, 0, 20, 20], enabled: true };
const graph = { schema_version: 'minimap.screen-graph.v1', places: [{ id: 'home', slug: 'home', label: 'Home' }], edges: [] };

class Leases extends EventEmitter {
  constructor() {
    super();
    this.createdAvds = {};
    this.leases = Object.fromEntries(['A', 'B'].map(id => [id, { state: 'ready', avd: 'Test', serial: `owned-${id}` }]));
  }
  get(id) { return this.leases[id]; }
  touch() {}
  async avds() { return []; }
  ownedAvds() { return []; }
  async sweep() {}
}

async function fixture(t, { enabled } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'minimap-toggle-')));
  const events = [], raw = [];
  const state = { initialized: false, execute: null, graph: null, uiNodes: null, probe: null, sessions: null };
  const selections = Object.fromEntries(['A', 'B'].map(id => [id, { navigation: 'toggle-nav', device: 'toggle-device' }]));
  fs.writeFileSync(path.join(dir, 'backends.json'), JSON.stringify(selections));
  if (enabled !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ minimapEnabled: enabled }));
  const provider = {
    id: 'toggle-nav', label: 'Test navigation', version: 'test',
    probe: async options => { events.push({ action: 'probe' }); return state.probe ? state.probe(options) : { available: true }; },
    async uiNodes(serial, options) {
      events.push({ action: 'uiNodes', serial });
      return state.uiNodes ? state.uiNodes(serial, options) : [node];
    },
    create() {
      events.push({ action: 'create' });
      return {
        status(cwd, packageName) {
          events.push({ action: 'status' });
          return { root: path.join(dir, 'map'), projectName: 'Test', packageName: packageName ?? 'com.example.app', initialized: state.initialized, places: state.initialized ? graph.places : [], edges: [] };
        },
        async prepare(context, options) {
          events.push({ action: 'prepare' });
          state.initialized = true;
          fs.mkdirSync(path.join(dir, 'map'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'map', 'saved.json'), JSON.stringify(graph));
          options.signal.throwIfAborted();
        },
        async execute(args, options) {
          events.push(args);
          return state.execute ? state.execute(args, options) : { status: 'ok', summary: 'Remembered.', currentPlaceId: 'home' };
        },
        async graph(context, options) {
          events.push({ action: 'graph' });
          return state.graph ? state.graph(context, options) : { graph, graphStatus: { status: 'ok' } };
        },
      };
    },
  };
  const device = (serial, options) => {
    const read = async () => {
      const shared = await options.uiNodes?.(serial, { timeoutMs: 3000 });
      if (shared) return shared;
      raw.push('uiNodes');
      return [node];
    };
    return {
      serial, uiNodes: read,
      async foregroundActivity() { raw.push('foreground'); return 'com.example.app/.Main'; },
      async open() { raw.push('open'); return 'Opened.'; },
      async app() { raw.push('restart'); return 'Restarted.'; },
      async key() { raw.push('key'); return 4; },
      async tap() { raw.push('tap'); },
      async swipe() { raw.push('swipe'); },
      async screenSize() { return { width: 100, height: 200 }; },
      async observe() { return { screenshot: Buffer.from('png'), nodes: await read(), foregroundActivity: 'com.example.app/.Main', errors: {} }; },
      async waitForNode() { return { node: (await read())[0], matches: 1 }; },
      async scrollTo() { return { node: (await read())[0], swipes: 0 }; },
    };
  };
  let service;
  const start = async () => {
    service = await startDaemon({
      dir,
      providers: { navigation: [provider], device: [{ id: 'toggle-device', version: 'test', create: device }] },
      createLeases: () => new Leases(),
      createConnectedDevices: () => ({ list: async () => [] }),
      readSessions: async ids => {
        if (state.sessions) await state.sessions(ids);
        return new Map(ids.map(id => [id, { state: 'active', cwd: dir }]));
      },
      log() {},
    });
  };
  await start();
  t.after(async () => { state.cleanup?.(); await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8');
  const call = async (tool, args = {}, threadId = 'A') => (await fetch(`http://127.0.0.1:${service.port}/api/call`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, tool, args }),
  })).json();
  return { call, events, raw, state, dir, restart: async () => { await service.close(); await start(); } };
}

test('Minimap defaults on, is discoverable in settings, and persists off across helper restarts', async t => {
  const { call, restart, events, dir } = await fixture(t);
  const settings = (await call('settings_read')).result.structuredContent;
  assert.equal(settings.values.minimapEnabled, true);
  assert.equal(settings.schema.properties.minimapEnabled.type, 'boolean');
  assert.match(settings.schema.properties.minimapEnabled.title, /minimap/i);
  assert.ok(settings.layout.some(group => group.items.some(item => item.property === 'minimapEnabled')));
  assert.equal((await call('settings_update', { set: { minimapEnabled: 'false' } })).ok, false);
  const disabled = await call('settings_update', { set: { minimapEnabled: false } });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.result.structuredContent.values.minimapEnabled, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))).minimapEnabled, false);
  await restart();
  assert.equal((await call('settings_read')).result.structuredContent.values.minimapEnabled, false);
  const status = await call('emulator_status');
  assert.equal(JSON.parse(status.result.text).settings.minimapEnabled, false);
  assert.equal(events.length, 0, 'loading persisted settings/status must not invoke navigation');
});

test('disabled navigation never creates/probes/calls a provider or exports a graph', async t => {
  const { call, events } = await fixture(t, { enabled: false });
  for (const action of ['status', 'graph', 'cancel', 'init', 'doctor', 'whereami', 'layout', 'go', 'tap', 'scroll', 'back']) {
    const result = await call('emulator_navigate', { action, packageName: 'com.example.app', target: 'home', point: [10, 10], direction: 'down' });
    assert.match(JSON.stringify(result), /disabled|off/i, action);
    if (action === 'graph') assert.equal(result.result.structuredContent.graphStatus.status, 'disabled');
    assert.equal(events.length, 0, `${action} must not reach navigation`);
  }
  const listed = await call('emulator_backends', { action: 'list' });
  assert.equal(listed.ok, true);
  assert.equal(events.length, 0, 'listing providers must not probe Minimap');
  const selected = await call('emulator_backends', { action: 'select', set: { navigation: 'toggle-nav' } });
  if (!selected.ok) assert.match(selected.error, /disabled|off/i);
  assert.equal(events.length, 0, 'selecting a disabled provider must not probe it');
});

test('a failed settings save leaves the live preference unchanged and a later disable really takes effect', async t => {
  const { call, dir, events } = await fixture(t);
  const file = path.join(dir, 'settings.json');
  fs.mkdirSync(file); // Deterministic write failure without changing directory permissions.
  const failed = await call('settings_update', { set: { minimapEnabled: false } });
  assert.equal(failed.ok, false);
  assert.equal((await call('settings_read')).result.structuredContent.values.minimapEnabled, true);
  fs.rmdirSync(file);
  assert.equal((await call('settings_update', { set: { minimapEnabled: false } })).ok, true);
  assert.equal((await call('emulator_navigate', { action: 'graph' })).result.structuredContent.graphStatus.status, 'disabled');
  assert.equal(events.length, 0);
});

test('disabled ordinary device operations bypass automatic hooks and navigation UI inspection', async t => {
  const { call, events, raw } = await fixture(t, { enabled: false });
  for (const [tool, args] of [
    ['emulator_open', { packageName: 'com.example.app' }],
    ['emulator_app', { action: 'restart', packageName: 'com.example.app' }],
    ['emulator_observe', {}],
    ['emulator_ui_tree', {}],
    ['emulator_wait_for', { text: 'Settings' }],
    ['emulator_scroll_to', { text: 'Settings' }],
    ['emulator_tap', { text: 'Settings' }],
    ['emulator_tap', { x: 10, y: 10 }],
    ['emulator_swipe', { direction: 'up' }],
    ['emulator_key', { key: 'BACK' }],
  ]) {
    const result = await call(tool, args);
    assert.equal(result.ok, true, `${tool}: ${JSON.stringify(result)}`);
    assert.equal(events.length, 0, `${tool} must not use any navigation hook`);
  }
  for (const action of ['open', 'restart', 'uiNodes', 'tap', 'swipe', 'key']) assert.ok(raw.includes(action), `${action} remains usable`);
  assert.equal(raw.includes('foreground'), false, 'automatic learning must not request extra device observations');
});

test('re-enabling restores tracking/graph behavior while preserving existing data and app association', async t => {
  const { call, events, dir } = await fixture(t);
  assert.equal((await call('emulator_open', { packageName: 'com.example.app' })).ok, true);
  const savedMap = fs.readFileSync(path.join(dir, 'map', 'saved.json'));
  const savedApps = fs.readFileSync(path.join(dir, 'navigation-apps.json'));
  assert.ok(events.some(event => event.action === 'prepare'));
  assert.ok(events.some(event => event.action === 'whereami'));
  assert.equal((await call('emulator_navigate', { action: 'graph' })).result.structuredContent.graphStatus.status, 'ok');
  assert.equal((await call('settings_update', { set: { minimapEnabled: false } })).ok, true);
  events.length = 0;
  await call('emulator_open', { packageName: 'com.example.app' });
  await call('emulator_navigate', { action: 'status' });
  assert.equal(events.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'map', 'saved.json')), savedMap);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'navigation-apps.json')), savedApps);
  assert.equal((await call('settings_update', { set: { minimapEnabled: true } })).ok, true);
  assert.equal(events.length, 0, 'enabling should not launch navigation on its own');
  const tapped = await call('emulator_tap', { text: 'Settings' });
  assert.equal(tapped.ok, true);
  assert.ok(events.some(event => event.action === 'uiNodes'));
  assert.ok(events.some(event => event.action === 'tap'));
  assert.equal(tapped.result.structuredContent.navigation.currentPlaceId, 'home');
  const exported = await call('emulator_navigate', { action: 'graph' });
  assert.equal(exported.result.structuredContent.graphStatus.status, 'ok');
  assert.deepEqual(exported.result.structuredContent.graph, graph);
});

test('disabling cancels active navigation and waits for cleanup before re-enabling or releasing input', { timeout: 10_000 }, async t => {
  const { call, state, raw } = await fixture(t);
  const entered = deferred(), aborted = deferred(), cleanup = deferred();
  state.cleanup = () => cleanup.resolve();
  state.execute = async (_args, { signal }) => {
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve();
    await cleanup.promise;
    throw new Error('Navigation cancelled');
  };
  const action = call('emulator_tap', { x: 10, y: 10 });
  await entered.promise;
  let disabledFinished = false, enabledFinished = false;
  const disable = call('settings_update', { set: { minimapEnabled: false } }).then(value => { disabledFinished = true; return value; });
  await aborted.promise;
  const enable = call('settings_update', { set: { minimapEnabled: true } }).then(value => { enabledFinished = true; return value; });
  assert.equal((await call('emulator_key', { key: 'HOME' })).ok, false);
  assert.equal(disabledFinished, false);
  assert.equal(enabledFinished, false);
  assert.equal(raw.includes('tap'), false, 'cancelled tracked input must not replay through raw controls');
  cleanup.resolve();
  assert.equal((await action).ok, false);
  assert.equal((await disable).ok, true);
  assert.equal((await enable).ok, true);
  assert.equal((await call('emulator_key', { key: 'HOME' })).ok, true);
  assert.equal((await call('settings_read')).result.structuredContent.values.minimapEnabled, true);
});

test('disabling cancels an in-flight graph export and discards its stale result', { timeout: 10_000 }, async t => {
  const { call, state } = await fixture(t);
  const entered = deferred(), aborted = deferred(), cleanup = deferred();
  state.cleanup = () => cleanup.resolve();
  state.graph = async (_context, { signal } = {}) => {
    assert.ok(signal, 'graph export must receive a cancellable signal');
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve();
    await cleanup.promise;
    return { graph, graphStatus: { status: 'ok' } };
  };
  const exporting = call('emulator_navigate', { action: 'graph' });
  await entered.promise;
  let disabledFinished = false;
  const disable = call('settings_update', { set: { minimapEnabled: false } }).then(value => { disabledFinished = true; return value; });
  await aborted.promise;
  assert.equal(disabledFinished, false, 'settings update waits for the owned graph process');
  cleanup.resolve();
  const result = await exporting;
  assert.notEqual(result.result?.structuredContent?.graphStatus?.status, 'ok', 'an export completed after disable is stale');
  assert.equal((await disable).ok, true);
});

test('disabling cancels incidental navigation inspection and later ordinary reads use the raw reader', { timeout: 10_000 }, async t => {
  const { call, state, raw, events } = await fixture(t);
  const entered = deferred(), aborted = deferred(), cleanup = deferred();
  state.cleanup = () => cleanup.resolve();
  state.uiNodes = async (_serial, { signal } = {}) => {
    assert.ok(signal, 'navigation UI inspection must receive a cancellable signal');
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve();
    await cleanup.promise;
    throw new Error('Inspection cancelled');
  };
  const inspection = call('emulator_ui_tree');
  await entered.promise;
  let disabledFinished = false;
  const disable = call('settings_update', { set: { minimapEnabled: false } }).then(value => { disabledFinished = true; return value; });
  await aborted.promise;
  assert.equal(disabledFinished, false);
  cleanup.resolve();
  await inspection;
  assert.equal((await disable).ok, true);
  events.length = 0;
  assert.equal((await call('emulator_ui_tree')).ok, true);
  assert.equal(events.length, 0);
  assert.ok(raw.includes('uiNodes'));
});

test('disabling cancels in-flight availability probes before reporting the setting saved', { timeout: 10_000 }, async t => {
  const { call, state } = await fixture(t);
  const entered = deferred(), aborted = deferred(), cleanup = deferred();
  state.cleanup = () => cleanup.resolve();
  state.probe = async ({ signal } = {}) => {
    assert.ok(signal, 'availability probes must receive a cancellable signal');
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve();
    await cleanup.promise;
    return { available: true };
  };
  const checking = call('emulator_backends', { action: 'select', set: { navigation: 'toggle-nav' } });
  await entered.promise;
  let disabledFinished = false;
  const disable = call('settings_update', { set: { minimapEnabled: false } }).then(value => { disabledFinished = true; return value; });
  await aborted.promise;
  assert.equal(disabledFinished, false);
  cleanup.resolve();
  assert.equal((await checking).ok, false, 'a cancelled probe must not report the backend ready');
  assert.equal((await disable).ok, true);
});

test('a request waiting for host session data cannot create navigation after disable or re-enable', { timeout: 10_000 }, async t => {
  const { call, state, events } = await fixture(t);
  const entered = deferred(), release = deferred();
  state.cleanup = () => release.resolve();
  state.sessions = async () => {
    state.sessions = null;
    entered.resolve();
    await release.promise;
  };
  const exporting = call('emulator_navigate', { action: 'graph' });
  await entered.promise;
  assert.equal(events.length, 0);
  const disable = call('settings_update', { set: { minimapEnabled: false } });
  while ((await call('settings_read')).result.structuredContent.values.minimapEnabled) {}
  const enable = call('settings_update', { set: { minimapEnabled: true } });
  release.resolve();
  assert.equal((await exporting).ok, false);
  assert.equal((await disable).ok, true);
  assert.equal((await enable).ok, true);
  assert.equal(events.length, 0, 'the old generation must stop before creating its provider');
  assert.equal((await call('emulator_navigate', { action: 'graph' })).result.structuredContent.graphStatus.status, 'ok');
});

test('dependency setup cancellation drains probes without writing or downloading, then permits a fresh retry', { timeout: 10_000 }, async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'minimap-toggle-dependencies-')));
  const entered = deferred(), aborted = deferred(), cleanup = deferred();
  t.after(() => { cleanup.resolve(); fs.rmSync(dir, { recursive: true, force: true }); });
  const minimap = path.join(dir, 'minimap'), android = path.join(dir, 'android');
  fs.writeFileSync(minimap, 'existing-minimap', { mode: 0o700 });
  fs.writeFileSync(android, 'existing-android', { mode: 0o700 });
  let first = true, downloads = 0;
  const control = new NavigationControl();
  const dependencies = createNavigationDependencies({
    dir, platform: 'linux', arch: 'x64',
    environment: { PATH: '', ANDROID_EMULATOR_MINIMAP: minimap, ANDROID_EMULATOR_ANDROID_CLI: android },
    fetchImpl: async () => { downloads++; throw new Error('unexpected download'); },
    runCommand: async (file, _args, { signal }) => {
      if (file === minimap && first) {
        first = false;
        entered.resolve();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        aborted.resolve();
        await cleanup.promise;
        throw signal.reason;
      }
      return { code: 0, stdout: file === minimap ? 'minimap 0.2.1' : '1.0.16406183' };
    },
  });
  const preparing = control.run(signal => dependencies.ensure({ signal }));
  const failedPreparation = assert.rejects(preparing);
  await entered.promise;
  let disabledFinished = false;
  const disabling = control.disable().then(() => { disabledFinished = true; });
  await aborted.promise;
  assert.equal(disabledFinished, false, 'setup must wait for owned probe cleanup');
  cleanup.resolve();
  await failedPreparation;
  await disabling;
  assert.equal(downloads, 0);
  assert.equal(fs.existsSync(path.join(dir, 'navigation-dependencies')), false, 'cancelled verification must not create launchers or managed downloads');
  assert.equal(fs.readFileSync(minimap, 'utf8'), 'existing-minimap');
  assert.equal(fs.readFileSync(android, 'utf8'), 'existing-android');
  control.enable();
  const ensured = await control.run(signal => dependencies.ensure({ signal }));
  assert.equal(ensured.available, true);
  assert.equal(ensured.minimap, minimap);
  assert.equal(downloads, 0);
  assert.equal(fs.existsSync(path.join(dir, 'navigation-dependencies/bin/android')), true);
});

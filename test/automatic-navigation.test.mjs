import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startDaemon } from '../runtime/core/daemon.mjs';
import { createMinimapBackend } from '../runtime/core/backends/minimap.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function temporary(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-navigation-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
class Leases extends EventEmitter {
  constructor() { super(); this.createdAvds = {}; this.leases = Object.fromEntries(['A', 'B', 'C'].map(id => [id, { state: 'ready', avd: 'Test', serial: `owned-${id}` }])); }
  get(id) { return this.leases[id]; }
  touch() {} async avds() { return []; } ownedAvds() { return []; } async sweep() {}
}
async function fixture(t) {
  const dir = temporary(t);
  const events = []; const graphs = new Map();
  const state = { foreground: 'com.example.app/.Main', prepareError: null, execute: null, rawInputs: 0, foregroundReads: 0 };
  const provider = { id: 'learned', version: 'test', probe: async () => ({ available: true }), create: () => ({
    status(cwd, packageName) { return { root: `${cwd}/${packageName ?? 'empty'}`, projectName: 'Project', packageName, places: graphs.has(packageName) ? [{ id: 'home', slug: 'home', label: 'Home' }] : [], edges: [], initialized: graphs.has(packageName) }; },
    async prepare(context) { events.push({ action: 'prepare', ...context }); if (state.prepareError) throw state.prepareError; graphs.set(context.packageName, true); },
    async execute(args, options) { events.push(args); if (state.execute) return state.execute(args, options); return { status: 'ok', summary: 'Remembered.', currentPlaceId: 'home' }; },
  }) };
  const device = serial => ({ serial,
    foregroundActivity: async () => { state.foregroundReads++; return state.foreground; },
    open: async ({ packageName }) => { if (packageName) state.foreground = `${packageName}/.Main`; return 'Opened.'; },
    app: async () => 'Restarted.',
    key: async () => { state.rawInputs++; return 4; },
    tap: async () => { state.rawInputs++; },
    uiNodes: async () => [{ text: 'Settings', description: '', resourceId: 'com.example:id/settings', className: 'Button', center: [10, 10], bounds: [0, 0, 20, 20], enabled: true }],
    observe: async () => ({ screenshot: Buffer.from('png'), nodes: null, foregroundActivity: state.foreground, errors: { uiNodes: 'unavailable' } }),
  });
  const selections = Object.fromEntries(['A', 'B', 'C'].map(id => [id, { navigation: 'learned', device: 'fixture' }]));
  fs.writeFileSync(path.join(dir, 'backends.json'), JSON.stringify(selections));
  const service = await startDaemon({ dir, providers: { navigation: [provider], device: [{ id: 'fixture', version: 'test', create: device }] }, createLeases: () => new Leases(), readSessions: async ids => new Map(ids.map(id => [id, { state: 'active', cwd: '/trusted/project' }])), log() {} });
  t.after(() => service.close());
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8');
  const call = async (threadId, tool, args = {}) => (await fetch(`http://127.0.0.1:${service.port}/api/call`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ threadId, tool, args }) })).json();
  return { call, state, events, dir, graphs };
}

test('ordinary open/tap learns automatically; status is passive and app switches keep separate maps', async t => {
  const { call, state, events, dir } = await fixture(t);
  await call('A', 'emulator_navigate', { action: 'status' });
  assert.equal(state.foregroundReads, 0); assert.equal(events.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'navigation-apps.json')), false);
  assert.equal((await call('A', 'emulator_open', { packageName: 'com.example.app' })).ok, true);
  const tapped = await call('A', 'emulator_tap', { text: 'Settings', cwd: '/untrusted', serial: 'owned-B' });
  assert.equal(tapped.result.structuredContent.navigation.status, 'ok');
  const tap = events.find(e => e.action === 'tap');
  assert.equal(tap.cwd, '/trusted/project'); assert.equal(tap.serial, 'owned-A');
  assert.equal(tap.selector, 'resource_id=com.example:id/settings'); assert.equal(tap.automatic, true);
  assert.equal(state.rawInputs, 0);
  state.foreground = 'com.other.app/.Main';
  await call('A', 'emulator_open', { packageName: 'com.other.app' });
  assert.equal((await call('A', 'emulator_navigate', { action: 'status' })).result.structuredContent.map.packageName, 'com.other.app');
  state.foreground = 'com.example.app/.Main';
  await call('A', 'emulator_open', { packageName: 'com.example.app' });
  assert.equal((await call('A', 'emulator_navigate', { action: 'status' })).result.structuredContent.map.places.length, 1);
  state.foreground = 'com.android.launcher3/.Launcher';
  assert.equal((await call('A', 'emulator_navigate', { action: 'go', target: 'home' })).ok, true);
  assert.equal(state.foreground, 'com.example.app/.Main');
  assert.equal((await call('A', 'emulator_navigate', { action: 'go', target: 'missing' })).ok, false);
});

test('setup failure allows one raw action; lost action reply never falls back or repeats input', async t => {
  const { call, state } = await fixture(t);
  state.prepareError = new Error('download failed');
  assert.equal((await call('A', 'emulator_tap', { text: 'Settings' })).ok, true);
  assert.equal(state.rawInputs, 1);
  assert.equal((await call('A', 'emulator_navigate', { action: 'status' })).result.structuredContent.map.learning.state, 'error');
  state.prepareError = null;
  let dispatched = 0;
  state.execute = async () => { dispatched++; throw new Error('reply lost after tap'); };
  const failure = await call('A', 'emulator_tap', { text: 'Settings' });
  assert.equal(failure.ok, false); assert.match(failure.error, /not retried/);
  assert.equal(dispatched, 1); assert.equal(state.rawInputs, 1);
  const observation = await call('A', 'emulator_observe');
  assert.equal(observation.ok, true); assert.ok(observation.result.image);
  assert.equal(observation.result.structuredContent.errors.uiNodes, 'unavailable');
});

test('open, restart, observations and navigation expose naming work to the agent until a label is applied', async t => {
  const { call, state, events } = await fixture(t);
  let currentPlace = { id: 'screen_1', slug: 'screen-1', label: 'Screen 1', needsLabel: true };
  state.execute = async args => {
    if (args.label) currentPlace = { ...currentPlace, slug: 'settings', label: args.label, needsLabel: false };
    return { status: 'known', summary: 'Current screen is known.', currentPlaceId: currentPlace.id, currentPlace };
  };
  for (const [tool, args] of [
    ['emulator_open', { packageName: 'com.example.app' }],
    ['emulator_app', { action: 'restart', packageName: 'com.example.app' }],
    ['emulator_observe', {}],
    ['emulator_tap', { text: 'Settings' }],
    ['emulator_navigate', { action: 'whereami' }],
  ]) {
    const response = await call('A', tool, args);
    assert.equal(response.ok, true);
    assert.match(response.result.text, /screen needs a descriptive name/);
    assert.match(response.result.text, /navigation tool/);
    const navigation = response.result.structuredContent.navigation ?? response.result.structuredContent.result;
    assert.equal(navigation.currentPlace.needsLabel, true);
  }
  const named = await call('A', 'emulator_navigate', { action: 'whereami', label: 'Settings' });
  assert.equal(named.ok, true);
  assert.equal(named.result.structuredContent.result.currentPlace.id, 'screen_1');
  assert.equal(named.result.structuredContent.result.currentPlace.label, 'Settings');
  assert.equal(events.at(-1).automatic, false, 'explicit labels must reach the native relabel path');
  assert.doesNotMatch(named.result.text, /needs a descriptive name/);
  const revisited = await call('A', 'emulator_observe');
  assert.doesNotMatch(revisited.result.text, /needs a descriptive name/);
});

test('shared-map writes serialize; queued cancellation does not unlock another active writer', { timeout: 10_000 }, async t => {
  const { call, state, events } = await fixture(t);
  const entered = deferred(); const release = deferred();
  state.execute = async args => { if (args.serial === 'owned-A') { entered.resolve(); await release.promise; } return { status: 'ok', currentPlaceId: 'home' }; };
  const first = call('A', 'emulator_tap', { text: 'Settings' }); await entered.promise;
  const second = call('B', 'emulator_tap', { text: 'Settings' });
  // Status becomes busy before B waits for the graph; no sleeps or timing assumptions.
  while (!(await call('B', 'emulator_navigate', { action: 'status' })).result.structuredContent.map.busy) {}
  assert.equal((await call('B', 'emulator_navigate', { action: 'cancel' })).ok, true);
  assert.equal((await second).ok, false);
  const third = call('C', 'emulator_tap', { text: 'Settings' });
  while (!(await call('C', 'emulator_navigate', { action: 'status' })).result.structuredContent.map.busy) {}
  assert.equal(events.filter(e => e.action === 'tap').length, 1);
  release.resolve(); assert.equal((await first).ok, true); assert.equal((await third).ok, true);
  assert.deepEqual(events.filter(e => e.action === 'tap').map(e => e.serial), ['owned-A', 'owned-C']);
});

test('active cancellation keeps input locked until the navigation process finishes cleanup', { timeout: 10_000 }, async t => {
  const { call, state } = await fixture(t);
  const entered = deferred(); const aborted = deferred(); const cleanup = deferred();
  state.execute = async (_args, { signal }) => {
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve(); await cleanup.promise; throw new Error('cancelled');
  };
  const action = call('A', 'emulator_tap', { text: 'Settings' }); await entered.promise;
  const cancel = call('A', 'emulator_navigate', { action: 'cancel' }); await aborted.promise;
  assert.equal((await call('A', 'emulator_key', { key: 'HOME' })).ok, false);
  cleanup.resolve(); assert.equal((await action).ok, false); assert.equal((await cancel).ok, true);
  assert.equal((await call('A', 'emulator_key', { key: 'HOME' })).ok, true);
});

test('automatic provider maps stay local, separate apps/projects, and reuse matching project graphs', async t => {
  const dir = temporary(t); const project = path.join(dir, 'project'); const state = path.join(dir, 'state'); fs.mkdirSync(project);
  const runCommand = async (file, args, options) => {
    if (args.includes('--version')) return { code: 0, stdout: file === 'android' ? '1.0.16500706' : 'minimap 0.2.1' };
    if (args[0] === 'init') {
      const pkg = args.find(s => s.startsWith('--package=')).slice(10);
      for (const folder of ['places', 'edges']) fs.mkdirSync(path.join(options.cwd, '.minimap/graph', folder), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, '.minimap/config.json'), JSON.stringify({ schema_version: 'minimap.config.v2', active_app_profile: 'default', app_profiles: { default: { android_package: pkg } } }));
      return { code: 0, stdout: '{"ok":true}' };
    }
    throw new Error('unexpected command');
  };
  const nav = createMinimapBackend({ stateDir: state, executable: 'minimap', environment: () => ({}), runCommand }).create();
  const first = await nav.prepare({ cwd: project, packageName: 'com.example.one' });
  const second = await nav.prepare({ cwd: project, packageName: 'com.example.two' });
  assert.notEqual(first.root, second.root); assert.equal(fs.existsSync(path.join(project, '.minimap')), false);
  assert.equal(nav.status(project, 'com.example.one').initialized, true);
  const other = path.join(dir, 'other'); fs.mkdirSync(other);
  assert.notEqual(nav.status(other, 'com.example.one').root, first.root);
  fs.cpSync(path.join(first.root, '.minimap'), path.join(project, '.minimap'), { recursive: true });
  assert.equal(nav.status(project, 'com.example.one').root, project);
  assert.equal(nav.status(project, 'com.example.two').root, second.root);
});

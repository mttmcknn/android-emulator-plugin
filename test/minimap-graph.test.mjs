import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createMinimapBackend, screenGraphProjection } from '../runtime/core/backends/minimap.mjs';
import { startDaemon } from '../runtime/core/daemon.mjs';
import { TOOLS } from '../runtime/core/tools.mjs';

const PRIVATE = 'private-graph-test-sentinel';
const projection = () => ({
  schema_version: 'minimap.screen-graph.v1',
  places: [{ id: 'p_search', label: 'Search', slug: 'search' }, { id: 'p_home', label: 'Home', slug: 'home' }],
  edges: [
    { id: 'forward', from: 'p_home', to: 'p_search', steps: 1, requiresHistory: false },
    { id: 'back', from: 'p_search', to: 'p_home', steps: 2, requiresHistory: true },
    { id: 'loop', from: 'p_home', to: 'p_home', steps: 1, requiresHistory: false },
    { id: 'dangling', from: 'p_home', to: 'missing', steps: 1, requiresHistory: false },
  ],
});

function directory(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-graph-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function savedGraph(root, packageName = 'com.example.app') {
  for (const folder of ['places', 'edges']) fs.mkdirSync(path.join(root, '.minimap/graph', folder), { recursive: true });
  fs.writeFileSync(path.join(root, '.minimap/config.json'), JSON.stringify({ schema_version: 'minimap.config.v2', active_app_profile: 'default', app_profiles: { default: { android_package: packageName } } }));
  const baseline = { identity_hash: PRIVATE, fingerprint: { selectors: [{ kind: 'text', value: PRIVATE }], static_text: [{ value: PRIVATE }], roles: {} } };
  fs.writeFileSync(path.join(root, '.minimap/graph/places/p_home.json'), JSON.stringify({ schema_version: 'minimap.place.v1', id: 'p_home', slug: 'home', label: 'Home', baseline, variants: [baseline] }));
}

function savedBytes(root) {
  const files = new Map();
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.set(path.relative(root, file), fs.readFileSync(file));
    }
  }
  visit(root);
  return files;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function mockRunner(calls, output = projection()) {
  return async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.join(' ') === 'graph --help') return { code: 0, stdout: 'Usage: minimap graph [OPTIONS]\n' };
    assert.deepEqual(args, ['graph'], 'a graph read must never issue Android or navigation actions');
    return { code: 0, stdout: JSON.stringify(output) };
  };
}

test('screen graph projection is a deterministic allowlist preserving direction, self-loops, and dangling IDs', () => {
  const input = projection();
  input.root = input.currentPlace = input.screenshot = PRIVATE;
  input.places.forEach(place => { place.baseline = place.variants = PRIVATE; });
  input.edges.forEach(edge => { edge.recipe = edge.intent = edge.selector = PRIVATE; });
  const result = screenGraphProjection(input);
  assert.deepEqual(Object.keys(result), ['schema_version', 'places', 'edges']);
  assert.deepEqual(result.places.map(place => place.id), ['p_home', 'p_search']);
  assert.deepEqual(result.edges.map(edge => edge.id), ['back', 'dangling', 'forward', 'loop']);
  assert.deepEqual(Object.keys(result.places[0]), ['id', 'label', 'slug']);
  assert.deepEqual(Object.keys(result.edges[0]), ['id', 'from', 'to', 'steps', 'requiresHistory']);
  assert.equal(result.edges[0].from, 'p_search'); assert.equal(result.edges[0].requiresHistory, true);
  assert.equal(result.edges[1].to, 'missing'); assert.equal(result.places.length, 2);
  assert.equal(result.edges[3].from, result.edges[3].to);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
  const reversed = { ...input, places: [...input.places].reverse(), edges: [...input.edges].reverse() };
  assert.deepEqual(screenGraphProjection(reversed), result);
  for (const change of [
    value => { value.schema_version = 'unknown'; },
    value => { value.places.push(value.places[0]); },
    value => { value.edges.push(value.edges[0]); },
    value => { value.edges[0].steps = -1; },
    value => { value.edges[0].steps = 1.5; },
    value => { value.edges[0].steps = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.edges[0].requiresHistory = 'true'; },
    value => { value.places[0].label = 'bad\nlabel'; },
    value => { value.places[0].id = 'x'.repeat(513); },
    value => { value.places = Array.from({ length: 2001 }, (_, index) => ({ id: `p${index}`, label: 'Screen', slug: 'screen' })); },
  ]) {
    const value = structuredClone(projection()); change(value);
    assert.throws(() => screenGraphProjection(value));
  }
});

test('saved route lengths are metadata, independent of the navigation action limit', () => {
  const value = projection();
  value.edges[0].steps = 0;
  value.edges[1].steps = 33;
  value.edges[2].steps = Number.MAX_SAFE_INTEGER;
  const result = screenGraphProjection(value);
  assert.equal(result.edges.find(edge => edge.id === 'forward').steps, 0);
  assert.equal(result.edges.find(edge => edge.id === 'back').steps, 33);
  assert.equal(result.edges.find(edge => edge.id === 'loop').steps, Number.MAX_SAFE_INTEGER);
});

test('graph export uses only the trusted root/executable and device-free graph commands', async t => {
  const root = directory(t); savedGraph(root);
  const nested = path.join(root, 'app'); fs.mkdirSync(nested);
  const before = savedBytes(root), calls = [], signal = new AbortController().signal;
  const raw = { ...projection(), root: PRIVATE, currentPlace: PRIVATE };
  raw.places[0].fingerprint = PRIVATE; raw.edges[0].recipe = PRIVATE;
  const nav = createMinimapBackend({ executable: '/trusted/minimap', environment: () => ({ PATH: 'trusted-path', ANDROID_SERIAL: 'must-not-forward' }), runCommand: mockRunner(calls, raw) }).create();
  const result = await nav.graph({ cwd: nested, packageName: 'com.example.app', serial: 'other-device', executable: '/untrusted' }, { signal });
  assert.equal(result.graphStatus.status, 'ok');
  assert.deepEqual(result.graph, screenGraphProjection(projection()));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, '/trusted/minimap'); assert.equal(call.options.cwd, root);
    assert.equal(call.options.signal, signal); assert.equal(call.options.timeoutMs, 5000);
    assert.equal(call.options.env.ANDROID_SERIAL, undefined);
    assert.ok(!call.args.includes('--serial'));
  }
  assert.deepEqual(savedBytes(root), before);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test('missing maps and unsafe graph paths never launch a CLI or create map state', async t => {
  const root = directory(t), calls = [];
  const nav = createMinimapBackend({ stateDir: path.join(root, 'state'), executable: '/trusted/minimap', environment: () => ({}), runCommand: mockRunner(calls) }).create();
  assert.equal((await nav.graph({ cwd: root, packageName: 'com.example.app' })).graphStatus.status, 'uninitialized');
  assert.equal(calls.length, 0); assert.deepEqual(fs.readdirSync(root), []);
  const elsewhere = directory(t); savedGraph(elsewhere);
  fs.symlinkSync(path.join(elsewhere, '.minimap'), path.join(root, '.minimap'));
  assert.equal((await nav.graph({ cwd: root })).graphStatus.status, 'error');
  fs.unlinkSync(path.join(root, '.minimap')); savedGraph(root);
  fs.rmSync(path.join(root, '.minimap/graph/places'), { recursive: true });
  fs.symlinkSync(path.join(elsewhere, '.minimap/graph/places'), path.join(root, '.minimap/graph/places'));
  assert.equal((await nav.graph({ cwd: root })).graphStatus.status, 'error');
  fs.unlinkSync(path.join(root, '.minimap/graph/places')); fs.mkdirSync(path.join(root, '.minimap/graph/places'));
  fs.symlinkSync(path.join(elsewhere, '.minimap/graph/places/p_home.json'), path.join(root, '.minimap/graph/places/p_home.json'));
  assert.equal((await nav.graph({ cwd: root })).graphStatus.status, 'error');
  assert.equal((await nav.graph({ cwd: 'untrusted-relative' })).graphStatus.status, 'error');
  assert.equal(calls.length, 0);
});

test('graph export reuses matching project maps and isolates automatic app/project stores', async t => {
  const root = directory(t), project = path.join(root, 'project'), other = path.join(root, 'other'), state = path.join(root, 'state');
  fs.mkdirSync(project); fs.mkdirSync(other); savedGraph(project, 'com.example.one');
  const calls = [], nav = createMinimapBackend({ stateDir: state, executable: '/trusted/minimap', environment: () => ({}), runCommand: mockRunner(calls) }).create();
  const privateRoot = nav.status(project, 'com.example.two').root;
  savedGraph(privateRoot, 'com.example.two');
  assert.equal((await nav.graph({ cwd: project, packageName: 'com.example.one' })).graphStatus.status, 'ok');
  assert.equal(calls[1].options.cwd, project);
  assert.equal((await nav.graph({ cwd: project, packageName: 'com.example.two' })).graphStatus.status, 'ok');
  assert.equal(calls[3].options.cwd, privateRoot);
  const untouched = nav.status(other, 'com.example.two').root;
  assert.equal((await nav.graph({ cwd: other, packageName: 'com.example.two' })).graphStatus.status, 'uninitialized');
  assert.equal(fs.existsSync(untouched), false); assert.equal(calls.length, 4);
  savedGraph(privateRoot, 'com.example.wrong');
  assert.equal((await nav.graph({ cwd: project, packageName: 'com.example.two' })).graphStatus.status, 'error');
  assert.equal(calls.length, 4);
  fs.rmSync(privateRoot, { recursive: true });
  fs.symlinkSync(project, privateRoot);
  assert.equal((await nav.graph({ cwd: project, packageName: 'com.example.two' })).graphStatus.status, 'error');
  assert.equal(calls.length, 4);
});

test('old CLI, malformed output, oversized output, launch failures, and aborts expose no private diagnostic text', async t => {
  const root = directory(t); savedGraph(root);
  let calls = 0;
  const old = createMinimapBackend({ environment: () => ({}), runCommand: async (_file, args) => {
    calls++; assert.deepEqual(args, ['graph', '--help']); return { code: 2, stdout: '' };
  } }).create();
  assert.equal((await old.graph({ cwd: root })).graphStatus.status, 'unsupported'); assert.equal(calls, 1);
  for (const response of [
    { code: 7, stdout: JSON.stringify({ summary: PRIVATE, root }) },
    { code: 0, stdout: PRIVATE },
    { code: 0, stdout: JSON.stringify({ ...projection(), schema_version: PRIVATE }) },
    { code: 0, stdout: 'x'.repeat(8 * 1024 * 1024 + 1) },
  ]) {
    const nav = createMinimapBackend({ environment: () => ({}), runCommand: async (_file, args) => args.includes('--help') ? { code: 0, stdout: 'Usage: minimap graph [OPTIONS]' } : response }).create();
    const result = await nav.graph({ cwd: root });
    assert.equal(result.graphStatus.status, 'error'); assert.equal(result.graph, null);
    assert.ok(!JSON.stringify(result).includes(PRIVATE)); assert.ok(!JSON.stringify(result).includes(root));
  }
  const unavailable = createMinimapBackend({ environment: () => ({}), runCommand: async () => { throw Object.assign(new Error(`${PRIVATE} ${root}`), { code: 'ENOENT' }); } }).create();
  assert.equal((await unavailable.graph({ cwd: root })).graphStatus.status, 'unavailable');
  const controller = new AbortController(); controller.abort(new Error(PRIVATE));
  calls = 0;
  const aborted = createMinimapBackend({ environment: () => ({}), runCommand: async () => { calls++; throw new Error('must not run'); } }).create();
  assert.equal((await aborted.graph({ cwd: root }, { signal: controller.signal })).graphStatus.status, 'error'); assert.equal(calls, 0);
});

test('a real local graph subprocess needs neither SDK resolution nor automatic dependency setup', async t => {
  const root = directory(t); savedGraph(root);
  const script = path.join(root, 'graph-cli.mjs'), log = path.join(root, 'calls.jsonl'), state = path.join(root, 'state');
  fs.writeFileSync(script, `#!${process.execPath}\nimport fs from 'node:fs'; const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,serial:process.env.ANDROID_SERIAL})+'\\n');if(args.join(' ')==='graph --help')process.stdout.write('Usage: minimap graph [OPTIONS]');else if(args.join(' ')==='graph')process.stdout.write(${JSON.stringify(JSON.stringify(projection()))});else process.exit(9);`, { mode: 0o700 });
  const nav = createMinimapBackend({ stateDir: state, executable: script, environment: () => ({ PATH: '', ANDROID_HOME: '/missing-test-sdk', ANDROID_SERIAL: 'must-ignore' }) }).create();
  assert.equal((await nav.graph({ cwd: root })).graphStatus.status, 'ok');
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [{ args: ['graph', '--help'] }, { args: ['graph'] }]);
  assert.equal(fs.existsSync(state), false, 'read-only graph export must not install dependencies or create state');
});

test('Codex forwards the existing trusted Minimap override without making it a tool argument', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../plugins/android-emulator-plugin/.mcp.json', import.meta.url), 'utf8'));
  assert.ok(config.mcpServers.emulator.env_vars.includes('ANDROID_EMULATOR_MINIMAP'));
  const schema = TOOLS.find(tool => tool.name === 'emulator_navigate').inputSchema;
  assert.equal(schema.properties.executable, undefined);
  assert.equal(schema.properties.cwd, undefined);
  assert.equal(schema.properties.serial, undefined);
});

class Leases extends EventEmitter {
  constructor() { super(); this.createdAvds = {}; this.leases = { A: { state: 'ready', serial: 'owned-A', kind: 'physical' }, B: { state: 'ready', serial: 'owned-B' } }; }
  get(id) { return this.leases[id]; }
  touch() {} async avds() { return []; } ownedAvds() { return []; } async sweep() {}
}

test('daemon graph API guards active host cwd/provider/device and remains passive during navigation', { timeout: 10_000 }, async t => {
  const root = directory(t), entered = deferred(), finish = deferred(), calls = [];
  const cwdA = path.join(root, 'project-a'), cwdB = path.join(root, 'project-b'); fs.mkdirSync(cwdA); fs.mkdirSync(cwdB);
  let keys = 0, observations = 0, preparations = 0, graphError = false, actionTesting = false, graphHold = null;
  const sessions = new Map([['A', { state: 'active', cwd: cwdA }], ['B', { state: 'active', cwd: cwdB }], ['archived', { state: 'archived', cwd: cwdA }]]);
  fs.writeFileSync(path.join(root, 'backends.json'), JSON.stringify({ A: { navigation: 'graph-provider', device: 'safe-device' }, B: { navigation: 'graph-provider', device: 'safe-device' } }));
  fs.writeFileSync(path.join(root, 'navigation-apps.json'), JSON.stringify({ A: { cwd: cwdA, packageName: 'com.example.one' }, B: { cwd: cwdB, packageName: 'com.example.two' } }));
  const provider = { id: 'graph-provider', version: 'test', probe: async () => ({ available: true }), create: () => ({
    status: cwd => ({ root: cwd, initialized: true, places: projection().places, edges: projection().edges }),
    ...(actionTesting ? {} : { prepare: async () => { preparations++; } }),
    graph: async args => { calls.push(args); if (graphError) throw new Error(`${PRIVATE} ${cwdA}`); if (graphHold) { graphHold.entered.resolve(); await graphHold.finish.promise; } return { graph: { ...projection(), root: PRIVATE }, graphStatus: { status: 'ok', message: PRIVATE }, privateResult: PRIVATE }; },
    execute: async args => {
      if (args.action === 'go') { entered.resolve(); await finish.promise; }
      return { status: 'known', currentPlaceId: 'p_home', summary: 'Located Home.' };
    },
  }) };
  const service = await startDaemon({ dir: root, providers: { navigation: [provider], device: [{ id: 'safe-device', version: 'test', create: () => ({ key: async () => { keys++; }, foregroundActivity: async () => { observations++; throw new Error('must not observe'); } }) }] }, createLeases: () => new Leases(),
    createConnectedDevices: () => ({ list: async () => { observations++; throw new Error('must not inspect attached devices for graph'); } }), readSessions: async () => sessions, log() {} });
  t.after(() => service.close());
  const token = fs.readFileSync(path.join(root, 'token'), 'utf8');
  const call = async (threadId, args) => (await fetch(`http://127.0.0.1:${service.port}/api/call`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ threadId, tool: 'emulator_navigate', args }) })).json();
  const result = await call('A', { action: 'graph', cwd: cwdB, packageName: 'com.untrusted.app', serial: 'owned-B', executable: PRIVATE });
  assert.equal(result.ok, true); assert.equal(result.result.structuredContent.graphStatus.status, 'ok');
  assert.deepEqual(calls[0], { cwd: cwdA, packageName: 'com.example.one' });
  assert.ok(!JSON.stringify(result).includes(PRIVATE)); assert.ok(!JSON.stringify(result).includes(cwdA));
  assert.deepEqual(Object.keys(result.result.structuredContent), ['graph', 'graphStatus']);
  assert.equal(observations, 0); assert.equal(keys, 0); assert.equal(preparations, 0);
  assert.equal((await call('A', { action: 'graph', deviceId: 'B' })).ok, false);
  assert.equal((await call('missing', { action: 'graph' })).ok, false);
  assert.equal((await call('archived', { action: 'graph' })).ok, false);
  assert.equal(calls.length, 1);
  actionTesting = true;
  await call('B', { action: 'whereami' });
  assert.equal((await call('B', { action: 'status' })).result.structuredContent.map.currentPlace, 'p_home');
  await call('B', { action: 'graph' });
  assert.deepEqual(calls[1], { cwd: cwdB, packageName: 'com.example.two' });
  assert.equal((await call('B', { action: 'status' })).result.structuredContent.map.currentPlace, 'p_home');
  const pending = call('B', { action: 'go', target: 'home' });
  await entered.promise;
  assert.equal((await call('B', { action: 'graph' })).result.structuredContent.graphStatus.status, 'ok');
  assert.equal((await call('B', { action: 'status' })).result.structuredContent.map.busy, true);
  finish.resolve(); assert.equal((await pending).ok, true);
  graphHold = { entered: deferred(), finish: deferred() };
  const heldRead = call('B', { action: 'graph' });
  await graphHold.entered.promise;
  const key = await fetch(`http://127.0.0.1:${service.port}/api/call`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'B', tool: 'emulator_key', args: { key: 'BACK' } }) });
  assert.equal((await key.json()).ok, true, 'a graph read must not hold the device input lock');
  assert.equal(keys, 1);
  graphHold.finish.resolve(); assert.equal((await heldRead).ok, true); graphHold = null;
  graphError = true;
  const failed = await call('B', { action: 'graph' });
  assert.equal(failed.ok, true); assert.equal(failed.result.structuredContent.graphStatus.status, 'error');
  assert.ok(!JSON.stringify(failed).includes(PRIVATE));
  assert.ok(!JSON.stringify(failed).includes(cwdA));
  const schema = TOOLS.find(tool => tool.name === 'emulator_navigate');
  assert.ok(schema.inputSchema.properties.action.enum.includes('graph'));
  for (const [file, type] of [['screen-graph.mjs', 'text/javascript'], ['screen-graph.css', 'text/css']]) {
    const response = await fetch(`http://127.0.0.1:${service.port}/static/${file}`);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), new RegExp(type));
    assert.ok((await response.text()).length > 0);
  }
});

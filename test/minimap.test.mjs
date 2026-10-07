import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createMinimapBackend, minimapRoot, readMinimap, runMinimap } from '../runtime/core/backends/minimap.mjs';
import { startDaemon } from '../runtime/core/daemon.mjs';

function directory(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-minimap-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function graph(root, packageName = 'com.example.test') {
  for (const folder of ['places', 'edges']) fs.mkdirSync(path.join(root, '.minimap/graph', folder), { recursive: true });
  fs.writeFileSync(path.join(root, '.minimap/config.json'), JSON.stringify({ schema_version: 'minimap.config.v2', active_app_profile: 'default', app_profiles: { default: { android_package: packageName } } }));
  fs.writeFileSync(path.join(root, '.minimap/graph/places/home.json'), JSON.stringify({ schema_version: 'minimap.place.v1', id: 'p_home', slug: 'home', label: 'Home', baseline: { privateScreenText: 'not panel metadata' } }));
}

test('Minimap resolves the trusted project at Git boundaries and exposes only graph summaries', t => {
  const root = directory(t);
  graph(root);
  const nested = path.join(root, 'app'); fs.mkdirSync(nested);
  assert.equal(minimapRoot(nested), root);
  fs.writeFileSync(path.join(root, '.minimap/graph/edges/back.json'), JSON.stringify({ schema_version: 'minimap.edge.v2', id: 'back', from: { id: 'p_home' }, to: { id: 'p_home' }, recipe: [{ kind: 'press_back' }] }));
  const map = readMinimap(nested);
  assert.equal(map.edges[0].requiresHistory, true);
  assert.equal(map.packageName, 'com.example.test');
  assert.deepEqual(map.places, [{ id: 'p_home', label: 'Home', slug: 'home' }]);
  assert.ok(!JSON.stringify(map).includes('privateScreenText'));
  fs.mkdirSync(path.join(nested, '.git'));
  assert.equal(minimapRoot(nested), nested);
  assert.equal(readMinimap(nested).initialized, false);
  assert.throws(() => minimapRoot('relative'), /host did not provide/);
  fs.symlinkSync(path.join(root, '.minimap'), path.join(nested, '.minimap'));
  assert.throws(() => readMinimap(nested), /symbolic link/);
  fs.unlinkSync(path.join(nested, '.minimap'));
  fs.mkdirSync(path.join(nested, '.minimap'));
  fs.symlinkSync(path.join(root, '.minimap/graph'), path.join(nested, '.minimap/graph'));
  assert.throws(() => readMinimap(nested), /inside this project/);
});

test('Minimap binds serial and cwd, forces fresh reads, retains meaningful nonzero outcomes, and never replays invalid output', async t => {
  const root = directory(t); graph(root);
  const calls = [];
  let output = { code: 5, stdout: JSON.stringify({ schema_version: 'minimap.result.v1', status: 'unknown', place: null }) };
  const provider = createMinimapBackend({ executable: '/trusted/minimap', environment: () => ({}), runCommand: async (file, args, options) => { calls.push({ file, args, options }); return output; } });
  const nav = provider.create();
  const result = await nav.execute({ cwd: root, serial: 'owned-A', action: 'whereami' });
  assert.equal(result.status, 'unknown'); assert.equal(result.exitCode, 5);
  assert.deepEqual(calls[0].args, ['--serial', 'owned-A', 'whereami', '--fresh']);
  assert.equal(calls[0].options.cwd, root);
  await nav.execute({ cwd: root, serial: 'owned-A', action: 'tap', selector: 'text=Search $(anything)', label: 'Search' });
  assert.deepEqual(calls[1].args.slice(2), ['tap', '--selector=text=Search $(anything)', '--label=Search']);
  await nav.execute({ cwd: root, serial: 'owned-A', action: 'go', target: 'p_home', expect: ['text=Home'] });
  assert.ok(calls[2].args.includes('--max-actions=32')); assert.ok(calls[2].args.includes('--recovery-seconds=60'));
  await assert.rejects(nav.execute({ cwd: root, serial: 'owned-A', action: 'go', target: '--serial=other' }), /target/);
  assert.equal(calls[2].args[3], 'home');
  await assert.rejects(nav.execute({ cwd: root, action: 'back' }), /running emulator/);
  assert.equal(calls.length, 3);
  output = { code: 0, stdout: 'not JSON' };
  await assert.rejects(nav.execute({ cwd: root, serial: 'owned-A', action: 'back' }), /invalid JSON/);
  assert.equal(calls.length, 4);
  output = { code: 0, stdout: JSON.stringify({ ok: true }) };
  const empty = directory(t);
  assert.equal((await nav.execute({ cwd: empty, action: 'init', packageName: 'com.example.app' })).status, 'ok');
  assert.deepEqual(calls[4].args, ['init', '--no-skills', '--package=com.example.app']);
  fs.rmSync(path.join(root, '.minimap/graph/edges'), { recursive: true });
  assert.match(nav.status(root).error, /screen map could not be read/);
  output = { code: 7, stdout: JSON.stringify({ status: 'config_error', summary: 'missing edges' }) };
  assert.equal((await nav.execute({ cwd: root, action: 'doctor' })).status, 'config_error');
  assert.deepEqual(calls[5].args, ['doctor', '--repo-only']);
  output = { code: 0, stdout: JSON.stringify({ ok: true }) };
  await nav.execute({ cwd: root, action: 'init', packageName: 'com.example.app' });
  assert.ok(calls[6].args.includes('--no-skills'));
});

test('cancellation kills an Android subprocess in its own process group before resolving', { timeout: 10_000 }, async t => {
  const root = directory(t);
  const script = path.join(root, 'minimap.mjs');
  const ready = path.join(root, 'ready');
  fs.writeFileSync(script, `import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.on('spawn',()=>fs.writeFileSync(${JSON.stringify(ready)},String(child.pid)));setInterval(()=>{},1000);`);
  const watcher = fs.watch(root);
  const signal = new AbortController();
  const result = runMinimap(process.execPath, [script], { signal: signal.signal });
  // Attach the rejection handler before aborting, and synchronize on child creation.
  const stopped = assert.rejects(result, /Navigation stopped/);
  try {
    await new Promise(resolve => { if (fs.existsSync(ready)) resolve(); else watcher.on('change', () => { if (fs.existsSync(ready)) resolve(); }); });
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    signal.abort(); await stopped;
    // A reparented child may briefly be a zombie; it must no longer be executable.
    const { stdout } = await runMinimap('/bin/ps', ['-p', String(pid), '-o', 'stat=']);
    assert.ok(!stdout.trim() || stdout.trim().startsWith('Z'), `Child still running: ${stdout}`);
  } finally { watcher.close(); signal.abort(); }
});

test('automatic naming handles pre-input and post-input needs_label without repeating a dispatched tap', async t => {
  const root = directory(t); graph(root);
  const calls = []; let attempts = 0, physicalTaps = 0;
  const nav = createMinimapBackend({ stateDir: path.join(root, 'state'), environment: () => ({}), runCommand: async (_file, args, options) => {
    calls.push({ args, session: options.env.TMPDIR });
    const action = args[2];
    if (action === 'tap') {
      attempts++;
      if (attempts === 1) return { code: 5, stdout: JSON.stringify({ status: 'needs_label', data: { orientation: {} } }) };
      physicalTaps++;
      return { code: 5, stdout: JSON.stringify({ status: 'needs_label', data: { source: 'source' } }) };
    }
    assert.equal(action, 'whereami');
    const label = args.find(arg => arg.startsWith('--label='))?.slice(8);
    if (!label) return { code: 5, stdout: JSON.stringify({ status: 'unknown' }) };
    const id = physicalTaps ? 'destination' : 'source';
    fs.writeFileSync(path.join(root, '.minimap/graph/places', `${id}.json`), JSON.stringify({ schema_version: 'minimap.place.v1', id, slug: id, label }));
    return { code: 0, stdout: JSON.stringify({ status: 'ok', data: { place: id } }) };
  } }).create();
  const result = await nav.execute({ cwd: root, packageName: 'com.example.test', serial: 'owned-A', action: 'tap', selector: 'text=Next', automatic: true });
  assert.equal(result.currentPlaceId, 'destination'); assert.equal(physicalTaps, 1); assert.equal(attempts, 2);
  assert.equal(new Set(calls.map(call => call.session)).size, 1);
  assert.equal(fs.existsSync(calls[0].session), false, 'pending recipes must not survive a separate raw/manual action');
  assert.deepEqual(nav.status(root).places.filter(p => p.id !== 'p_home').map(p => p.label).sort(), ['Screen 2', 'Screen 3']);
});

class Leases extends EventEmitter {
  constructor() { super(); this.createdAvds = {}; this.leases = { A: { state: 'ready', avd: 'Test', serial: 'owned-A' }, B: { state: 'ready', avd: 'Test', serial: 'owned-B' } }; }
  get(id) { return this.leases[id]; }
  touch() {} async avds() { return []; } ownedAvds() { return []; } async sweep() {}
}

test('daemon binds navigation to trusted project/device, allows cancellation, rejects interleaved input, and isolates other sessions', { timeout: 10_000 }, async t => {
  const root = directory(t); let enter; const entered = new Promise(resolve => { enter = resolve; }); const calls = []; let keys = 0;
  const provider = { id: 'fake-map', version: 'test', probe: async () => ({ available: true }), create: () => ({
    status: cwd => ({ root: cwd, places: [], edges: [] }),
    execute: (args, { signal }) => new Promise((resolve, reject) => {
      calls.push(args); enter();
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
  }) };
  fs.writeFileSync(path.join(root, 'backends.json'), JSON.stringify({ A: { navigation: 'fake-map', device: 'fake-device' }, B: { navigation: 'fake-map', device: 'fake-device' } }));
  const service = await startDaemon({ dir: root, providers: { navigation: [provider], device: [{ id: 'fake-device', version: 'test', create: () => ({ key: async () => { keys++; } }) }] }, createLeases: () => new Leases(), readSessions: async () => new Map([['A', { state: 'active', cwd: '/trusted/A' }], ['B', { state: 'active', cwd: '/trusted/B' }]]), log() {} });
  t.after(() => service.close());
  const token = fs.readFileSync(path.join(root, 'token'), 'utf8');
  const call = async (threadId, tool, args) => (await fetch(`http://127.0.0.1:${service.port}/api/call`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ threadId, tool, args }) })).json();
  const pending = call('A', 'emulator_navigate', { action: 'go', target: 'home', cwd: '/untrusted', serial: 'owned-B' });
  await entered;
  assert.equal(calls[0].cwd, '/trusted/A'); assert.equal(calls[0].serial, 'owned-A');
  assert.equal((await call('A', 'emulator_navigate', { action: 'status' })).result.structuredContent.map.busy, true);
  assert.equal((await call('B', 'emulator_navigate', { action: 'status' })).result.structuredContent.map.root, '/trusted/B');
  assert.equal((await call('A', 'emulator_key', { key: 'BACK' })).ok, false);
  assert.equal((await call('B', 'emulator_key', { key: 'BACK' })).ok, true); assert.equal(keys, 1);
  assert.equal((await call('A', 'emulator_navigate', { action: 'cancel' })).ok, true);
  assert.equal((await pending).ok, false);
  assert.equal((await call('A', 'emulator_key', { key: 'BACK' })).ok, true); assert.equal(keys, 2);
  assert.equal((await call('missing', 'emulator_navigate', { action: 'status' })).ok, false);
});

test('Minimap rejects the released foreground bug and caches compatible dependency probes', async () => {
  const environment = () => ({});
  const calls = [];
  const old = createMinimapBackend({ environment, runCommand: async (_file, args) => { calls.push(args); return { code: 0, stdout: 'minimap 0.2.0' }; } });
  assert.equal((await old.probe()).available, false);
  assert.equal(calls.length, 1);
  const current = createMinimapBackend({ environment, runCommand: async file => { calls.push(file); return { code: 0, stdout: file === 'android' ? '1.0.16406183' : 'minimap 0.2.1' }; } });
  const [a, b] = await Promise.all([current.probe(), current.probe()]);
  assert.equal(a.available, true); assert.equal(b.version, '0.2.1');
  assert.equal(calls.length, 3);
});

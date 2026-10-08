import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { createNavigationDependencies } from '../runtime/core/backends/navigation-dependencies.mjs';

function tarFile(name, contents) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write('0000700\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(0x20, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  const sum = [...header].reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, contents, Buffer.alloc((512 - contents.length % 512) % 512), Buffer.alloc(1024)]));
}

function response(bytes) {
  return { ok: true, status: 200, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes };
}

function manifestFor(minimap, android, minimapChecksum = createHash('sha256').update(minimap).digest('hex')) {
  return {
    minimap: { version: '0.2.1', platforms: { 'linux-x64': { url: 'https://example.invalid/minimap', sha256: minimapChecksum } } },
    android: { platforms: { 'linux-x64': { url: 'https://example.invalid/android', sha256: createHash('sha256').update(android).digest('hex') } } },
  };
}

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'navigation-dependencies-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function runner(versions) {
  return async file => ({ code: 0, stdout: versions.get(file) ?? (file.includes('minimap') ? 'minimap 0.2.1' : '1.0.16406183') });
}

test('probe does not download missing dependencies', async t => {
  const dir = await temp(t); let downloads = 0;
  const dependencies = createNavigationDependencies({
    dir, home: path.join(dir, 'home'), platform: 'linux', arch: 'x64', environment: { PATH: '' },
    fetchImpl: async () => { downloads++; throw new Error('unexpected download'); },
  });
  const status = await dependencies.probe();
  assert.equal(status.available, false);
  assert.equal(downloads, 0);
});

test('probe only locates an installed override and never starts Android CLI', async t => {
  const dir = await temp(t); const minimap = path.join(dir, 'minimap'); const android = path.join(dir, 'android');
  await fs.writeFile(minimap, 'x', { mode: 0o700 }); await fs.writeFile(android, 'x', { mode: 0o700 });
  let runs = 0;
  const dependencies = createNavigationDependencies({
    dir, platform: 'linux', arch: 'x64', environment: { PATH: '', ANDROID_EMULATOR_MINIMAP: minimap, ANDROID_EMULATOR_ANDROID_CLI: android },
    runCommand: async () => { runs++; throw new Error('unexpected process'); },
  });
  const status = await dependencies.probe();
  assert.equal(status.available, true);
  assert.equal(runs, 0);
});

test('checksum failure leaves no managed cache entry', async t => {
  const dir = await temp(t); const minimap = tarFile('minimap', Buffer.from('minimap'));
  const dependencies = createNavigationDependencies({
    dir, home: path.join(dir, 'home'), platform: 'linux', arch: 'x64', environment: { PATH: '' },
    manifest: manifestFor(minimap, Buffer.from('android'), '0'.repeat(64)), fetchImpl: async () => response(minimap), runCommand: runner(new Map()),
  });
  await assert.rejects(dependencies.ensure(), /checksum verification failed/);
  await assert.rejects(fs.access(path.join(dir, 'navigation-dependencies/minimap/0.2.1/linux-x64/minimap')));
});

test('cancelled installs are atomic and a later explicit retry succeeds', async t => {
  const dir = await temp(t); const minimap = tarFile('bin/minimap', Buffer.from('minimap'));
  const android = Buffer.from('android'); const manifest = manifestFor(minimap, android);
  let cancelled = true; let downloads = 0; let started;
  const startedDownload = new Promise(resolve => { started = resolve; });
  const dependencies = createNavigationDependencies({
    dir, home: path.join(dir, 'home'), platform: 'linux', arch: 'x64', environment: { PATH: '' }, manifest, runCommand: runner(new Map()),
    fetchImpl: async (_url, { signal }) => {
      downloads++;
      if (cancelled) {
        started();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      }
      return response(downloads === 2 ? minimap : android);
    },
  });
  const controller = new AbortController();
  const pending = dependencies.ensure({ signal: controller.signal });
  await startedDownload;
  controller.abort();
  await assert.rejects(pending);
  await assert.rejects(fs.access(path.join(dir, 'navigation-dependencies/minimap/0.2.1/linux-x64/minimap')));
  cancelled = false;
  const ensured = await dependencies.ensure();
  assert.match(ensured.env.PATH, /navigation-dependencies\/bin/);
  assert.ok(await fs.stat(ensured.minimap));
  assert.ok(await fs.stat(ensured.android));
  const notices = path.join(path.dirname(ensured.minimap), 'LICENSES.txt');
  assert.deepEqual(await fs.readFile(notices), await fs.readFile(new URL('../runtime/core/vendor/MINIMAP-LICENSES.txt', import.meta.url)));
  assert.equal((await fs.stat(notices)).mode & 0o777, 0o600);
  const rustNotices = path.join(path.dirname(ensured.minimap), 'MINIMAP-RUST-COPYRIGHT-library.html');
  assert.deepEqual(await fs.readFile(rustNotices), await fs.readFile(new URL('../runtime/core/vendor/MINIMAP-RUST-COPYRIGHT-library.html', import.meta.url)));
  assert.equal((await fs.stat(rustNotices)).mode & 0o777, 0o600);
});

test('concurrent explicit installs share one download sequence', async t => {
  const dir = await temp(t); const minimap = tarFile('minimap', Buffer.from('minimap'));
  const android = Buffer.from('android'); let downloads = 0; let release;
  const firstDownload = new Promise(resolve => { release = resolve; });
  const dependencies = createNavigationDependencies({
    dir, home: path.join(dir, 'home'), platform: 'linux', arch: 'x64', environment: { PATH: '' },
    manifest: manifestFor(minimap, android), runCommand: runner(new Map()),
    fetchImpl: async (_url) => {
      const download = ++downloads;
      if (download === 1) await firstDownload;
      return response(download === 1 ? minimap : android);
    },
  });
  const one = dependencies.ensure(); const two = dependencies.ensure();
  assert.strictEqual(one, two);
  release();
  await one;
  assert.equal(downloads, 2);
});

test('existing explicit overrides are reused and incompatible overrides are never replaced', async t => {
  const dir = await temp(t); const minimap = path.join(dir, 'custom-minimap'); const android = path.join(dir, 'custom-android');
  await fs.writeFile(minimap, 'x', { mode: 0o700 }); await fs.writeFile(android, 'x', { mode: 0o700 });
  let downloads = 0;
  const dependencies = createNavigationDependencies({
    dir, platform: 'linux', arch: 'x64', environment: { PATH: '', ANDROID_EMULATOR_MINIMAP: minimap, ANDROID_EMULATOR_ANDROID_CLI: android },
    fetchImpl: async () => { downloads++; throw new Error('unexpected'); }, runCommand: runner(new Map([[minimap, 'minimap 0.2.1'], [android, '1.0.16406183']])),
  });
  const ensured = await dependencies.ensure();
  assert.equal(ensured.minimap, minimap); assert.equal(ensured.android, android); assert.equal(downloads, 0);
  assert.deepEqual(ensured.versions, { minimap: 'minimap 0.2.1', android: '1.0.16406183' });
  const unsupported = createNavigationDependencies({
    dir, platform: 'linux', arch: 'x64', environment: { PATH: '', ANDROID_EMULATOR_MINIMAP: minimap, ANDROID_EMULATOR_ANDROID_CLI: android },
    fetchImpl: async () => { downloads++; throw new Error('unexpected'); }, runCommand: runner(new Map([[minimap, 'minimap 0.2.0'], [android, '1.0.16406183']])),
  });
  await assert.rejects(unsupported.ensure(), /will not be replaced automatically/);
  assert.equal(downloads, 0);
});

test('an incompatible PATH installation is replaced locally and the managed version wins on restart', async t => {
  const dir = await temp(t); const bin = path.join(dir, 'bin'); await fs.mkdir(bin);
  const old = path.join(bin, 'minimap'); const android = path.join(bin, 'android');
  await fs.writeFile(old, 'minimap', { mode: 0o700 }); await fs.writeFile(android, 'android', { mode: 0o700 });
  const archive = tarFile('minimap', Buffer.from('new-minimap')); let downloads = 0;
  const options = { dir, home: path.join(dir, 'home'), platform: 'linux', arch: 'x64', environment: { PATH: bin },
    manifest: manifestFor(archive, Buffer.from('android')),
    fetchImpl: async () => { downloads++; return response(archive); },
    runCommand: runner(new Map([[old, 'minimap 0.2.0']])),
  };
  const first = await createNavigationDependencies(options).ensure();
  assert.notEqual(first.minimap, old); assert.equal(downloads, 1);
  const notices = path.join(path.dirname(first.minimap), 'LICENSES.txt');
  const rustNotices = path.join(path.dirname(first.minimap), 'MINIMAP-RUST-COPYRIGHT-library.html');
  await fs.rm(notices);
  await fs.rm(rustNotices);
  const restarted = await createNavigationDependencies(options).ensure();
  assert.equal(restarted.minimap, first.minimap); assert.equal(downloads, 1);
  assert.equal(await fs.readFile(old, 'utf8'), 'minimap');
  assert.deepEqual(await fs.readFile(notices), await fs.readFile(new URL('../runtime/core/vendor/MINIMAP-LICENSES.txt', import.meta.url)), 'older managed caches gain notices without redownloading');
  assert.deepEqual(await fs.readFile(rustNotices), await fs.readFile(new URL('../runtime/core/vendor/MINIMAP-RUST-COPYRIGHT-library.html', import.meta.url)), 'older managed caches gain Rust notices without redownloading');
});

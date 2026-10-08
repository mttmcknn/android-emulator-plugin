import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { retainRuntime } from '../runtime/mcp/runtime-copy.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(repo, 'plugins', 'android-emulator-plugin');
const runtimeCopyModule = pathToFileURL(path.join(plugin, 'runtime', 'mcp', 'runtime-copy.mjs')).href;

function fixture(root) {
  const source = path.join(root, 'plugin-cache');
  fs.cpSync(path.join(plugin, 'runtime'), source, { recursive: true });
  return source;
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emulator-plugin-runtime-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString());
      else reject(new Error(`Child exited ${code}: ${Buffer.concat(stderr).toString()}`));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for retained helper.');
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

test('retainRuntime preserves a complete helper bundle after its throwaway source is removed', async (t) => {
  const root = temporaryRoot(t);
  const source = fixture(root);
  const state = path.join(root, 'state');
  const retained = retainRuntime(source, state);
  for (const relative of [
    'LICENSE',
    'NOTICE',
    'hosts/codex/daemon.mjs',
    'core/lib/device.mjs',
    'core/web/index.html',
    'core/web/app.js',
    'core/vendor/scrcpy-server-v5.0.1',
    'core/vendor/SCRCPY-LICENSE',
    'core/vendor/SCRCPY-NOTICES.md',
    'core/vendor/KOTLIN-LICENSE',
    'core/vendor/KOTLIN-BOOST-LICENSE',
    'core/vendor/KOTLIN-THREETENBP-LICENSE',
    'core/vendor/MINIMAP-LICENSES.txt',
    'core/package.json',
  ]) assert.ok(fs.statSync(path.join(retained, relative)).isFile(), relative);

  const retainedApp = fs.readFileSync(path.join(retained, 'core', 'web', 'app.js'), 'utf8');
  fs.rmSync(source, { recursive: true, force: true });
  assert.match(retainedApp, /function/);

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(retained, 'hosts', 'codex', 'daemon.mjs')], {
    env: {
      ...process.env,
      EMULATOR_FOR_CODEX_STATE_DIR: state,
      EMULATOR_FOR_CODEX_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  t.after(() => stop(child));
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.ok;
    } catch {
      return false;
    }
  });
  const staticAsset = await fetch(`http://127.0.0.1:${port}/static/app.js`);
  assert.equal(staticAsset.status, 200);
  assert.equal(await staticAsset.text(), retainedApp);
});

test('retainRuntime hashes bytes, reuses identical bundles, and is safe across concurrent callers', async (t) => {
  const root = temporaryRoot(t);
  const source = fixture(root);
  const state = path.join(root, 'state');
  const first = retainRuntime(source, state);
  assert.equal(retainRuntime(source, state), first);

  const app = path.join(source, 'core', 'web', 'app.js');
  fs.appendFileSync(app, '\n// different retained runtime bytes\n');
  const changed = retainRuntime(source, state);
  assert.notEqual(changed, first);
  assert.match(fs.readFileSync(path.join(changed, 'core', 'web', 'app.js'), 'utf8'), /different retained runtime bytes/);
  assert.doesNotMatch(fs.readFileSync(path.join(first, 'core', 'web', 'app.js'), 'utf8'), /different retained runtime bytes/);

  const concurrentState = path.join(root, 'concurrent-state');
  const script = 'import(process.argv[1]).then(({ retainRuntime }) => process.stdout.write(retainRuntime(process.argv[2], process.argv[3])));';
  const outputs = await Promise.all(Array.from({ length: 6 }, () => runNode(['-e', script, runtimeCopyModule, source, concurrentState])));
  const concurrent = outputs.map((value) => value.trim());
  assert.equal(new Set(concurrent).size, 1);
  assert.equal(retainRuntime(source, concurrentState), concurrent[0]);
  assert.deepEqual(fs.readdirSync(path.join(concurrentState, 'runtimes')).filter((name) => name.startsWith('.prepare-')), []);
});

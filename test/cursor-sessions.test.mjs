import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionReader, registerSession, resolveWorkspace, sessionIdFor } from '../runtime/hosts/cursor/sessions.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aep-cursor-'));

test('uses the expanded workspace folder and ignores an unexpanded placeholder', () => {
  assert.equal(resolveWorkspace({ env: { EMULATOR_WORKSPACE: '/projects/app' }, cwd: '/elsewhere' }), '/projects/app');
  assert.equal(resolveWorkspace({ env: { EMULATOR_WORKSPACE: '${workspaceFolder}' }, cwd: '/projects/fallback' }), '/projects/fallback');
  assert.equal(resolveWorkspace({ env: {}, cwd: os.homedir() }), null);
});

test('falls back to the first file root reported over MCP roots/list before the process cwd', () => {
  const roots = [{ uri: 'https://example.com/repo' }, { uri: 'file:///projects/from%20roots', name: 'app' }];
  assert.equal(resolveWorkspace({ env: {}, roots, cwd: os.homedir() }), '/projects/from roots');
  assert.equal(resolveWorkspace({ env: { EMULATOR_WORKSPACE: '/projects/app' }, roots, cwd: os.homedir() }), '/projects/app');
});

test('derives a stable UUID-shaped session per workspace', () => {
  const id = sessionIdFor('/projects/app');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(sessionIdFor('/projects/app'), id);
  assert.notEqual(sessionIdFor('/projects/other'), id);
});

test('reports a registered session as active with its workspace for navigation memory', async () => {
  const dir = tempDir();
  const id = sessionIdFor('/projects/app');
  const stop = registerSession(dir, id, '/projects/app', 4242);
  stop();
  const states = await createSessionReader(dir)([id, sessionIdFor('/projects/unknown'), 'not-a-session']);
  assert.deepEqual(Object.fromEntries(states), { [id]: { state: 'active', title: 'app', cwd: '/projects/app' } });
});

test('marks a session missing once its process is gone and its heartbeat is stale, and prunes the heartbeat', async () => {
  const dir = tempDir();
  const id = sessionIdFor('/projects/app');
  registerSession(dir, id, '/projects/app', 4242)();
  const later = () => Date.now() + 6 * 60_000;
  const states = await createSessionReader(dir, { now: later, alive: () => false })([id]);
  assert.equal(states.get(id).state, 'missing');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sessions', id)), ['info.json']);
});

test('keeps a session active while its process runs even if the heartbeat went stale during sleep', async () => {
  const dir = tempDir();
  const id = sessionIdFor('/projects/app');
  registerSession(dir, id, '/projects/app', 4242)();
  const later = () => Date.now() + 60 * 60_000;
  const states = await createSessionReader(dir, { now: later, alive: pid => pid === 4242 })([id]);
  assert.equal(states.get(id).state, 'active');
});

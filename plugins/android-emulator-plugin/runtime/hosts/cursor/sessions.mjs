// Cursor does not tell MCP servers which chat made a call, so a session is the workspace of the Cursor
// window that started this MCP process. Every chat in that window shares one emulator.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEARTBEAT_MS = 30_000;
const STALE_MS = 5 * 60_000;

const sessionsDir = (dir) => path.join(dir, 'sessions');

// Prefers an expanded EMULATOR_WORKSPACE (project mcp.json), then the first file root the client reports
// over MCP roots/list, then the process cwd. A home or filesystem-root cwd means no project is known.
export function resolveWorkspace({ env = process.env, roots = [], cwd = process.cwd() } = {}) {
  const configured = env.EMULATOR_WORKSPACE;
  if (configured && !configured.includes('${') && path.isAbsolute(configured)) return path.resolve(configured);
  const root = roots.find(({ uri }) => typeof uri === 'string' && uri.startsWith('file://'));
  if (root) return fileURLToPath(root.uri);
  const fallback = path.resolve(cwd);
  return fallback === os.homedir() || fallback === path.parse(fallback).root ? null : fallback;
}

export function sessionIdFor(workspace) {
  const hex = crypto.createHash('sha256').update(`cursor:${workspace ?? '<no-workspace>'}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Records the workspace and keeps a per-process heartbeat so the helper can tell when the window is gone.
export function registerSession(dir, sessionId, workspace, pid = process.pid) {
  const folder = path.join(sessionsDir(dir), sessionId);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, 'info.json'), JSON.stringify({ cwd: workspace, title: workspace ? path.basename(workspace) : 'Cursor' }), { mode: 0o600 });
  const beat = path.join(folder, `${pid}.pid`);
  const touch = () => fs.writeFileSync(beat, String(Date.now()), { mode: 0o600 });
  touch();
  const timer = setInterval(touch, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A session is active while its MCP process runs, or for STALE_MS after its last heartbeat so a window
// reload never looks like a closed window. Heartbeat age alone is not enough: timers stop during sleep.
// Returns Map<sessionId, { state: 'active' | 'missing', title, cwd }>. Unknown sessions are omitted.
export function createSessionReader(dir, { now = () => Date.now(), alive = processAlive } = {}) {
  return async (sessionIds) => {
    const states = new Map();
    for (const id of new Set(sessionIds)) {
      if (!SESSION_ID.test(id)) continue;
      const folder = path.join(sessionsDir(dir), id);
      let info;
      try {
        info = JSON.parse(fs.readFileSync(path.join(folder, 'info.json'), 'utf8'));
      } catch {
        continue;
      }
      let active = false;
      for (const name of fs.readdirSync(folder)) {
        const pid = Number(name.match(/^(\d+)\.pid$/)?.[1]);
        if (!pid) continue;
        const file = path.join(folder, name);
        if (alive(pid) || now() - fs.statSync(file).mtimeMs < STALE_MS) active = true;
        else fs.rmSync(file, { force: true });
      }
      states.set(id, { state: active ? 'active' : 'missing', title: info.title ?? null, cwd: info.cwd ?? null });
    }
    return states;
  };
}

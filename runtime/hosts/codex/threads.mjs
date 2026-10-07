// Reads Codex's local thread state so emulators can be cleaned up after a thread is archived or deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../core/lib/sdk.mjs';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function stateDatabase() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  if (!fs.existsSync(home)) return null;
  const [latest] = fs
    .readdirSync(home)
    .map((name) => name.match(/^state_(\d+)\.sqlite$/))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return latest ? path.join(home, latest[0]) : null;
}

// Returns Map<threadId, { state: 'active' | 'archived' | 'missing', title, cwd }>. Threads that cannot be checked are omitted.
export async function threadInfo(threadIds) {
  const ids = [...new Set(threadIds)].filter((id) => THREAD_ID.test(id));
  const database = stateDatabase();
  const states = new Map();
  if (!ids.length || !database) return states;
  const query = `select id, archived, cwd, coalesce(nullif(name, ''), title) as title from threads where id in (${ids.map((id) => `'${id}'`).join(',')});`;
  const result = await run('sqlite3', ['-readonly', '-json', database, query], { timeoutMs: 10_000 }).catch(() => null);
  if (result?.code !== 0) return states;
  const rows = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.id === id);
    states.set(id, { state: !row ? 'missing' : row.archived ? 'archived' : 'active', title: row?.title || null, cwd: row?.cwd || null });
  }
  return states;
}

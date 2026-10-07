import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-codex-'));
const active = '01a0eeff-bbae-76c3-853f-98e62c3b18f9';
const archived = '019fb5fe-3dc5-7372-9def-9aca0bfb9fc4';
const missing = '00000000-0000-0000-0000-000000000000';
execFileSync('sqlite3', [
  path.join(home, 'state_5.sqlite'),
  `create table threads (id text primary key, archived integer, title text, name text, cwd text); insert into threads values ('${active}', 0, 'Fix login', '', '/projects/login'), ('${archived}', 1, 'Old work', 'Renamed', '/projects/old');`,
]);
fs.writeFileSync(path.join(home, 'state_4.sqlite'), '');
process.env.CODEX_HOME = home;
const { threadInfo } = await import('../runtime/hosts/codex/threads.mjs');

test('reads thread state and display titles from the newest Codex state database', async () => {
  const states = await threadInfo([active, archived, missing, "x' or 1=1 --"]);
  assert.deepEqual(Object.fromEntries(states), {
    [active]: { state: 'active', title: 'Fix login', cwd: '/projects/login' },
    [archived]: { state: 'archived', title: 'Renamed', cwd: '/projects/old' },
    [missing]: { state: 'missing', title: null, cwd: null },
  });
});

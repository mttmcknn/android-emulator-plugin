import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WINDOW_MS = 24 * 60 * 60_000;
const TAIL_BYTES = 1024 * 1024;
const MAX_FILES = 3;
const MAX_EVENTS = 5;
const UUID = /^[a-f0-9-]{36}$/i;

// Only structured, allowlisted fields leave this module. Never return raw log lines,
// error messages/stacks, URLs, sandbox IDs, or another chat's identity.
export function parseHostFailures(chunks, { now, threadId }) {
  const records = [];
  const owners = new Map();
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      const event = line.match(/\bmcp_app_sandbox\.(sandbox_requested|render_process_gone|init_failed)\b/)?.[1];
      if (!event) continue;
      const stamp = line.match(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/)?.[0];
      const time = Date.parse(stamp);
      if (!Number.isFinite(time) || time < now - WINDOW_MS || time > now) continue;
      const field = (name) => line.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`))?.[1];
      const init = field('initId');
      if (!UUID.test(init ?? '')) continue;
      const server = field('server');
      const thread = field('threadId');
      const owner = owners.get(init) ?? {};
      if (server) owner.server = server;
      if (thread) owner.thread = thread;
      owners.set(init, owner);
      if (event === 'sandbox_requested') continue;
      const reason = field('reason');
      if (event === 'render_process_gone' && reason === 'clean-exit') continue;
      const exit = field('exitCode');
      records.push({ init, time, event,
        reason: ['launch-failed', 'crashed', 'killed', 'oom', 'abnormal-exit', 'integrity-failure'].includes(reason) ? reason : 'unknown',
        exitCode: /^-?\d{1,10}$/.test(exit ?? '') ? Number(exit) : null,
        handshake: field('stage') === 'handshake',
      });
    }
  }
  const seen = new Set();
  const events = [];
  for (const record of records.sort((a, b) => b.time - a.time)) {
    const owner = owners.get(record.init);
    if (owner.server !== 'emulator' || (owner.thread && owner.thread !== threadId)) continue;
    const code = record.event === 'render_process_gone' ? 'AE_HOST_RENDERER' : record.handshake ? 'AE_HOST_HANDSHAKE' : 'AE_HOST_PANEL_INIT';
    const key = `${record.init}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ time: new Date(record.time).toISOString(), code,
      scope: owner.thread ? 'this_chat' : 'host_unattributed',
      ...(record.event === 'render_process_gone' ? { reason: record.reason, exitCode: record.exitCode } : {}),
    });
  }
  return { events: events.slice(0, MAX_EVENTS), omittedEvents: Math.max(0, events.length - MAX_EVENTS) };
}

// Read only recent macOS log tails. Missing logs or an unknown host format are not
// evidence of a healthy panel, and host-wide events are never assigned to a chat.
export async function hostDiagnostics({ now = Date.now(), threadId, platform = process.platform,
  root = path.join(os.homedir(), 'Library', 'Logs', 'com.openai.codex') } = {}) {
  const result = { status: 'unavailable', windowHours: 24, filesRead: 0, filesSkipped: 0, tailLimited: false, fileLimitReached: false, events: [], omittedEvents: 0 };
  if (platform !== 'darwin') return { ...result, status: 'unsupported' };
  const folders = new Set([now, now - WINDOW_MS].map(time => {
    const date = new Date(time);
    return path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  }));
  const files = [];
  for (const folder of folders) {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/^codex-desktop-.*\.log$/.test(entry.name)) continue;
      const file = path.join(folder, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.mtimeMs >= now - WINDOW_MS) files.push({ file, modified: stat.mtimeMs });
    }
  }
  const chunks = [];
  for (const { file } of files.sort((a, b) => b.modified - a.modified).slice(0, MAX_FILES)) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let chunk = buffer.toString('utf8', 0, bytesRead);
      if (start > 0) chunk = chunk.slice(chunk.indexOf('\n') + 1);
      chunks.push(chunk);
      result.tailLimited ||= start > 0;
    } catch { result.filesSkipped += 1; }
    finally { await handle?.close(); }
  }
  return { ...result, status: chunks.length ? 'checked' : 'unavailable', filesRead: chunks.length,
    fileLimitReached: files.length > MAX_FILES, ...parseHostFailures(chunks, { now, threadId }) };
}

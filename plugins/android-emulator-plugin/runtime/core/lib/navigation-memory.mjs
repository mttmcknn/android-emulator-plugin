import fs from 'node:fs';
import path from 'node:path';

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

// Package selection is local session state, never an agent-supplied cwd or serial.
// The provider owns map storage and format; this layer only associates a project
// with the app being used and reports optional learning failures.
export class NavigationMemory {
  constructor({ dir, readSessions, backends }) {
    this.file = path.join(dir, 'navigation-apps.json');
    this.readSessions = readSessions;
    this.backends = backends;
    this.learning = new Map();
    try { this.apps = new Map(Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.apps = new Map(); }
  }

  async context(threadId) {
    const session = (await this.readSessions([threadId])).get(threadId);
    if (!session?.cwd || session.state !== 'active') throw new Error('Open this chat in an app project to remember screens.');
    const saved = this.apps.get(threadId);
    if (saved && saved.cwd !== session.cwd) this.learning.delete(threadId);
    const packageName = saved?.cwd === session.cwd ? saved.packageName : undefined;
    const provider = this.backends.get(threadId, 'navigation');
    return { cwd: session.cwd, packageName, provider, navigator: provider.create() };
  }

  select(threadId, context, packageName) {
    if (!PACKAGE.test(packageName ?? '')) throw new Error('Could not identify the app package. Open the intended app and try again.');
    if (context.packageName === packageName) return context;
    const next = new Map(this.apps);
    next.set(threadId, { cwd: context.cwd, packageName });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(next)), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.apps = next;
    this.learning.delete(threadId);
    return { ...context, packageName };
  }

  async status(threadId, context) {
    const { cwd, packageName, navigator, provider } = context;
    const map = await navigator.status(cwd, packageName);
    const availability = await this.backends.probe('navigation', provider);
    return { ...map, availability, learning: this.learning.get(threadId) ?? {
      state: map.initialized ? 'ready' : 'waiting',
      message: 'Screens and routes are remembered as the agent uses your app.',
    } };
  }

  report(threadId, state, message, detail) { this.learning.set(threadId, { state, message, ...(detail ? { detail } : {}) }); }
}

export function appPackage(activity) {
  const name = typeof activity === 'string' ? activity.split('/')[0] : null;
  if (!name || !PACKAGE.test(name)) return null;
  // These surfaces do not identify the app being tested. Do not create maps for
  // launcher transitions, the system shade, or transient permission prompts.
  if (/(?:^|\.)(?:systemui|launcher\d*|nexuslauncher|permissioncontroller)$/.test(name)) return null;
  return name;
}

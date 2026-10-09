import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sdk } from '../lib/sdk.mjs';
import { createNavigationDependencies } from './navigation-dependencies.mjs';
import { parseAndroidLayout } from './android-cli.mjs';

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;
const bounded = (value, name, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be nonempty text of at most ${max} characters without control characters.`);
  return value;
};

// Follow Minimap's ancestor lookup, stopping at a Git boundary. The host supplies
// cwd; neither an agent nor a panel can choose a repository or executable.
export function minimapRoot(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('The host did not provide this chat’s project directory. Open the chat in a project to use Minimap.');
  const start = fs.realpathSync(cwd);
  if (!fs.statSync(start).isDirectory()) throw new Error('The chat’s project directory is unavailable.');
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.minimap/config.json'))) return directory;
    if (fs.existsSync(path.join(directory, '.git')) || directory === path.dirname(directory)) return start;
  }
}

function readJson(root, relative) {
  const file = path.join(root, '.minimap', relative);
  const stat = fs.lstatSync(file);
  const canonical = fs.realpathSync(file);
  const base = path.join(root, '.minimap') + path.sep;
  if (!stat.isFile() || !canonical.startsWith(base) || stat.size > 2 * 1024 * 1024) throw new Error('Minimap contains an unsupported or oversized graph file.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function minimapLocation(cwd) {
  const root = minimapRoot(cwd);
  const base = { root, projectName: path.basename(root), initialized: false, packageName: null, places: [], edges: [] };
  const graphDir = path.join(root, '.minimap');
  if (fs.existsSync(graphDir) && fs.lstatSync(graphDir).isSymbolicLink()) throw new Error('Minimap’s directory must be inside this project, not a symbolic link.');
  for (const relative of ['graph', 'graph/places', 'graph/edges']) {
    const directory = path.join(graphDir, relative);
    if (fs.existsSync(directory) && !fs.realpathSync(directory).startsWith(graphDir + path.sep)) throw new Error('Minimap graph directories must be inside this project.');
  }
  return { ...base, initialized: fs.existsSync(path.join(graphDir, 'config.json')) };
}

export function readMinimap(cwd) {
  const base = minimapLocation(cwd);
  const { root, initialized } = base;
  if (!initialized) return base;
  const graphDir = path.join(root, '.minimap');
  const config = readJson(root, 'config.json');
  if (config.schema_version !== 'minimap.config.v2') throw new Error('This Minimap graph uses an unsupported config schema. Inspect it with Minimap before changing it.');
  let totalBytes = 0;
  const readObjects = (folder, summarize) => {
    const dir = path.join(graphDir, 'graph', folder);
    if (!fs.realpathSync(dir).startsWith(graphDir + path.sep)) throw new Error('Minimap graph directories must be inside this project.');
    const names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort();
    if (names.length > 2000) throw new Error('This Minimap graph exceeds the panel’s 2,000-object limit.');
    return names.map(name => {
      totalBytes += fs.lstatSync(path.join(dir, name)).size;
      if (totalBytes > 16 * 1024 * 1024) throw new Error('This Minimap graph exceeds the panel’s 16 MB limit.');
      return summarize(readJson(root, path.join('graph', folder, name)));
    });
  };
  const places = readObjects('places', p => {
    if (p.schema_version !== 'minimap.place.v1') throw new Error('Unsupported Minimap place schema.');
    return { id: bounded(p.id, 'Place ID'), label: bounded(p.label, 'Place label'), slug: bounded(p.slug, 'Place slug'), needsLabel: /^Screen \d+$/i.test(p.label.trim()) };
  });
  const edges = readObjects('edges', e => {
    if (!['minimap.edge.v1', 'minimap.edge.v2'].includes(e.schema_version) || !Array.isArray(e.recipe)) throw new Error('Unsupported Minimap route schema.');
    return { id: bounded(e.id, 'Route ID'), from: bounded(e.from?.id, 'Source ID'), to: bounded(e.to?.id, 'Destination ID'), steps: e.recipe.length, requiresHistory: e.recipe.some(step => step.kind === 'press_back') };
  });
  return { ...base, initialized: true, packageName: config.app_profiles?.[config.active_app_profile]?.android_package || null, places, edges };
}

// Minimap isolates its own Android subprocess groups. Stop its parent first,
// then kill descendant groups too so cancellation cannot leave input running.
async function terminateTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  const kill = (pid, signal) => { try { process.kill(pid, signal); } catch {} };
  if (process.platform === 'win32') { child.kill('SIGKILL'); return; }
  kill(child.pid, 'SIGSTOP');
  try {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000, maxBuffer: 1024 * 1024 });
    const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const descendants = new Set([child.pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [pid, parent] of rows) if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); kill(pid, 'SIGSTOP'); changed = true; }
    }
    for (const pid of [...descendants].reverse()) { kill(-pid, 'SIGKILL'); kill(pid, 'SIGKILL'); }
  } finally { kill(-child.pid, 'SIGKILL'); kill(child.pid, 'SIGKILL'); }
}

export function runMinimap(file, args, { cwd, env = process.env, signal, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Navigation stopped. Inspect the device before continuing; completed actions are not undone.'));
    const child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, failure = null, stopping;
    const stop = message => {
      failure ??= message;
      stopping ??= terminateTree(child).catch(() => { failure = 'Minimap was interrupted, but subprocess cleanup could not be verified. Inspect the device before continuing.'; });
    };
    const abort = () => stop('Navigation stopped. Inspect the device before continuing; completed actions are not undone.');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Minimap timed out. Inspect the device before retrying; some actions may have completed.'), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) stop('Minimap output exceeded its size limit. Inspect the device before retrying.');
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) stop('Minimap output exceeded its size limit.'); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', async code => {
      cleanup();
      await stopping;
      if (failure) reject(new Error(failure));
      else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

function argumentsFor(options) {
  const { action } = options;
  if (action === 'init') {
    const packageName = bounded(options.packageName, 'packageName');
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) throw new Error('packageName must be a qualified Android application ID.');
    return ['init', '--no-skills', `--package=${packageName}`];
  }
  if (action === 'doctor') return ['doctor', '--repo-only'];
  if (action === 'whereami') return ['whereami', '--fresh', ...(options.label === undefined ? [] : [`--label=${bounded(options.label, 'label', 120)}`])];
  if (action === 'layout') return ['layout', '--fresh'];
  if (action === 'back') return ['back'];
  if (action === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(options.direction)) throw new Error('direction must be up, down, left, or right.');
    return ['scroll', `--direction=${options.direction}`];
  }
  if (action === 'tap') {
    if (options.point && (!Array.isArray(options.point) || options.point.length !== 2 || !options.point.every(n => Number.isFinite(n) && n >= 0))) throw new Error('A tap point requires two nonnegative coordinates.');
    const args = ['tap', options.point ? `--point=${options.point.map(Math.round).join(',')}` : `--selector=${bounded(options.selector, 'selector')}`];
    if (options.label !== undefined) args.push(`--label=${bounded(options.label, 'label', 120)}`);
    if (options.reason !== undefined) args.push(`--reason=${bounded(options.reason, 'reason')}`);
    return args;
  }
  if (action === 'go') {
    const target = bounded(options.target, 'target');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(target)) throw new Error('target must be a place ID or slug from Minimap status.');
    const expectations = options.expect ?? [];
    if (!Array.isArray(expectations) || expectations.length > 8) throw new Error('expect must contain at most eight selectors.');
    return ['go', target, '--max-actions=32', '--recovery-seconds=60', ...expectations.map(s => `--expect=${bounded(s, 'expect selector')}`)];
  }
  throw new Error('Unknown navigation action.');
}

export function createMinimapBackend({ stateDir, executable = process.env.ANDROID_EMULATOR_MINIMAP ?? (fs.existsSync(path.join(os.homedir(), '.local/bin/minimap')) ? path.join(os.homedir(), '.local/bin/minimap') : 'minimap'), runCommand = runMinimap, environment = () => ({ ...process.env, PATH: [path.dirname(sdk().adb), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(path.delimiter) }) } = {}) {
  let probePromise, probeAt = 0;
  const dependencies = stateDir && runCommand === runMinimap ? createNavigationDependencies({ dir: stateDir,
    environment: { ...process.env, PATH: [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(path.delimiter) } }) : null;
  let resolved;
  async function resolveDependencies(signal) {
    if (!dependencies || resolved) return;
    signal?.throwIfAborted();
    const pending = dependencies.ensure({ signal });
    if (!signal) { resolved = await pending; return; }
    let abort;
    try {
      resolved = await Promise.race([pending, new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  }
  function runtimeEnvironment(serial, sessionDir) {
    const base = environment();
    return { ...base, ...resolved?.env, PATH: [resolved?.env.PATH, base.PATH].filter(Boolean).join(path.delimiter), ...(serial ? { ANDROID_SERIAL: serial } : {}), ...(sessionDir ? { TMPDIR: sessionDir } : {}) };
  }
  function mapFor(cwd, packageName) {
    const project = minimapLocation(cwd);
    let existing;
    try { existing = readMinimap(cwd); }
    catch { existing = { ...project, error: 'The saved screen map could not be read. Ask the agent to diagnose navigation.' }; }
    if (!packageName || !stateDir || (existing.initialized && existing.packageName === packageName)) return existing;
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) throw new Error('A qualified Android app package is required.');
    // Keep automatic maps out of source control. Different apps and projects
    // never rebind one another's graphs; existing matching project maps are reused.
    const key = createHash('sha256').update(project.root).digest('hex');
    const root = path.join(stateDir, 'navigation', 'maps', key, packageName);
    const base = { root, projectRoot: project.root, projectName: project.projectName, initialized: false, packageName, places: [], edges: [] };
    if (!fs.existsSync(root)) return base;
    try { return { ...readMinimap(root), projectRoot: project.root, projectName: project.projectName, packageName }; }
    catch { return { ...base, initialized: true, error: 'The saved screen map could not be read. Ask the agent to diagnose navigation.' }; }
  }
  async function probeDependencies() {
      try {
        const env = environment();
        const result = await runCommand(executable, ['--version'], { env, timeoutMs: 5000 });
        const version = result.stdout.trim().match(/^minimap (0\.2\.\d+)$/)?.[1];
        if (result.code !== 0 || !version) return { available: false, reason: 'Install Minimap 0.2.1 or a newer 0.2.x patch. Other CLI versions are not supported.' };
        if (Number(version.split('.')[2]) < 1) return { available: false, version, reason: 'Update Minimap to 0.2.1. Version 0.2.0 cannot identify the foreground app reliably on mirrored foldables.' };
        const android = await runCommand('android', ['--version'], { env, timeoutMs: 5000 });
        if (android.code !== 0) return { available: false, version, reason: 'Android CLI is required by Minimap. Install android and make it available on PATH.' };
        return { available: true, version };
      } catch { return { available: false, reason: 'Minimap needs the Minimap 0.2.1+ CLI, Android CLI, and Android SDK. Install the missing dependency; Minimap is found on PATH or in ~/.local/bin.' }; }
  }
  const provider = {
    id: 'minimap', label: 'Minimap navigation memory', version: '0.2.x',
    async uiNodes(serial, { timeoutMs = 30_000 } = {}) {
      if (!dependencies) return null;
      const signal = AbortSignal.timeout(timeoutMs);
      // Android CLI owns a persistent inspection service. Running ADB's
      // uiautomator dump alongside it kills that service, including after a
      // helper restart. Share its reader for all ordinary inspection tools.
      try {
        try { await resolveDependencies(signal); } catch (error) { if (signal.aborted) throw error; return null; }
        const response = await runCommand(resolved.android, ['--no-metrics', 'layout', `--device=${serial}`, '--full'], { env: runtimeEnvironment(serial), signal, timeoutMs });
        if (response.code !== 0) throw new Error('Android CLI could not inspect the screen. Retry observation before sending input.');
        return parseAndroidLayout(response.stdout);
      } catch (error) {
        if (signal.aborted) throw new Error('UI inspection timed out (exit 124).');
        throw error;
      }
    },
    probe() {
      if (dependencies) return Promise.resolve({ available: true, automaticSetup: true, version: resolved?.versions.minimap.replace(/^minimap /, '') });
      if (!probePromise || Date.now() - probeAt > 30_000) {
        probeAt = Date.now();
        probePromise = probeDependencies();
      }
      return probePromise;
    },
    create() {
      return {
        status(cwd, packageName) { return mapFor(cwd, packageName); },
        async prepare({ cwd, packageName }, { signal } = {}) {
          await resolveDependencies(signal);
          const availability = await provider.probe();
          if (!availability.available) throw new Error(availability.reason);
          const map = mapFor(cwd, packageName);
          if (map.error) throw new Error(map.error);
          if (!map.initialized) {
            fs.mkdirSync(map.root, { recursive: true, mode: 0o700 });
            const result = await this.execute({ cwd, packageName, action: 'init' }, { signal });
            if (result.status !== 'ok') throw new Error('The screen map could not be prepared. Ordinary device controls are still available.');
          }
          return this.status(cwd, packageName);
        },
        async execute({ cwd, serial, packageName, automatic = false, sourcePrepared = false, sessionDir, ...options }, { signal } = {}) {
          await resolveDependencies(signal);
          if (automatic && stateDir && !sessionDir) {
            const base = path.join(stateDir, 'navigation', 'sessions');
            fs.mkdirSync(base, { recursive: true, mode: 0o700 });
            const isolated = fs.mkdtempSync(path.join(base, 'action-'));
            try { return await this.execute({ cwd, serial, packageName, automatic, sourcePrepared, ...options, sessionDir: isolated }, { signal }); }
            finally { fs.rmSync(isolated, { recursive: true, force: true }); }
          }
          const map = packageName && stateDir ? mapFor(cwd, packageName) : ['init', 'doctor'].includes(options.action) ? minimapLocation(cwd) : readMinimap(cwd);
          if (map.error && !['init', 'doctor'].includes(options.action)) throw new Error(map.error);
          // Minimap v0.2 accepts slugs, while the panel and agents may hold IDs.
          const target = options.action === 'go' ? map.places.find(p => p.id === options.target)?.slug ?? options.target : options.target;
          const args = argumentsFor({ ...options, packageName, target });
          if (options.action !== 'init' && !map.initialized) throw new Error('Initialize Minimap for this project and application package first.');
          if (!['init', 'doctor'].includes(options.action) && !serial) throw new Error('Navigation requires this chat’s running emulator.');
          // Pending CLI transitions live only for this automatic action. Manual
          // input or text entry between calls cannot become an incomplete recipe.
          const env = runtimeEnvironment(serial, sessionDir);
          const response = await runCommand(resolved?.minimap ?? executable, [...(serial ? ['--serial', serial] : []), ...args], { cwd: map.root, env, signal });
          let result;
          try { result = JSON.parse(response.stdout); } catch { throw new Error(`Minimap returned invalid JSON (exit ${response.code}). Inspect the device before retrying.`); }
          // Init returns its own shape. Other outcomes (including useful nonzero
          // statuses such as unknown/no_known_path) retain their full CLI result.
          if (options.action === 'init' && result.ok === true) result = { ...result, status: 'ok', summary: 'Minimap initialized for this project.' };
          if (typeof result.status !== 'string' || ![0, 2, 5, 6, 7].includes(response.code)) throw new Error('Minimap returned an unsupported result. Inspect the device before retrying.');
          const latest = this.status(cwd, packageName);
          const located = result.place?.id ?? result.data?.current ?? result.data?.to ?? result.data?.place ?? result.minimap?.place?.id;
          const place = latest.places.find(p => p.id === located || p.slug === located);
          const currentPlace = place && ['ok', 'known', 'known_changed'].includes(result.status) ? place : null;
          result = { ...result, exitCode: response.code, currentPlaceId: currentPlace?.id ?? null, currentPlace };
          if (!automatic) return result;
          const locate = async initial => {
            const observed = initial ?? await this.execute({ cwd, serial, packageName, sessionDir, action: 'whereami' }, { signal });
            if (observed.status !== 'unknown') return observed;
            const places = this.status(cwd, packageName).places;
            // A provisional identity lets this action finish learning its route.
            // Tool results ask the host agent to name it from fresh UI evidence.
            let number = places.length + 1;
            while (places.some(p => p.label === `Screen ${number}`)) number++;
            return this.execute({ cwd, serial, packageName, sessionDir, action: 'whereami', label: `Screen ${number}` }, { signal });
          };
          if (options.action === 'whereami' && result.status === 'unknown') return locate(result);
          // This particular response is emitted before Minimap sends any input.
          // Name the source, then dispatch once. Never retry an action error or
          // a lost reply: either can follow an input that already reached Android.
          if (options.action === 'tap' && !sourcePrepared && result.status === 'needs_label' && result.data?.orientation) {
            const source = await locate();
            if (!source.currentPlaceId) return source;
            return this.execute({ cwd, serial, packageName, sessionDir, ...options, automatic: true, sourcePrepared: true }, { signal });
          }
          if (options.action === 'tap' && result.status === 'needs_label' && result.data?.source) {
            const destination = await locate();
            return { ...result, status: destination.currentPlaceId ? 'ok' : destination.status,
              summary: destination.currentPlaceId ? 'Tapped and remembered the destination.' : 'Tap completed; the destination could not be identified.',
              currentPlaceId: destination.currentPlaceId, currentPlace: destination.currentPlace, observation: destination };
          }
          if (['back', 'scroll'].includes(options.action) && result.status === 'ok' && !result.currentPlaceId) {
            const observed = await locate();
            return { ...result, currentPlaceId: observed.currentPlaceId, currentPlace: observed.currentPlace, observation: observed };
          }
          return result;
        },
      };
    },
  };
  return provider;
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { avdDiskBytes, avdPostures, PROFILES, systemImages } from './lib/avds.mjs';
import { apkInfo, findNode, formatNodes, resolveKeycode, scopedAdb } from './lib/device.mjs';
import { LeaseManager } from './lib/leases.mjs';
import { Logcat } from './lib/logcat.mjs';
import { Backends } from './backends.mjs';
import { typeIntoDevice } from './lib/text-input.mjs';
import { NavigationMemory, appPackage } from './lib/navigation-memory.mjs';
import { errorDetails } from './lib/errors.mjs';
import { leaseDiagnostics } from './lib/diagnostics.mjs';
import { Captures } from './lib/captures.mjs';
import { copyCaptureToClipboard } from './lib/clipboard.mjs';
import { adb } from './lib/sdk.mjs';
import { RUNTIME_VERSION } from './version.mjs';
import { themeAttribute } from './lib/appearance.mjs';
import { AUTOMATIC, Settings, VIDEO_QUALITY } from './lib/settings.mjs';
import { BridgeViewer } from './lib/bridge.mjs';
import { assertPanelAction, matchesKey, scopedKey } from './lib/panel-access.mjs';
import { THREADLESS } from './tools.mjs';
import { upgrade } from './lib/websocket.mjs';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const MIRROR_IDLE_MS = 3_000;
const MAX_VIEWER_BACKLOG = 2 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const STREAM_WAIT_MS = 8_000;
const BRIDGE_IDLE_MS = 20_000;

// Integration owns storage, helper discovery, session lifecycle and host appearance.
// No host implementation is loaded by this module. Without session data, cleanup is idle-only.
export async function startDaemon({
  dir, port: requestedPort = 0, version = RUNTIME_VERSION, helperVersion = version,
  readSessions = async () => new Map(), appearance = {}, panelScript = null, panelMetadata = () => ({}),
  providers = {}, createLeases = options => new LeaseManager(options), createLogcat = (serial, onLines) => new Logcat(serial, onLines),
  log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`),
}) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('An absolute emulator state directory is required.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backends = new Backends({ dir, providers });
  const PLUGIN_VERSION = version;
  const HELPER_VERSION = helperVersion;
  const DEFAULT_PORT = requestedPort;

  // The listening port is the process-wide lock. Claim it before reading or mutating lease state.
  // Falling back to a second port could create two helpers controlling the same devices.
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { error: 'Invalid request.' });
      else res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(DEFAULT_PORT, '127.0.0.1', resolve);
  });

  const tokenFile = path.join(dir, 'token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const leases = createLeases({ dir, log, readSessions });
  const settings = new Settings(dir);
  let theme = appearance.read?.() ?? null;
  const recorders = new Map();
  let closed = false;
  const backendSwitches = new Set();
  const activeOperations = new Map();
  const navigationRuns = new Map();
  const lastPlaces = new Map();
  const navigation = new NavigationMemory({ dir, readSessions, backends });
  const graphRuns = new Map();
  const passiveTools = new Set(['emulator_status', 'emulator_diagnostics', 'emulator_panel', 'emulator_screenshot', 'emulator_capture', 'emulator_ui_tree', 'emulator_observe', 'emulator_wait_for', 'emulator_record', 'emulator_context', 'emulator_capture_selection']);
  function navigationEvent(threadId, busy) {
    for (const viewer of viewers.get(threadId) ?? []) viewer.sendJson({ t: 'navigation', busy });
  }
  function invalidatePlace(threadId) {
    if (lastPlaces.delete(threadId)) navigationEvent(threadId, navigationRuns.has(threadId));
  }
  async function cancelNavigation(threadId) {
    const running = navigationRuns.get(threadId);
    running?.controller.abort();
    if (running) await running.done.catch(() => {});
    invalidatePlace(threadId);
  }
  function recorderFor(threadId) {
    const provider = backends.get(threadId, 'recording');
    if (!recorders.has(provider.id)) recorders.set(provider.id, provider.create(dir));
    return recorders.get(provider.id);
  }
  function isRecording(serial) { return [...recorders.values()].some(recorder => recorder.isRecording(serial)); }
  function deviceFor(threadId, serial) {
    const capture = backends.get(threadId, 'capture');
    const navigation = backends.get(threadId, 'navigation');
    return backends.get(threadId, 'device').create(serial, {
      capture: target => backends.measure(threadId, 'capture', capture, () => capture.capture(target)),
      uiNodes: navigation.uiNodes,
    });
  }
  async function operation(threadId, work, tool, args = {}) {
    const navigationRead = tool === 'emulator_navigate' && ['status', 'cancel'].includes(args.action);
    if (navigationRuns.has(threadId) && !navigationRead && !passiveTools.has(tool)) throw new Error('Navigation is using this device. Stop it from Screen map before overriding it.');
    if (tool !== 'emulator_navigate' && !passiveTools.has(tool)) invalidatePlace(threadId);
    activeOperations.set(threadId, (activeOperations.get(threadId) ?? 0) + 1);
    try { return await work(); }
    finally {
      const remaining = activeOperations.get(threadId) - 1;
      if (remaining) activeOperations.set(threadId, remaining); else activeOperations.delete(threadId);
    }
  }
  const captures = new Captures(dir);
  // Activity is in memory; give running emulators a fresh idle window after a helper restart.
  for (const threadId of Object.keys(leases.leases)) leases.touch(threadId);

  /** @type {Map<string, Set<import('./lib/websocket.mjs').WebSocketConnection>>} */
  const viewers = new Map();
  /** @type {Map<string, {mirror: EventEmitter, ready: Promise<void>, idleTimer?: NodeJS.Timeout}>} */
  const mirrors = new Map();
  const typing = new Set();
  const inputConnections = new Map();
  const mirrorFailures = new Map();
  const mirrorRetries = new Map();
  /** @type {Map<string, {logcat: Logcat, subscribers: Set<import('./lib/websocket.mjs').WebSocketConnection>}>} */
  const logcats = new Map();
  const screenSizes = new Map();
  const port = server.address().port;

  const origin = () => `http://127.0.0.1:${port}`;
  const panelUrl = (threadId) => `${origin()}/t/${encodeURIComponent(threadId)}?k=${channelKey(threadId)}`;
  // Embedded panels can't open sockets to the helper; they stream through `emulator_stream` with this per-thread key,
  // so a panel can only ever reach the thread (or manager) it was opened for.
  const channelKey = (thread) => scopedKey(token, `channel:${thread}`);
  const panelMeta = (thread) => ({ panelUrl: panelUrl(thread), channel: { thread, key: channelKey(thread) } });
  const captureMeta = (thread, capture) => ({ capture: { downloadUrl: `${origin()}/captures/${encodeURIComponent(thread)}/${capture.id}?k=${scopedKey(token, `capture:${thread}:${capture.id}`)}` } });
  /** @type {Map<string, {thread: string, viewer: BridgeViewer}>} */
  const bridges = new Map();

  const recordingSaves = new Map();
  function saveRecording(threadId, lease) {
    if (!recordingSaves.has(threadId)) {
      recordingSaves.set(threadId, backends.measure(threadId, 'recording', backends.get(threadId, 'recording'), () => recorderFor(threadId).stop(lease.serial, lease.avd))
        .then(recording => captures.create(threadId, { recording, serial: lease.serial }))
        .finally(() => recordingSaves.delete(threadId)));
    }
    return recordingSaves.get(threadId);
  }

  function requireLease(threadId) {
    const lease = leases.get(threadId);
    if (!lease) throw new Error('This thread has no emulator. Call emulator_start (or emulator_create if no AVDs exist) first.');
    if (lease.state !== 'ready') throw new Error(`This thread's emulator is still ${lease.state}.`);
    return lease;
  }

  function publicLease(lease) {
    if (!lease) return null;
    const { avd, serial, readOnly, state, startedAt } = lease;
    return { avd, serial, readOnly, state, startedAt };
  }

  async function status(threadId, { forPane = false } = {}) {
    const lease = leases.get(threadId);
    const postures = lease ? avdPostures(lease.avd) : [];
    const foldable = postures.length ? {
      postures,
      posture: lease.state === 'ready' ? await deviceFor(threadId, lease.serial).posture().catch(() => null) : null,
    } : null;
    const value = {
      display: { viewers: viewers.get(threadId)?.size ?? 0, streaming: mirrors.has(threadId) },
      backends: backends.selection(threadId),
      foldable,
      emulator: publicLease(lease),
      avds: await leases.avds(),
      createdByThisThread: leases.ownedAvds(threadId),
    };
    if (!forPane) return value;
    return {
      ...value,
      inUseAvds: !lease ? [...(await leases.inUseAvds?.() ?? [])] : [],
      profiles: PROFILES.map(({ id, name, form }) => ({ id, name, form })),
      images: systemImages().map(({ id, label, tags }) => ({ id, label, tablet: tags.includes('tablet') })),
      recording: lease ? isRecording(lease.serial) : false,
      settings: { keepCreatedDevices: settings.get('keepCreatedDevices') },
      theme,
    };
  }

  const text = (value) => ({ text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });

  function pushStatus(threadId) {
    const set = viewers.get(threadId);
    if (!set?.size) return;
    status(threadId, { forPane: true }).then((value) => {
      for (const viewer of set) viewer.sendJson({ t: 'status', ...value });
    }, () => {});
  }

  // Shows what the agent did in the panel. Points are normalized to the screen (0-1).
  async function agentEvent(threadId, serial, event) {
    if (!viewers.get(threadId)?.size) return;
    let size = screenSizes.get(serial);
    if (!size || Date.now() - size.at > 3_000) {
      size = { ...(await deviceFor(threadId, serial).screenSize().catch(() => ({ width: 1, height: 1 }))), at: Date.now() };
      screenSizes.set(serial, size);
    }
    // The emulator can rotate its panel without Android reporting it; follow the video's orientation.
    const video = mirrors.get(threadId)?.mirror.session;
    const swap = video && (video.width > video.height) !== (size.width > size.height);
    const [width, height] = swap ? [size.height, size.width] : [size.width, size.height];
    const norm = ([x, y]) => [x / width, y / height];
    const payload = { t: 'agent', kind: event.kind, label: event.label };
    if (event.point) payload.point = norm(event.point);
    if (event.to) payload.to = norm(event.to);
    if (event.bounds) payload.bounds = [...norm(event.bounds.slice(0, 2)), ...norm(event.bounds.slice(2))];
    for (const viewer of viewers.get(threadId) ?? []) viewer.sendJson(payload);
  }

  function formatBytes(bytes) {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  }

  async function managerOverview() {
    const avds = await leases.avds();
    const leased = Object.values(leases.leases).filter((lease) => leases.get(lease.threadId));
    const inUse = await leases.inUseAvds?.() ?? new Set(leased.map(lease => lease.avd));
    const info = await readSessions([...leased.map(({ threadId }) => threadId), ...Object.values(leases.createdAvds).map(({ threadId }) => threadId)]);
    const title = (threadId) => info.get(threadId)?.title ?? null;
    const devices = await Promise.all(avds.map(async (name) => {
      const owner = leases.createdAvds[name];
      const bytes = await avdDiskBytes(name);
      return {
        name,
        inUse: inUse.has(name),
        bytes,
        size: formatBytes(bytes),
        createdBy: owner ? { threadId: owner.threadId, title: title(owner.threadId), keep: owner.keep } : null,
        runningFor: leased.filter((lease) => lease.avd === name).map(({ threadId }) => ({ threadId, title: title(threadId) })),
      };
    }));
    return {
      running: leased.map((lease) => ({ ...publicLease(lease), threadId: lease.threadId, threadTitle: title(lease.threadId) })),
      devices,
      totalSize: formatBytes(devices.reduce((sum, device) => sum + device.bytes, 0)),
      pluginSize: formatBytes(devices.filter((device) => device.createdBy).reduce((sum, device) => sum + device.bytes, 0)),
    };
  }

  async function installAndLaunch(threadId, serial, file, { launch = true } = {}) {
    const info = await apkInfo(file);
    const device = deviceFor(threadId, serial);
    await device.install([file]).catch((error) => {
      if (/MISSING_SPLIT/.test(error.message)) throw new Error(`${info.label ?? info.packageName} is a split APK. Install it together with its split APKs (emulator_install with every .apk).`);
      throw error;
    });
    if (launch && info.packageName) {
      await device.open({ packageName: info.packageName }).catch(() => {});
      try { await learnNavigation(threadId, device, { action: 'whereami' }, { packageName: info.packageName }); } catch {}
    }
    return info;
  }

  function defaultAvd(avds) {
    const preferred = settings.get('defaultAvd');
    return preferred !== AUTOMATIC && avds.includes(preferred) ? preferred : undefined;
  }

  async function navigationMap(threadId, context) {
    context ??= await navigation.context(threadId);
    const map = await navigation.status(threadId, context);
    return { ...map, busy: navigationRuns.has(threadId), currentPlace: lastPlaces.get(threadId)?.id ?? null };
  }

  function rememberPlace(threadId, result) {
    if (result.currentPlaceId) lastPlaces.set(threadId, { id: result.currentPlaceId });
    else lastPlaces.delete(threadId);
    navigation.report(threadId, ['ok', 'known', 'known_changed'].includes(result.status) ? 'ready' : 'error', result.summary);
  }

  async function withNavigation(threadId, work) {
    const controller = new AbortController();
    const entry = { controller, done: null };
    navigationRuns.set(threadId, entry);
    invalidatePlace(threadId);
    navigationEvent(threadId, true);
    entry.done = Promise.resolve().then(() => work(controller.signal));
    try { return await entry.done; }
    finally { navigationRuns.delete(threadId); navigationEvent(threadId, false); }
  }

  async function withGraph(context, signal, work) {
    // Shared project maps can be used by multiple chats. Serialize their writes,
    // including initialization, while keeping unrelated projects independent.
    const status = await context.navigator.status(context.cwd, context.packageName);
    const key = `${context.provider.id}:${status.root ?? context.cwd}`;
    const previous = graphRuns.get(key) ?? Promise.resolve();
    let started = false;
    const done = previous.catch(() => {}).then(() => { signal.throwIfAborted(); started = true; return work(); });
    graphRuns.set(key, done);
    const cleanup = () => { if (graphRuns.get(key) === done) graphRuns.delete(key); };
    done.then(cleanup, cleanup);
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => { if (!started) reject(new Error('Navigation stopped while waiting for the screen map.')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    // A queued cancellation can return promptly, but its queue entry must remain
    // behind the previous writer so a third chat cannot overtake that writer.
    try { return await Promise.race([done, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  async function learnNavigation(threadId, device, args, { foregroundActivity, packageName } = {}) {
    if (navigationRuns.has(threadId) || (activeOperations.get(threadId) ?? 0) > 1) return null;
    // Providers can omit automatic preparation; raw controls stay usable.
    if (!backends.get(threadId, 'navigation').create().prepare) return null;
    return withNavigation(threadId, async signal => {
      let dispatched = false;
      try {
        let context = await navigation.context(threadId);
        const activity = foregroundActivity === undefined ? await device.foregroundActivity() : foregroundActivity;
        const foreground = appPackage(activity);
        if (!foreground || (packageName && foreground !== packageName)) {
          navigation.report(threadId, 'waiting', 'Open your app to remember its screens.');
          return null;
        }
        context = navigation.select(threadId, context, foreground);
        return await withGraph(context, signal, async () => {
          const { provider, navigator, cwd } = context;
          navigation.report(threadId, 'waiting', 'Preparing screen memory…');
          await navigator.prepare(context, { signal });
          signal.throwIfAborted();
          dispatched = true;
          const result = await backends.measure(threadId, 'navigation', provider,
            () => navigator.execute({ ...args, cwd, packageName: foreground, serial: requireLease(threadId).serial, automatic: true }, { signal }));
          rememberPlace(threadId, result);
          return { text: result.summary ?? `Navigation: ${result.status}.`, structuredContent: { navigation: result } };
        });
      } catch (error) {
        navigation.report(threadId, 'error', 'Screen memory is unavailable. Device controls remain available; the agent can inspect navigation diagnostics.', String(error.message).slice(0,300));
        if (signal.aborted) throw new Error('Navigation stopped. Inspect the device before continuing.');
        // A failure after dispatch may follow input reaching the device. Never
        // replay it via ordinary controls, even if the CLI reply was lost.
        if (dispatched) throw new Error(`${error.message} Inspect the device before continuing; the action was not retried.`);
        return null;
      }
    });
  }

  const tools = {
    async emulator_navigate(threadId, args = {}) {
      if (args.action === 'cancel') {
        await cancelNavigation(threadId);
        return { text: 'Navigation stopped. Inspect the device before continuing; completed actions are not undone.', structuredContent: { map: await navigationMap(threadId) } };
      }
      if (args.action === 'status') return { text: 'Saved screens and routes.', structuredContent: { map: await navigationMap(threadId) } };
      if ((activeOperations.get(threadId) ?? 0) > 1) throw new Error('Finish this chat’s active operation before starting navigation.');
      return withNavigation(threadId, async signal => {
        let context = await navigation.context(threadId);
        const device = ['init', 'doctor'].includes(args.action) ? null : deviceFor(threadId, requireLease(threadId).serial);
        if (context.navigator.prepare) {
          const packageName = args.action === 'init' ? args.packageName
            : ['go', 'doctor'].includes(args.action) ? context.packageName || (await context.navigator.status(context.cwd)).packageName
            : appPackage(await device.foregroundActivity());
          if (!packageName) throw new Error('Open the app you want to use. Its screen map will be prepared automatically.');
          context = navigation.select(threadId, context, packageName);
          if (args.action === 'go') {
            const saved = await context.navigator.status(context.cwd, packageName);
            if (!saved.places.some(p => p.id === args.target || p.slug === args.target)) throw new Error('That screen is not in this app’s saved map. Refresh the screen map and choose a saved destination.');
            if (appPackage(await device.foregroundActivity()) !== packageName) {
              await device.open({ packageName });
              if (appPackage(await device.foregroundActivity()) !== packageName) throw new Error('The mapped app did not open. Inspect the device before navigating.');
            }
          }
        }
        return withGraph(context, signal, async () => {
          if (context.navigator.prepare && args.action !== 'doctor') await context.navigator.prepare(context, { signal });
          const { provider, navigator, cwd, packageName } = context;
          const availability = await backends.probe('navigation', provider);
          if (!availability.available) throw new Error(availability.reason);
          const serial = device ? requireLease(threadId).serial : undefined;
          const result = args.action === 'init' && navigator.prepare
            ? { status: 'ok', summary: 'Screen map ready.' }
            : await backends.measure(threadId, 'navigation', provider,
              () => navigator.execute({ ...args, cwd, packageName, serial, automatic: args.label === undefined }, { signal }));
          rememberPlace(threadId, result);
          const map = await navigationMap(threadId, context);
          map.busy = false;
          return { text: result.summary ?? `Navigation: ${result.status}.`, structuredContent: { result, map } };
        });
      });
    },
    async emulator_backends(threadId, { action = 'list', set } = {}) {
      if (action === 'metrics') return text({ selected: backends.selection(threadId), metrics: backends.snapshot(threadId),
        notes: 'In-memory metrics since helper start, up to 128 recent successful durations per backend/version. Dependency versions are those observed at the latest availability check. Connection durations are time to first encoded frame, not panel render latency. Frames and bytes are encoder output before viewer fan-out.' });
      if (action === 'list') return text({ selected: backends.selection(threadId), available: await backends.available() });
      if (action !== 'select') throw new Error('action must be list, select, or metrics.');
      if (backendSwitches.has(threadId)) throw new Error('A backend selection is already in progress for this chat.');
      backendSwitches.add(threadId);
      try {
        await backends.check(set);
        const lease = leases.get(threadId);
        if (typing.has(threadId) || (activeOperations.get(threadId) ?? 0) > 1 || (lease && isRecording(lease.serial))) {
          throw new Error('Finish this chat’s active operation or recording before changing backends.');
        }
        const old = backends.selection(threadId);
        const selected = backends.select(threadId, set);
        if (selected.connection !== old.connection) {
          stopMirror(threadId);
          if (viewers.get(threadId)?.size) await attachViewers(threadId);
        }
        pushStatus(threadId);
        return text({ selected });
      } finally { backendSwitches.delete(threadId); }
    },
    // App-only transport for embedded panels: queued pane messages in, viewer messages out (long-polled).
    async emulator_stream(callerThread, { thread, key, session, send = [], wait = false }) {
      if (!matchesKey(key, channelKey(String(thread ?? '')))) throw new Error('This panel is not authorized for that emulator.');
      if (callerThread && thread !== 'manager' && callerThread !== thread) throw new Error('This panel belongs to a different thread.');
      const id = `${thread}\n${String(session ?? '').slice(0, 64)}`;
      let entry = bridges.get(id);
      // Keep a closed session briefly so late polls/input cannot resurrect a hidden pane.
      if (entry?.viewer.closed) {
        if (Array.isArray(send) && send.some((message) => message?.t === 'bye')) return { text: '', structuredContent: { messages: [] } };
        throw new Error('This display session has closed. Reconnect with a new session.');
      }
      if (!entry) {
        entry = { thread, viewer: new BridgeViewer() };
        bridges.set(id, entry);
        if (Array.isArray(send) && send.some((message) => message?.t === 'bye')) {
          entry.viewer.close();
          return { text: '', structuredContent: { messages: [] } };
        }
        addViewer(thread, entry.viewer);
      }
      entry.viewer.lastSeen = Date.now();
      for (const message of Array.isArray(send) ? send : []) {
        if (message?.t === 'bye') {
          entry.viewer.close();
          break;
        }
        handleViewerMessage(thread, entry.viewer, message).catch((error) => log(`viewer message failed: ${error.message}`));
      }
      // Only polls drain the queue, so video packets always arrive in order on one request at a time.
      const messages = wait && !entry.viewer.closed ? await entry.viewer.drain(STREAM_WAIT_MS) : [];
      return { text: '', structuredContent: { messages } };
    },

    async emulator_status(threadId) {
      return text(await status(threadId));
    },

    async emulator_diagnostics(threadId) {
      // Do not use leases.get(): it removes stale leases. Preserve evidence and idle timers.
      const lease = Object.hasOwn(leases.leases, threadId) ? leases.leases[threadId] : null;
      const entry = mirrors.get(threadId);
      return { text: '', structuredContent: {
        schemaVersion: 1,
        device: leaseDiagnostics(lease),
        display: {
          viewers: viewers.get(threadId)?.size ?? 0,
          encoderActive: Boolean(entry),
          videoSessionReady: Boolean(entry?.mirror.session),
          retryPending: mirrorRetries.has(threadId),
          consecutiveFailures: mirrorFailures.get(threadId) ?? 0,
          inputActive: typing.has(threadId) || navigationRuns.has(threadId),
          navigationActive: navigationRuns.has(threadId),
        },
      } };
    },

    async emulator_panel(threadId) {
      const lease = leases.get(threadId);
      return {
        text: lease ? `Showing ${lease.avd} (${lease.serial}) in the emulator panel.` : 'Showing the emulator panel. No emulator is running for this thread yet.',
        structuredContent: { emulator: publicLease(lease) },
        meta: { panel: panelMeta(threadId), ...panelMetadata(threadId) },
      };
    },

    async emulator_manager(threadId) {
      const overview = await managerOverview();
      return {
        text: `${overview.running.length} emulator(s) running; ${overview.devices.length} device(s) using ${overview.totalSize}.`,
        structuredContent: { running: overview.running.length, devices: overview.devices.length },
        meta: { panel: panelMeta('manager') },
      };
    },

    async settings_read() {
      return { text: '', structuredContent: settings.describe(await leases.avds()) };
    },

    async settings_update(_threadId, { set }) {
      const qualityChanged = set?.videoQuality !== undefined && set.videoQuality !== settings.get('videoQuality');
      const values = settings.update(set);
      if (qualityChanged) {
        for (const threadId of [...mirrors.keys()]) {
          stopMirror(threadId);
          attachViewers(threadId);
        }
      }
      for (const threadId of viewers.keys()) pushStatus(threadId);
      return { text: 'Settings saved.', structuredContent: { values } };
    },

    async emulator_apk(threadId, { file, action = 'info', resourcePath }) {
      const apk = resourcePath;
      if (!apk) throw new Error(`The host did not provide a file path for ${file?.name ?? 'this APK'}.`);
      if (action === 'info') {
        const info = await apkInfo(apk);
        return {
          text: `${info.label ?? info.packageName} ${info.versionName ?? ''}`.trim(),
          structuredContent: { apk: { ...info, file: undefined, name: file?.name }, emulator: publicLease(leases.get(threadId)) },
          meta: { panel: panelMeta(threadId) },
        };
      }
      if (action !== 'install') throw new Error('action must be info or install.');
      let lease = leases.get(threadId);
      if (!lease) lease = await leases.start(threadId, { avd: defaultAvd(await leases.avds()) });
      const info = await installAndLaunch(threadId, lease.serial, apk);
      return { text: `Installed and opened ${info.label ?? info.packageName} on ${lease.avd}.`, structuredContent: { installed: true, emulator: publicLease(lease) } };
    },

    async emulator_mentions(threadId, { query = '' }) {
      const needle = query.toLowerCase();
      const items = (await leases.avds())
        .filter((name) => name.toLowerCase().includes(needle) || name.replaceAll('_', ' ').toLowerCase().includes(needle))
        .map((name) => ({ type: 'resource_link', uri: `emulator://avd/${encodeURIComponent(name)}`, name: name.replaceAll('_', ' '), description: 'Virtual device', mimeType: 'text/plain' }));
      const lease = leases.get(threadId);
      if (lease?.state === 'ready') {
        const packages = await deviceFor(threadId, lease.serial).installedPackages().catch(() => []);
        for (const pkg of packages.filter((name) => name.toLowerCase().includes(needle)).slice(0, 20)) {
          items.push({ type: 'resource_link', uri: `emulator://app/${encodeURIComponent(pkg)}`, name: pkg, description: `Installed on ${lease.avd.replaceAll('_', ' ')}`, mimeType: 'text/plain' });
        }
      }
      return { text: '', structuredContent: { items: items.slice(0, 40) } };
    },

    async emulator_record(threadId, { action }) {
      const lease = requireLease(threadId);
      if (action === 'start') {
        await recorderFor(threadId).start(lease.serial, threadId);
        pushStatus(threadId);
        return text('Recording started.');
      }
      if (action !== 'stop') throw new Error('action must be start or stop.');
      let capture;
      try { capture = await saveRecording(threadId, lease); }
      finally { pushStatus(threadId); }
      return {
        text: `Saved a ${capture.seconds}s recording to ${capture.file}. Use emulator_capture to copy the video file or inspect timestamped frames.`,
        structuredContent: { file: capture.file, seconds: capture.seconds, capture },
        meta: captureMeta(threadId, capture),
      };
    },

    async emulator_snapshot(threadId, { action, name }) {
      const lease = requireLease(threadId);
      if (lease.readOnly && action === 'save') throw new Error('This emulator is read-only, so snapshots cannot be saved. Start a writable instance to save one.');
      const snapshots = await deviceFor(threadId, lease.serial).snapshots(action, name);
      return { text: action === 'list' ? (snapshots.length ? snapshots.join('\n') : 'No snapshots.') : `Snapshot ${action}d: ${name}.`, structuredContent: { snapshots } };
    },

    async emulator_create(threadId, { profile, systemImage, name, keep = settings.get('keepCreatedDevices'), start = true }) {
      const created = await leases.create(threadId, { profileId: profile, imageId: systemImage, name, keep });
      const summary = `Created ${created.name} (${created.profile}, ${created.image})${keep ? '' : '; it is deleted when this thread is archived'}.`;
      if (!start) return text(summary);
      const lease = await leases.start(threadId, { avd: created.name });
      return text({ created: summary, emulator: publicLease(lease), next: 'Use the existing device panel. Call emulator_panel only if it is not open or the user asks to show it.' });
    },

    async emulator_start(threadId, { avd, readOnly, coldBoot } = {}) {
      const lease = await leases.start(threadId, { avd: avd ?? defaultAvd(await leases.avds()), readOnly, coldBoot });
      return text({ emulator: publicLease(lease), next: 'Use the existing device panel. Call emulator_panel only if it is not open or the user asks to show it.' });
    },

    async emulator_stop(threadId, { deleteDevice = false } = {}) {
      const lease = leases.get(threadId);
      const avd = lease?.avd;
      const capture = lease && isRecording(lease.serial) ? await saveRecording(threadId, lease) : null;
      const stopped = await leases.stop(threadId);
      const owned = leases.ownedAvds(threadId).map(({ name }) => name);
      const targets = deleteDevice ? (avd ? [avd] : owned).filter((name) => owned.includes(name)) : [];
      for (const name of targets) await leases.deleteOwned(threadId, name);
      const parts = [stopped ? `Stopped ${avd}.` : 'This thread had no running emulator.'];
      if (capture) parts.push(`Saved the active recording to ${capture.file}.`);
      if (targets.length) parts.push(`Deleted ${targets.join(', ')}.`);
      else if (deleteDevice && avd) parts.push(`Kept ${avd} because this thread did not create it.`);
      return text(parts.join(' '));
    },

    async emulator_screenshot(threadId, { save = false } = {}) {
      const { serial } = requireLease(threadId);
      const png = await deviceFor(threadId, serial).screenshot();
      if (!save) return { text: `Screenshot of ${serial}.`, image: { data: png.toString('base64'), mimeType: 'image/png' } };
      const capture = captures.create(threadId, { png, serial });
      return { text: `Screenshot of ${serial}. Saved to ${capture.file}.`, image: { data: png.toString('base64'), mimeType: 'image/png' },
        structuredContent: { capture }, meta: captureMeta(threadId, capture) };
    },

    async emulator_capture(threadId, { action, captureId } = {}) {
      if (action === 'list') return text(captures.list(threadId));
      const capture = captures.get(threadId, captureId);
      if (action === 'copy') {
        const copied = await copyCaptureToClipboard(capture.file, capture.mimeType);
        return { text: copied.kind === 'image' ? 'Screenshot copied to the clipboard.' : 'Video file copied to the clipboard. Paste it into an app that accepts files.', structuredContent: { capture, copied } };
      }
      if (action !== 'context') throw new Error('action must be list, copy, or context.');
      const context = await captures.context(threadId, captureId);
      return { text: context.text, images: context.images, structuredContent: { capture, resource: context.resource ?? null }, meta: captureMeta(threadId, capture) };
    },

    async emulator_ui_tree(threadId, { query } = {}) {
      const { serial } = requireLease(threadId);
      let nodes = await deviceFor(threadId, serial).uiNodes();
      if (query) {
        const needle = query.toLowerCase();
        nodes = nodes.filter((node) => [node.text, node.description, node.resourceId].some((value) => value.toLowerCase().includes(needle)));
      }
      return text(nodes.length ? formatNodes(nodes) : 'No matching UI nodes.');
    },

    async emulator_wait_for(threadId, { text: label, description, resourceId, state, timeoutMs } = {}) {
      const device = deviceFor(threadId, requireLease(threadId).serial);
      const selector = { text: label, description, resourceId };
      const { node, matches } = await device.waitForNode(selector, { state, timeoutMs });
      if (!node) return { text: 'The matching UI node is no longer visible.', structuredContent: { node: null, matches, state: 'disappeared' } };
      return { text: `Matched ${formatNodes([node])}${matches > 1 ? ` (first of ${matches} matches)` : ''}.`, structuredContent: { node, matches, state: 'appeared' } };
    },

    async emulator_tap(threadId, { x, y, text: label, description, resourceId, durationMs }) {
      const device = deviceFor(threadId, requireLease(threadId).serial);
      const hasCoordinates = x !== undefined || y !== undefined;
      if (hasCoordinates) {
        if (![x, y].every(Number.isFinite)) throw new Error('Provide finite x and y coordinates.');
        if (durationMs === undefined) {
          const learned = await learnNavigation(threadId, device, { action: 'tap', point: [x, y] });
          if (learned) { agentEvent(threadId, device.serial, { kind: 'tap', point: [x, y], label: 'Tap' }); return learned; }
        }
        await device.tap(x, y, durationMs);
        const action = durationMs === undefined ? 'Tapped' : 'Long pressed';
        agentEvent(threadId, device.serial, { kind: 'tap', point: [x, y], label: action });
        return text(`${action} (${Math.round(x)}, ${Math.round(y)})${durationMs === undefined ? '' : ` for ${durationMs}ms`}.`);
      }
      const nodes = await device.uiNodes();
      const { node, matches } = findNode(nodes, { text: label, description, resourceId });
      if (!node) throw new Error('No visible UI node matched. It may be off-screen: swipe and retry, or call emulator_ui_tree to inspect the screen.');
      if (durationMs === undefined && matches === 1 && !node.password && !node.editable) {
        const selector = [['resource_id', 'resourceId'], ['content_desc', 'description'], ['text', 'text']]
          .find(([, key]) => node[key] && nodes.filter(n => n[key] === node[key]).length === 1);
        if (selector) {
          const learned = await learnNavigation(threadId, device, { action: 'tap', selector: `${selector[0]}=${node[selector[1]]}` });
          if (learned) { agentEvent(threadId, device.serial, { kind: 'tap', point: node.center, bounds: node.bounds, label: 'Tap' }); return learned; }
        }
      }
      await device.tap(...node.center, durationMs);
      const action = durationMs === undefined ? 'Tapped' : 'Long pressed';
      agentEvent(threadId, device.serial, { kind: 'tap', point: node.center, bounds: node.bounds, label: node.text || node.description || node.resourceId.replace(/^.*:id\//, '') || action });
      return text(`${action} ${formatNodes([node])}${durationMs === undefined ? '' : ` for ${durationMs}ms`}${matches > 1 ? ` (first of ${matches} matches)` : ''}.`);
    },

    async emulator_swipe(threadId, { direction, x1, y1, x2, y2, durationMs }) {
      const device = deviceFor(threadId, requireLease(threadId).serial);
      if (direction && durationMs === undefined && [x1, y1, x2, y2].every(n => n === undefined)) {
        const contentDirection = { up: 'down', down: 'up', left: 'right', right: 'left' }[direction];
        if (!contentDirection) throw new Error('direction must be up, down, left, or right.');
        const learned = await learnNavigation(threadId, device, { action: 'scroll', direction: contentDirection });
        if (learned) return learned;
      }
      durationMs ??= 300;
      if (direction) {
        const { width, height } = await device.screenSize();
        const cx = width / 2;
        const cy = height / 2;
        const dx = width * 0.35;
        const dy = height * 0.3;
        const vectors = { up: [cx, cy + dy, cx, cy - dy], down: [cx, cy - dy, cx, cy + dy], left: [cx + dx, cy, cx - dx, cy], right: [cx - dx, cy, cx + dx, cy] };
        if (!vectors[direction]) throw new Error('direction must be up, down, left, or right.');
        [x1, y1, x2, y2] = vectors[direction];
      }
      if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error('Provide direction or x1, y1, x2, y2.');
      await device.swipe(x1, y1, x2, y2, durationMs);
      agentEvent(threadId, device.serial, { kind: 'swipe', point: [x1, y1], to: [x2, y2], label: direction ? `Swipe ${direction}` : 'Swipe' });
      return text(`Swiped (${Math.round(x1)}, ${Math.round(y1)}) → (${Math.round(x2)}, ${Math.round(y2)}).`);
    },

    async emulator_type(threadId, options) {
      const device = deviceFor(threadId, requireLease(threadId).serial);
      if (typing.has(threadId)) throw new Error('Another text entry is in progress for this chat. Wait for its result before typing again.');
      typing.add(threadId);
      try {
        // Reuse a visible stream's control socket, but do not start video solely to enter text.
        const entry = mirrors.get(threadId);
        let connection;
        if (entry) {
          clearTimeout(entry.idleTimer);
          await entry.ready;
          connection = entry.mirror;
        } else {
          connection = backends.get(threadId, 'connection').create({ serial: device.serial, log, video: false });
          inputConnections.set(threadId, connection);
          await connection.start();
        }
        const result = await typeIntoDevice(device, connection, options);
        agentEvent(threadId, device.serial, { kind: 'label', label: `Text input: ${result.characters} characters` });
        return {
          text: result.verified ? `Verified ${result.characters} characters${result.submitted ? ' and pressed Enter' : ''}.` : result.reason,
          structuredContent: result,
        };
      } finally {
        inputConnections.get(threadId)?.stop();
        inputConnections.delete(threadId);
        typing.delete(threadId);
        scheduleMirrorIdle(threadId, 0);
      }
    },

    async emulator_observe(threadId) {
      const { serial } = requireLease(threadId);
      const device = deviceFor(threadId, serial);
      const observation = await device.observe();
      // The requested observation is still useful if optional screen learning fails.
      let learned;
      try { learned = await learnNavigation(threadId, device, { action: 'whereami' }, { foregroundActivity: observation.foregroundActivity }); }
      catch { /* A read failure must not discard successful screenshot/UI reads. */ }
      const { screenshot, ...details } = observation;
      const errors = Object.entries(details.errors).map(([part, error]) => `${part}: ${error}`);
      return {
        text: [`Foreground: ${details.foregroundActivity ?? 'unavailable'}`, 'Read concurrently; the screenshot and elements may differ during animation.', details.nodes ? formatNodes(details.nodes) : 'UI elements unavailable.', ...errors].join('\n'),
        ...(screenshot ? { image: { data: screenshot.toString('base64'), mimeType: 'image/png' } } : {}),
        structuredContent: { serial, ...details, ...(learned?.structuredContent ?? {}), learning: navigation.learning.get(threadId) },
      };
    },

    async emulator_scroll_to(threadId, { text: label, description, resourceId, ...options } = {}) {
      const device = deviceFor(threadId, requireLease(threadId).serial);
      const result = await device.scrollTo({ text: label, description, resourceId }, options);
      agentEvent(threadId, device.serial, { kind: options.tap ? 'tap' : 'label', bounds: result.node.bounds, point: result.node.center, label: options.tap ? 'Found and tapped element' : 'Found element' });
      return { text: `Found after ${result.swipes} swipes${options.tap ? ' and tapped' : ''}: ${formatNodes([result.node])}`, structuredContent: result };
    },

    async emulator_app(threadId, options) {
      const device = deviceFor(threadId, requireLease(threadId).serial);
      const result = await device.app(options);
      if (options.action === 'restart') {
        try { await learnNavigation(threadId, device, { action: 'whereami' }, { packageName: options.packageName }); } catch {}
      }
      return { ...text(result), structuredContent: { learning: navigation.learning.get(threadId) } };
    },

    async emulator_key(threadId, { key }) {
      const device = deviceFor(threadId, requireLease(threadId).serial);
      if (resolveKeycode(key) === 4) {
        const learned = await learnNavigation(threadId, device, { action: 'back' });
        if (learned) return learned;
      }
      const code = await device.key(key);
      agentEvent(threadId, device.serial, { kind: 'label', label: `Pressed ${String(key).toUpperCase().replace(/^KEYCODE_/, '')}` });
      return text(`Pressed keycode ${code}.`);
    },

    async emulator_install(threadId, { apkPaths, grantPermissions }) {
      const device = deviceFor(threadId, requireLease(threadId).serial);
      const output = await device.install(apkPaths, { grantPermissions });
      agentEvent(threadId, device.serial, { kind: 'label', label: 'Installed app' });
      return text(output);
    },

    async emulator_open(threadId, { url, packageName, component }) {
      const device = deviceFor(threadId, requireLease(threadId).serial);
      const output = await device.open({ url, packageName, component });
      try { await learnNavigation(threadId, device, { action: 'whereami' }, { packageName: packageName || component?.split('/')[0] }); } catch {}
      return { ...text(output || 'Opened.'), structuredContent: { learning: navigation.learning.get(threadId) } };
    },

    async emulator_settings(threadId, changes) {
      const lease = requireLease(threadId);
      if (changes.posture !== undefined && !avdPostures(lease.avd).includes(changes.posture)) {
        throw new Error(`${lease.avd} does not support posture "${changes.posture}". Use a foldable AVD with hinge support.`);
      }
      const applied = await deviceFor(threadId, lease.serial).applySettings(changes);
      if (changes.rotate || changes.posture) screenSizes.delete(lease.serial);
      if (changes.posture) pushStatus(threadId);
      return text(applied.length ? `Applied: ${applied.join('; ')}.` : 'No settings were provided.');
    },

    async emulator_adb(threadId, { args, timeoutMs }) {
      return text(await scopedAdb(requireLease(threadId).serial, args, { timeoutMs }));
    },
  };

  // ---- Mirroring -------------------------------------------------------------

  function broadcast(threadId, frame, droppable) {
    for (const viewer of viewers.get(threadId) ?? []) {
      if (droppable && viewer.needsKeyFrame) continue;
      if (droppable && !(viewer instanceof BridgeViewer) && viewer.bufferedAmount > MAX_VIEWER_BACKLOG) {
        viewer.needsKeyFrame = true;
        mirrors.get(threadId)?.mirror.requestKeyFrame('socket backlog');
        continue;
      }
      viewer.sendBinary(frame);
    }
  }

  function sessionFrame({ width, height }) {
    const frame = Buffer.alloc(9);
    frame[0] = 1;
    frame.writeUInt32BE(width, 1);
    frame.writeUInt32BE(height, 5);
    return frame;
  }

  function packetFrame({ config, key, pts, data }) {
    const header = Buffer.alloc(10);
    header[0] = config ? 2 : 3;
    header[1] = key ? 1 : 0;
    header.writeBigUInt64BE(pts, 2);
    return [header, data];
  }

  function ensureMirror(threadId) {
    if (closed) return null;
    clearTimeout(mirrorRetries.get(threadId));
    mirrorRetries.delete(threadId);
    const existing = mirrors.get(threadId);
    if (existing) {
      clearTimeout(existing.idleTimer);
      return existing;
    }
    const lease = leases.get(threadId);
    if (!lease || lease.state !== 'ready') return null;
    const provider = backends.get(threadId, 'connection');
    const startedAt = performance.now();
    const quality = settings.get('videoQuality');
    backends.counter(threadId, 'connection', provider, { count: 1 }, quality);
    let mirror;
    try { mirror = provider.create({ serial: lease.serial, log, ...VIDEO_QUALITY[quality] }); }
    catch (error) { backends.counter(threadId, 'connection', provider, { errors: 1 }, quality); throw error; }
    let firstFrame = true;
    mirror.on('session', (session) => {
      if (closed || mirrors.get(threadId)?.mirror !== mirror) return;
      mirrorFailures.delete(threadId);
      broadcast(threadId, sessionFrame(session), false);
    });
    mirror.on('packet', (packet) => {
      if (closed || mirrors.get(threadId)?.mirror !== mirror) return;
      backends.counter(threadId, 'connection', provider, { packets: 1, bytes: packet.data.length,
        ...(!packet.config ? { frames: 1 } : {}),
        ...(!packet.config && firstFrame ? { durationMs: performance.now() - startedAt } : {}),
      }, quality);
      if (!packet.config) firstFrame = false;
      if (!viewers.get(threadId)?.size) return;
      if (packet.key) {
        for (const viewer of viewers.get(threadId) ?? []) {
          if (!(viewer instanceof BridgeViewer) && viewer.bufferedAmount <= MAX_VIEWER_BACKLOG) viewer.needsKeyFrame = false;
        }
      }
      broadcast(threadId, Buffer.concat(packetFrame(packet)), !packet.config && !packet.key);
    });
    const ended = () => {
      if (closed || mirrors.get(threadId)?.mirror !== mirror) return;
      mirrors.delete(threadId);
      backends.counter(threadId, 'connection', provider, { errors: 1 }, quality);
      for (const viewer of viewers.get(threadId) ?? []) viewer.sendJson({ t: 'mirror-ended', reason: 'The display connection failed. Reconnecting automatically…' });
      if (viewers.get(threadId)?.size && leases.get(threadId)?.state === 'ready') {
        const failures = (mirrorFailures.get(threadId) ?? 0) + 1;
        mirrorFailures.set(threadId, failures);
        mirrorRetries.set(threadId, setTimeout(() => {
          mirrorRetries.delete(threadId);
          if (viewers.get(threadId)?.size) attachViewers(threadId);
        }, Math.min(30_000, 1_000 * 2 ** (failures - 1))));
      }
    };
    mirror.on('end', ended);
    const entry = { mirror, ready: Promise.resolve().then(() => mirror.start()) };
    entry.ready.catch((error) => {
      log(`mirror start failed for ${lease.serial}: ${error.message}`);
      mirror.stop();
      ended();
    });
    mirrors.set(threadId, entry);
    return entry;
  }

  function stopMirror(threadId) {
    clearTimeout(mirrorRetries.get(threadId));
    mirrorRetries.delete(threadId);
    const entry = mirrors.get(threadId);
    if (!entry) return;
    mirrors.delete(threadId);
    clearTimeout(entry.idleTimer);
    entry.mirror.stop();
  }

  // Starts (or joins) the mirror and primes each viewer with the current session and a fresh key frame.
  async function attachViewers(threadId, targets = viewers.get(threadId) ?? []) {
    let entry;
    try { entry = ensureMirror(threadId); }
    catch (error) {
      for (const viewer of targets) viewer.sendJson({ t: 'error', error: `Display backend could not start: ${error.message}` });
      return;
    }
    if (!entry) return;
    try {
      await entry.ready;
    } catch {
      return;
    }
    for (const viewer of targets) {
      if (!viewers.get(threadId)?.has(viewer)) continue;
      viewer.needsKeyFrame = true;
      if (entry.mirror.session) viewer.sendBinary(sessionFrame(entry.mirror.session));
      if (entry.mirror.config) viewer.sendBinary(Buffer.concat(packetFrame({ config: true, key: false, pts: 0n, data: entry.mirror.config })));
    }
    entry.mirror.requestKeyFrame('viewer joined');
  }

  function scheduleMirrorIdle(threadId, delayMs = MIRROR_IDLE_MS) {
    const entry = mirrors.get(threadId);
    if (!entry || viewers.get(threadId)?.size || typing.has(threadId)) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      // Startup owns asynchronous socket/forward creation; let it settle before releasing those resources.
      const stopIfIdle = () => {
        if (mirrors.get(threadId) === entry && !viewers.get(threadId)?.size && !typing.has(threadId)) stopMirror(threadId);
      };
      entry.ready.then(stopIfIdle, stopIfIdle);
    }, delayMs);
  }

  function detachViewer(threadId, viewer) {
    const set = viewers.get(threadId);
    set?.delete(viewer);
    unsubscribeLogcat(threadId, viewer);
    if (set?.size) return;
    viewers.delete(threadId);
    scheduleMirrorIdle(threadId);
  }

  leases.on('change', (threadId) => {
    const lease = leases.get(threadId);
    if (!lease) {
      invalidatePlace(threadId);
      recorders.forEach(recorder => recorder.discardThread(threadId));
      inputConnections.get(threadId)?.stop();
      stopMirror(threadId);
      for (const viewer of logcats.get(threadId)?.subscribers ?? []) unsubscribeLogcat(threadId, viewer);
    }
    pushStatus(threadId);
    if (lease?.state === 'ready' && viewers.get(threadId)?.size) attachViewers(threadId);
  });

  function subscribeLogcat(threadId, viewer) {
    const lease = leases.get(threadId);
    if (!lease || lease.state !== 'ready') return;
    let entry = logcats.get(threadId);
    if (!entry) {
      const subscribers = new Set();
      const logcat = createLogcat(lease.serial, (lines) => {
        for (const subscriber of subscribers) subscriber.sendJson({ t: 'logcat', lines });
      });
      entry = { subscribers, logcat };
      logcats.set(threadId, entry);
    }
    entry.subscribers.add(viewer);
  }

  function unsubscribeLogcat(threadId, viewer) {
    const entry = logcats.get(threadId);
    if (!entry) return;
    entry.subscribers.delete(viewer);
    if (!entry.subscribers.size) {
      entry.logcat.stop();
      logcats.delete(threadId);
    }
  }

  // Actions the panel can run. Manager actions act across threads because the user runs them directly.
  async function deleteSavedDevice({ avd, confirmed } = {}) {
    if (confirmed !== true) throw new Error('Confirm device deletion before continuing.');
    await leases.deleteSaved(avd);
  }

  const paneActions = {
    emulator_navigate: (threadId, args) => tools.emulator_navigate(threadId, args),
    emulator_start: (threadId, args) => tools.emulator_start(threadId, args),
    emulator_stop: (threadId, args) => tools.emulator_stop(threadId, args),
    emulator_create: (threadId, args) => tools.emulator_create(threadId, args),
    async emulator_delete_avd(threadId, args) {
      await deleteSavedDevice(args);
      return status(threadId, { forPane: true });
    },
    emulator_settings: (threadId, args) => tools.emulator_settings(threadId, args),
    emulator_screenshot: (threadId, args) => tools.emulator_screenshot(threadId, args),
    emulator_record: (threadId, args) => tools.emulator_record(threadId, args),
    emulator_capture: (threadId, args) => tools.emulator_capture(threadId, args),
    emulator_capture_selection: (threadId, { captureIds } = {}) => ({ captureIds: captures.selection(threadId, captureIds) }),
    emulator_snapshot: (threadId, args) => tools.emulator_snapshot(threadId, args),
    async emulator_context(threadId) {
      const lease = requireLease(threadId);
      const device = deviceFor(threadId, lease.serial);
      const [png, activity] = await Promise.all([device.screenshot(), device.foregroundActivity().catch(() => null)]);
      return { avd: lease.avd, serial: lease.serial, activity, image: { data: png.toString('base64'), mimeType: 'image/png' } };
    },
    manager_overview: () => managerOverview(),
    async manager_stop(_threadId, { threadId }) {
      if (!leases.get(threadId)) throw new Error('That emulator is no longer running.');
      await cancelNavigation(threadId);
      await leases.stop(threadId);
      return managerOverview();
    },
    async manager_delete(_threadId, args) {
      await deleteSavedDevice(args);
      return managerOverview();
    },
  };

  async function reply(viewer, id, work) {
    try {
      viewer.sendJson({ t: 'result', id, ok: true, result: await work() });
    } catch (error) {
      viewer.sendJson({ t: 'result', id, ok: false, error: error.message });
    }
  }

  // APKs dropped on the panel arrive as base64 chunks over the viewer channel (WebSocket or bridge), then install and launch.
  async function receiveUpload(threadId, viewer, { upload, name, offset, data, done }) {
    viewer.uploads ??= new Map();
    let entry = viewer.uploads.get(upload);
    if (!entry) {
      if (offset !== 0) throw new Error('Upload must start at the beginning of the file.');
      const safe = path.basename(String(name ?? 'upload.apk')).replace(/[^A-Za-z0-9._-]/g, '_');
      const uploads = path.join(dir, 'uploads');
      fs.mkdirSync(uploads, { recursive: true });
      entry = { file: path.join(uploads, `${crypto.randomUUID()}-${safe.endsWith('.apk') ? safe : `${safe}.apk`}`), size: 0 };
      viewer.uploads.set(upload, entry);
      viewer.once('close', () => fs.rmSync(entry.file, { force: true }));
    }
    const discard = () => {
      viewer.uploads.delete(upload);
      fs.rmSync(entry.file, { force: true });
    };
    if (offset !== entry.size) {
      discard();
      throw new Error('Upload chunks arrived out of order.');
    }
    const chunk = Buffer.from(String(data ?? ''), 'base64');
    entry.size += chunk.length;
    if (entry.size > MAX_UPLOAD_BYTES) {
      discard();
      throw new Error('Upload is larger than 1 GB.');
    }
    fs.appendFileSync(entry.file, chunk, { mode: 0o600 });
    if (!done) return { received: entry.size };
    try {
      const info = await installAndLaunch(threadId, requireLease(threadId).serial, entry.file);
      return { label: info.label ?? info.packageName, packageName: info.packageName };
    } finally {
      discard();
    }
  }

  async function handleViewerMessage(threadId, viewer, message) {
    if (!message || typeof message !== 'object') return;
    const mirror = mirrors.get(threadId)?.mirror;
    const size = mirror?.session;
    leases.touch(threadId);
    if (['touch', 'scroll', 'key', 'text', 'paste'].includes(message.t)) {
      if (navigationRuns.has(threadId)) { viewer.sendJson({ t: 'error', error: 'Navigation is using this device. Open Screen map and stop navigation to take control.' }); return; }
      invalidatePlace(threadId);
    }
    switch (message.t) {
      case 'touch':
        if (size) mirror.touch({ action: message.a, x: message.x, y: message.y, ...size });
        return;
      case 'scroll':
        if (size) mirror.scroll({ x: message.x, y: message.y, ...size, hscroll: message.h, vscroll: message.v });
        return;
      case 'key': {
        const code = resolveKeycode(message.key);
        const metaState = message.meta ?? 0;
        mirror?.pressKey(code, metaState);
        return;
      }
      case 'text':
        mirror?.typeText(String(message.s ?? ''));
        return;
      case 'paste':
        mirror?.pasteText(String(message.s ?? ''));
        return;
      case 'reconnect':
        requireLease(threadId);
        if (mirrors.has(threadId) && !mirror?.session) return;
        stopMirror(threadId);
        mirrorFailures.delete(threadId);
        await attachViewers(threadId);
        return;
      case 'keyframe':
        mirror?.requestKeyFrame('decoder recovery');
        return;
      case 'logcat':
        if (message.on) subscribeLogcat(threadId, viewer);
        else unsubscribeLogcat(threadId, viewer);
        return;
      case 'call':
        return reply(viewer, message.id, () => {
          if (!Object.hasOwn(paneActions, message.tool)) throw new Error(`Unsupported pane action ${message.tool}`);
          assertPanelAction(threadId, message.tool);
          return operation(threadId, () => paneActions[message.tool](threadId, message.args ?? {}), message.tool, message.args);
        });
      case 'upload':
        return reply(viewer, message.id, () => operation(threadId, () => receiveUpload(threadId, viewer, message), 'upload'));
      default:
    }
  }

  // ---- HTTP ------------------------------------------------------------------

  function authorized(req) {
    return matchesKey(req.headers.authorization?.replace(/^Bearer /, ''), token);
  }

  function validHost(req) {
    return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
  }

  function sendJson(res, statusCode, value) {
    res.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(value));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          chunks.length = 0;
          reject(new Error('Request body is too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const STATIC = {
    '/static/app.js': ['app.js', 'text/javascript'],
    '/static/app.css': ['app.css', 'text/css'],
  };

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!validHost(req)) return sendJson(res, 403, { error: 'Invalid host' });
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, version: HELPER_VERSION, pluginVersion: PLUGIN_VERSION, pid: process.pid, capabilities: { diagnostics: true } });

    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      return fs.createReadStream(path.join(WEB_DIR, file)).pipe(res);
    }
    if (url.pathname === '/host/panel.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
      return res.end(panelScript ? fs.readFileSync(panelScript, 'utf8') : '');
    }
    const captureMatch = url.pathname.match(/^\/captures\/([^/]+)\/([a-f0-9-]{36})$/);
    if (req.method === 'GET' && captureMatch) {
      const thread = decodeURIComponent(captureMatch[1]);
      const id = captureMatch[2];
      if (!matchesKey(url.searchParams.get('k'), scopedKey(token, `capture:${thread}:${id}`))) return sendJson(res, 401, { error: 'Unauthorized' });
      let capture;
      try { capture = captures.get(thread, id); } catch { return sendJson(res, 404, { error: 'Capture not found' }); }
      res.writeHead(200, { 'content-type': capture.mimeType, 'content-disposition': `attachment; filename="${capture.name}"`, 'cache-control': 'no-store' });
      return fs.createReadStream(capture.file).pipe(res);
    }
    const recordingMatch = url.pathname.match(/^\/recordings\/([^/]+\.mp4)$/);
    if (req.method === 'GET' && recordingMatch) {
      if (!matchesKey(url.searchParams.get('k'), scopedKey(token, `recording:${decodeURIComponent(recordingMatch[1])}`))) return sendJson(res, 401, { error: 'Unauthorized' });
      const file = path.join(dir, 'recordings', path.basename(decodeURIComponent(recordingMatch[1])));
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Recording not found' });
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-disposition': `attachment; filename="${path.basename(file)}"`, 'access-control-allow-origin': '*' });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/t/')) {
      const threadId = decodeURIComponent(url.pathname.slice(3));
      if (!matchesKey(url.searchParams.get('k'), channelKey(threadId))) return sendJson(res, 401, { error: 'Unauthorized' });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data: blob:; style-src 'self'; script-src 'self'",
      });
      const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
      return res.end(html.replace('<meta name="emulator-theme" content="" />', () => `<meta name="emulator-theme" content="${themeAttribute(theme)}" />`).replace('<body>', `<body data-view="${threadId === 'manager' ? 'manager' : 'device'}">`));
    }

    if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    if (req.method === 'POST' && url.pathname === '/api/call') {
      try {
        const { threadId, tool, args } = JSON.parse(await readBody(req));
        if (!Object.hasOwn(tools, tool)) throw new Error(`Unknown tool ${tool}`);
        if (!threadId && !THREADLESS.has(tool)) throw new Error('Missing thread identity.');
        if (threadId && tool !== 'emulator_diagnostics') leases.touch(threadId);
        return sendJson(res, 200, { ok: true, result: await (['emulator_stream', 'emulator_status', 'emulator_diagnostics'].includes(tool)
          ? tools[tool](threadId ?? '', args ?? {})
          : operation(threadId, () => tools[tool](threadId ?? '', args ?? {}), tool, args)) });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error.message, errorCode: errorDetails(error).code });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      sendJson(res, 200, { ok: true });
      log('shutdown requested');
      setImmediate(() => close());
      return undefined;
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const threadId = url.searchParams.get('thread');
    if (!validHost(req) || !threadId || !matchesKey(url.searchParams.get('k'), channelKey(threadId)) || url.pathname !== '/ws') {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const viewer = upgrade(req, socket);
    if (!viewer) return;
    viewer.on('message', (raw, binary) => {
      if (binary) return;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      handleViewerMessage(threadId, viewer, message).catch((error) => log(`viewer message failed: ${error.message}`));
    });
    addViewer(threadId, viewer);
  });

  // Registers a pane viewer (WebSocket or bridge), sends it the current status, and joins it to the mirror.
  function addViewer(threadId, viewer) {
    if (!viewers.has(threadId)) viewers.set(threadId, new Set());
    viewers.get(threadId).add(viewer);
    viewer.on('keyframe', (reason) => mirrors.get(threadId)?.mirror.requestKeyFrame(`bridge backlog: ${reason}`));
    viewer.on('close', () => detachViewer(threadId, viewer));
    status(threadId, { forPane: true }).then((value) => viewer.sendJson({ t: 'status', ...value }), (error) => viewer.sendJson({ t: 'error', error: error.message }));
    attachViewers(threadId, [viewer]);
  }

  // Bridge viewers have no socket to close; drop the ones whose panel stopped polling.
  const bridgeSweep = setInterval(() => {
    for (const [id, { viewer }] of bridges) {
      const idleMs = Date.now() - viewer.lastSeen;
      if (!viewer.polling && idleMs > BRIDGE_IDLE_MS) viewer.close();
      if (viewer.closed && idleMs > 60_000) bridges.delete(id);
    }
  }, 5_000).unref();

  const leaseSweep = setInterval(() => {
    leases.sweep({ isBusy: threadId => activeOperations.has(threadId), idleMs: settings.get('idleMinutes') * 60_000, isWatched: (threadId) => (viewers.get(threadId)?.size ?? 0) > 0 }).catch((error) => log(`sweep failed: ${error.message}`));
  }, SWEEP_INTERVAL_MS).unref();

  const stopAppearance = appearance.subscribe?.(next => {
    if (JSON.stringify(next) === JSON.stringify(theme)) return;
    theme = next;
    for (const set of viewers.values()) for (const viewer of set) viewer.sendJson({ t: 'theme', theme });
  });

  let closing;
  function close() {
    if (closing) return closing;
    closed = true;
    for (const timer of mirrorRetries.values()) clearTimeout(timer);
    mirrorRetries.clear();
    clearInterval(bridgeSweep);
    clearInterval(leaseSweep);
    stopAppearance?.();
    for (const set of viewers.values()) for (const viewer of set) viewer.close();
    for (const connection of inputConnections.values()) connection.stop();
    for (const threadId of mirrors.keys()) stopMirror(threadId);
    for (const threadId of Object.keys(leases.leases)) recorders.forEach(recorder => recorder.discardThread(threadId));
    const stoppedNavigation = Promise.allSettled([...navigationRuns.keys()].map(cancelNavigation));
    closing = Promise.all([stoppedNavigation, new Promise(resolve => server.close(resolve))]).then(() => {});
    server.closeAllConnections();
    return closing;
  }

  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ port, pid: process.pid, version: HELPER_VERSION, pluginVersion: PLUGIN_VERSION }), { mode: 0o600 });
  log(`Android Emulators ${PLUGIN_VERSION} listening on 127.0.0.1:${port}`);

  return { port, close };
}

// Android Emulators UI. Runs in a host panel or as a page served by the local helper.
const $ = (id) => document.getElementById(id);
const view = document.body.dataset.view ?? 'device';
const host = globalThis.emulatorHost;
const embedded = Boolean(host?.embedded);

const stage = $('stage');
const device = $('device');
const screenBox = $('screen-box');
const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const agentLayer = $('agent-layer');
const keyboard = $('keys');
const message = $('message');
const launcher = $('launcher');
const drawer = $('drawer');
const minimapDrawer = $('minimap-drawer');
const menu = $('device-menu');

let capabilities = {};
let socketUrl = null;
let fallbackUrl = null;
let lastStatus = null;
let session = null;
let decoder = null;
let codec = null;
let config = null;
let waitingForKey = true;
let activePointerId = null;
let postureChanging = false;
let framesDrawn = 0;
let pendingFrame = null;
let paintRequest = null;
let connected = false;
let displayReady = false;
let displayError = '';
let displayConnectingAt = Date.now();
let displayRecoveryAttempted = false;
let callId = 0;
let minimapMap = null;
let minimapBusyUI = false;
let minimapCancelling = false;
let minimapRefreshId = 0;
const pending = new Map();
const pretty = (name) => name.replaceAll('_', ' ');

// ---- Host integration -----------------------------------------------------------

function applyHostContext(context = {}) {
  if (context.theme === 'light' || context.theme === 'dark') hostMode = context.theme;
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (value) document.documentElement.style.setProperty(name, value);
    else document.documentElement.style.removeProperty(name);
  }
  applyTheme();
  if (context.displayMode) setDisplayMode(context.displayMode);
}

function setDisplayMode(mode) {
  const inline = mode === 'inline';
  document.body.classList.toggle('inline', inline);
  $('expand').hidden = !(embedded && inline);
  if (inline) host?.setDisplayMode?.(mode);
}

async function initHost() {
  host.onContextChange(applyHostContext);
  const init = await host.initialize();
  capabilities = init?.capabilities ?? {};
  applyHostContext(init?.context);
}

const SERVER_ERROR_CODES = new Set([
  'AE_HELPER_START',
  'AE_HELPER_CONNECT',
  'AE_THREAD_REQUIRED',
  'AE_RESOURCE_LOAD',
  'AE_ACTION_FAILED',
]);

function codedError(code, text, cause) {
  const error = Object.assign(new Error(text), { code });
  if (cause) error.cause = cause;
  return error;
}

function safeServerMessage(value, fallback) {
  if (typeof value !== 'string' || value.length > 280 || /https?:\/\/|(?:token|key|authorization)=/i.test(value)) return fallback;
  return value;
}

function panelError(result, fallbackCode, fallbackMessage) {
  const error = result?.structuredContent?.error;
  if (SERVER_ERROR_CODES.has(error?.code)) return codedError(error.code, safeServerMessage(error.message, fallbackMessage));
  return codedError(fallbackCode, fallbackMessage);
}

function showPanelError(error, action) {
  const code = error?.code ?? 'AE_PANEL_INIT';
  const text = error?.message ?? 'The emulator panel could not start. Reopen the panel and try again.';
  message.replaceChildren(
    element('span', { className: 'mono', textContent: code }),
    element('span', { textContent: text }),
    ...(action ? [action] : []),
  );
  message.classList.add('stacked');
  message.hidden = false;
}

// ---- Theme ------------------------------------------------------------------
// Mode comes from the host when embedded, else the supplied host appearance, else the system.

const systemLight = matchMedia('(prefers-color-scheme: light)');
let hostMode = null;
let hostTheme = (() => {
  try {
    return JSON.parse(document.querySelector('meta[name="emulator-theme"]')?.content || 'null');
  } catch {
    return null;
  }
})();

// CSS variables for one mode of a host theme; mixes keep every tint derived from its surface and ink.
export function themeVariables(chrome, light) {
  const vars = {};
  const { surface, ink, accent, contrast, fontUi, fontCode } = chrome ?? {};
  const mix = (a, b, percent) => `color-mix(in srgb, ${a} ${percent}%, ${b})`;
  const k = (contrast ?? 50) / 100;
  if (surface) {
    vars['--emulator-bg'] = surface;
    vars['--emulator-surface'] = light ? mix(surface, '#fff', 45) : mix(ink ?? '#fff', surface, 5);
  }
  if (surface && ink) {
    vars['--emulator-raised'] = mix(ink, surface, light ? 4 + 3 * k : 8);
    vars['--emulator-text-2'] = mix(ink, surface, 68);
    vars['--emulator-text-3'] = mix(ink, surface, 45);
  }
  if (ink) {
    vars['--emulator-text'] = ink;
    vars['--emulator-line'] = mix(ink, 'transparent', (light ? 7 : 6) + 6 * k);
    vars['--emulator-line-strong'] = mix(ink, 'transparent', (light ? 13 : 11) + 9 * k);
    vars['--emulator-hover'] = mix(ink, 'transparent', light ? 5 : 6);
    vars['--emulator-pressed'] = mix(ink, 'transparent', light ? 9 : 10);
  }
  if (accent) vars['--emulator-accent'] = accent;
  if (fontUi) vars['--emulator-font'] = `"${fontUi}", -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
  if (fontCode) vars['--emulator-mono'] = `"${fontCode}", "SF Mono", ui-monospace, Menlo, monospace`;
  return vars;
}

function applyTheme() {
  const configured = hostTheme?.mode === 'light' || hostTheme?.mode === 'dark' ? hostTheme.mode : null;
  const mode = hostMode ?? configured ?? (systemLight.matches ? 'light' : 'dark');
  const root = document.documentElement;
  root.dataset.theme = mode;
  for (const name of [...root.style]) if (name.startsWith('--emulator-')) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(themeVariables(hostTheme?.[mode], mode === 'light'))) root.style.setProperty(name, value);
}

systemLight.addEventListener('change', applyTheme);

// ---- Tooltips ---------------------------------------------------------------
// Native title bubbles are unreliable inside embedded panels. Keep one label outside the scrolling rail.
const tooltip = $('tooltip');
let tooltipTarget = null;
let tooltipTimer = null;

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTarget = null;
  tooltip.hidden = true;
}

function setTooltip(button, label) {
  if (button.dataset.tooltip === label) return;
  button.dataset.tooltip = label;
  button.setAttribute('aria-label', label);
  if (tooltipTarget === button) hideTooltip();
}

function showTooltip(button) {
  hideTooltip();
  tooltipTarget = button;
  tooltipTimer = setTimeout(() => {
    if (!button.isConnected || !button.getClientRects().length) return hideTooltip();
    tooltip.textContent = button.dataset.tooltip;
    tooltip.hidden = false;
    const rect = button.getBoundingClientRect();
    const { width, height } = tooltip.getBoundingClientRect();
    const rail = button.closest('#rail');
    const left = rail ? rect.left - width - 8 : rect.left + (rect.width - width) / 2;
    const top = rail ? rect.top + (rect.height - height) / 2 : rect.bottom + 8;
    tooltip.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
  }, 250);
}

for (const button of document.querySelectorAll('[data-tooltip]')) {
  button.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'touch') showTooltip(button);
  });
  button.addEventListener('pointerleave', hideTooltip);
  button.addEventListener('focus', () => showTooltip(button));
  button.addEventListener('blur', hideTooltip);
}
document.addEventListener('pointerdown', hideTooltip, true);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideTooltip(); });
document.addEventListener('scroll', hideTooltip, true);
window.addEventListener('resize', hideTooltip);
window.addEventListener('blur', hideTooltip);

// ---- Connection -------------------------------------------------------------
// The helper page talks to the helper over a WebSocket. Embedded hosts can instead
// exchange the same messages through the `emulator_stream` tool.

const POLL_INTERVAL_MS = 33; // at most ~30 polls a second while the screen is changing; idle polls wait on the helper
const UPLOAD_CHUNK_BYTES = 512 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let transport = null;
let channel = null;

// Iframes inherit document visibility, but CSS-hidden panels need an intersection signal too.
let panelInViewport = true;
let pageHidden = false;
let disposed = false;
let activeUploads = 0;
let reconcileStream = () => {};
const visibilityWaiters = new Set();

function panelVisible() {
  return !disposed && !pageHidden && !document.hidden && panelInViewport;
}

function streamNeeded() {
  return !disposed && !pageHidden && (panelVisible() || pending.size > 0 || activeUploads > 0);
}

function visibilityChanged() {
  reconcileStream();
  for (const wake of visibilityWaiters) wake();
}

function watchVisibility() {
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', () => { pageHidden = true; visibilityChanged(); });
  window.addEventListener('pageshow', () => { pageHidden = false; visibilityChanged(); });
  let observer;
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(([entry]) => {
      panelInViewport = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      visibilityChanged();
    });
    observer.observe(document.documentElement);
  }
  host?.onTeardown?.(() => {
    disposed = true;
    observer?.disconnect();
    visibilityChanged();
  });
}

function waitForStream() {
  if (streamNeeded() || disposed) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      if (!streamNeeded() && !disposed) return;
      visibilityWaiters.delete(wake);
      resolve();
    };
    visibilityWaiters.add(wake);
    wake();
  });
}

function onConnected() {
  connected = true;
  displayConnectingAt = Date.now();
  if (view === 'manager') refreshManager();
  else if (view === 'device') render();
  if (!$('logcat').hidden) send({ t: 'logcat', on: true });
}

function onDisconnected() {
  connected = false;
  activePointerId = null;
  rejectPending(new Error('The connection was interrupted. Check the result before trying the action again.'));
  resetDecoder();
  session = null;
  displayReady = false;
  displayError = '';
  displayConnectingAt = Date.now();
  if (view === 'device') render();
  showMessage('Reconnecting to the emulator helper…');
}

function connect() {
  watchVisibility();
  return channel ? connectBridge() : connectSocket();
}

function connectSocket() {
  let socket = null;
  let retry = null;
  reconcileStream = () => {
    if (!streamNeeded()) {
      clearTimeout(retry);
      retry = null;
      if (socket) {
        const previous = socket;
        socket = null;
        previous.onopen = previous.onmessage = previous.onclose = null;
        previous.close();
        onDisconnected();
      }
      return;
    }
    if (socket || retry) return;
    const ws = socket = new WebSocket(socketUrl);
    ws.binaryType = 'arraybuffer';
    transport = { send: (value) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(value)) };
    ws.onopen = onConnected;
    ws.onmessage = (event) => (typeof event.data === 'string' ? onJson(JSON.parse(event.data)) : onBinary(event.data));
    ws.onclose = () => {
      socket = null;
      onDisconnected();
      retry = setTimeout(() => { retry = null; reconcileStream(); }, 1000);
    };
  };
  reconcileStream();
}

function connectBridge() {
  let streamSession = null;
  const stream = async (sessionId, args) => {
    let result;
    try {
      result = await host.callTool('emulator_stream', { ...channel, session: sessionId, ...args }, 15_000);
    } catch (error) {
      throw codedError('AE_STREAM_CONNECT', 'The panel could not connect to the emulator helper. Reopen the panel and try again.', error);
    }
    if (result?.isError) throw panelError(result, 'AE_STREAM_CONNECT', 'The emulator stream could not be reached. Reopen the panel and try again.');
    return result?.structuredContent?.messages ?? [];
  };
  // Input goes out on its own calls, batched while one is in flight, so taps never wait behind a held poll.
  let outbox = [];
  let sending = false;
  const flush = async () => {
    if (sending || !outbox.length || !streamSession) return;
    sending = true;
    const batch = outbox;
    const sendingSession = streamSession;
    outbox = [];
    await stream(sendingSession, { send: batch }).catch((error) => {
      if (sendingSession !== streamSession) return;
      rejectPending(error);
      toast(`Input could not be sent: ${error.message}`);
    });
    sending = false;
    flush();
    reconcileStream();
  };
  transport = {
    send: (value) => {
      if (!streamSession) return false;
      outbox.push(value);
      flush();
      return true;
    },
  };
  const closeSession = () => {
    const previous = streamSession;
    streamSession = null;
    outbox = []; // Never replay input on a replacement connection.
    if (previous) {
      stream(previous, { send: [{ t: 'bye' }] }).catch(() => {});
      onDisconnected();
    }
  };
  reconcileStream = () => {
    if (!streamNeeded()) closeSession();
  };
  (async () => {
    let failures = 0;
    while (!disposed) {
      await waitForStream();
      if (disposed) break;
      if (!streamNeeded()) continue;
      if (!streamSession) streamSession = crypto.randomUUID();
      const pollingSession = streamSession;
      const started = performance.now();
      try {
        const messages = await stream(pollingSession, { wait: true });
        // A held poll may complete after the panel was hidden or removed.
        if (pollingSession !== streamSession) continue;
        if (!connected) onConnected();
        failures = 0;
        for (const item of messages) {
          if (item.b === undefined) onJson(item.j);
          else onBinary(fromBase64(item.b));
        }
      } catch (error) {
        if (pollingSession !== streamSession) continue;
        failures += 1;
        closeSession();
        if (failures >= 3) showBrowserFallback(error);
        await sleep(Math.min(failures, 5) * 1000);
      }
      const elapsed = performance.now() - started;
      if (elapsed < POLL_INTERVAL_MS) await sleep(POLL_INTERVAL_MS - elapsed);
    }
  })();
}

function fromBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text).buffer;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.toBase64) return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function showBrowserFallback(error = codedError('AE_STREAM_CONNECT', 'The panel could not connect to the emulator helper. Reopen the panel and try again.')) {
  const open = Object.assign(document.createElement('button'), { type: 'button', className: 'button', textContent: 'Open in browser pane' });
  open.addEventListener('click', () => {
    const opening = host?.openUrl?.(fallbackUrl);
    if (opening) opening.catch(() => window.open(fallbackUrl));
    else window.open(fallbackUrl);
  });
  showPanelError(error, open);
}

function send(value) {
  if (!connected || !transport) return false;
  return transport.send(value) !== false;
}

function request(value) {
  if (!connected || !transport) return Promise.reject(new Error('The emulator is reconnecting. Wait for the connection before trying again.'));
  const id = ++callId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The action timed out. Check the emulator before trying again.'));
      reconcileStream();
    }, 600_000);
    pending.set(id, { resolve, reject, timer });
    try {
      if (!send({ ...value, id })) throw new Error('The emulator connection is unavailable. Try again after it reconnects.');
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function rejectPending(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

function call(tool, args = {}) {
  return request({ t: 'call', tool, args });
}

// Sends an APK in chunks over the active channel; the helper installs and launches it after the last chunk.
async function uploadApk(file) {
  activeUploads++;
  try {
    const upload = crypto.randomUUID();
    for (let offset = 0; ; offset += UPLOAD_CHUNK_BYTES) {
      const data = toBase64(await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer());
      const done = offset + UPLOAD_CHUNK_BYTES >= file.size;
      const result = await request({ t: 'upload', upload, name: file.name, offset, data, done });
      if (done) return result;
    }
  } finally {
    activeUploads--;
    reconcileStream();
  }
}

function onJson(msg) {
  if (msg.theme !== undefined && JSON.stringify(msg.theme) !== JSON.stringify(hostTheme)) {
    hostTheme = msg.theme;
    applyTheme();
  }
  if (msg.t === 'status') renderStatus(msg);
  else if (msg.t === 'agent') showAgentEvent(msg);
  else if (msg.t === 'navigation') {
    if (minimapMap) {
      minimapMap = { ...minimapMap, busy: Boolean(msg.busy) };
      renderMinimap();
    }
    if (!msg.busy && !minimapDrawer.hidden && !minimapBusyUI) refreshMinimap();
  }
  else if (msg.t === 'logcat') appendLog(msg.lines);
  else if (msg.t === 'result') {
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(entry?.timer);
    if (msg.ok) entry?.resolve(msg.result);
    else entry?.reject(new Error(msg.error));
    // Let action continuations start their next request before deciding the hidden panel is idle.
    queueMicrotask(() => reconcileStream());
  } else if (msg.t === 'mirror-ended') {
    resetDecoder();
    session = null;
    displayReady = false;
    displayError = '[AE_DISPLAY_ENDED] The display connection failed. Reconnecting automatically…';
    displayRecoveryAttempted = true;
    render();
  } else if (msg.t === 'error') showMessage(msg.error);
}

// ---- Video ------------------------------------------------------------------

const hex = (byte) => byte.toString(16).padStart(2, '0');

// Builds an avc1 codec string from the SPS NAL unit in an Annex B config packet.
function codecFromConfig(bytes) {
  for (let i = 0; i + 4 < bytes.length; i += 1) {
    const startCode = bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1));
    if (!startCode) continue;
    const nal = i + (bytes[i + 2] === 1 ? 3 : 4);
    if ((bytes[nal] & 0x1f) === 7) return `avc1.${hex(bytes[nal + 1])}${hex(bytes[nal + 2])}${hex(bytes[nal + 3])}`;
  }
  return 'avc1.42e01f';
}

function resetDecoder() {
  if (paintRequest !== null) cancelAnimationFrame(paintRequest);
  paintRequest = null;
  pendingFrame?.close();
  pendingFrame = null;
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  waitingForKey = true;
}

function ensureDecoder() {
  if (decoder && decoder.state !== 'closed') return decoder;
  decoder = new VideoDecoder({
    output: (videoFrame) => {
      pendingFrame?.close();
      pendingFrame = videoFrame;
      if (paintRequest !== null) return;
      paintRequest = requestAnimationFrame(() => {
        paintRequest = null;
        const frame = pendingFrame;
        pendingFrame = null;
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        framesDrawn++;
        const firstFrame = !displayReady;
        displayReady = true;
        displayError = '';
        displayRecoveryAttempted = false;
        if (firstFrame) render();
      });
    },
    error: (error) => {
      console.warn('decoder error', error);
      resetDecoder();
      displayReady = false;
      displayError = '[AE_DISPLAY_DECODE] The display frame could not be decoded. Reconnecting…';
      render();
      send({ t: 'keyframe' });
    },
  });
  decoder.configure({ codec, optimizeForLatency: true });
  return decoder;
}

function onBinary(buffer) {
  const bytes = new DataView(buffer);
  const type = bytes.getUint8(0);
  if (type === 1) {
    resetDecoder();
    config = null;
    displayReady = false;
    session = { width: bytes.getUint32(1), height: bytes.getUint32(5) };
    render();
    return;
  }
  const key = bytes.getUint8(1) === 1;
  const pts = Number(bytes.getBigUint64(2));
  const data = new Uint8Array(buffer, 10);
  if (type === 2) {
    config = data.slice();
    const nextCodec = codecFromConfig(config);
    if (nextCodec !== codec) {
      codec = nextCodec;
      resetDecoder();
    }
    waitingForKey = true;
    return;
  }
  if (!codec || (waitingForKey && !key)) return;
  if (decoder?.decodeQueueSize > 8) {
    resetDecoder();
    if (!key) {
      send({ t: 'keyframe' });
      return;
    }
  }
  let chunk = data;
  if (key && config) {
    chunk = new Uint8Array(config.length + data.length);
    chunk.set(config);
    chunk.set(data, config.length);
  }
  waitingForKey = false;
  try {
    ensureDecoder().decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: chunk }));
  } catch (error) {
    console.warn('decode failed', error);
    resetDecoder();
    displayReady = false;
    displayError = '[AE_DISPLAY_DECODE] The display frame could not be decoded. Reconnecting…';
    render();
    send({ t: 'keyframe' });
  }
}

let fpsFrames = 0;
setInterval(() => {
  const count = framesDrawn - fpsFrames;
  $('fps').textContent = lastStatus?.emulator?.state !== 'ready' ? '' : !connected ? 'Reconnecting…' : displayError ? 'Display unavailable' : displayReady ? (count ? `${count} fps` : 'Idle') : 'Connecting…';
  $('fps').title = count ? 'Frames displayed per second' : 'No new frames in the last second. The screen may be still.';
  fpsFrames = framesDrawn;
  checkDisplayConnection();
}, 1000);

function checkDisplayConnection() {
  if (view !== 'device' || document.hidden || !connected || lastStatus?.emulator?.state !== 'ready' || displayReady) return;
  if (Date.now() - displayConnectingAt < 15000) return;
  displayError = '[AE_DISPLAY_TIMEOUT] The emulator is running, but its display is not responding.';
  render();
  if (!displayRecoveryAttempted) {
    displayRecoveryAttempted = true;
    send({ t: 'reconnect' });
  }
}

function reconnectDisplay() {
  displayError = '';
  displayReady = false;
  displayConnectingAt = Date.now();
  displayRecoveryAttempted = true;
  resetDecoder();
  session = null;
  render();
  send({ t: 'reconnect' });
}

function showDisplayError() {
  const retry = element('button', { type: 'button', className: 'button', textContent: 'Reconnect display' });
  retry.addEventListener('click', reconnectDisplay);
  const [, code = 'AE_DISPLAY_TIMEOUT', text = displayError] = displayError.match(/^\[([^\]]+)]\s*(.*)$/) ?? [];
  showPanelError(codedError(code, text), retry);
}

// ---- Screen layout ------------------------------------------------------------

const px = (value) => `${value}px`;

// Fits the screen, as a plain rectangle, inside the stage. The video's own size tracks rotation.
function layout() {
  if (!session) return;
  const pad = 24;
  const availW = Math.max(stage.clientWidth - pad * 2, 60);
  const availH = Math.max(stage.clientHeight - pad * 2, 60);
  const s = Math.min(availW / session.width, availH / session.height);
  Object.assign(device.style, { width: px(session.width * s), height: px(session.height * s) });
}

new ResizeObserver(() => layout()).observe(stage);

// ---- Agent activity overlay ------------------------------------------------------

const percent = (value) => `${Math.min(Math.max(value, 0), 1) * 100}%`;

function showChip(text) {
  const chip = $('agent-chip');
  chip.textContent = `${host?.label ?? 'Agent'} · ${text}`;
  chip.classList.add('show');
  clearTimeout(showChip.timer);
  showChip.timer = setTimeout(() => chip.classList.remove('show'), 1800);
}

function showAgentEvent(event) {
  if (event.bounds) {
    const [x1, y1, x2, y2] = event.bounds;
    const outline = Object.assign(document.createElement('div'), { className: 'agent-outline' });
    Object.assign(outline.style, { left: percent(x1), top: percent(y1), width: percent(x2 - x1), height: percent(y2 - y1) });
    agentLayer.append(outline);
    setTimeout(() => outline.remove(), 1200);
  }
  if (event.kind === 'tap' && event.point) {
    const ripple = Object.assign(document.createElement('div'), { className: 'agent-ripple' });
    Object.assign(ripple.style, { left: percent(event.point[0]), top: percent(event.point[1]) });
    agentLayer.append(ripple);
    setTimeout(() => ripple.remove(), 700);
  }
  if (event.kind === 'swipe' && event.point && event.to) {
    const dot = Object.assign(document.createElement('div'), { className: 'agent-dot' });
    Object.assign(dot.style, { left: percent(event.point[0]), top: percent(event.point[1]) });
    agentLayer.append(dot);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => Object.assign(dot.style, { left: percent(event.to[0]), top: percent(event.to[1]), opacity: '0' })),
    );
    setTimeout(() => dot.remove(), 800);
  }
  if (event.label) showChip(event.label);
}

// ---- Status -----------------------------------------------------------------

function showMessage(text) {
  message.classList.remove('stacked');
  message.textContent = text;
  message.hidden = !text;
}

function render() {
  const ready = connected && lastStatus?.emulator?.state === 'ready';
  for (const button of document.querySelectorAll('#rail .icon-button')) button.disabled = !ready;
  // Reading or initializing a project map does not require a running device.
  $('minimap-toggle').disabled = !connected;
  $('more').disabled = !connected || !lastStatus?.emulator;
  renderPostures();
  const emulator = lastStatus?.emulator;
  const live = emulator?.state === 'ready' && session && displayReady;
  device.hidden = !live;
  launcher.hidden = Boolean(emulator) || !lastStatus;
  if (live) {
    showMessage('');
    layout();
  } else if (displayError && emulator?.state === 'ready') showDisplayError();
  else if (emulator?.state === 'booting') showMessage(`Booting ${pretty(emulator.avd)}…`);
  else if (emulator) showMessage('Connecting display…');
  else showMessage(lastStatus ? '' : 'Connecting…');
}

function renderPostures() {
  const foldable = lastStatus?.foldable;
  $('fold-controls').hidden = !foldable?.postures?.length;
  for (const button of document.querySelectorAll('[data-posture]')) {
    const supported = foldable?.postures.includes(button.dataset.posture) ?? false;
    button.hidden = !supported;
    button.disabled = !supported || !connected || lastStatus?.emulator?.state !== 'ready' || postureChanging;
    button.setAttribute('aria-pressed', String(foldable?.posture === button.dataset.posture));
  }
}

async function changePosture(posture) {
  if (postureChanging) return;
  postureChanging = true;
  renderPostures();
  try {
    await runAction('emulator_settings', { posture });
  } finally {
    postureChanging = false;
    renderPostures();
  }
}

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function deleteDeviceButton(name, inUse, onDelete) {
  const remove = element('button', {
    type: 'button', className: 'button danger', textContent: 'Delete', disabled: inUse,
    title: inUse ? 'Stop every instance of this device before deleting it.' : `Delete ${pretty(name)}`,
  });
  remove.setAttribute('aria-label', `Delete ${pretty(name)}`);
  remove.addEventListener('click', () => {
    const dialog = $('delete-dialog');
    if (dialog.open) return;
    $('delete-description').textContent = `Delete ${pretty(name)} and its saved apps, data, and snapshots? This removes the device from Android Studio too. This cannot be undone.`;
    dialog.returnValue = '';
    dialog.addEventListener('close', async () => {
      if (dialog.returnValue !== 'delete') return;
      remove.disabled = true;
      try { await onDelete(); } finally { remove.disabled = inUse; }
    }, { once: true });
    dialog.showModal();
  });
  return remove;
}

function renderLauncher(status) {
  const owned = new Set(status.createdByThisThread.map(({ name }) => name));
  const inUse = new Set(status.inUseAvds ?? []);
  $('avd-list').replaceChildren(
    ...(status.avds.length
      ? status.avds.map((name) => {
          const start = element('button', { type: 'button', className: 'button', textContent: 'Start' });
          start.setAttribute('aria-label', `Start ${pretty(name)}`);
          start.addEventListener('click', () => startDevice('emulator_start', { avd: name }, name));
          const remove = deleteDeviceButton(name, inUse.has(name), async () => {
            const updated = await runAction('emulator_delete_avd', { avd: name, confirmed: true });
            if (updated) renderStatus(updated);
          });
          return element('li', {}, [
            element('span', { className: 'avd-name', textContent: pretty(name), title: pretty(name) }),
            ...(owned.has(name) ? [element('span', { className: 'tag', textContent: 'This chat' })] : []),
            element('span', { className: 'row-actions' }, [start, remove]),
          ]);
        })
      : [element('li', { className: 'empty', textContent: 'No virtual devices yet.' })]),
  );

  const profile = $('profile');
  if (!profile.options.length) {
    profile.replaceChildren(...status.profiles.map(({ id, name }) => new Option(name, id)));
    profile.value = status.profiles.find(({ id }) => id === 'pixel_9')?.id ?? status.profiles[0]?.id;
    $('keep').checked = Boolean(status.settings?.keepCreatedDevices);
  }
  const tablet = status.profiles.find(({ id }) => id === profile.value)?.form === 'tablet';
  const image = $('image');
  const selected = image.value;
  const images = status.images.filter((candidate) => candidate.tablet === tablet);
  image.replaceChildren(...(images.length ? images : status.images).map(({ id, label }) => new Option(label, id)));
  if ([...image.options].some((option) => option.value === selected)) image.value = selected;
  $('create-form').querySelector('button').disabled = status.images.length === 0;
}

function renderMenu() {
  const status = lastStatus;
  if (!status) return;
  const current = status.emulator?.avd;
  const items = status.avds.map((name) => {
    const item = element('button', { type: 'button', role: 'menuitem', textContent: pretty(name), className: name === current ? 'current' : '' });
    item.addEventListener('click', () => switchDevice(name));
    return item;
  });
  const create = element('button', { type: 'button', role: 'menuitem', textContent: 'New device…' });
  create.addEventListener('click', async () => {
    closeMenu();
    if (status.emulator) await runAction('emulator_stop');
  });
  menu.replaceChildren(...items, element('hr'), create);
}

function closeMenu() {
  menu.hidden = true;
  $('device-button').setAttribute('aria-expanded', 'false');
}

async function switchDevice(name) {
  closeMenu();
  if (name === lastStatus?.emulator?.avd) return;
  showMessage(`Switching to ${pretty(name)}…`);
  device.hidden = true;
  if (lastStatus?.emulator && !(await runAction('emulator_stop'))) {
    render();
    return;
  }
  if (!(await runAction('emulator_start', { avd: name }))) render();
}

function renderStatus(status) {
  lastStatus = status;
  if (view !== 'device') return;
  const emulator = status.emulator;
  $('dot').className = `dot ${emulator?.state ?? ''}`;
  $('title').textContent = emulator ? pretty(emulator.avd) : 'Android Emulator';
  $('subtitle').textContent = emulator ? `${emulator.serial}${emulator.readOnly ? ' · Read-only' : ''}` : 'No device';
  const owned = emulator && status.createdByThisThread.some(({ name }) => name === emulator.avd);
  $('details').textContent = emulator
    ? `${emulator.avd} on ${emulator.serial}. ${emulator.readOnly ? 'Read-only: changes are discarded on stop.' : owned ? 'Created for this chat.' : 'Changes are saved to this AVD.'}`
    : '';
  $('stop-delete').hidden = !owned;
  $('record').classList.toggle('recording', Boolean(status.recording));
  setTooltip($('record'), status.recording ? 'Stop and save recording (⇧⌘R)' : 'Record screen (⇧⌘R)');
  $('attach').hidden = !(embedded && capabilities.captureContext && emulator?.state === 'ready');
  if (!emulator) {
    activePointerId = null;
    displayReady = false;
    displayError = '';
    displayRecoveryAttempted = false;
    displayConnectingAt = Date.now();
    session = null;
    drawer.hidden = true;
    $('logcat').hidden = true;
    resetDecoder();
    renderLauncher(status);
  }
  renderMenu();
  render();
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---- Screen map ---------------------------------------------------------------

function minimapStatusText(result, fallback) {
  const navigation = result?.structuredContent?.result;
  const status = typeof navigation?.status === 'string' && navigation.status
    ? pretty(navigation.status)
    : '';
  const summary = typeof navigation?.summary === 'string' && navigation.summary.trim()
    ? navigation.summary.trim()
    : '';
  return [status, summary].filter(Boolean).join(': ') || fallback;
}

function setMinimapStatus(text) {
  $('minimap-status').textContent = text;
}

function knownPlace(map, id) {
  return map?.places?.find((place) => place.id === id) ?? null;
}

function renderMinimap() {
  const map = minimapMap;
  const availability = map?.availability;
  const available = Boolean(map && availability?.available !== false && !map.error);
  const initialized = Boolean(map?.initialized);
  const busy = Boolean(map?.busy || minimapBusyUI);
  const places = Array.isArray(map?.places) ? map.places : [];
  const edges = Array.isArray(map?.edges) ? map.edges : [];
  const current = knownPlace(map, map?.currentPlace);
  const currentText = current?.label ?? (map?.currentPlace ? 'Last located screen is not yet in the map.' : 'Not located yet');
  const learning = map?.learning;
  const ready = lastStatus?.emulator?.state === 'ready';
  const hasCurrent = Boolean(current || map?.currentPlace);

  $('minimap-summary').textContent = map ? `${map.projectName} · ${places.length} ${places.length === 1 ? 'screen' : 'screens'} · ${edges.length} ${edges.length === 1 ? 'route' : 'routes'}` : '';
  $('minimap-association').textContent = map?.packageName ? `Associated with ${map.packageName}` : '';
  $('minimap-association').hidden = !map?.packageName;
  $('minimap-current').textContent = currentText;
  $('minimap-current').classList.toggle('known', Boolean(current));
  $('minimap-refresh').disabled = minimapBusyUI;
  $('minimap-locate').disabled = !available || busy || !ready;
  $('minimap-cancel').hidden = !busy;
  $('minimap-cancel').disabled = minimapCancelling;
  $('minimap-current-section').hidden = !hasCurrent;
  $('minimap-places-section').hidden = !places.length;
  $('minimap-routes-section').hidden = !edges.length;

  if (!map) return;
  if (!available || learning?.state === 'unavailable') {
    const reason = map.error || (typeof availability?.reason === 'string' && availability.reason.trim()
      ? availability.reason.trim()
      : learning?.state === 'unavailable' || learning?.state === 'error'
        ? learning.message || 'The screen map is unavailable for this project.'
        : 'The screen map is unavailable for this project.');
    setMinimapStatus(`Unavailable: ${reason}`);
  } else if (learning?.state === 'error') {
    setMinimapStatus(learning.message || 'Screen map learning could not continue.');
  } else if (!initialized) {
    setMinimapStatus('Screens and routes are remembered as the agent uses your app.');
  } else if (busy) {
    if (!minimapBusyUI) setMinimapStatus('Navigation is in progress.');
  } else if (learning?.state === 'waiting' || !places.length) {
    setMinimapStatus('Screens and routes are remembered as the agent uses your app.');
  }

  $('minimap-places').replaceChildren(
    ...places.map((place) => {
      const go = element('button', { type: 'button', className: 'button', textContent: 'Go' });
      go.disabled = !available || busy || !ready;
      go.addEventListener('click', () => navigateToPlace(place.id));
      const name = element('span', {
        className: `place-name${place.id === map.currentPlace ? ' current-place' : ''}`,
        textContent: place.label || place.id,
      });
      return element('li', {}, [name, go]);
    }),
  );
  $('minimap-routes').replaceChildren(
    ...edges.map((edge) => {
      const from = knownPlace(map, edge.from)?.label ?? edge.from;
      const to = knownPlace(map, edge.to)?.label ?? edge.to;
      const steps = edge.steps;
      const detail = edge.requiresHistory ? 'Manual Back' : Number.isFinite(steps) ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : '';
      return element('li', {}, [
        element('span', { className: 'route', textContent: `${from} → ${to}` }),
        ...(detail ? [element('span', { className: 'route-detail', textContent: detail, title: edge.requiresHistory ? 'Screen map does not replay Back without verified navigation history. Use Back on the device, or learn an explicit app navigation control.' : '' })] : []),
      ]);
    }),
  );
}

function applyMinimapResult(result, fallback) {
  const map = result?.structuredContent?.map;
  if (map) minimapMap = map;
  setMinimapStatus(minimapStatusText(result, fallback));
  renderMinimap();
}

async function refreshMinimap() {
  if (minimapDrawer.hidden) return;
  const refreshId = ++minimapRefreshId;
  try {
    const result = await call('emulator_navigate', { action: 'status' });
    if (refreshId !== minimapRefreshId) return;
    applyMinimapResult(result, 'Screen map refreshed.');
  } catch (error) {
    setMinimapStatus(error.message);
  }
}

async function runMinimapAction(args, fallback) {
  if (minimapBusyUI || minimapMap?.busy) return null;
  minimapRefreshId++;
  minimapBusyUI = true;
  setMinimapStatus('Navigation is in progress.');
  renderMinimap();
  try {
    const result = await call('emulator_navigate', args);
    applyMinimapResult(result, fallback);
    return result;
  } catch (error) {
    setMinimapStatus(error.message);
    return null;
  } finally {
    minimapBusyUI = false;
    renderMinimap();
  }
}

function navigateToPlace(target) {
  if (minimapBusyUI || minimapMap?.busy) return;
  runMinimapAction({ action: 'go', target }, 'Navigation finished.');
}

function openMinimap() {
  drawer.hidden = true;
  $('more').setAttribute('aria-pressed', 'false');
  minimapDrawer.hidden = false;
  $('minimap-toggle').setAttribute('aria-pressed', 'true');
  setMinimapStatus('Loading screen map…');
  refreshMinimap();
}

function closeMinimap() {
  minimapDrawer.hidden = true;
  $('minimap-toggle').setAttribute('aria-pressed', 'false');
}

async function runAction(tool, args, done) {
  try {
    const result = await call(tool, args);
    if (done) toast(typeof done === 'function' ? done(result) : done);
    return result;
  } catch (error) {
    toast(error.message);
    return null;
  }
}

async function startDevice(tool, args, label) {
  launcher.hidden = true;
  showMessage(`Starting ${pretty(label)}…`);
  if (!(await runAction(tool, args))) render();
}

// ---- Chat integration -----------------------------------------------------------

let lastCapture = null;
let capturePending = false;
let recordingPending = false;
let sharingCapture = false;
let chatCaptures = new Map();
let captureSelectionLoaded = false;
const MAX_CHAT_CAPTURES = 4;
const MAX_CONTEXT_CHARS = 16 * 1024 * 1024;

function supportsCaptureContext() {
  return embedded && Boolean(capabilities.captureContext);
}

async function showCapture(result) {
  const capture = result?.structuredContent?.capture;
  if (!capture) throw new Error('This helper cannot share captures yet. Reload the updated plugin.');
  lastCapture = { ...capture, image: result.image, downloadUrl: result.meta?.capture?.downloadUrl };
  const video = capture.mimeType === 'video/mp4';
  $('capture-title').textContent = video ? 'Recording saved' : 'Screenshot saved';
  $('capture-preview').hidden = !result.image;
  $('capture-preview').src = result.image ? `data:${result.image.mimeType};base64,${result.image.data}` : '';
  $('capture-detail').textContent = video
    ? `${capture.seconds}s · Copies as an MP4 file. Chat gets a local video reference and up to four sample frames.`
    : 'Copy the image, or add it to your next message’s context.';
  $('capture-both').hidden = $('capture-chat').hidden = !supportsCaptureContext();
  $('capture-open').textContent = embedded && capabilities.openFile ? 'Open file' : 'Download';
  $('capture-feedback').textContent = '';
  $('capture-tray').hidden = false;
  if (supportsCaptureContext()) {
    try { await restoreCaptureSelection(); }
    catch (error) {
      $('capture-feedback').textContent = error.message;
      $('capture-clear-context').hidden = false;
      $('capture-clear-context').textContent = 'Clear capture context';
    }
  }
}

async function attachScreen() {
  if (await screenshot()) await shareCapture({ chat: true });
}

async function screenshot() {
  if (capturePending || sharingCapture) return false;
  capturePending = true;
  try {
    const result = await runAction('emulator_screenshot', { save: true });
    if (!result?.image) return false;
    await showCapture(result);
    return true;
  } catch (error) { toast(error.message); return false; }
  finally { capturePending = false; }
}

async function toggleRecording() {
  if (recordingPending || sharingCapture) return;
  recordingPending = true;
  const recording = lastStatus?.recording;
  try {
    const result = await runAction('emulator_record', { action: recording ? 'stop' : 'start' });
    if (!result) return;
    if (lastStatus) renderStatus({ ...lastStatus, recording: !recording });
    if (!recording) return toast('Recording… press again to stop');
    await showCapture(result);
  } catch (error) { toast(error.message); }
  finally { recordingPending = false; }
}

function updateCaptureCount() {
  $('capture-clear-context').hidden = !chatCaptures.size;
  $('capture-clear-context').textContent = `Clear capture context (${chatCaptures.size}/${MAX_CHAT_CAPTURES})`;
}

async function restoreCaptureSelection() {
  if (captureSelectionLoaded) return;
  const { captureIds } = await call('emulator_capture_selection');
  chatCaptures = new Map(captureIds.map(id => [id, null]));
  captureSelectionLoaded = true;
  updateCaptureCount();
}

async function captureContent(captureId) {
  const result = await call('emulator_capture', { action: 'context', captureId });
  const content = [{ type: 'text', text: result.text }];
  if (result.structuredContent?.resource && capabilities.contextResourceLink) content.push(result.structuredContent.resource);
  for (const image of result.images ?? []) {
    content.push(...host.contextImage(image));
  }
  return content;
}

async function addCaptureContext(capture) {
  if (!supportsCaptureContext()) throw new Error(`Open this capture in the ${host?.label ?? 'host'} emulator panel to add it to chat.`);
  await restoreCaptureSelection();
  if (!chatCaptures.has(capture.id) && chatCaptures.size >= MAX_CHAT_CAPTURES) throw new Error('Chat context holds four captures. Clear capture context to add another.');
  const next = new Map(chatCaptures).set(capture.id, null);
  for (const [id, content] of next) if (!content) next.set(id, await captureContent(id));
  const combined = [...next.values()].flat();
  if (JSON.stringify(combined).length > MAX_CONTEXT_CHARS) throw new Error('These captures are too large together. Clear capture context, then add fewer captures.');
  // Host updates replace this panel's whole context. Resend prior captures too.
  await host.updateContext(combined);
  chatCaptures = next;
  updateCaptureCount();
  await call('emulator_capture_selection', { captureIds: [...next.keys()] });
}

async function shareCapture({ copy = false, chat = false } = {}) {
  if (!lastCapture || sharingCapture) return;
  sharingCapture = true;
  const capture = lastCapture;
  const buttons = ['capture-copy', 'capture-chat', 'capture-both', 'capture-clear-context'];
  for (const id of buttons) $(id).disabled = true;
  $('capture-feedback').textContent = chat && capture.mimeType === 'video/mp4' ? 'Preparing video frames…' : 'Sharing capture…';
  const jobs = [];
  if (copy) jobs.push({ label: 'Copied to clipboard', run: () => call('emulator_capture', { action: 'copy', captureId: capture.id }) });
  if (chat) jobs.push({ label: capture.mimeType === 'video/mp4' ? 'Video sample frames and saved file path added to chat context' : 'Screenshot added to chat context', run: () => addCaptureContext(capture) });
  try {
    const results = await Promise.allSettled(jobs.map(job => job.run()));
    $('capture-feedback').textContent = results.map((result, i) => result.status === 'fulfilled' ? jobs[i].label : result.reason.message).join('. ');
  } finally {
    sharingCapture = false;
    for (const id of buttons) $(id).disabled = false;
  }
}

async function clearCaptureContext() {
  if (sharingCapture) return;
  sharingCapture = true;
  try {
    await host.updateContext([]);
    chatCaptures = new Map();
    await call('emulator_capture_selection', { captureIds: [] });
    captureSelectionLoaded = true;
    updateCaptureCount();
    $('capture-feedback').textContent = 'Capture context cleared.';
  } catch (error) { $('capture-feedback').textContent = error.message; }
  finally { sharingCapture = false; }
}

async function openCapture() {
  if (!lastCapture) return;
  try {
    if (embedded && capabilities.openFile) await host.openFile(lastCapture.file);
    else if (lastCapture.image) element('a', { href: `data:${lastCapture.image.mimeType};base64,${lastCapture.image.data}`, download: lastCapture.name }).click();
    else if (!embedded && lastCapture.downloadUrl) element('a', { href: lastCapture.downloadUrl, download: lastCapture.name }).click();
    else throw new Error('This host cannot open the capture. Copy it, or ask the agent for the saved file.');
  } catch (error) { $('capture-feedback').textContent = error.message; }
}

// ---- Logcat -------------------------------------------------------------------

const LEVELS = 'VDIWEF';
const logLines = $('log-lines');
let logPaused = false;

function logMatches(line) {
  const level = line.match(/^\S+\s+\S+\s+\d+\s+\d+\s+([VDIWEF])\s/)?.[1] ?? 'I';
  const filter = $('log-filter').value.trim().toLowerCase();
  return { level, show: LEVELS.indexOf(level) >= LEVELS.indexOf($('log-level').value) && (!filter || line.toLowerCase().includes(filter)) };
}

function appendLog(lines) {
  if (logPaused) return;
  const atBottom = logLines.scrollHeight - logLines.scrollTop - logLines.clientHeight < 24;
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const { level, show } = logMatches(line);
    const row = element('div', { className: level, textContent: line });
    row.hidden = !show;
    fragment.append(row);
  }
  logLines.append(fragment);
  while (logLines.childElementCount > 3000) logLines.firstElementChild.remove();
  if (atBottom) logLines.scrollTop = logLines.scrollHeight;
}

function refilterLog() {
  for (const row of logLines.children) row.hidden = !logMatches(row.textContent).show;
}

function setLogcat(open) {
  $('logcat').hidden = !open;
  $('logcat-toggle').setAttribute('aria-pressed', String(open));
  setTooltip($('logcat-toggle'), open ? 'Hide Logcat' : 'Logcat');
  send({ t: 'logcat', on: open });
  if (open) logLines.replaceChildren();
  requestAnimationFrame(layout);
}

// ---- Snapshots ------------------------------------------------------------------

async function refreshSnapshots(action = 'list', name) {
  const result = await runAction('emulator_snapshot', { action, name }, action === 'list' ? undefined : `Snapshot ${action === 'save' ? 'saved' : action === 'load' ? 'loaded' : 'deleted'}`);
  const snapshots = result?.structuredContent?.snapshots ?? [];
  $('snapshot-list').replaceChildren(
    ...(snapshots.length
      ? snapshots.map((snapshot) => {
          const load = element('button', { type: 'button', className: 'button', textContent: 'Load' });
          const remove = element('button', { type: 'button', className: 'button danger', textContent: 'Delete' });
          load.addEventListener('click', () => refreshSnapshots('load', snapshot));
          remove.addEventListener('click', () => refreshSnapshots('delete', snapshot));
          return element('li', {}, [element('span', { className: 'grow', textContent: snapshot }), element('span', { className: 'row-actions' }, [load, remove])]);
        })
      : [element('li', { className: 'empty', textContent: lastStatus?.emulator?.readOnly ? 'Read-only emulators cannot save snapshots.' : 'No snapshots yet.' })]),
  );
}

// ---- Input ------------------------------------------------------------------

function devicePoint(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  const y = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
  return { x: Math.round(x * (session.width - 1)), y: Math.round(y * (session.height - 1)) };
}

canvas.addEventListener('pointerdown', (event) => {
  if (!connected || !session || activePointerId !== null || event.isPrimary === false) return;
  event.preventDefault();
  keyboard.focus({ preventScroll: true });
  if (event.button === 2) return send({ t: 'key', key: 'BACK' });
  if (event.button === 1) return send({ t: 'key', key: 'HOME' });
  if (event.button !== 0) return undefined;
  activePointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  send({ t: 'touch', a: 0, ...devicePoint(event) });
  return undefined;
});
canvas.addEventListener('pointermove', (event) => {
  if (!connected || !session || activePointerId !== event.pointerId) return;
  const samples = event.getCoalescedEvents?.();
  for (const sample of samples?.length ? samples : [event]) send({ t: 'touch', a: 2, ...devicePoint(sample) });
});
const endTouch = (event) => {
  if (activePointerId !== event.pointerId) return;
  activePointerId = null;
  if (!connected || !session) return;
  send({ t: 'touch', a: 1, ...devicePoint(event) });
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);
canvas.addEventListener('lostpointercapture', endTouch);
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener(
  'wheel',
  (event) => {
    if (!session) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 1 / 3 : 1 / 100;
    send({ t: 'scroll', ...devicePoint(event), h: -event.deltaX * scale, v: -event.deltaY * scale });
  },
  { passive: false },
);

const SPECIAL_KEYS = {
  Enter: 'ENTER',
  Backspace: 'DEL',
  Delete: 'FORWARD_DEL',
  Tab: 'TAB',
  Escape: 'BACK',
  ArrowUp: 'DPAD_UP',
  ArrowDown: 'DPAD_DOWN',
  ArrowLeft: 'DPAD_LEFT',
  ArrowRight: 'DPAD_RIGHT',
  Home: 'MOVE_HOME',
  End: 'MOVE_END',
  PageUp: 'PAGE_UP',
  PageDown: 'PAGE_DOWN',
};
const META_SHIFT_ON = 0x1;
const META_ALT_ON = 0x2;
const META_CTRL_ON = 0x1000;

// Android Studio emulator shortcuts (macOS). Returns true when handled.
function studioShortcut(event) {
  if (!(event.metaKey || event.ctrlKey) || lastStatus?.emulator?.state !== 'ready') return false;
  const key = event.key.toLowerCase();
  const actions = {
    arrowleft: () => runAction('emulator_settings', { rotate: 'left' }),
    arrowright: () => runAction('emulator_settings', { rotate: 'right' }),
    arrowup: () => send({ t: 'key', key: 'VOLUME_UP' }),
    arrowdown: () => send({ t: 'key', key: 'VOLUME_DOWN' }),
    backspace: () => send({ t: 'key', key: 'BACK' }),
    o: () => send({ t: 'key', key: 'APP_SWITCH' }),
    p: () => send({ t: 'key', key: 'POWER' }),
    s: () => screenshot(),
  };
  const shifted = { h: () => send({ t: 'key', key: 'HOME' }), r: () => toggleRecording() };
  const action = event.shiftKey ? shifted[key] : actions[key];
  if (!action) return false;
  event.preventDefault();
  action();
  return true;
}

// Letters, digits, and space go through as key events (like scrcpy's default), which the IME keeps in order.
function printableKey(char) {
  if (/^[a-z]$/i.test(char)) return { key: 29 + char.toLowerCase().charCodeAt(0) - 97, meta: char === char.toUpperCase() ? META_SHIFT_ON : 0 };
  if (/^[0-9]$/.test(char)) return { key: 7 + Number(char), meta: 0 };
  if (char === ' ') return { key: 'SPACE', meta: 0 };
  return null;
}

keyboard.addEventListener('keydown', (event) => {
  if (event.isComposing || studioShortcut(event)) return;
  const shortcut = event.metaKey || event.ctrlKey;
  if (shortcut && event.key.toLowerCase() === 'v') return; // handled by the paste event
  if (shortcut && /^[a-z]$/i.test(event.key)) {
    event.preventDefault();
    send({ t: 'key', key: 29 + event.key.toLowerCase().charCodeAt(0) - 97, meta: META_CTRL_ON });
    return;
  }
  const special = SPECIAL_KEYS[event.key];
  if (special) {
    event.preventDefault();
    send({ t: 'key', key: special, meta: (event.shiftKey ? META_SHIFT_ON : 0) | (event.altKey ? META_ALT_ON : 0) });
  } else if (event.key.length === 1 && !shortcut) {
    event.preventDefault();
    const key = printableKey(event.key);
    send(key ? { t: 'key', ...key } : { t: 'text', s: event.key });
  }
});
// Shortcuts also work when the panel has focus but the device screen doesn't.
document.addEventListener('keydown', (event) => {
  if (event.target === keyboard || event.target.closest?.('input, select, textarea')) return;
  studioShortcut(event);
});
// Text that arrives without a key event: IME composition, dictation, emoji picker, autofill.
keyboard.addEventListener('input', (event) => {
  if (!event.isComposing && event.data) send({ t: 'text', s: event.data });
  if (!event.isComposing) keyboard.value = '';
});
keyboard.addEventListener('compositionend', (event) => {
  if (event.data) send({ t: 'text', s: event.data });
  keyboard.value = '';
});
keyboard.addEventListener('paste', (event) => {
  const value = event.clipboardData?.getData('text/plain');
  if (value) {
    event.preventDefault();
    send({ t: 'paste', s: value });
  }
});

// Drag an APK onto the panel to install and open it.
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
stage.addEventListener('dragenter', (event) => {
  if (!hasFiles(event) || lastStatus?.emulator?.state !== 'ready') return;
  dragDepth += 1;
  $('drop-target').hidden = false;
});
stage.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
stage.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-target').hidden = true;
});
stage.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('drop-target').hidden = true;
  const file = [...(event.dataTransfer?.files ?? [])].find((candidate) => candidate.name.toLowerCase().endsWith('.apk'));
  if (!file) return toast('Drop an .apk file to install it');
  showChip(`Installing ${file.name}…`);
  try {
    const result = await uploadApk(file);
    toast(`Installed ${result.label}`);
  } catch (error) {
    toast(`Install failed: ${error.message}`);
  }
  return undefined;
});

// ---- Controls -----------------------------------------------------------------

for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('click', () => {
    send({ t: 'key', key: button.dataset.key });
    keyboard.focus({ preventScroll: true });
  });
}
for (const button of document.querySelectorAll('[data-posture]')) {
  button.addEventListener('click', () => changePosture(button.dataset.posture));
}
for (const button of document.querySelectorAll('[data-rotate]')) {
  button.addEventListener('click', () => runAction('emulator_settings', { rotate: button.dataset.rotate }));
}
for (const button of document.querySelectorAll('[data-setting]')) {
  button.addEventListener('click', () => runAction('emulator_settings', JSON.parse(button.dataset.setting), 'Applied'));
}
$('font-scale').addEventListener('change', (event) => runAction('emulator_settings', { fontScale: Number(event.target.value) }, 'Font size applied'));
$('set-location').addEventListener('click', () =>
  runAction('emulator_settings', { location: { latitude: Number($('lat').value), longitude: Number($('lng').value) } }, 'Location set'),
);
$('battery').addEventListener('input', (event) => ($('battery-value').textContent = `${event.target.value}%`));
$('set-battery').addEventListener('click', () =>
  runAction('emulator_settings', { battery: { level: Number($('battery').value), charging: $('charging').checked } }, 'Battery updated'),
);
$('more').addEventListener('click', () => {
  closeMinimap();
  drawer.hidden = !drawer.hidden;
  $('more').setAttribute('aria-pressed', String(!drawer.hidden));
  if (!drawer.hidden) refreshSnapshots();
});
drawer.querySelector('[data-close]').addEventListener('click', () => {
  drawer.hidden = true;
  $('more').setAttribute('aria-pressed', 'false');
});
$('minimap-toggle').addEventListener('click', () => {
  if (minimapDrawer.hidden) openMinimap();
  else closeMinimap();
});
$('minimap-close').addEventListener('click', closeMinimap);
$('minimap-refresh').addEventListener('click', refreshMinimap);
$('minimap-locate').addEventListener('click', () => runMinimapAction({ action: 'whereami' }, 'Current screen located.'));
$('minimap-cancel').addEventListener('click', async () => {
  if (minimapCancelling) return;
  minimapBusyUI = true;
  minimapCancelling = true;
  renderMinimap();
  try {
    const result = await call('emulator_navigate', { action: 'cancel' });
    applyMinimapResult(result, 'Navigation stopped.');
  } catch (error) {
    setMinimapStatus(error.message);
  } finally {
    minimapBusyUI = false;
    minimapCancelling = false;
    renderMinimap();
  }
});
$('snapshot-form').addEventListener('submit', (event) => {
  event.preventDefault();
  refreshSnapshots('save', $('snapshot-name').value.trim());
  $('snapshot-name').value = '';
});
for (const [id, deleteDevice] of [['stop', false], ['stop-delete', true]]) {
  $(id).addEventListener('click', async () => {
    drawer.hidden = true;
    showMessage(deleteDevice ? 'Stopping and deleting…' : 'Stopping…');
    device.hidden = true;
    await runAction('emulator_stop', { deleteDevice });
  });
}
$('screenshot').addEventListener('click', screenshot);
$('record').addEventListener('click', toggleRecording);
$('attach').addEventListener('click', attachScreen);
$('capture-copy').addEventListener('click', () => shareCapture({ copy: true }));
$('capture-chat').addEventListener('click', () => shareCapture({ chat: true }));
$('capture-both').addEventListener('click', () => shareCapture({ copy: true, chat: true }));
$('capture-open').addEventListener('click', openCapture);
$('capture-clear-context').addEventListener('click', clearCaptureContext);
$('capture-close').addEventListener('click', () => { $('capture-tray').hidden = true; });
$('expand').addEventListener('click', () => {
  const request = host?.requestDisplayMode?.('fullscreen');
  request?.catch(() => {});
});
$('logcat-toggle').addEventListener('click', () => setLogcat($('logcat').hidden));
$('log-close').addEventListener('click', () => setLogcat(false));
$('log-clear').addEventListener('click', () => logLines.replaceChildren());
$('log-pause').addEventListener('click', () => {
  logPaused = !logPaused;
  $('log-pause').setAttribute('aria-pressed', String(logPaused));
  setTooltip($('log-pause'), logPaused ? 'Resume logs' : 'Pause logs');
});
$('log-level').addEventListener('change', refilterLog);
$('log-filter').addEventListener('input', refilterLog);
$('device-button').addEventListener('click', () => {
  menu.hidden = !menu.hidden;
  $('device-button').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (event) => {
  if (!menu.hidden && !event.target.closest('#device-menu, #device-button')) closeMenu();
});
$('profile').addEventListener('change', () => lastStatus && renderLauncher(lastStatus));
$('create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const profile = $('profile');
  startDevice(
    'emulator_create',
    { profile: profile.value, systemImage: $('image').value || undefined, keep: $('keep').checked },
    profile.selectedOptions[0]?.textContent ?? 'device',
  );
});

// ---- Manager view -----------------------------------------------------------------

function openChat(threadId) {
  const opening = host?.openChat?.(threadId);
  opening?.catch(() => {});
}

async function refreshManager(action, args) {
  const refresh = $('manager-refresh');
  if (refresh.disabled) return;
  refresh.disabled = true;
  const overview = await runAction(action ?? 'manager_overview', args);
  refresh.disabled = false;
  if (!overview) return;
  $('manager-count').textContent = overview.running.length;
  $('manager-device-count').textContent = overview.devices.length;
  $('manager-storage').textContent = overview.totalSize;
  $('manager-summary').textContent = overview.devices.some((avd) => avd.createdBy) ? `${overview.pluginSize} used by devices created in ${host?.label ?? 'this host'}. Storage includes saved apps and snapshots.` : 'Storage includes saved apps and snapshots.';
  $('manager-running').replaceChildren(
    ...(overview.running.length
      ? overview.running.map((lease) => {
          const stop = element('button', { type: 'button', className: 'button', textContent: 'Stop' });
          stop.addEventListener('click', () => refreshManager('manager_stop', { threadId: lease.threadId }));
          const actions = [stop];
          if (embedded) {
            const open = element('button', { type: 'button', className: 'button', textContent: 'Open chat' });
            open.addEventListener('click', () => openChat(lease.threadId));
            actions.unshift(open);
          }
          return element('li', {}, [
            element('span', { className: 'grow' }, [
              `${pretty(lease.avd)} `,
              element('span', { className: 'sub', textContent: `${lease.threadTitle ?? 'Untitled chat'} · ${lease.serial}${lease.readOnly ? ' · Temporary session' : ''}` }),
            ]),
            element('span', { className: 'row-actions' }, actions),
          ]);
        })
      : [element('li', { className: 'empty', textContent: 'No chat emulators are running. Open Android Emulator in a chat to start one.' })]),
  );
  $('manager-devices').replaceChildren(
    ...overview.devices.map((avd) => {
      const inUse = avd.inUse || avd.runningFor.length > 0;
      const detail = [avd.size, avd.createdBy ? `Created for ${avd.createdBy.title ?? 'a chat'}${avd.createdBy.keep ? ' · Kept after chat ends' : ''}` : 'Managed in Android Studio', inUse ? 'In use' : null]
        .filter(Boolean)
        .join(' · ');
      const remove = deleteDeviceButton(avd.name, inUse, () => refreshManager('manager_delete', { avd: avd.name, confirmed: true }));
      return element('li', {}, [
        element('span', { className: 'grow' }, [`${pretty(avd.name)} `, element('span', { className: 'sub', textContent: detail })]),
        element('span', { className: 'row-actions' }, [remove]),
      ]);
    }),
  );
}

// ---- APK view -------------------------------------------------------------------

async function bootApk() {
  const result = await host.firstToolResult('emulator_apk', () => {
    const file = host?.toolInput?.()?.file;
    return file ? { file } : {};
  });
  const apk = result?.structuredContent?.apk;
  if (!apk) {
    $('apk-label').textContent = 'Could not read this APK';
    $('apk-status').textContent = result?.content?.[0]?.text ?? '';
    return;
  }
  const file = host?.toolInput?.()?.file ?? { name: apk.name, resourceUri: '' };
  $('apk-label').textContent = apk.label ?? apk.name ?? apk.packageName;
  $('apk-package').textContent = apk.packageName ?? '';
  const facts = [
    ['Version', [apk.versionName, apk.versionCode && `(${apk.versionCode})`].filter(Boolean).join(' ')],
    ['Min SDK', apk.minSdk],
    ['Target SDK', apk.targetSdk],
    ['Launch activity', apk.launchActivity],
    ['Permissions', String(apk.permissions?.length ?? 0)],
    ['Size', `${(apk.bytes / 1e6).toFixed(1)} MB`],
  ].filter(([, value]) => value);
  $('apk-facts').replaceChildren(...facts.map(([label, value]) => element('div', { className: 'row' }, [element('span', { textContent: label }), element('span', { textContent: value })])));
  const install = $('apk-install');
  install.disabled = false;
  install.classList.add('android');
  install.textContent = result.structuredContent.emulator ? `Install on ${pretty(result.structuredContent.emulator.avd)}` : 'Start emulator and install';
  install.addEventListener('click', async () => {
    install.disabled = true;
    $('apk-status').textContent = 'Installing…';
    try {
      const installed = await host.callTool('emulator_apk', { file, action: 'install' });
      $('apk-status').textContent = installed?.content?.[0]?.text ?? 'Installed.';
    } catch (error) {
      $('apk-status').textContent = error.message;
    }
    install.disabled = false;
  });
}

// ---- Boot -------------------------------------------------------------------

async function boot() {
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `${view}-view`;
  applyTheme();
  if (embedded) {
    await initHost();
  }
  if (view === 'apk') return bootApk();
  if (!('VideoDecoder' in window) && view === 'device') return showMessage(`[AE_VIDEO_UNSUPPORTED] This browser cannot decode the emulator video. Open the panel in ${host?.label ?? 'the host'} or a browser with WebCodecs support.`);
  if (embedded) {
    const result = await host.firstToolResult(view === 'manager' ? 'emulator_manager' : 'emulator_panel');
    const panel = result?._meta?.panel;
    if (!panel?.channel) return showPanelError(panelError(result, 'AE_PANEL_INIT', 'The emulator helper did not return a panel connection. Reopen the panel and try again.'));
    channel = panel.channel;
    fallbackUrl = panel.panelUrl;
  } else {
    const threadId = decodeURIComponent(location.pathname.split('/')[2] ?? '');
    const key = new URLSearchParams(location.search).get('k') ?? '';
    socketUrl = `ws://${location.host}/ws?thread=${encodeURIComponent(threadId)}&k=${encodeURIComponent(key)}`;
  }
  if (view === 'device') showMessage('Connecting…');
  $('manager-refresh').addEventListener('click', () => refreshManager());
  connect();
  return undefined;
}

boot().catch((error) => {
  const hostTimeout = error?.code === 'AE_HOST_TIMEOUT';
  showPanelError(codedError(
    hostTimeout ? 'AE_HOST_TIMEOUT' : 'AE_PANEL_INIT',
    hostTimeout ? 'The host did not respond while starting the emulator panel. Reopen the panel and try again.' : 'The emulator panel could not start. Reopen the panel and try again.',
    error,
  ));
});

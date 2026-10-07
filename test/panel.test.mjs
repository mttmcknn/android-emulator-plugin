import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Run the actual connection and video handlers without a browser or Android device. The decoder double
// accepts packets immediately; this test covers transport recovery, not H.264 decoding.
const source = fs.readFileSync(new URL('../runtime/core/web/app.js', import.meta.url), 'utf8');
const connection = source.slice(source.indexOf('const SERVER_ERROR_CODES'), source.indexOf('// ---- Theme')) + '\n' + source.slice(source.indexOf('// Iframes inherit'), source.indexOf('function fromBase64('));
const video = source.slice(source.indexOf('const hex ='), source.indexOf('let fpsFrames'));

test('three failed panel polls reconnect with fresh video setup and restores subscriptions on the same thread', async () => {
  let polls = 0;
  let nextId = 0;
  const sessions = new Set();
  const requests = [];
  const setup = [
    Buffer.from([1, 0, 0, 1, 0, 0, 0, 2, 0]),
    Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x67, 0x42, 0, 0x1f]),
    Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  ];
  const context = vm.createContext({
    crypto: { randomUUID: () => String(++nextId) },
    host: { callTool: async (_, args) => {
      requests.push(args);
      if (!args.wait) return {};
      polls++;
      if (polls >= 2 && polls <= 4) throw new Error('Transient tool call failure');
      if (polls > 5) return new Promise(() => {});
      // Existing viewers do not resend setup just because the next poll succeeds.
      const packets = sessions.has(args.session) ? [setup[2]] : setup;
      sessions.add(args.session);
      return { structuredContent: { messages: packets.map((b) => ({ b: b.toString('base64') })) } };
    } },
    window: { addEventListener() {} },
    document: { hidden: false },
    performance: { now: () => 0 },
    sleep: async () => {},
    requestAnimationFrame: setImmediate,
    cancelAnimationFrame: clearImmediate,
    console,
    Buffer,
    VideoDecoder: class {
      constructor(options) { this.options = options; this.state = 'configured'; }
      configure() {}
      close() { this.state = 'closed'; }
      decode() { this.options.output({ displayWidth: 256, displayHeight: 512, close() {} }); }
    },
    EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
  });
  vm.runInContext(`
    let everConnected = false, session = null, decoder = null, codec = null, config = null;
    let framesDrawn = 0, waitingForKey = true, transport = null, connected = false;
    let displayReady = false, displayError = '', displayConnectingAt = 0, displayRecoveryAttempted = false;
    let pendingFrame = null, paintRequest = null, activePointerId = 1, fallbacks = 0;
    const channel = { thread: 'thread-A', key: 'panel-key' }, pending = new Map();
    const view = 'device', POLL_INTERVAL_MS = 33;
    const canvas = {}, ctx = { drawImage() {} }, device = { hidden: false };
    const $ = () => ({ hidden: false });
    function render() {} function showMessage() {} function refreshManager() {}
    function onJson() {} function showBrowserFallback() { fallbacks++; } function rejectPending() {} function toast() {}
    function send(value) { transport?.send(value); }
    function fromBase64(value) { return Uint8Array.from(Buffer.from(value, 'base64')).buffer; }
    ${connection}\n${video}
    connectBridge();
  `, context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(polls, 6);
  assert.equal(vm.runInContext('fallbacks', context), 1, 'offer browser fallback while continuing recovery');
  assert.equal(vm.runInContext('activePointerId', context), null, 'cancel an interrupted drag before resetting the device session');
  assert.equal(vm.runInContext('session?.width', context), 256, 'restore display session after a failed poll');
  assert.equal(vm.runInContext('session?.height', context), 512);
  assert.equal(vm.runInContext('framesDrawn', context), 1, 'display the recovered frame, not the pending frame from the broken session');
  assert.equal(sessions.size, 2);
  const subscriptions = requests.filter((args) => args.send?.some((message) => message.t === 'logcat' && message.on));
  assert.equal(subscriptions.length, 2, 'restore the open logcat subscription on the new viewer');
  assert.notEqual(subscriptions[0].session, subscriptions[1].session);
  assert.ok(requests.every((args) => args.thread === 'thread-A' && args.key === 'panel-key'));
});


test('missing first frame triggers one automatic display recovery and shows a persistent retry state', () => {
  let now = 20000;
  const context = vm.createContext({ Date: { now: () => now }, document: { hidden: false } });
  const watchdog = source.slice(source.indexOf('function checkDisplayConnection()'), source.indexOf('function showDisplayError()'));
  vm.runInContext(`
    const view = 'device', lastStatus = { emulator: { state: 'ready' } };
    let connected = true, displayReady = false, displayError = '', displayConnectingAt = 0;
    let displayRecoveryAttempted = false, session = null, rendered = 0;
    const sent = [];
    function render() { rendered++; } function send(message) { sent.push(message); } function resetDecoder() {}
    ${watchdog}
    checkDisplayConnection();
    checkDisplayConnection();
  `, context);
  assert.equal(vm.runInContext('sent.length', context), 1, 'a silent display must not cause an automatic restart loop');
  assert.match(vm.runInContext('displayError', context), /emulator is running/);
  vm.runInContext('reconnectDisplay()', context);
  assert.equal(vm.runInContext('sent.length', context), 2, 'manual retry is available');
  assert.equal(vm.runInContext('displayError', context), '');
  now += 16000;
  vm.runInContext('checkDisplayConnection()', context);
  assert.match(vm.runInContext('displayError', context), /not responding/);
  assert.equal(vm.runInContext('sent.length', context), 2, 'one click does not create an endless retry loop');
  vm.runInContext("displayReady = true; displayError = ''; checkDisplayConnection()", context);
  assert.equal(vm.runInContext('displayError', context), '');
});

test('mirror failure invalidates the old image and exposes an actionable error', () => {
  const handler = source.slice(source.indexOf('function onJson('), source.indexOf('// ---- Video'));
  const context = vm.createContext({});
  vm.runInContext(`
    let session = { width: 100, height: 200 }, displayReady = true, displayError = '', renders = 0;
    function resetDecoder() {} function render() { renders++; }
    ${handler}
    onJson({ t: 'mirror-ended', reason: 'The display connection failed. Reconnecting automatically…' });
  `, context);
  assert.equal(vm.runInContext('session', context), null);
  assert.equal(vm.runInContext('displayReady', context), false);
  assert.match(vm.runInContext('displayError', context), /display connection failed/);
  assert.equal(vm.runInContext('renders', context), 1);
});

test('disconnected or closed transports reject actions immediately without leaving pending requests', async () => {
  const requests = source.slice(source.indexOf('function send(value)'), source.indexOf('function rejectPending('));
  let timers = 0;
  const context = vm.createContext({
    setTimeout: () => { timers++; return 1; },
    clearTimeout: () => { timers--; },
  });
  vm.runInContext(`
    let connected = false, transport = null, callId = 0;
    const pending = new Map();
    ${requests}
  `, context);
  await assert.rejects(vm.runInContext("request({ t: 'call' })", context), /reconnecting/);
  for (const sender of ['() => false', "() => { throw new Error('Socket closed'); }"]) {
    vm.runInContext(`connected = true; transport = { send: ${sender} };`, context);
    await assert.rejects(vm.runInContext("request({ t: 'call' })", context), /unavailable|Socket closed/);
  }
  assert.equal(vm.runInContext('pending.size', context), 0);
  assert.equal(timers, 0);
});

test('device switching stops on failure and restores the actual view', async () => {
  const switching = source.slice(source.indexOf('async function switchDevice('), source.indexOf('function renderStatus('));
  const calls = [];
  let failedTool = 'emulator_stop';
  const context = vm.createContext({
    runAction: async (tool) => { calls.push(tool); return tool === failedTool ? null : {}; },
  });
  vm.runInContext(`
    const lastStatus = { emulator: { avd: 'original' } }, device = {};
    let renders = 0;
    function render() { renders++; } function closeMenu() {} function showMessage() {}
    const pretty = (name) => name;
    ${switching}
  `, context);
  await vm.runInContext("switchDevice('new')", context);
  assert.deepEqual(calls, ['emulator_stop']);
  assert.equal(vm.runInContext('renders', context), 1);
  calls.length = 0;
  failedTool = 'emulator_start';
  await vm.runInContext("switchDevice('new')", context);
  assert.deepEqual(calls, ['emulator_stop', 'emulator_start']);
  assert.equal(vm.runInContext('renders', context), 2);
});

test('touch input tracks one pointer and tolerates a disappearing device mid-drag', () => {
  const input = source.slice(source.indexOf('function devicePoint('), source.indexOf('const SPECIAL_KEYS'));
  const listeners = new Map();
  const sent = [];
  const context = vm.createContext({
    canvas: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 200 }),
      setPointerCapture() {},
    },
    keyboard: { focus() {} }, send: (message) => sent.push(message),
  });
  vm.runInContext(`let connected = true, session = { width: 100, height: 200 }, activePointerId = null; ${input}`, context);
  const event = (pointerId, extra = {}) => ({ pointerId, clientX: 10, clientY: 20, button: 0, preventDefault() {}, ...extra });
  listeners.get('pointerdown')(event(1));
  listeners.get('pointerdown')(event(2));
  listeners.get('pointermove')(event(2));
  listeners.get('pointerup')(event(2));
  listeners.get('pointermove')(event(1, { getCoalescedEvents: () => [] }));
  listeners.get('pointerup')(event(1));
  assert.deepEqual(sent.map(({ a }) => a), [0, 2, 1]);
  listeners.get('pointerdown')(event(3));
  vm.runInContext('session = null;', context);
  listeners.get('pointermove')(event(3));
  listeners.get('pointercancel')(event(3));
  assert.deepEqual(sent.map(({ a }) => a), [0, 2, 1, 0]);
  assert.equal(vm.runInContext('activePointerId', context), null);
});

test('render disables device controls while reconnecting and restores them on connection', () => {
  const rendering = source.slice(source.indexOf('function render()'), source.indexOf('function renderPostures()'));
  const buttons = [{}, {}];
  const more = {};
  const context = vm.createContext({ document: { querySelectorAll: () => buttons }, $: () => more });
  vm.runInContext(`
    let connected = false;
    const lastStatus = { emulator: { state: 'ready' } }, device = {}, launcher = {};
    const session = null, displayReady = false, displayError = '';
    function showMessage() {} function layout() {} function renderPostures() {}
    ${rendering}
    render();
  `, context);
  assert.ok(buttons.every((button) => button.disabled));
  assert.equal(more.disabled, true);
  vm.runInContext('connected = true; render();', context);
  assert.ok(buttons.every((button) => !button.disabled));
  assert.equal(more.disabled, false);
});

test('fold controls reflect supported and observed postures, block overlapping actions, and stay honest on failure', async () => {
  const controls = source.slice(source.indexOf('function renderPostures()'), source.indexOf('function element('));
  const group = {};
  const buttons = ['folded', 'half-folded', 'unfolded'].map((posture) => ({ dataset: { posture }, setAttribute(name, value) { this[name] = value; } }));
  const calls = [];
  let finish;
  const context = vm.createContext({
    $: () => group,
    document: { querySelectorAll: () => buttons },
    runAction: async (tool, args) => { calls.push({ tool, ...args }); return new Promise((resolve) => { finish = resolve; }); },
  });
  vm.runInContext(`
    let connected = true, postureChanging = false;
    let lastStatus = { emulator: { state: 'ready' }, foldable: null };
    ${controls}
    renderPostures();
  `, context);
  assert.equal(group.hidden, true);
  vm.runInContext("lastStatus.foldable = { postures: ['folded', 'unfolded'], posture: 'unfolded' }; renderPostures();", context);
  assert.equal(group.hidden, false);
  assert.equal(buttons[1].hidden, true);
  assert.equal(buttons[2]['aria-pressed'], 'true');
  const changing = vm.runInContext("changePosture('folded')", context);
  assert.ok(buttons.every((button) => button.disabled));
  await vm.runInContext("changePosture('unfolded')", context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'emulator_settings');
  assert.equal(calls[0].posture, 'folded');
  finish(null);
  await changing;
  assert.equal(buttons[2]['aria-pressed'], 'true', 'failed change must not update selection optimistically');
  vm.runInContext("lastStatus.foldable.posture = 'folded'; renderPostures();", context);
  assert.equal(buttons[0]['aria-pressed'], 'true');
  vm.runInContext('connected = false; renderPostures();', context);
  assert.ok(buttons.every((button) => button.disabled));
});

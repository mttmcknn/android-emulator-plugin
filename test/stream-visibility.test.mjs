import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../runtime/core/web/app.js', import.meta.url), 'utf8');
const connection = app.slice(app.indexOf('const SERVER_ERROR_CODES'), app.indexOf('// ---- Theme')) + '\n' + app.slice(app.indexOf('// Iframes inherit'), app.indexOf('function fromBase64('));
const tick = () => new Promise(setImmediate);
async function until(check) {
  for (let i = 0; i < 20 && !check(); i++) await tick();
  assert.ok(check(), 'expected panel transition');
}

function panel(bridge = true) {
  const events = new Map(), hostEvents = new Map(), polls = [], calls = [], sockets = [];
  let intersection;
  let nextId = 0;
  const document = { hidden: false, documentElement: {}, addEventListener: (name, fn) => events.set(name, fn) };
  const context = vm.createContext({
    document,
    window: { addEventListener: (name, fn) => events.set(name, fn) },
    IntersectionObserver: class {
      constructor(fn) { intersection = fn; }
      observe() {} disconnect() {}
    },
    host: {
      onTeardown: (fn) => hostEvents.set('teardown', fn),
      callTool: (_, args) => {
        calls.push(args);
        if (!args.wait) return Promise.resolve({});
        return new Promise((resolve, reject) => polls.push({ args, reject, resolve: (messages = []) => resolve({ structuredContent: { messages } }) }));
      },
    },
    WebSocket: class {
      static OPEN = 1;
      constructor() { this.readyState = 1; sockets.push(this); }
      send() {} close() { this.closed = true; }
    },
    crypto: { randomUUID: () => String(++nextId) },
    performance: { now: () => 0 },
    sleep: tick, setTimeout, clearTimeout, queueMicrotask,
  });
  vm.runInContext(`
    let transport, connected = false, everConnected = false, activePointerId = null;
    let displayConnectingAt = 0, displayReady = false, displayError = '', session = null;
    let received = 0, resets = 0;
    const pending = new Map(), view = 'device', POLL_INTERVAL_MS = 33;
    const channel = ${bridge ? '{}' : 'null'}, socketUrl = 'ws://test';
    const $ = () => ({ hidden: true });
    function render() {} function refreshManager() {} function showMessage() {}
    function resetDecoder() { resets++; }
    function rejectPending() { pending.clear(); }
    function onJson() { received++; } function onBinary() { received++; }
    function fromBase64() {} function showBrowserFallback() {} function toast() {}
    ${connection}
    connect();
  `, context);
  return {
    polls, calls, sockets, document,
    run: (code) => vm.runInContext(code, context),
    event: (name) => events.get(name)(),
    intersect: (visible) => intersection([{ isIntersecting: visible, intersectionRect: { width: visible ? 100 : 0, height: 200 } }]),
    teardown: () => hostEvents.get('teardown')(),
  };
}

test('hidden embedded panel releases a held poll immediately and ignores its late frame before resuming a fresh session', async () => {
  const p = panel();
  await tick();
  assert.equal(p.polls.length, 1);
  p.intersect(false);
  assert.equal(p.calls.filter((call) => call.send?.[0]?.t === 'bye').length, 1);
  p.polls[0].resolve([{ j: { t: 'status' } }, { b: 'old frame' }]);
  await tick();
  assert.equal(p.run('received'), 0);
  assert.equal(p.run('connected'), false);
  assert.equal(p.polls.length, 1, 'no hidden polling');
  p.intersect(true);
  await tick();
  assert.equal(p.polls.length, 2);
  assert.notEqual(p.polls[0].args.session, p.polls[1].args.session);
  p.polls[1].resolve([{ j: { t: 'status' } }]);
  await tick();
  assert.equal(p.run('connected'), true);
  assert.equal(p.run('received'), 1);
  p.teardown();
  p.polls.at(-1).resolve();
  await tick();
  const count = p.polls.length;
  p.event('pageshow');
  p.intersect(true);
  await tick();
  assert.equal(p.polls.length, count, 'teardown never reconnects');
});

test('page visibility and pagehide pause sockets; blur is not a visibility signal', () => {
  const p = panel(false);
  p.sockets[0].onopen();
  p.document.hidden = true;
  p.event('visibilitychange');
  assert.equal(p.sockets[0].closed, true);
  p.intersect(true);
  assert.equal(p.sockets.length, 1, 'intersection cannot override a minimized document');
  p.document.hidden = false;
  p.event('visibilitychange');
  assert.equal(p.sockets.length, 2);
  p.event('pagehide');
  assert.equal(p.sockets[1].closed, true);
  p.event('pageshow');
  assert.equal(p.sockets.length, 3);
  p.intersect(false);
  assert.equal(p.sockets[2].closed, true, 'CSS-hidden fallback closes too');
  p.teardown();
});

test('hidden panel finishes actions and multi-chunk uploads before releasing its connection', async () => {
  const p = panel();
  await tick();
  p.polls[0].resolve();
  await tick();
  p.run('pending.set(1, {}); activeUploads = 1;');
  p.intersect(false);
  assert.equal(p.calls.some((call) => call.send), false);
  p.run('pending.clear(); reconcileStream();');
  assert.equal(p.calls.some((call) => call.send), false, 'keep connection between APK chunks');
  p.run('activeUploads = 0; reconcileStream();');
  assert.equal(p.calls.filter((call) => call.send?.[0]?.t === 'bye').length, 1);
  p.teardown();
  p.polls.at(-1).resolve();
  await tick();
});

test('last-viewer shutdown preserves other viewers, typing, and other emulator streams', async () => {
  const daemon = fs.readFileSync(new URL('../runtime/core/daemon.mjs', import.meta.url), 'utf8');
  const idle = daemon.slice(daemon.indexOf('function scheduleMirrorIdle('), daemon.indexOf("leases.on('change'"));
  const timers = new Map();
  let id = 0;
  const context = vm.createContext({
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(`
    const MIRROR_IDLE_MS = 3000, mirrors = new Map([['A', { ready: Promise.resolve() }], ['B', { ready: Promise.resolve() }]]);
    const first = {}, second = {}, other = {};
    const viewers = new Map([['A', new Set([first, second])], ['B', new Set([other])]]), typing = new Set();
    const stopped = [];
    function stopMirror(thread) { stopped.push(thread); mirrors.delete(thread); }
    function unsubscribeLogcat() {}
    ${idle}
    detachViewer('A', first);
  `, context);
  assert.equal(timers.size, 0);
  vm.runInContext("detachViewer('A', second)", context);
  const idleTimer = [...timers.values()][0];
  assert.equal(idleTimer.ms, 3000);
  vm.runInContext("typing.add('A')", context);
  idleTimer.fn();
  await tick();
  assert.equal(vm.runInContext('stopped.length', context), 0);
  vm.runInContext("typing.delete('A'); scheduleMirrorIdle('A', 0)", context);
  const typingTimer = [...timers.values()].at(-1);
  assert.equal(typingTimer.ms, 0);
  typingTimer.fn();
  await tick();
  assert.equal(vm.runInContext("stopped.join(',')", context), 'A');
  assert.equal(vm.runInContext("mirrors.has('B')", context), true);
});


test('a helper-expired session recovers even when the host did not deliver a visibility event', async () => {
  const p = panel();
  await tick();
  p.polls[0].resolve([{ j: { t: 'status' } }]);
  await until(() => p.polls.length === 2);
  p.polls.at(-1).reject(new Error('This display session has closed. Reconnect with a new session.'));
  await until(() => p.polls.length === 3);
  assert.notEqual(p.polls.at(-1).args.session, p.polls[0].args.session);
  p.polls.at(-1).resolve([{ j: { t: 'status' } }]);
  await tick();
  assert.equal(p.run('connected'), true);
  assert.equal(p.run('received'), 2);
  p.teardown();
  p.polls.at(-1).resolve();
  await tick();
});

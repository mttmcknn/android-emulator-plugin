import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { panelResource } from '../runtime/mcp/resources.mjs';

const source = fs.readFileSync(new URL('../runtime/core/web/app.js', import.meta.url), 'utf8');
const workspace = source.slice(source.indexOf('// ---- Device workspace'), source.indexOf('// ---- Manager view'));

class Node {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.attributes = {};
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name), toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    this.contentWindow = {};
  }
  append(...nodes) { for (let node of nodes) { if (typeof node === 'string') node = Object.assign(new Node('text'), { textContent: node }); node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener, options) { this.listeners.set(name, { listener, options }); }
  dispatch(name, event = {}) { const entry = this.listeners.get(name); if (entry?.options?.once) this.listeners.delete(name); return entry?.listener(event); }
  querySelectorAll(selector) { return this.children.flatMap((node) => [...(selector === '[role="tab"]' && node.role === 'tab' ? [node] : []), ...node.querySelectorAll(selector)]); }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
}

function fixture({ embedded = false, initialize = true } = {}) {
  const nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const calls = [];
  const host = { embedded: true, onTeardown() {}, callTool: async (...args) => { calls.push(args); return {}; } };
  const context = vm.createContext({
    document: { addEventListener() {}, createElement: (tag) => new Node(tag), querySelectorAll: () => [] },
    window: { VideoDecoder: {} },
    $, host, URL, location: { href: 'http://localhost/t/chat?workspace=1' },
    element: (tag, props = {}, children = []) => { const node = Object.assign(new Node(tag), props); node.append(...children); return node; },
  });
  vm.runInContext(`
    let view = 'device', lastStatus;
    const embedded = ${embedded}, hostInitialization = { capabilities: { captureContext: true } }, latestHostContext = { theme: 'dark' };
    const launcher = $('launcher'), message = $('message');
    const pretty = (text) => text.replaceAll('_', ' ');
    const safeServerMessage = (text, fallback) => text ?? fallback;
    let visible = true;
    function panelVisible() { return visible; }
    function renderLauncher() {} function showMessage() {}
    const actionCalls = [];
    async function call(tool, args) { actionCalls.push({ tool, args }); return tool === 'emulator_devices' ? currentInventory : {}; }
    let currentInventory;
    ${workspace}
    if (${initialize}) initializeWorkspace();
  `, context);
  const run = (code) => vm.runInContext(code, context);
  const inventory = (devices) => {
    context.nextInventory = { structuredContent: { devices, connectedDevices: [], avds: [] }, meta: { panels: Object.fromEntries(devices.map(({ id }) => [id, { channel: { thread: id, key: `key-${id}` }, panelUrl: `http://localhost/t/${id}?k=key-${id}` }])) } };
    run('currentInventory = nextInventory; renderWorkspace(currentInventory);');
  };
  return { $, run, calls, inventory, context };
}

const device = (id, extra = {}) => ({ id, label: `Device ${id}`, serial: `serial-${id}`, state: 'ready', kind: 'emulator', ...extra });

test('device resources allow only local blob frames without network resources', () => {
  for (const view of ['device', 'manager', 'apk']) {
    const resource = panelResource({ uri: 'ui://fixture', view, webDir: fileURLToPath(new URL('../runtime/core/web', import.meta.url)) });
    assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [], ...(view === 'device' ? { frameDomains: ['blob:'] } : {}) });
  }
});

test('tabs distinguish two instances of the same device by serial', () => {
  const p = fixture();
  p.inventory([device('a', { label: 'Pixel' }), device('b', { label: 'Pixel' })]);
  assert.deepEqual(p.$('workspace-tabs').querySelectorAll('[role="tab"]').map(tab => tab.textContent), ['Pixel · serial-a', 'Pixel · serial-b']);
});

test('unchanged inventory refreshes preserve tabs during keyboard focus and drag', () => {
  const p = fixture();
  const devices = [device('a'), device('b')];
  p.inventory(devices);
  const first = p.$('workspace-tabs').children[0];
  first.dispatch('dragstart', { dataTransfer: { setData() {} } });
  p.inventory(devices);
  assert.equal(p.$('workspace-tabs').children[0], first);
  assert.equal(p.run('draggedDeviceId'), 'a');
});

test('workspace defaults to one fixed-device frame and switches tabs without stopping devices', () => {
  const p = fixture();
  p.inventory([device('a'), device('b'), device('c', { kind: 'physical' })]);
  assert.equal(p.run('workspaceFrames.size'), 1);
  assert.equal(p.run('activeDeviceId'), 'a');
  assert.match(p.run("workspaceFrames.get('a').frame.src"), /\/t\/a\?k=key-a&deviceFrame=1$/);
  p.run("selectWorkspaceDevice('b')");
  assert.equal(p.run('workspaceFrames.size'), 2);
  assert.equal(p.run("workspaceFrames.get('a').frame.hidden"), true);
  assert.equal(p.run("workspaceFrames.get('b').frame.hidden"), false);
  assert.equal(p.run('actionCalls.length'), 0, 'selecting another tab never stops or restarts it');
  const tabs = p.$('workspace-tabs').querySelectorAll('[role="tab"]');
  assert.equal(tabs[1].attributes['aria-selected'], 'true');
  assert.equal(tabs[0].tabIndex, -1);
});

test('Compare, Single view, and drag-to-compare manage exact pairs and parent visibility', () => {
  const p = fixture();
  p.inventory([device('a'), device('b'), device('c')]);
  p.$('workspace-compare').dispatch('click');
  assert.equal(p.run('comparisonDeviceId'), 'b');
  assert.equal(p.run('workspaceFrames.size'), 2);
  const visibility = [];
  p.context.recordVisibility = (visible) => visibility.push(visible);
  p.run("workspaceFrames.get('a').visibilityHandler = recordVisibility;");
  p.run("selectWorkspaceDevice('c')");
  assert.equal(visibility.at(-1), false);
  p.$('workspace-single').dispatch('click');
  assert.equal(p.run('comparisonDeviceId'), null);
  assert.equal(p.run("workspaceFrames.get('b').frame.hidden"), true);
  const transfer = { setData() {} };
  const [first, , third] = p.$('workspace-tabs').children;
  first.dispatch('dragstart', { dataTransfer: transfer });
  third.dispatch('drop', { preventDefault() {} });
  assert.equal(p.run('activeDeviceId'), 'c');
  assert.equal(p.run('comparisonDeviceId'), 'a');
  assert.equal(p.run("workspaceFrames.get('a').frame.hidden"), false);
  p.run('globalThis.__emulatorWorkspaceVisibility(false)');
  assert.equal(visibility.at(-1), false);
  p.run('globalThis.__emulatorWorkspaceVisibility(true)');
  assert.equal(visibility.at(-1), true);
});

test('unpinning disposes only its frame; a disconnected physical pin remains selected', () => {
  const p = fixture();
  p.inventory([device('a'), device('b', { kind: 'physical' })]);
  p.$('workspace-compare').dispatch('click');
  let disposed = 0;
  p.context.onDispose = () => disposed++;
  p.run("workspaceFrames.get('a').teardownHandler = onDispose;");
  p.inventory([device('b', { kind: 'physical', state: 'disconnected' })]);
  assert.equal(disposed, 1);
  assert.equal(p.run('workspaceFrames.size'), 1);
  assert.equal(p.run('activeDeviceId'), 'b');
  assert.equal(p.run('comparisonDeviceId'), null);
  assert.equal(p.run("workspaceFrames.get('b').frame.hidden"), false);
});

test('transfer is sent only after the user accepts the named move dialog', async () => {
  const p = fixture();
  p.inventory([device('a')]);
  p.run("confirmDeviceTransfer({requestId:'request-1',label:'<phone>',ownerTitle:'Other <chat>'})");
  assert.match(p.$('transfer-description').textContent, /Move <phone> from Other <chat>/);
  p.$('transfer-dialog').returnValue = 'cancel';
  p.$('transfer-dialog').open = false;
  p.$('transfer-dialog').dispatch('close');
  assert.equal(p.run('actionCalls.length'), 0);
  p.run("confirmDeviceTransfer({requestId:'request-2',label:'Phone',ownerTitle:'Other chat'})");
  p.$('transfer-dialog').returnValue = 'move';
  p.$('transfer-dialog').dispatch('close');
  await new Promise(setImmediate);
  assert.equal(p.run("actionCalls[0].tool"), 'emulator_transfer');
  assert.equal(p.run("actionCalls[0].args.requestId"), 'request-2');
  assert.equal(p.run("actionCalls[0].args.confirmed"), true);
});

test('child host reuses initialization and scopes direct tool calls without changing stream credentials', async () => {
  const p = fixture();
  p.inventory([device('a')]);
  p.run("globalThis.childHost = globalThis.__emulatorDeviceHost('a')");
  const init = await p.run('childHost.initialize()');
  assert.equal(init.context.displayMode, 'fullscreen');
  assert.equal(init.context.theme, 'dark');
  assert.equal(p.calls.length, 0, 'child must not send ui/initialize to the host');
  const result = await p.run('childHost.firstToolResult()');
  assert.equal(result._meta.panel.channel.thread, 'a');
  await p.run("childHost.callTool('emulator_screenshot', {deviceId:'wrong'})");
  assert.equal(p.calls[0][1].deviceId, 'a');
  await p.run("childHost.callTool('emulator_stream', {thread:'a',key:'key-a',session:'s'})");
  assert.equal(p.calls[1][1].deviceId, undefined);
  assert.equal(p.calls[1][1].thread, 'a');
  assert.equal(p.calls[1][1].key, 'key-a');
});

test('offline and unauthorized inventory give an actionable hint', () => {
  const p = fixture();
  assert.match(p.run("connectedDeviceHint({state:'unauthorized'})"), /Allow USB debugging/);
  assert.match(p.run("connectedDeviceHint({state:'offline'})"), /reconnect/);
  assert.match(p.run("connectedDeviceHint({state:'device',ownerTitle:'Design chat'})"), /Pinned to Design chat/);
});

test('capture updates from device tabs merge without replacing another device evidence', async () => {
  const p = fixture();
  p.inventory([device('a'), device('b')]);
  p.$('workspace-compare').dispatch('click');
  const contexts = [];
  p.context.updateContext = async (content) => contexts.push(JSON.parse(JSON.stringify(content)));
  p.run("host.updateContext = updateContext; globalThis.a = __emulatorDeviceHost('a'); globalThis.b = __emulatorDeviceHost('b');");
  await Promise.all([p.run("a.updateContext([{type:'text',text:'Before'}])"), p.run("b.updateContext([{type:'text',text:'After'}])")]);
  assert.deepEqual(contexts.at(-1).map(({ text }) => text), ['Before', 'After']);
  await p.run('a.updateContext([])');
  assert.deepEqual(contexts.at(-1).map(({ text }) => text), ['After']);
});

test('a child intersection event cannot override the parent hiding its tab', () => {
  let intersect;
  const context = vm.createContext({
    document: { hidden: false, documentElement: {}, addEventListener() {} },
    window: { addEventListener() {} }, host: {},
    IntersectionObserver: class { constructor(handler) { intersect = handler; } observe() {} },
  });
  const visibility = source.slice(source.indexOf('// Iframes inherit'), source.indexOf('function onConnected()'));
  vm.runInContext(`const pending = new Map(); ${visibility}; watchVisibility(); __emulatorFrameVisible(false);`, context);
  intersect([{ isIntersecting: true, intersectionRect: { width: 100, height: 100 } }]);
  assert.equal(vm.runInContext('streamNeeded()', context), false);
  vm.runInContext('__emulatorFrameVisible(true)', context);
  assert.equal(vm.runInContext('streamNeeded()', context), true);
});

test('inventory prompts a move once per request and permits a newly requested move after cancellation', () => {
  const p = fixture();
  p.inventory([device('a')]);
  p.run("currentInventory.structuredContent.confirmationRequired = {requestId:'move-1',label:'Phone',ownerTitle:'Other chat'}; renderWorkspace(currentInventory)");
  const dialog = p.$('transfer-dialog');
  assert.equal(dialog.open, true);
  dialog.returnValue = 'cancel';
  dialog.open = false;
  dialog.dispatch('close');
  p.run('renderWorkspace(currentInventory)');
  p.run('renderWorkspace(currentInventory)');
  assert.equal(dialog.open, false, 'periodic refreshes must not reopen a cancelled move');
  p.run("currentInventory.structuredContent.confirmationRequired.requestId = 'move-2'; renderWorkspace(currentInventory)");
  assert.equal(dialog.open, true, 'a new request may ask again');
  assert.equal(p.run('actionCalls.length'), 0, 'showing or cancelling prompts never transfers a device');
});

test('boot preserves a first tool result conflict until the workspace is connected', async () => {
  const p = fixture({ embedded: true, initialize: false });
  p.context.initialResult = {
    structuredContent: { confirmationRequired: { requestId: 'initial-move', label: 'Phone', ownerTitle: 'Other chat' } },
    _meta: { panel: { workspace: true, channel: { thread: 'chat', key: 'key', workspace: true } } },
  };
  const boot = source.slice(source.indexOf('async function boot()'), source.indexOf('boot().catch('));
  const connected = source.slice(source.indexOf('function onConnected()'), source.indexOf('function onDisconnected()'));
  p.run(`
    const deviceFrame = false;
    let channel, fallbackUrl, socketUrl, connected = false, displayConnectingAt = 0;
    function applyTheme() {} async function initHost() {} function connect() {} function send() {}
    host.firstToolResult = async () => initialResult;
    ${boot}
    ${connected}
  `);
  p.$('logcat').hidden = true;
  await p.run('boot()');
  assert.equal(p.run('view'), 'workspace');
  assert.notEqual(p.$('transfer-dialog').open, true, 'wait for the connection before enabling a move');
  p.run('onConnected()');
  assert.equal(p.$('transfer-dialog').open, true);
  assert.match(p.$('transfer-description').textContent, /Move Phone from Other chat/);
  assert.equal(p.run('workspaceInitialResult'), null);
  p.run('renderWorkspace(initialResult)');
  assert.equal(p.run('shownTransferRequests.size'), 1);
});

test('manager stops the selected device in a multi-device chat and labels physical devices as Unpin', async () => {
  const p = fixture();
  p.context.overview = {
    running: [device('a', { threadId: 'same-chat', avd: 'Pixel' }), device('b', { threadId: 'same-chat', kind: 'physical', label: 'USB phone' })],
    devices: [], totalSize: '0 B',
  };
  const manager = source.slice(source.indexOf('async function refreshManager('), source.indexOf('// ---- APK view'));
  p.run(`async function runAction(tool, args) { actionCalls.push({tool, args}); return overview; } ${manager}`);
  await p.run('refreshManager()');
  const rows = p.$('manager-running').children;
  const physicalStop = rows[1].children[1].children[0];
  assert.equal(physicalStop.textContent, 'Unpin');
  await physicalStop.dispatch('click');
  assert.equal(p.run('actionCalls[1].tool'), 'manager_stop');
  assert.equal(p.run('actionCalls[1].args.threadId'), 'same-chat');
  assert.equal(p.run('actionCalls[1].args.deviceId'), 'b');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../runtime/hosts/codex/panel.js', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function adapter(pathname = '/panel') {
  const listeners = new Map();
  const sent = [];
  const timers = [];
  const parent = { postMessage: (message) => sent.push(message) };
  const emulatorTheme = { content: '' };
  const window = { parent, addEventListener: (name, handler) => listeners.set(name, handler) };
  const context = vm.createContext({
    window, location: { pathname },
    document: { querySelector: (selector) => selector.includes('emulator-theme') ? emulatorTheme : null },
    setTimeout: (handler) => { timers.push(handler); return timers.length; },
    clearTimeout: () => {},
  });
  vm.runInContext(source, context);
  return {
    context,
    sent,
    theme: emulatorTheme,
    deliver: (data) => listeners.get('message')({ source: parent, data }),
  };
}

test('Codex adapter normalizes host capabilities and owns host RPC details', async () => {
  const panel = adapter();
  const initialized = vm.runInContext('emulatorHost.initialize()', panel.context);
  const initialize = panel.sent.at(-1);
  assert.equal(initialize.method, 'ui/initialize');
  panel.deliver({ jsonrpc: '2.0', id: initialize.id, result: {
    hostContext: { theme: 'dark' },
    hostCapabilities: { updateModelContext: { image: {}, resourceLink: {} }, experimental: { 'openai/files': {} } },
  } });
  const init = await initialized;
  assert.deepEqual(plain(init.context), { theme: 'dark' });
  assert.deepEqual(plain(init.capabilities), { captureContext: true, contextResourceLink: true, openFile: true });

  const call = vm.runInContext("emulatorHost.callTool('emulator_stream', { session: 'one' })", panel.context);
  const tool = panel.sent.at(-1);
  assert.equal(tool.method, 'tools/call');
  assert.deepEqual(plain(tool.params), { name: 'emulator_stream', arguments: { session: 'one' } });
  panel.deliver({ jsonrpc: '2.0', id: tool.id, result: { structuredContent: {} } });
  await call;

  const openChat = vm.runInContext("emulatorHost.openChat('thread-1')", panel.context);
  const open = panel.sent.at(-1);
  assert.deepEqual(plain(open.params), { url: 'codex://threads/thread-1' });
  panel.deliver({ jsonrpc: '2.0', id: open.id, result: {} });
  await openChat;
  const first = vm.runInContext("emulatorHost.firstToolResult('emulator_panel')", panel.context);
  panel.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { panel: true } } });
  assert.deepEqual(plain(await first), { structuredContent: { panel: true } });
  const blocks = vm.runInContext("emulatorHost.contextImage({ title: 'Frame 1', data: 'bytes', mimeType: 'image/png' })", panel.context);
  assert.equal(blocks[1]._meta['openai/title'], 'Frame 1');
});

test('Codex adapter keeps directly served browser pages on the WebSocket transport', () => {
  const browser = adapter('/t/chat');
  assert.equal(vm.runInContext('emulatorHost.embedded', browser.context), false);
  assert.deepEqual(browser.sent, []);
});

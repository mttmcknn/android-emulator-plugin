import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../runtime/core/web/app.js', import.meta.url), 'utf8');

test('panel errors prefer the server error contract and never copy tool-result content', () => {
  const helpers = source.slice(source.indexOf('const SERVER_ERROR_CODES'), source.indexOf('// ---- Theme'));
  const context = vm.createContext({ Error, Set });
  vm.runInContext(`${helpers}
    globalThis.structured = panelError({
      content: [{ text: 'https://localhost/?token=secret' }],
      structuredContent: { error: { code: 'AE_HELPER_CONNECT', message: 'The local helper is unavailable.' } },
    }, 'AE_PANEL_INIT', 'The panel could not start.');
    globalThis.untrusted = panelError({
      content: [{ text: 'channel-key-should-never-appear' }],
      structuredContent: { error: { code: 'UNKNOWN', message: 'channel-key-should-never-appear' } },
    }, 'AE_PANEL_INIT', 'The panel could not start.');
    globalThis.url = panelError({
      structuredContent: { error: { code: 'AE_HELPER_CONNECT', message: 'Open https://localhost/?key=secret' } },
    }, 'AE_PANEL_INIT', 'The panel could not start.');`, context);

  assert.equal(context.structured.code, 'AE_HELPER_CONNECT');
  assert.equal(context.structured.message, 'The local helper is unavailable.');
  assert.equal(context.untrusted.code, 'AE_PANEL_INIT');
  assert.equal(context.untrusted.message, 'The panel could not start.');
  assert.equal(context.url.message, 'The panel could not start.');
});

test('display failures expose stable timeout, decode, and ended codes', () => {
  const watchdog = source.slice(source.indexOf('function checkDisplayConnection()'), source.indexOf('function showDisplayError()'));
  const timeout = vm.createContext({ Date: { now: () => 20_000 }, document: { hidden: false } });
  vm.runInContext(`
    const view = 'device', lastStatus = { emulator: { state: 'ready' } };
    let connected = true, displayReady = false, displayError = '', displayConnectingAt = 0;
    let displayRecoveryAttempted = false, session = null;
    function render() {} function send() { return true; } function resetDecoder() {}
    ${watchdog}
    checkDisplayConnection();
  `, timeout);
  assert.match(vm.runInContext('displayError', timeout), /^\[AE_DISPLAY_TIMEOUT]/);

  const handler = source.slice(source.indexOf('function onJson('), source.indexOf('// ---- Video'));
  const ended = vm.createContext({});
  vm.runInContext(`
    let session = {}, displayReady = true, displayError = '';
    function resetDecoder() {} function render() {}
    ${handler}
    onJson({ t: 'mirror-ended' });
  `, ended);
  assert.match(vm.runInContext('displayError', ended), /^\[AE_DISPLAY_ENDED]/);

  const video = source.slice(source.indexOf('const hex ='), source.indexOf('let fpsFrames'));
  const decode = vm.createContext({
    console: { warn() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    VideoDecoder: class {
      constructor() { this.state = 'configured'; }
      configure() {}
      close() { this.state = 'closed'; }
      decode() { throw new Error('decode failed'); }
    },
    EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
  });
  vm.runInContext(`
    let paintRequest = null, pendingFrame = null, decoder = null, waitingForKey = false;
    let codec = 'avc1.42e01f', config = null, displayReady = true, displayError = '', framesDrawn = 0;
    const canvas = {}, ctx = { drawImage() {} };
    function render() {} function send() { return true; }
    ${video}
    const packet = new ArrayBuffer(11);
    new DataView(packet).setUint8(0, 3);
    new DataView(packet).setUint8(1, 1);
    onBinary(packet);
  `, decode);
  assert.match(vm.runInContext('displayError', decode), /^\[AE_DISPLAY_DECODE]/);
});

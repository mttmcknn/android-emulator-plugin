// Codex host adapter. It is loaded before the shared emulator web module.
(() => {
  let nextId = 0;
  const waiting = new Map();
  const handlers = new Map();
  let toolInput = {};

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== window.parent || message?.jsonrpc !== '2.0') return;
    if (message.method) {
      if (message.method === 'ui/notifications/tool-input') toolInput = message.params?.arguments ?? toolInput;
      for (const handler of handlers.get(message.method) ?? []) handler(message.params ?? {});
      if (message.id !== undefined) window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
      return;
    }
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });

  const on = (method, handler) => handlers.set(method, [...(handlers.get(method) ?? []), handler]);
  const notify = (method, params = {}) => window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  const request = (method, params = {}, timeoutMs = 600_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(Object.assign(new Error('The host did not respond. Reopen the emulator panel and try again.'), { code: 'AE_HOST_TIMEOUT' }));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });

  globalThis.emulatorHost = {
    embedded: !location.pathname.startsWith('/t/'),
    label: 'Codex',
    async initialize() {
      const init = await request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'android-emulator-plugin', version: '1' },
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
      }, 15_000);
      notify('ui/notifications/initialized');
      const hostCapabilities = init?.hostCapabilities ?? {};
      return {
        context: init?.hostContext,
        capabilities: {
          captureContext: Boolean(hostCapabilities.updateModelContext?.image),
          contextResourceLink: Boolean(hostCapabilities.updateModelContext?.resourceLink),
          openFile: Boolean(hostCapabilities.experimental?.['openai/files']),
        },
      };
    },
    onContextChange: (handler) => on('ui/notifications/host-context-changed', handler),
    onTeardown: (handler) => on('ui/resource-teardown', handler),
    firstToolResult(tool, args = () => ({})) {
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (result) => {
          if (done || !result) return;
          done = true;
          resolve(result);
        };
        on('ui/notifications/tool-result', finish);
        setTimeout(() => {
          if (!done) this.callTool(tool, args()).then(finish, reject);
        }, 800);
      });
    },
    callTool: (name, args, timeoutMs) => request('tools/call', { name, arguments: args }, timeoutMs),
    openUrl: (url) => request('ui/open-link', { url }),
    setDisplayMode: () => notify('ui/notifications/size-changed', { height: 640 }),
    requestDisplayMode: (mode) => request('ui/request-display-mode', { mode }),
    updateContext: (content) => request('ui/update-model-context', { content }, 30_000),
    openFile: (path) => request('openai/files/open', { path }, 30_000),
    openChat: (threadId) => request('ui/open-link', { url: `codex://threads/${threadId}` }),
    contextImage: (image) => [
      { type: 'text', text: image.title },
      { type: 'image', data: image.data, mimeType: image.mimeType, _meta: { 'openai/title': image.title } },
    ],
    toolInput: () => toolInput,
  };
})();

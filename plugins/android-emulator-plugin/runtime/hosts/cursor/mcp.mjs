// Cursor entrypoint: binds every call to this window's workspace session and the shared emulator runtime.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHelperClient } from '../../mcp/helper-client.mjs';
import { retainRuntime } from '../../mcp/runtime-copy.mjs';
import { createMcpHandler } from '../../mcp/server.mjs';
import { panelResource } from '../../mcp/resources.mjs';
import { diagnosticError } from '../../core/lib/errors.mjs';
import { PLUGIN_VERSION, HELPER_VERSION, stateDir } from './config.mjs';
import { collectDiagnostics } from './diagnostics.mjs';
import { registerSession, resolveWorkspace, sessionIdFor } from './sessions.mjs';
import { serveMcpWithClient } from './stdio.mjs';
import { iconFor, INSTRUCTIONS, MANAGER_URI, PANEL_URI, TOOLS, withPanelConnection } from './tools.mjs';

const dir = stateDir();
const runtimeRoot = retainRuntime(fileURLToPath(new URL('../../', import.meta.url)), dir);
const webDir = path.join(runtimeRoot, 'core', 'web');
const panelScript = path.join(runtimeRoot, 'hosts', 'cursor', 'panel.js');
const helper = createHelperClient({ dir, daemonFile: path.join(runtimeRoot, 'hosts', 'cursor', 'daemon.mjs'), helperVersion: HELPER_VERSION });
const views = { [PANEL_URI]: 'device', [MANAGER_URI]: 'manager' };

const ROOTS_TIMEOUT_MS = 3_000;
let supportsRoots = false;
let roots = Promise.resolve([]);
let session;

function onMessage(message, request) {
  if (message.method === 'initialize') supportsRoots = Boolean(message.params?.capabilities?.roots);
  if (message.method === 'notifications/initialized' && supportsRoots) {
    roots = request('roots/list').then(result => result?.roots ?? [], () => []);
  }
}

// Resolved on the first call, after the client has had a chance to report its workspace roots.
function currentSession() {
  const timeout = new Promise(resolve => setTimeout(resolve, ROOTS_TIMEOUT_MS, []).unref());
  session ??= Promise.race([roots, timeout]).then(reported => {
    const workspace = resolveWorkspace({ roots: reported });
    const id = sessionIdFor(workspace);
    registerSession(dir, id, workspace);
    return id;
  });
  return session;
}

serveMcpWithClient(createMcpHandler({
  serverInfo: { name: 'android-emulator-plugin', title: 'Android Emulators', version: PLUGIN_VERSION, icons: iconFor('android') },
  instructions: INSTRUCTIONS, tools: TOOLS,
  resources: Object.entries(views).map(([uri, view]) => ({ uri, name: `Emulator ${view === 'device' ? 'panel' : view}`, mimeType: 'text/html;profile=mcp-app' })),
  readResource(uri) {
    if (!views[uri]) throw Object.assign(new Error(`Unknown resource ${uri}`), { code: -32602 });
    try {
      return panelResource({ uri, view: views[uri], webDir, panelScript });
    } catch (error) {
      throw diagnosticError('AE_RESOURCE_LOAD', 'The emulator panel files could not be read. Reinstall the plugin and reload the window.', error);
    }
  },
  async callTool(name, args) {
    const sessionId = await currentSession();
    // Diagnostics cannot upgrade/restart a helper, even if the plugin just updated.
    if (name === 'emulator_diagnostics') return collectDiagnostics({ dir, webDir, info: helper.readInfo(), threadId: sessionId });
    return withPanelConnection(await helper.call(sessionId, name, args));
  },
}), { onMessage });

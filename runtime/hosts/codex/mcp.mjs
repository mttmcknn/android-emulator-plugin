// Codex entrypoint: binds trusted tool metadata to the shared emulator runtime.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHelperClient } from '../../mcp/helper-client.mjs';
import { retainRuntime } from '../../mcp/runtime-copy.mjs';
import { createMcpHandler, serveMcp } from '../../mcp/server.mjs';
import { panelResource, mentionResource } from '../../mcp/resources.mjs';
import { EMULATOR_INSTRUCTIONS } from '../../core/tools.mjs';
import { diagnosticError } from '../../core/lib/errors.mjs';
import { PLUGIN_VERSION, HELPER_VERSION, stateDir } from './config.mjs';
import { readCodexTheme } from './theme.mjs';
import { collectDiagnostics } from './diagnostics.mjs';
import { APK_URI, iconFor, MANAGER_URI, PANEL_URI, THREADLESS, TOOLS, TOOL_NAMES, runtimeToolName, toolReferences } from './tools.mjs';

const dir = stateDir();
const runtimeRoot = retainRuntime(fileURLToPath(new URL('../../', import.meta.url)), dir);
const webDir = path.join(runtimeRoot, 'core', 'web');
const panelScript = path.join(runtimeRoot, 'hosts', 'codex', 'panel.js');
const helper = createHelperClient({ dir, daemonFile: path.join(runtimeRoot, 'hosts', 'codex', 'daemon.mjs'), helperVersion: HELPER_VERSION });
const settings = { readTool: 'settings_read', updateTool: 'settings_update' };
const views = { [PANEL_URI]: 'device', [MANAGER_URI]: 'manager', [APK_URI]: 'apk' };


serveMcp(createMcpHandler({
  serverInfo: { name: 'android-emulator-plugin', title: 'Android Emulators', version: PLUGIN_VERSION, icons: iconFor('android') },
  instructions: toolReferences(EMULATOR_INSTRUCTIONS), tools: TOOLS,
  capabilities: { experimental: { 'openai/settings': settings }, extensions: { 'openai/settings': settings } },
  resources: Object.entries(views).map(([uri, view]) => ({ uri, name: `Emulator ${view === 'device' ? 'panel' : view}`, mimeType: 'text/html;profile=mcp-app' })),
  readResource(uri) {
    if (views[uri]) {
      try {
        const resource = panelResource({ uri, view: views[uri], webDir, panelScript, theme: readCodexTheme(), meta: {
          'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
          'openai/widgetDescription': 'Run apps and control this chat’s Android device.',
        } });
        const names = JSON.stringify(TOOL_NAMES).replaceAll('<', '\\u003c');
        resource.text = resource.text.replace('<head>', `<head><script type="application/json" id="codex-tool-names">${names}</script>`);
        return resource;
      } catch (error) { throw diagnosticError('AE_RESOURCE_LOAD', 'The emulator panel files could not be read. Reinstall the plugin and reopen the panel.', error); }
    }
    const mention = mentionResource(uri);
    if (mention) return mention;
    throw Object.assign(new Error(`Unknown resource ${uri}`), { code: -32602 });
  },
  callTool(name, args, meta) {
    name = runtimeToolName(name);
    const threadId = meta?.threadId;
    // Diagnostics cannot upgrade/restart a helper, even if the plugin just updated.
    if (name === 'emulator_diagnostics') return collectDiagnostics({ dir, webDir, info: helper.readInfo(), threadId });
    if (!threadId && !THREADLESS.has(name)) throw diagnosticError('AE_THREAD_REQUIRED', 'Codex did not supply a chat identity. Open Android Emulator from the chat you want to use.');
    // Only Codex's trusted file-entrypoint metadata can supply this path.
    const callArgs = name === 'emulator_apk' ? { ...args, resourcePath: meta?.['openai/resource']?.path } : args;
    return helper.call(threadId, name, callArgs);
  },
}));

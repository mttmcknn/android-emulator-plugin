import { TOOLS as sharedTools, iconFor, THREADLESS } from '../../core/tools.mjs';
export { iconFor, THREADLESS };

// Keep published resource URIs and Codex entrypoints stable; schemas live in core.
export const PANEL_URI = 'ui://android-emulator-plugin/panel.html';
export const MANAGER_URI = 'ui://android-emulator-plugin/manager.html';
export const APK_URI = 'ui://android-emulator-plugin/apk.html';
const registrations = {
  emulator_panel: { ui: { resourceUri: PANEL_URI }, 'openai/outputTemplate': PANEL_URI,
    'openai/widgetAccessible': true, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  emulator_manager: { ui: { visibility: ['app'], resourceUri: MANAGER_URI }, 'openai/ui': { entrypoints: [{ type: 'global' }] } },
  emulator_apk: { ui: { visibility: ['app'], resourceUri: APK_URI }, 'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.apk'] }] } },
  emulator_mentions: { ui: { visibility: ['app'] }, 'openai/extensions': { 'mentions/search': {} } },
};
export const TOOLS = sharedTools.map(tool => registrations[tool.name] ? { ...tool, _meta: registrations[tool.name] } : tool);
export const panelMetadata = threadId => ({ 'openai/widgetSessionId': `android-emulator:${threadId}` });

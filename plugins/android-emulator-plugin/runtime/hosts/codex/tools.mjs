import { TOOLS as sharedTools, iconFor, THREADLESS } from '../../core/tools.mjs';
export { iconFor, THREADLESS };

// Keep published resource URIs and Codex entrypoints stable; schemas live in core.
export const PANEL_URI = 'ui://android-emulator-plugin/panel.html';
export const MANAGER_URI = 'ui://android-emulator-plugin/manager.html';
export const APK_URI = 'ui://android-emulator-plugin/apk.html';

// Codex derives activity labels from tool names, ignoring MCP display titles.
// Keep this presentation choice at the host boundary; runtime operation IDs stay stable.
export const TOOL_NAMES = Object.freeze({
  emulator_devices: 'list_devices',
  emulator_pin: 'pin_device',
  emulator_navigate: 'navigate_app',
  emulator_backends: 'manage_device_tools',
  emulator_status: 'check_device_status',
  emulator_diagnostics: 'diagnose_device_issues',
  emulator_panel: 'show_device_panel',
  emulator_create: 'create_emulator',
  emulator_start: 'start_emulator',
  emulator_stop: 'stop_or_unpin_device',
  emulator_screenshot: 'take_screenshot',
  emulator_capture: 'view_or_copy_captures',
  emulator_ui_tree: 'read_screen_elements',
  emulator_wait_for: 'wait_for_screen',
  emulator_tap: 'tap_screen',
  emulator_swipe: 'swipe_screen',
  emulator_scroll_to: 'scroll_to_element',
  emulator_observe: 'inspect_screen',
  emulator_type: 'type_text',
  emulator_app: 'manage_app',
  emulator_key: 'press_device_key',
  emulator_install: 'install_app',
  emulator_open: 'open_app_or_link',
  emulator_settings: 'change_device_settings',
  emulator_record: 'record_screen',
  emulator_snapshot: 'manage_emulator_snapshots',
  emulator_adb: 'run_device_command',
});
const runtimeNames = new Map(Object.entries(TOOL_NAMES).map(([internal, exposed]) => [exposed, internal]));
export const runtimeToolName = name => runtimeNames.get(name) ?? name;
export const toolReferences = text => text.replace(/\bemulator_[a-z_]+\b/g, name => TOOL_NAMES[name] ?? name);
const registrations = {
  emulator_panel: { ui: { resourceUri: PANEL_URI }, 'openai/outputTemplate': PANEL_URI,
    'openai/widgetAccessible': true, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  emulator_manager: { ui: { visibility: ['app'], resourceUri: MANAGER_URI }, 'openai/ui': { entrypoints: [{ type: 'global' }] } },
  emulator_apk: { ui: { visibility: ['app'], resourceUri: APK_URI }, 'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.apk'] }] } },
  emulator_mentions: { ui: { visibility: ['app'] }, 'openai/extensions': { 'mentions/search': {} } },
};
export const TOOLS = sharedTools.map(tool => ({
  ...tool,
  name: TOOL_NAMES[tool.name] ?? tool.name,
  description: toolReferences(tool.description),
  inputSchema: JSON.parse(toolReferences(JSON.stringify(tool.inputSchema))),
  ...(registrations[tool.name] ? { _meta: registrations[tool.name] } : {}),
}));
// Result-level UI metadata opens the device only after startup succeeds. Sharing
// the resource and session with emulator_panel lets Codex reuse the same tab.
export const panelMetadata = threadId => ({
  ui: { resourceUri: PANEL_URI },
  'openai/widgetSessionId': `android-emulator:${threadId}`,
});

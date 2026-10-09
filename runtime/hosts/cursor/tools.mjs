import { EMULATOR_INSTRUCTIONS, TOOLS as sharedTools, iconFor, MANAGER_URI, PANEL_URI, THREADLESS } from '../../core/tools.mjs';
export { iconFor, MANAGER_URI, PANEL_URI, THREADLESS };

// The .apk file viewer and @-mention search depend on Codex entrypoints that Cursor does not offer.
const UNSUPPORTED = new Set(['emulator_apk', 'emulator_mentions']);

export const TOOLS = sharedTools.filter(tool => !UNSUPPORTED.has(tool.name));

// Cursor renders a panel only for tools that declare one, so startup results cannot open it.
export const AUTO_PANEL = 'Successful startup returns the device panel automatically in supported hosts; do not follow it with emulator_panel.';
const CURSOR_PANEL = 'After startup, call emulator_panel to show the device. If the panel does not render inline, give the user the browser URL from the result.';

export const INSTRUCTIONS =
  'In Cursor a "chat" is the Cursor window: every chat in one window shares its devices. ' +
  EMULATOR_INSTRUCTIONS.replace(AUTO_PANEL, CURSOR_PANEL);

// Cursor can drop _meta before forwarding a result to the panel, so the connection also rides in
// structuredContent, and the text offers the browser panel for when the inline panel does not render.
export function withPanelConnection(result) {
  const panel = result?.meta?.panel;
  if (!panel) return result;
  const text = panel.panelUrl ? `${result.text}\nIf the panel does not appear inline, open it in a browser: ${panel.panelUrl}` : result.text;
  return { ...result, text, structuredContent: { ...result.structuredContent, panel } };
}

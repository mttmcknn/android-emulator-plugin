import { EMULATOR_INSTRUCTIONS, TOOLS as sharedTools, iconFor, MANAGER_URI, PANEL_URI, THREADLESS } from '../../core/tools.mjs';
export { iconFor, MANAGER_URI, PANEL_URI, THREADLESS };

/** Screen memory routes every action through the navigation CLI; Cursor enables it only on request. */
export const screenMemoryEnabled = (env = process.env) => env.EMULATOR_SCREEN_MEMORY === '1';

// The .apk file viewer and @-mention search depend on Codex entrypoints that Cursor does not offer.
const UNSUPPORTED = new Set(['emulator_apk', 'emulator_mentions']);

// Cursor renders a panel only for tools that declare one, so startup results cannot open it.
export const AUTO_PANEL = 'Successful startup returns the device panel automatically in supported hosts; do not follow it with emulator_panel.';
const CURSOR_PANEL = 'After startup, call emulator_panel to show the device. If the panel does not render inline, give the user the browser URL from the result.';
export const SCREEN_NAMING = 'Name screens as you inspect them: when navigation reports currentPlace.needsLabel, call emulator_navigate with action whereami and a short descriptive label based on fresh UI evidence. Replace numbered placeholders on revisit, preserve useful names, omit personal data, and never ask the user to manage screen names. ';

// Short swipes fling scrollable lists past the target before the next read, so scroll_to swipes slowly.
export const SCROLL_TO_DURATION_MS = 900;

export function cursorTools({ screenMemory }) {
  return sharedTools.filter(tool => !UNSUPPORTED.has(tool.name) && (screenMemory || tool.name !== 'emulator_navigate'));
}

export function cursorInstructions({ screenMemory }) {
  const shared = EMULATOR_INSTRUCTIONS.replace(AUTO_PANEL, CURSOR_PANEL);
  return 'In Cursor a "chat" is the Cursor window: every chat in one window shares its devices. ' +
    (screenMemory ? shared : shared.replace(SCREEN_NAMING, ''));
}

export function withCursorDefaults(name, args) {
  return name === 'emulator_scroll_to' ? { durationMs: SCROLL_TO_DURATION_MS, ...args } : args;
}

// Cursor can drop _meta before forwarding a result to the panel, so the connection also rides in
// structuredContent, and the text offers the browser panel for when the inline panel does not render.
export function withPanelConnection(result) {
  const panel = result?.meta?.panel;
  if (!panel) return result;
  const text = panel.panelUrl ? `${result.text}\nIf the panel does not appear inline, open it in a browser: ${panel.panelUrl}` : result.text;
  return { ...result, text, structuredContent: { ...result.structuredContent, panel } };
}

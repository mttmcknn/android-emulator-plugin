import { createMinimapBackend } from '../../core/backends/minimap.mjs';

export const INSPECT_ONLY = 'inspect-only';

// Reads screens through the Android CLI like the minimap backend but never prepares screen memory, so
// taps, swipes, keys, and app launches run directly instead of through the navigation CLI, which adds
// seconds per action. Without a prepare step the runtime skips automatic learning.
export function inspectOnlyNavigation({ stateDir }) {
  const minimap = createMinimapBackend({ stateDir });
  return {
    id: INSPECT_ONLY,
    label: 'Screen reading without screen memory',
    version: minimap.version,
    probe: async () => ({ available: true }),
    uiNodes: minimap.uiNodes,
    create: () => ({
      status: (cwd, packageName) => ({ initialized: false, packageName, places: [], edges: [] }),
      execute: async () => {
        throw new Error('Screen memory is off in Cursor. Set EMULATOR_SCREEN_MEMORY=1 in the MCP server environment to enable it.');
      },
    }),
  };
}

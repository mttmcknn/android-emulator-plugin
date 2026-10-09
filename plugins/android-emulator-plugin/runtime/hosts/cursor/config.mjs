import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNTIME_VERSION } from '../../core/version.mjs';

export const PLUGIN_VERSION = RUNTIME_VERSION;
export const HELPER_VERSION = PLUGIN_VERSION;

// Separate from the Codex helper so both hosts can run side by side without replacing each other.
export function stateDir() {
  const dir = process.env.EMULATOR_FOR_CURSOR_STATE_DIR
    ?? (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Emulator for Cursor')
      : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'emulator-for-cursor'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const helperPort = () => Number(process.env.EMULATOR_FOR_CURSOR_PORT ?? 47660);

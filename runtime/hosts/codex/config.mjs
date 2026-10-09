import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNTIME_VERSION } from '../../core/version.mjs';

export const PLUGIN_VERSION = RUNTIME_VERSION;

// Epoch 2 introduces device-scoped sessions. Upgrade helpers already running the
// same dated plugin version, while older clients keep using the newer helper.
export function helperVersion(version) {
  return version.replace(/^\d+/, (major) => String(Number(major) + 2));
}
export const HELPER_VERSION = helperVersion(PLUGIN_VERSION);

export function stateDir() {
  const dir = process.env.EMULATOR_FOR_CODEX_STATE_DIR
    ?? (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Emulator for Codex')
      : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'emulator-for-codex'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const helperPort = () => Number(process.env.EMULATOR_FOR_CODEX_PORT ?? 47650);

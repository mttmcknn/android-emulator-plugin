import { fileURLToPath } from 'node:url';
import { startDaemon } from '../../core/daemon.mjs';
import { panelMetadata } from './tools.mjs';
import { stateDir, helperPort, PLUGIN_VERSION, HELPER_VERSION } from './config.mjs';
import { threadInfo } from './threads.mjs';
import { readCodexTheme, watchTheme } from './theme.mjs';

try {
  const service = await startDaemon({
    dir: stateDir(), port: helperPort(), version: PLUGIN_VERSION, helperVersion: HELPER_VERSION,
    panelMetadata, readSessions: threadInfo, appearance: { read: readCodexTheme, subscribe: watchTheme },
    panelScript: fileURLToPath(new URL('./panel.js', import.meta.url)),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => service.close().then(() => process.exit(0)));
} catch (error) {
  process.stderr.write(`Android Emulators could not start: ${error.message}\n`);
  process.exitCode = 1;
}

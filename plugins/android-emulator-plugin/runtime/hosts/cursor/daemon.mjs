import { fileURLToPath } from 'node:url';
import { startDaemon } from '../../core/daemon.mjs';
import { inspectOnlyNavigation } from './backends.mjs';
import { stateDir, helperPort, PLUGIN_VERSION, HELPER_VERSION } from './config.mjs';
import { createSessionReader } from './sessions.mjs';

try {
  const dir = stateDir();
  const service = await startDaemon({
    dir, port: helperPort(), version: PLUGIN_VERSION, helperVersion: HELPER_VERSION,
    readSessions: createSessionReader(dir),
    providers: { navigation: [inspectOnlyNavigation({ stateDir: dir })] },
    panelScript: fileURLToPath(new URL('./panel.js', import.meta.url)),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => service.close().then(() => process.exit(0)));
} catch (error) {
  process.stderr.write(`Android Emulators could not start: ${error.message}\n`);
  process.exitCode = 1;
}

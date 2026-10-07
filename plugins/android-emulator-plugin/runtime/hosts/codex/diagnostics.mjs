import { collectDiagnostics as collectRuntimeDiagnostics } from '../../core/lib/diagnostics.mjs';
import { compareVersions } from '../../core/lib/sdk.mjs';
import { PLUGIN_VERSION, HELPER_VERSION } from './config.mjs';
import { hostDiagnostics } from './host-diagnostics.mjs';

export function collectDiagnostics({ hostOptions = {}, ...options }) {
  return collectRuntimeDiagnostics({
    ...options, version: PLUGIN_VERSION, helperVersion: HELPER_VERSION,
    hostDiagnostics: context => hostDiagnostics({ ...hostOptions, ...context }),
    supportsDiagnostics: health => health.capabilities?.diagnostics === true || compareVersions(health.version, '1.3.0') >= 0,
  });
}

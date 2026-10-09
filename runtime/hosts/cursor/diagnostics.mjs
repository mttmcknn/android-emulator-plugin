import { collectDiagnostics as collectRuntimeDiagnostics } from '../../core/lib/diagnostics.mjs';
import { PLUGIN_VERSION, HELPER_VERSION } from './config.mjs';

export const collectDiagnostics = options => collectRuntimeDiagnostics({ ...options, version: PLUGIN_VERSION, helperVersion: HELPER_VERSION });

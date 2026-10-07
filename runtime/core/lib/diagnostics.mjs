import fs from 'node:fs';
import path from 'node:path';
import { sdk } from './sdk.mjs';
import { RUNTIME_VERSION } from '../version.mjs';

const version = value => /^\d+\.\d+\.\d+$/.test(value ?? '') ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const MAX_HELPER_BYTES = 64 * 1024;

async function helperJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_HELPER_BYTES) throw new Error('Diagnostic response exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function leaseDiagnostics(lease) {
  if (!lease) return { state: 'unassigned' };
  let processRunning = null;
  if (Number.isSafeInteger(lease.pid) && lease.pid > 0) {
    try { process.kill(lease.pid, 0); processRunning = true; }
    catch (error) { if (error.code === 'ESRCH') processRunning = false; }
  }
  return {
    state: ['unassigned', 'ready', 'starting', 'booting', 'stopping', 'error'].includes(lease.state) ? lease.state : 'unknown',
    serial: /^emulator-\d{4,5}$/.test(lease.serial ?? '') ? lease.serial : null,
    processRunning,
  };
}

function savedDevice(dir, threadId) {
  if (!threadId) return { state: 'unknown', source: 'unavailable' };
  let fd;
  try {
    fd = fs.openSync(path.join(dir, 'leases.json'), 'r');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes === buffer.length) throw new Error('State too large');
    const saved = JSON.parse(buffer.toString('utf8', 0, bytes));
    if (!saved.leases || typeof saved.leases !== 'object') throw new Error('Invalid state');
    return { ...leaseDiagnostics(Object.hasOwn(saved.leases, threadId) ? saved.leases[threadId] : null), source: 'saved_state' };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'unassigned' : 'unknown', source: 'saved_state' };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function sdkDiagnostics() {
  try {
    const found = sdk();
    const executable = file => {
      try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
    };
    return { emulator: executable(found.emulator), adb: executable(found.adb) };
  } catch { return { emulator: false, adb: false }; }
}

async function helperDiagnostics(info, threadId, supportsDiagnostics) {
  const result = { status: info ? 'unreachable' : 'not_found', pluginVersion: null };
  if (!info || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !Number.isSafeInteger(info.pid) || info.pid < 1) return { helper: result };
  const origin = `http://127.0.0.1:${info.port}`;
  try {
    const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    const body = await helperJson(health);
    if (!health.ok || !body.ok || body.pid !== info.pid) return { helper: result };
    result.status = 'reachable';
    result.pluginVersion = version(body.pluginVersion);
    result.snapshot = 'unavailable';
    if (!threadId) return { helper: result };
    // Older helpers have no snapshot endpoint. Diagnose them without upgrading them.
    if (!supportsDiagnostics(body)) {
      result.snapshot = 'unsupported';
      return { helper: result };
    }
    const response = await fetch(`${origin}/api/call`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1500),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ threadId, tool: 'emulator_diagnostics', args: {} }),
    });
    const reply = await helperJson(response);
    const snapshot = reply?.result?.structuredContent;
    if (!response.ok || !reply.ok || snapshot?.schemaVersion !== 1 || !snapshot.device || !snapshot.display) return { helper: result };
    result.snapshot = 'available';
    // Rebuild the output: future helper versions cannot accidentally leak extra fields.
    const device = { ...leaseDiagnostics(snapshot.device), processRunning: bool(snapshot.device.processRunning), source: 'helper' };
    const display = { viewers: count(snapshot.display.viewers), encoderActive: bool(snapshot.display.encoderActive),
      videoSessionReady: bool(snapshot.display.videoSessionReady), retryPending: bool(snapshot.display.retryPending),
      consecutiveFailures: count(snapshot.display.consecutiveFailures), inputActive: bool(snapshot.display.inputActive) };
    return { helper: result, device, display };
  } catch { return { helper: result }; }
}

export async function collectDiagnostics({ dir, webDir, info, threadId, version: PLUGIN_VERSION = RUNTIME_VERSION, helperVersion: HELPER_VERSION = PLUGIN_VERSION, hostDiagnostics = async () => ({ status: 'unsupported', events: [] }), supportsDiagnostics = health => health.capabilities?.diagnostics === true }) {
  const now = Date.now();
  const [runtime, host] = await Promise.all([
    helperDiagnostics(info, threadId, supportsDiagnostics), hostDiagnostics({ threadId, now }),
  ]);
  const report = {
    schemaVersion: 1, collectedAt: new Date(now).toISOString(), chatBound: Boolean(threadId),
    plugin: { loadedVersion: PLUGIN_VERSION, expectedHelperVersion: HELPER_VERSION,
      panelFilesAvailable: ['index.html', 'app.js', 'app.css'].every(name => {
        try { fs.accessSync(path.join(webDir, name), fs.constants.R_OK); return true; } catch { return false; }
      }) },
    sdk: sdkDiagnostics(), ...runtime,
    device: runtime.device ?? savedDevice(dir, threadId), display: runtime.display ?? null,
    host, findings: [],
    limitations: [
      'Device state is the recorded lease and process liveness, not an Android boot or ADB connectivity check.',
      'Host events are recent history, not proof of a current failure. Unattributed events may belong to another chat.',
      'Host diagnostic coverage depends on the integration; no matching event does not prove the panel works.',
      'Versions describe this loaded tool and the running helper, not the latest available release.',
    ],
  };
  const add = (code, message, nextStep) => report.findings.push({ code, message, nextStep });
  if (!threadId) add('AE_THREAD_REQUIRED', 'The host did not supply a chat identity; device checks were skipped.', 'Run this tool from the intended chat.');
  if (!report.plugin.panelFilesAvailable) add('AE_RESOURCE_LOAD', 'The loaded panel files are missing or unreadable.', 'Reinstall the plugin and reopen the panel.');
  if (!report.sdk.emulator || !report.sdk.adb) add('AE_SDK_MISSING', 'The Android Emulator or ADB executable is unavailable.', 'Install Android Emulator and Platform Tools, or set ANDROID_HOME to the SDK.');
  if (runtime.helper.status !== 'reachable') add('AE_HELPER_UNAVAILABLE', 'The helper could not be reached; saved device state may be stale.', 'Use emulator_status to reconnect or start the helper. This diagnostic did not start it.');
  else if (runtime.helper.pluginVersion && runtime.helper.pluginVersion !== PLUGIN_VERSION) add('AE_VERSION_MISMATCH', 'This chat and the running helper use different plugin versions.', 'Reload the plugin or reopen the host so chats use the same installed version.');
  if (threadId && runtime.helper.status === 'reachable' && runtime.helper.snapshot !== 'available') add('AE_DIAGNOSTICS_PARTIAL', 'The helper did not provide a live diagnostic snapshot.', 'An older helper needs the updated plugin loaded. If versions match, check helper connectivity.');
  if (report.device.processRunning === false) add('AE_DEVICE_EXITED', 'The recorded emulator process has exited.', 'Use emulator_status, then emulator_start if this chat needs a device.');
  if (report.display?.retryPending || report.display?.consecutiveFailures) add('AE_STREAM_RETRYING', 'The display stream has failed and is recovering.', 'Inspect the panel error code; use Reconnect display if recovery does not finish.');
  const lines = [
    `Android emulator diagnostics (${report.collectedAt})`,
    `Plugin ${PLUGIN_VERSION}; helper ${runtime.helper.pluginVersion ?? 'unknown'} (${runtime.helper.status}).`,
    `Device: ${report.device.serial ?? 'none/unknown'}; recorded state ${report.device.state}; process running ${report.device.processRunning ?? 'unknown'}.`,
    report.display ? `Display: ${report.display.viewers ?? 'unknown'} viewer(s), encoder active ${report.display.encoderActive ?? 'unknown'}, retry pending ${report.display.retryPending ?? 'unknown'}.` : 'Display: unavailable.',
    ...report.findings.map(f => `[${f.code}] ${f.message} ${f.nextStep}`),
    `Recent host failures: ${host.events.length}; logs ${host.status}${host.tailLimited || host.fileLimitReached || host.filesSkipped ? ' (partial coverage)' : ''}. These may be unrelated to the current panel.`,
    ...host.events.map(e => `[${e.code}] ${e.time} (${e.scope})${e.reason ? `: ${e.reason}, exit ${e.exitCode ?? 'unknown'}` : ''}.`),
    'No helper, emulator, or stream was started or restarted. No screenshot, device content, access key, or raw log is included.',
  ];
  return { text: lines.join('\n'), structuredContent: report };
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions } from '../core/lib/sdk.mjs';
import { diagnosticError } from '../core/lib/errors.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createHelperClient({ dir, daemonFile, helperVersion }) {
  function readDaemonInfo() {
    try {
      return {
        ...JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8')),
        token: fs.readFileSync(path.join(dir, 'token'), 'utf8').trim(),
      };
    } catch {
      return null;
    }
  }

  async function healthy(info) {
    if (!info) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      return body.ok && body.pid === info.pid ? body : false;
    } catch {
      return false;
    }
  }

  let daemonPromise;
  let daemonInfo;
  let daemonCheckedAt = 0;

  // Reuses the shared helper, replacing it only with a newer plugin version. Chats still running an older plugin after
  // an update keep using the newer helper instead of shutting it down (their own files may already be gone).
  async function daemon() {
    // An open chat with an older plugin can win the port while we replace its helper. Retry discovery/upgrade
    // rather than waiting for that older process to somehow become the requested version.
    for (let launch = 0; launch < 3; launch += 1) {
      let info = readDaemonInfo();
      const health = await healthy(info);
      if (health && compareVersions(health.version, helperVersion) >= 0) return info;
      if (health) {
        await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } }).catch(() => {});
        for (let attempt = 0; attempt < 30 && (await healthy(info)); attempt += 1) await sleep(100);
      }
      const logFd = fs.openSync(path.join(dir, 'daemon.log'), 'a');
      const child = spawn(process.execPath, [daemonFile], { detached: true, stdio: ['ignore', logFd, logFd] });
      fs.closeSync(logFd);
      child.unref();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await sleep(100);
        info = readDaemonInfo();
        const current = await healthy(info);
        if (compareVersions(current?.version, helperVersion) >= 0) return info;
        if (current) break;
      }
    }
    throw diagnosticError('AE_HELPER_START', 'The emulator helper did not start. Check daemon.log in the plugin state directory.');
  }

  async function callDaemon(threadId, tool, args) {
    const info = await ensureDaemon();
    let body;
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/api/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
        body: JSON.stringify({ threadId, tool, args }),
      });
      body = await response.json();
    } catch (error) {
      daemonInfo = undefined;
      throw diagnosticError('AE_HELPER_CONNECT', 'The emulator helper connection failed. Check the device before retrying; the action may have completed.', error); // Never replay an action whose result was lost.
    }
    if (!body.ok) throw diagnosticError(body.errorCode ?? 'AE_ACTION_FAILED', body.error);
    return body.result;
  }

  function ensureDaemon() {
    // Active video makes ~30 calls/second. Avoid a health HTTP request and two synchronous file reads per call.
    if (daemonInfo && Date.now() - daemonCheckedAt < 5_000) return Promise.resolve(daemonInfo);
    daemonPromise ??= daemon().then((info) => {
      daemonInfo = info;
      daemonCheckedAt = Date.now();
      return info;
    }).finally(() => {
      daemonPromise = undefined;
    });
    return daemonPromise;
  }

  return { call: callDaemon, readInfo: readDaemonInfo };
}

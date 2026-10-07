import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { compareVersions } from '../runtime/core/lib/sdk.mjs';
import { helperVersion } from '../runtime/hosts/codex/config.mjs';

test('upgrade retries when an older chat wins the helper port, and never replaces a newer helper', async () => {
  const source = fs.readFileSync(new URL('../runtime/mcp/helper-client.mjs', import.meta.url), 'utf8');
  const daemon = source.slice(source.indexOf('async function daemon()'), source.indexOf('async function callDaemon('));
  let running = { version: '0.10.1', pid: 1, port: 1234 };
  let launches = 0;
  let shutdowns = 0;
  const context = vm.createContext({
    helperVersion: helperVersion('0.1.1'), daemonFile: 'unused', dir: '/unused', path, process: { execPath: 'unused' },
    compareVersions,
    readDaemonInfo: () => running,
    healthy: async () => running,
    sleep: async () => {},
    fs: { openSync: () => 1, closeSync() {} },
    fetch: async () => { shutdowns++; running = null; },
    spawn: () => {
      launches++;
      // On the first launch, an already-open older chat claims the port before the new child can start.
      running = { version: launches === 1 ? '0.10.1' : helperVersion('0.1.1'), pid: launches + 1, port: 1234 };
      return { unref() {} };
    },
  });
  vm.runInContext(daemon, context);
  assert.equal((await vm.runInContext('daemon()', context)).version, helperVersion('0.1.1'));
  assert.equal(launches, 2);
  assert.equal(shutdowns, 2);
  running = { version: helperVersion('0.1.2'), pid: 4, port: 1234 };
  assert.equal((await vm.runInContext('daemon()', context)).pid, 4);
  assert.equal(shutdowns, 2);
  assert.equal(launches, 2);
});

test('helper ordering survives the public version reset and subsequent releases', () => {
  assert.ok(compareVersions(helperVersion('0.1.0'), '0.10.1') > 0);
  assert.ok(compareVersions(helperVersion('0.1.1'), helperVersion('0.1.0')) > 0);
  assert.ok(compareVersions(helperVersion('0.2.0'), helperVersion('0.1.1')) > 0);
  assert.ok(compareVersions(helperVersion('1.0.0'), helperVersion('0.10.1')) > 0);
});

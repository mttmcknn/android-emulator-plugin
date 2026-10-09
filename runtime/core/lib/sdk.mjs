import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function latestBuildTool(root, name) {
  const dir = path.join(root, 'build-tools');
  const versions = fs.existsSync(dir) ? fs.readdirSync(dir).filter((version) => fs.existsSync(path.join(dir, version, name))) : [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? path.join(dir, versions.at(-1), name) : null;
}

let cachedSdk;

export function sdk() {
  if (cachedSdk) return cachedSdk;
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);
  const root = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'platform-tools', 'adb')));
  if (!root) {
    throw new Error(
      `Android SDK Platform Tools not found. Checked: ${candidates.join(', ')}. ` +
        'Install Platform Tools with Android Studio or sdkmanager, or set ANDROID_HOME.',
    );
  }
  cachedSdk = {
    root,
    adb: path.join(root, 'platform-tools', 'adb'),
    emulator: fs.existsSync(path.join(root, 'emulator', 'emulator')) ? path.join(root, 'emulator', 'emulator') : null,
    aapt2: latestBuildTool(root, 'aapt2'),
  };
  return cachedSdk;
}

export function requireEmulator() {
  const { emulator } = sdk();
  if (!emulator) throw new Error('Android Emulator is not installed in this SDK. Install it with Android Studio or sdkmanager to create or start a virtual device. Connected physical devices only require Platform Tools.');
  return emulator;
}

// Runs a process without a shell and resolves with its exit status and output.
export function run(file, args, { timeoutMs = 30_000, binary = false, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      resolve({
        code: timedOut ? 124 : code,
        timedOut,
        truncated: bytes > maxBytes,
        stdout: binary ? out : out.toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export function adb(serial, args, options) {
  return run(sdk().adb, serial ? ['-s', serial, ...args] : args, options);
}

export async function adbOk(serial, args, options) {
  const result = await adb(serial, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || String(result.stdout)).trim().slice(0, 500);
    throw new Error(`adb ${args.join(' ')} failed on ${serial} (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Numeric comparison of dotted versions ("0.10.0" > "0.9.1").
export function compareVersions(a = '0', b = '0') {
  const [x, y] = [a, b].map((value) => String(value).split('.').map((part) => Number.parseInt(part, 10) || 0));
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

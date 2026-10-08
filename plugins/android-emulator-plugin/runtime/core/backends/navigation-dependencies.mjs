import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const MEBIBYTE = 1024 * 1024;
const MAX_MINIMAP_ARCHIVE = 8 * MEBIBYTE;
const MAX_ANDROID_BINARY = 128 * MEBIBYTE;

// These are release-asset digests published by GitHub for Minimap v0.2.1.
// Android CLI's official installer downloads an unversioned binary directly
// from dl.google.com and publishes no checksum. These digests are therefore
// pinned from the official binaries fetched on 2026-10-07; a future upstream
// replacement fails closed until this manifest is deliberately refreshed.
export const NAVIGATION_DEPENDENCIES = Object.freeze({
  minimap: Object.freeze({
    version: '0.2.1',
    platforms: Object.freeze({
      'darwin-arm64': Object.freeze({
        url: 'https://github.com/mttmcknn/minimap/releases/download/v0.2.1/minimap-aarch64-apple-darwin.tar.gz',
        sha256: 'a6c1afb83d62edc7be0f28fbf2c35e06eb187a01c10230f61c943a53c7794de3',
      }),
      'darwin-x64': Object.freeze({
        url: 'https://github.com/mttmcknn/minimap/releases/download/v0.2.1/minimap-x86_64-apple-darwin.tar.gz',
        sha256: 'd905ca3ca5c9ec3c6b0a0659b99767cb63c846fe789e7a6998338fa65fb9a362',
      }),
      'linux-x64': Object.freeze({
        url: 'https://github.com/mttmcknn/minimap/releases/download/v0.2.1/minimap-x86_64-unknown-linux-gnu.tar.gz',
        sha256: '729e7d85bfbd7bb01eada29c13dbc4e7357e23a78928d04b82c0f09de4c42b97',
      }),
    }),
  }),
  android: Object.freeze({
    platforms: Object.freeze({
      'darwin-arm64': Object.freeze({ url: 'https://dl.google.com/android/cli/latest/darwin_arm64/android', sha256: '52618946fb521fa08de5729181d12cb9190a5d6a2e8e869f71799808bc82792e' }),
      'darwin-x64': Object.freeze({ url: 'https://dl.google.com/android/cli/latest/darwin_x86_64/android', sha256: '003a4b7d8e2f282010afdc47a9856dc66a3ed688204549e762d868abbd87c624' }),
      'linux-x64': Object.freeze({ url: 'https://dl.google.com/android/cli/latest/linux_x86_64/android', sha256: '54b6e2d382444b91511fcc7ab34ddec6561f257d6d1cdce16bb91af6789b6de2' }),
    }),
  }),
});

function platformKey(platform, arch) {
  const system = platform === 'darwin' || platform === 'linux' ? platform : null;
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  return system && cpu ? `${system}-${cpu}` : null;
}

function commandName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function validOverride(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}

async function executable(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch { return false; }
}

function pathCandidates(name, environment) {
  return String(environment.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, commandName(name)));
}

async function firstExecutable(files) {
  for (const file of files) if (await executable(file)) return file;
  return null;
}

async function defaultRun(file, args, { environment, signal } = {}) {
  const { stdout, stderr } = await exec(file, args, {
    env: environment,
    signal,
    timeout: 120_000,
    maxBuffer: 8 * 1024,
    windowsHide: true,
  });
  return { code: 0, stdout, stderr };
}

function resultVersion(result) {
  return String(result?.stdout ?? '').trim();
}

function supportedMinimap(version) {
  const match = version.match(/^minimap (\d+)\.(\d+)\.(\d+)$/);
  return Boolean(match && Number(match[1]) === 0 && Number(match[2]) === 2 && Number(match[3]) >= 1);
}

function supportedAndroid(version) {
  return /^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9]+)?$/m.test(version);
}

function abortError() {
  const error = new Error('Navigation dependency installation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

async function readResponse(fetchImpl, url, maxBytes, signal) {
  checkAbort(signal);
  const timeout = AbortSignal.timeout(90_000);
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(url, { signal, redirect: 'follow' });
  if (!response?.ok) throw new Error(`Navigation dependency download failed (${response?.status ?? 'network error'}).`);
  const size = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(size) && size > maxBytes) throw new Error('Navigation dependency download exceeds its size limit.');
  const chunks = [];
  let total = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error('Navigation dependency download exceeds its size limit.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
  } else chunks.push(Buffer.from(await response.arrayBuffer()));
  const bytes = Buffer.concat(chunks);
  checkAbort(signal);
  if (bytes.length > maxBytes) throw new Error('Navigation dependency download exceeds its size limit.');
  return bytes;
}

function checksum(bytes, expected) {
  if (!expected) return;
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error('Navigation dependency checksum verification failed.');
}

function tarNumber(field) {
  const value = field.toString('utf8').replace(/\0.*$/, '').trim();
  return value ? Number.parseInt(value, 8) : 0;
}

// The archive hash is checked before extraction. We still only accept one
// ordinary file named minimap, so an unexpected release layout cannot write
// arbitrary state files.
function minimapFromArchive(archive) {
  let source;
  try { source = gunzipSync(archive, { maxOutputLength: 32 * MEBIBYTE }); }
  catch { throw new Error('Minimap release archive could not be unpacked.'); }
  for (let offset = 0; offset + 512 <= source.length;) {
    const header = source.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = tarNumber(header.subarray(124, 136));
    const type = header.subarray(156, 157).toString('utf8');
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end > source.length) break;
    if ((type === '' || type === '0') && (name === 'minimap' || name.endsWith('/minimap'))) return Buffer.from(source.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('Minimap release archive did not contain its executable.');
}

async function atomicWrite(file, bytes, signal, mode = 0o700) {
  checkAbort(signal);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    checkAbort(signal);
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function unavailable(name, reason, extra = {}) {
  return { name, available: false, reason, ...extra };
}

/**
 * Resolves navigation tools without changing global configuration. probe() only
 * checks existing candidates. ensure() is intentionally the sole mutating API
 * and must be called from an explicit agent action, never a status request.
 */
export function createNavigationDependencies({
  dir,
  environment = process.env,
  home = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  manifest = NAVIGATION_DEPENDENCIES,
  fetchImpl = globalThis.fetch,
  runCommand = defaultRun,
} = {}) {
  if (!path.isAbsolute(dir ?? '')) throw new Error('Navigation dependency state must be an absolute trusted directory.');
  if (typeof fetchImpl !== 'function') throw new Error('Navigation dependency downloads require fetch support.');
  const key = platformKey(platform, arch);
  const base = path.join(dir, 'navigation-dependencies');
  const locations = {
    minimap: path.join(base, 'minimap', manifest.minimap.version, key ?? 'unsupported', commandName('minimap')),
    android: path.join(base, 'android', key ?? 'unsupported', commandName('android')),
  };
  let ensuring;

  async function candidates(name, overrideName) {
    const override = environment[overrideName];
    if (override !== undefined && !validOverride(override)) throw new Error(`${overrideName} must name an executable.`);
    if (validOverride(override)) return [{ file: override, source: 'override', override: true }];
    const files = [
      locations[name],
      ...pathCandidates(name, environment),
      path.join(home, '.local', 'bin', commandName(name)),
    ];
    const file = await firstExecutable([...new Set(files)]);
    return file ? [{ file, source: file === locations[name] ? 'managed' : 'existing', override: false }] : [];
  }

  async function locate(name, overrideName) {
    const [candidate] = await candidates(name, overrideName);
    if (!candidate) return unavailable(name, `${name === 'minimap' ? 'Minimap 0.2.1' : 'Android CLI'} is not installed.`);
    return { name, available: true, verified: false, file: candidate.file, source: candidate.source, override: candidate.override };
  }

  async function verify(name, overrideName, compatible, signal) {
    const candidate = await locate(name, overrideName);
    if (!candidate.available) return candidate;
    try {
      const result = await runCommand(candidate.file, name === 'android' ? ['--no-metrics', '--version'] : ['--version'], { environment: runtimeEnvironment(), signal });
      const version = resultVersion(result);
      if (result?.code === 0 && compatible(version)) return { name, available: true, file: candidate.file, source: candidate.source, version };
      const reason = `${name === 'minimap' ? 'Minimap 0.2.1 or a newer 0.2.x patch is required.' : 'Android CLI did not return a supported version.'}`;
      return unavailable(name, reason, { file: candidate.file, source: candidate.source, override: candidate.override, version });
    } catch {
      return unavailable(name, `${name === 'minimap' ? 'Minimap' : 'Android CLI'} could not be checked.`, { file: candidate.file, source: candidate.source, override: candidate.override });
    }
  }

  async function probe() {
    const [minimap, android] = await Promise.all([
      locate('minimap', 'ANDROID_EMULATOR_MINIMAP'),
      locate('android', 'ANDROID_EMULATOR_ANDROID_CLI'),
    ]);
    return { minimap, android, available: minimap.available && android.available };
  }

  function runtimeEnvironment() {
    return {
      ...environment,
      // Android CLI initializes its bundle cache even for --version. Keep that
      // first-run state with this plugin rather than modifying the user's home.
      ANDROID_USER_HOME: path.join(base, 'android-user-home'),
    };
  }

  async function installMinimap(signal) {
    const entry = manifest.minimap.platforms[key];
    if (!entry) throw new Error(`Minimap v${manifest.minimap.version} has no supported release for ${platform}/${arch}.`);
    const archive = await readResponse(fetchImpl, entry.url, MAX_MINIMAP_ARCHIVE, signal);
    checksum(archive, entry.sha256);
    const binary = minimapFromArchive(archive);
    if (!binary.length || binary.length > MAX_MINIMAP_ARCHIVE) throw new Error('Minimap release executable exceeds its size limit.');
    await retainMinimapLicenses(signal);
    await atomicWrite(locations.minimap, binary, signal);
  }

  async function retainMinimapLicenses(signal) {
    const notices = await fs.readFile(new URL('../vendor/MINIMAP-LICENSES.txt', import.meta.url));
    await atomicWrite(path.join(path.dirname(locations.minimap), 'LICENSES.txt'), notices, signal, 0o600);
  }

  async function installAndroid(signal) {
    const entry = manifest.android.platforms[key];
    if (!entry) throw new Error(`Android CLI has no supported release for ${platform}/${arch}.`);
    const binary = await readResponse(fetchImpl, entry.url, MAX_ANDROID_BINARY, signal);
    checksum(binary, entry.sha256);
    if (!binary.length) throw new Error('Android CLI download was empty.');
    await atomicWrite(locations.android, binary, signal);
  }

  async function ensureInternal(signal) {
    checkAbort(signal);
    let state = await Promise.all([
      verify('minimap', 'ANDROID_EMULATOR_MINIMAP', supportedMinimap, signal),
      verify('android', 'ANDROID_EMULATOR_ANDROID_CLI', supportedAndroid, signal),
    ]).then(([minimap, android]) => ({ minimap, android }));
    for (const dependency of ['minimap', 'android']) {
      const current = state[dependency];
      if (current.available) {
        // Upgrade older managed caches that were installed without notices.
        if (dependency === 'minimap' && current.source === 'managed') await retainMinimapLicenses(signal);
        continue;
      }
      if (current.override) throw new Error(`${dependency === 'minimap' ? 'ANDROID_EMULATOR_MINIMAP' : 'ANDROID_EMULATOR_ANDROID_CLI'} is configured but incompatible; it will not be replaced automatically.`);
      if (dependency === 'minimap') await installMinimap(signal);
      else await installAndroid(signal);
      state = await Promise.all([
        verify('minimap', 'ANDROID_EMULATOR_MINIMAP', supportedMinimap, signal),
        verify('android', 'ANDROID_EMULATOR_ANDROID_CLI', supportedAndroid, signal),
      ]).then(([minimap, android]) => ({ minimap, android }));
      if (!state[dependency].available) {
        await fs.rm(locations[dependency], { force: true }).catch(() => {});
        throw new Error(`${dependency === 'minimap' ? 'Minimap' : 'Android CLI'} installation did not produce a compatible executable.`);
      }
    }
    // Minimap calls a command named android. Use a private launcher to honor
    // custom executable names and disable CLI telemetry on every invocation.
    const androidDir = path.join(base, 'bin');
    const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
    const androidFile = path.isAbsolute(state.android.file) ? state.android.file
      : await firstExecutable(pathCandidates(state.android.file, environment));
    if (!androidFile) throw new Error('The configured Android CLI executable could not be resolved.');
    const bridge = fileURLToPath(new URL('./android-layout-bridge.mjs', import.meta.url));
    await atomicWrite(path.join(androidDir, 'android'), Buffer.from(`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bridge)} ${quote(androidFile)} "$@"\n`), signal);
    return {
      minimap: state.minimap.file,
      android: state.android.file,
      available: true,
      versions: { minimap: state.minimap.version, android: state.android.version },
      env: {
        ANDROID_EMULATOR_MINIMAP: state.minimap.file,
        ANDROID_EMULATOR_ANDROID_CLI: state.android.file,
        ANDROID_USER_HOME: runtimeEnvironment().ANDROID_USER_HOME,
        PATH: [androidDir, environment.PATH].filter(Boolean).join(path.delimiter),
      },
    };
  }

  return {
    probe,
    ensure({ signal } = {}) {
      if (!ensuring) ensuring = ensureInternal(signal).finally(() => { ensuring = undefined; });
      return ensuring;
    },
  };
}

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createAvd, deleteAvd } from './avds.mjs';
import { adb, run, sdk, requireEmulator } from './sdk.mjs';

const PORT_FIRST = 5600;
const PORT_LAST = 5698;
const BOOT_TIMEOUT_MS = 240_000;
// A thread missing from the host's session store is only treated as deleted once its lease is this old.
const MISSING_GRACE_MS = 10 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export function parseAvdList(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9._-]+$/.test(line));
}

export function parseAdbDevices(stdout) {
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state)
    .map(([serial, state, ...fields]) => ({ serial, state, ...Object.fromEntries(fields.filter(field => /^(model|product|device|transport_id):/.test(field)).map(field => field.split(/:(.*)/s).slice(0, 2))) }));
}

// Chooses the first even console port whose serial and TCP ports are unused.
export function choosePort(usedSerials, isFree) {
  return (async () => {
    for (let port = PORT_FIRST; port <= PORT_LAST; port += 2) {
      if (usedSerials.has(`emulator-${port}`)) continue;
      if ((await isFree(port)) && (await isFree(port + 1))) return port;
    }
    throw new Error(`No free emulator console port between ${PORT_FIRST} and ${PORT_LAST}. Stop an emulator and retry.`);
  })();
}

export class LeaseManager extends EventEmitter {
  constructor({ dir, log, isPortFree = portFree, readSessions = async () => new Map() }) {
    super();
    this.file = path.join(dir, 'leases.json');
    this.logDir = path.join(dir, 'logs');
    this.log = log;
    this.readSessions = readSessions;
    this.pending = new Map();
    // Holds an AVD only while a launch is choosing a port and persisting its lease.
    // A persisted lease takes over the reservation before boot polling begins.
    this.reservedAvds = new Set();
    this.deletingAvds = new Set();
    this.reservedPorts = new Set();
    this.isPortFree = isPortFree;
    this.portAllocation = Promise.resolve();
    this.activity = new Map();
    fs.mkdirSync(this.logDir, { recursive: true });
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // First run: no state yet.
    }
    this.leases = Object.assign(Object.create(null), state.leases);
    // AVDs this plugin created, keyed by name: { threadId, keep, createdAt }.
    this.createdAvds = Object.assign(Object.create(null), state.createdAvds);
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ leases: this.leases, createdAvds: this.createdAvds }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  update(threadId, patch) {
    const lease = this.leases[threadId];
    if (!lease) return;
    Object.assign(lease, patch);
    this.save();
    this.emit('change', threadId);
  }

  remove(threadId) {
    if (!this.leases[threadId]) return;
    delete this.leases[threadId];
    this.save();
    this.emit('change', threadId);
  }

  async avds() {
    if (!sdk().emulator) return [];
    const result = await run(sdk().emulator, ['-list-avds'], { timeoutMs: 15_000 });
    return parseAvdList(result.stdout);
  }

  async devices() {
    const result = await adb(null, ['devices', '-l'], { timeoutMs: 10_000 });
    if (result.code !== 0) throw new Error(`adb devices failed: ${result.stderr.trim()}`);
    return parseAdbDevices(result.stdout);
  }

  async runningAvdNames(devices, { strict = false } = {}) {
    const names = new Set();
    await Promise.all(
      devices
        .filter(({ serial }) => serial.startsWith('emulator-'))
        .map(async ({ serial }) => {
          const result = await adb(serial, ['emu', 'avd', 'name'], { timeoutMs: 5_000 });
          const name = result.stdout.split('\n')[0]?.trim();
          if (result.code === 0 && /^[A-Za-z0-9._-]+$/.test(name ?? '') && !['OK', 'KO'].includes(name)) names.add(name);
          else if (strict) throw new Error(`Cannot identify running emulator ${serial}. Close it before deleting a saved device.`);
        }),
    );
    return names;
  }

  async inUseAvds(options) {
    const running = await this.runningAvdNames(await this.devices(), options);
    for (const name of this.reservedAvds) running.add(name);
    for (const id of Object.keys(this.leases)) {
      const lease = this.get(id);
      if (lease) running.add(lease.avd);
    }
    return running;
  }

  touch(threadId) {
    this.activity.set(threadId, Date.now());
  }

  ownedAvds(threadId) {
    return Object.entries(this.createdAvds)
      .filter(([, owner]) => owner.threadId === threadId)
      .map(([name, owner]) => ({ name, keep: owner.keep }));
  }

  async create(threadId, { profileId, imageId, name, keep = false }) {
    const created = createAvd({ profileId, imageId, name, existingNames: await this.avds() });
    this.createdAvds[created.name] = { threadId, keep, createdAt: new Date().toISOString() };
    this.save();
    this.emit('change', threadId);
    return created;
  }

  // Deletes an AVD this thread created. Other AVDs are never deleted.
  async deleteOwned(threadId, name) {
    const owner = this.createdAvds[name];
    if (owner?.threadId !== threadId) throw new Error(`${name} was not created by this thread, so it will not be deleted.`);
    await this.deleteSaved(name);
  }

  async deleteSaved(name) {
    if (this.deletingAvds.has(name)) throw new Error(`${name} is already being deleted.`);
    this.deletingAvds.add(name);
    try {
      if ((await this.inUseAvds({ strict: true })).has(name)) throw new Error(`${name} is running or starting. Stop every instance before deleting it.`);
      deleteAvd(name);
      const owner = this.createdAvds[name];
      delete this.createdAvds[name];
      this.save();
      if (owner) this.emit('change', owner.threadId);
      this.log(`deleted saved AVD ${name}`);
    } finally { this.deletingAvds.delete(name); }
  }

  // Returns the live lease for this thread, dropping it if its emulator has exited.
  get(threadId) {
    const lease = this.leases[threadId];
    if (!lease) return null;
    if (lease.kind === 'physical') return lease;
    if (!processAlive(lease.pid)) {
      this.log(`lease ${threadId} emulator pid ${lease.pid} exited`);
      this.remove(threadId);
      return null;
    }
    return lease;
  }

  async start(threadId, options = {}) {
    if (this.pending.has(threadId)) return this.pending.get(threadId);
    const existing = this.get(threadId);
    if (existing) {
      if (options.avd && options.avd !== existing.avd) {
        throw new Error(
          `This thread already owns ${existing.avd} (${existing.serial}). Stop it before starting ${options.avd}.`,
        );
      }
      return existing;
    }
    const starting = this.launch(threadId, options).finally(() => this.pending.delete(threadId));
    this.pending.set(threadId, starting);
    return starting;
  }

  // Serial port probing awaits the OS, so serialize just this reservation window.
  // The selected port remains reserved until its lease is persisted.
  async reservePort(devices) {
    const previous = this.portAllocation;
    let release;
    this.portAllocation = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const usedSerials = new Set([
        ...devices.map(({ serial }) => serial),
        ...Object.values(this.leases).map(({ serial }) => serial),
        ...[...this.reservedPorts].map((port) => `emulator-${port}`),
      ]);
      const port = await choosePort(usedSerials, this.isPortFree);
      this.reservedPorts.add(port);
      return port;
    } finally {
      release();
    }
  }

  async launch(threadId, { avd: requestedAvd, readOnly, coldBoot = false }) {
    const executable = requireEmulator();
    const [avds, devices] = await Promise.all([this.avds(), this.devices()]);
    if (avds.length === 0) throw new Error('No Android Virtual Devices found. Create one in Android Studio Device Manager.');
    if (requestedAvd && !avds.includes(requestedAvd)) {
      throw new Error(`Unknown AVD "${requestedAvd}". Available AVDs: ${avds.join(', ')}.`);
    }

    const running = await this.runningAvdNames(devices);
    const claimedAvds = new Set([
      ...running,
      ...this.reservedAvds,
      ...Object.values(this.leases).map(({ avd }) => avd),
    ]);
    const available = avds.filter(name => !this.deletingAvds.has(name));
    if (!available.length || (requestedAvd && !available.includes(requestedAvd))) throw new Error('The selected device is being deleted. Refresh the device list.');
    const avd = requestedAvd ?? available.find((name) => !claimedAvds.has(name)) ?? available[0];
    // A running, booting, or just-reserved AVD must never get a second writer.
    const ephemeral = readOnly === true || claimedAvds.has(avd);
    this.reservedAvds.add(avd);
    let port;
    try {
      port = await this.reservePort(devices);
      const serial = `emulator-${port}`;
      const args = ['-avd', avd, '-port', String(port), '-qt-hide-window', '-no-boot-anim', '-netdelay', 'none', '-netspeed', 'full'];
      if (ephemeral) args.push('-read-only');
      if (coldBoot) args.push('-no-snapshot-load');

      const logFile = path.join(this.logDir, `${serial}.log`);
      const logFd = fs.openSync(logFile, 'w');
      const child = spawn(executable, args, { detached: true, stdio: ['ignore', logFd, logFd] });
      fs.closeSync(logFd);
      child.unref();
      this.log(`thread ${threadId} launching ${avd} as ${serial} pid ${child.pid}${ephemeral ? ' read-only' : ''}`);

      this.leases[threadId] = {
        threadId,
        kind: 'emulator',
        avd,
        serial,
        port,
        pid: child.pid,
        readOnly: ephemeral,
        state: 'booting',
        startedAt: new Date().toISOString(),
        logFile,
      };
      this.save();
      this.emit('change', threadId);
    } finally {
      this.reservedAvds.delete(avd);
      if (port !== undefined) this.reservedPorts.delete(port);
    }

    try {
      await this.waitForBoot(threadId);
    } catch (error) {
      await this.stop(threadId).catch(() => {});
      throw error;
    }
    this.update(threadId, { state: 'ready', readyAt: new Date().toISOString() });
    return this.leases[threadId];
  }

  async waitForBoot(threadId) {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const lease = this.leases[threadId];
      if (!lease) throw new Error('Emulator start was cancelled.');
      if (!processAlive(lease.pid)) {
        const tail = fs.existsSync(lease.logFile) ? fs.readFileSync(lease.logFile, 'utf8').slice(-1500) : '';
        throw new Error(`Emulator ${lease.avd} exited during boot. Log tail:\n${tail}`);
      }
      const result = await adb(lease.serial, ['shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 5_000 });
      if (result.code === 0 && result.stdout.trim() === '1') return;
      await sleep(1_000);
    }
    throw new Error(`Emulator did not finish booting within ${BOOT_TIMEOUT_MS / 1000}s.`);
  }

  async stop(threadId) {
    const lease = this.leases[threadId];
    if (!lease) return false;
    if (lease.kind === 'physical') { this.remove(threadId); return true; }
    this.log(`thread ${threadId} stopping ${lease.serial}`);
    await adb(lease.serial, ['emu', 'kill'], { timeoutMs: 10_000 }).catch(() => {});
    const deadline = Date.now() + 15_000;
    while (processAlive(lease.pid) && Date.now() < deadline) await sleep(250);
    if (processAlive(lease.pid)) process.kill(lease.pid, 'SIGTERM');
    this.remove(threadId);
    return true;
  }

  attach(threadId, device) {
    if (Object.values(this.leases).some(lease => lease.serial === device.serial || (device.hardwareId && lease.hardwareId === device.hardwareId))) throw new Error('The device was pinned by another chat. Refresh and select it again.');
    this.leases[threadId] = { threadId, kind: 'physical', serial: device.serial, hardwareId: device.hardwareId, avd: device.label, label: device.label, state: 'ready', startedAt: new Date().toISOString() };
    this.save();
    this.emit('change', threadId);
    return this.leases[threadId];
  }

  // Stops emulators for archived or deleted threads, deletes their non-kept AVDs, and stops idle emulators.
  async sweep({ idleMs, isWatched, isBusy = () => false }) {
    const owners = new Set([...Object.keys(this.leases), ...Object.values(this.createdAvds).map(({ threadId }) => threadId)]);
    const states = await this.readSessions(owners);
    for (const threadId of owners) {
      if (isBusy(threadId)) continue;
      const lease = this.get(threadId);
      const state = states.get(threadId)?.state;
      const age = lease ? Date.now() - Date.parse(lease.startedAt) : Infinity;
      const ended = state === 'archived' || (state === 'missing' && age > MISSING_GRACE_MS);
      if (ended) {
        this.log(`thread ${threadId} is ${state}; cleaning up`);
        if (lease) await this.stop(threadId);
        for (const { name, keep } of this.ownedAvds(threadId)) if (!keep) await this.deleteOwned(threadId, name).catch((error) => this.log(error.message));
        continue;
      }
      const lastActive = Math.max(this.activity.get(threadId) ?? 0, lease ? Date.parse(lease.readyAt ?? lease.startedAt) : 0);
      if (lease?.state === 'ready' && lease.kind !== 'physical' && idleMs > 0 && !isWatched(threadId) && Date.now() - lastActive > idleMs) {
        this.log(`thread ${threadId} idle for ${Math.round((Date.now() - lastActive) / 60_000)} min; stopping ${lease.serial}`);
        await this.stop(threadId);
      }
    }
  }
}

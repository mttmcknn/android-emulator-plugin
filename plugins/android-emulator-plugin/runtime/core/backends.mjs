import fs from 'node:fs';
import path from 'node:path';
import { Device } from './lib/device.mjs';
import { Mirror } from './lib/mirror.mjs';
import { Recorder } from './lib/recorder.mjs';
import { createMinimapBackend } from './backends/minimap.mjs';
import { createAndroidCliCapture } from './backends/android-cli.mjs';
import { SCRCPY_VERSION } from './lib/control.mjs';

// Factories describe implementations, not sessions. All mutable resources belong
// to the caller that creates them. No dynamic imports or executable paths from tools.
export function builtinBackends({ dir } = {}) {
  return {
    capture: [
      { id: 'adb', label: 'ADB PNG capture', version: 'sdk', capture: serial => new Device(serial).screenshot() },
      createAndroidCliCapture(),
    ],
    device: [{ id: 'adb', label: 'ADB device operations', version: 'sdk', create: (serial, options) => new Device(serial, options) }],
    connection: [{ id: 'scrcpy', label: 'scrcpy H.264 and input', version: SCRCPY_VERSION, create: options => new Mirror(options) }],
    navigation: [createMinimapBackend({ stateDir: dir })],
    recording: [{ id: 'screenrecord', label: 'Android screenrecord', version: 'device', create: dir => new Recorder(dir) }],
  };
}

export const DEFAULT_BACKENDS = Object.freeze({ capture: 'adb', device: 'adb', connection: 'scrcpy', recording: 'screenrecord', navigation: 'minimap' });
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const round = value => Math.round(value * 100) / 100;

export class Backends {
  constructor({ dir, providers = {} }) {
    this.catalog = new Map();
    for (const [component, builtins] of Object.entries(builtinBackends({ dir }))) {
      const entries = new Map();
      for (const backend of [...builtins, ...(providers[component] ?? [])]) {
        if (!ID.test(backend.id) || entries.has(backend.id)) throw new Error(`Duplicate or invalid ${component} backend: ${backend.id}`);
        if (typeof backend[component === 'capture' ? 'capture' : 'create'] !== 'function') throw new Error(`Missing ${component} backend factory: ${backend.id}`);
        entries.set(backend.id, Object.freeze({ ...backend }));
      }
      this.catalog.set(component, entries);
    }
    for (const component of Object.keys(providers)) if (!this.catalog.has(component)) throw new Error(`Unknown backend component: ${component}`);
    this.file = path.join(dir, 'backends.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!saved || Array.isArray(saved) || typeof saved !== 'object') throw new Error('Invalid backend selections.');
      this.selections = new Map(Object.entries(saved));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.selections = new Map();
    }
    this.metrics = new Map();
    this.versions = new Map();
  }

  get(session, component, id = this.selection(session)[component]) {
    const backend = this.catalog.get(component)?.get(id);
    if (!backend) throw new Error(`Unknown ${component} backend "${id}". List available backends and select one explicitly.`);
    return { ...backend, version: this.versions.get(`${component}:${id}`) ?? backend.version };
  }

  selection(session) { return { ...DEFAULT_BACKENDS, ...this.selections.get(session) }; }

  async probe(component, backend) {
    const result = await backend.probe?.() ?? { available: true };
    if (result.available && result.version) this.versions.set(`${component}:${backend.id}`, result.version);
    return result;
  }

  async available() {
    return Object.fromEntries(await Promise.all([...this.catalog].map(async ([component, implementations]) => [component,
      await Promise.all([...implementations.values()].map(async backend => {
        let availability;
        try { availability = await this.probe(component, backend); }
        catch { availability = { available: false, reason: 'Backend availability check failed.' }; }
        return { id: backend.id, label: backend.label, version: availability.version ?? backend.version, ...availability };
      })),
    ])));
  }

  async check(changes) {
    if (!changes || Array.isArray(changes) || typeof changes !== 'object' || !Object.keys(changes).length) throw new Error('Provide at least one backend selection.');
    for (const [component, id] of Object.entries(changes)) {
      const backend = this.get('', component, id);
      const probe = await this.probe(component, backend);
      if (probe && !probe.available) throw new Error(`${component} backend "${id}" is unavailable. ${probe.reason ?? 'Install its dependency before selecting it.'}`);
    }
  }

  select(session, changes) {
    for (const [component, id] of Object.entries(changes)) this.get(session, component, id);
    const next = new Map(this.selections);
    next.set(session, { ...this.selection(session), ...changes });
    // Commit persistence before exposing a changed selection to new operations.
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(next), null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.selections = next;
    return this.selection(session);
  }

  counter(session, component, backend, values, configuration = '') {
    // Bounded in-memory numeric diagnostics; never retain arguments, frames, or text.
    let entries = this.metrics.get(session);
    if (!entries) {
      if (this.metrics.size >= 128) this.metrics.delete(this.metrics.keys().next().value);
      this.metrics.set(session, entries = new Map());
    }
    const key = `${component}:${backend.id}:${backend.version}:${configuration}`;
    let entry = entries.get(key);
    if (!entry && entries.size >= 64) entries.delete(entries.keys().next().value);
    if (!entry) entries.set(key, entry = { component, backend: backend.id, version: backend.version, ...(configuration ? { configuration } : {}), samples: [], count: 0, errors: 0 });
    for (const [name, value] of Object.entries(values)) {
      if (name === 'durationMs') {
        entry.samples.push(value);
        if (entry.samples.length > 128) entry.samples.shift();
      } else if (Number.isFinite(value)) entry[name] = (entry[name] ?? 0) + value;
    }
  }

  async measure(session, component, backend, work) {
    const start = performance.now();
    try {
      const value = await work();
      this.counter(session, component, backend, { count: 1, durationMs: performance.now() - start });
      return value;
    } catch (error) {
      this.counter(session, component, backend, { count: 1, errors: 1 });
      throw error; // Never substitute another implementation or replay an action.
    }
  }

  snapshot(session) {
    return [...(this.metrics.get(session)?.values() ?? [])].map(({ samples, ...entry }) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return { ...entry, windowSamples: sorted.length, ...(sorted.length ? {
        p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]),
      } : {}) };
    });
  }
}

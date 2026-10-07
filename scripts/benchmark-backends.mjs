// Local developer benchmark. Requires an explicit serial; never allocates/stops a device.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { builtinBackends } from '../runtime/core/backends.mjs';
import { VIDEO_QUALITY } from '../runtime/core/lib/settings.mjs';
import { RUNTIME_VERSION } from '../runtime/core/version.mjs';

const { values } = parseArgs({ options: {
  serial: { type: 'string' }, component: { type: 'string', default: 'capture' },
  implementations: { type: 'string' }, samples: { type: 'string', default: '5' },
  seconds: { type: 'string', default: '5' }, quality: { type: 'string', default: 'Balanced' }, output: { type: 'string' },
} });
if (!values.serial?.trim()) throw new Error('Provide --serial for the test device you own. No device is selected automatically.');
const samples = Number(values.samples), seconds = Number(values.seconds);
if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new Error('--samples must be 1–30.');
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw new Error('--seconds must be 1–30.');
if (!['capture', 'connection'].includes(values.component)) throw new Error('--component must be capture or connection.');
if (!VIDEO_QUALITY[values.quality]) throw new Error('Unknown --quality.');
const catalog = builtinBackends()[values.component];
const ids = (values.implementations ?? (values.component === 'capture' ? 'adb,android-cli' : 'scrcpy')).split(',').map(id => id.trim());
if (new Set(ids).size !== ids.length) throw new Error('Provide each implementation only once.');
const implementations = ids.map(id => {
  const found = catalog.find(candidate => candidate.id === id);
  if (!found) throw new Error(`Unknown ${values.component} implementation: ${id}`);
  return found;
});
const result = { schemaVersion: 1, collectedAt: new Date().toISOString(), runtimeVersion: RUNTIME_VERSION,
  component: values.component, serial: values.serial, quality: values.component === 'connection' ? values.quality : null,
  methodology: values.component === 'capture'
    ? 'Sequential, alternating implementations; no warmup excluded. Timings include command startup and PNG validation. Images are discarded.'
    : 'Sequential connections on the unchanged device. First frame is encoded output, not rendering; fps depends on screen activity. No input or animation is generated.',
  implementations: [],
};
const outcomes = new Map();
for (const backend of implementations) {
  const availability = await backend.probe?.() ?? { available: true, version: backend.version };
  const item = { id: backend.id, version: availability.version ?? backend.version, availability, samples: [] };
  outcomes.set(backend.id, item); result.implementations.push(item);
}
const round = value => Math.round(value * 100) / 100;
for (let sample = 0; sample < samples; sample++) {
  // Reverse every other round to reduce consistent ordering bias.
  for (const backend of sample % 2 ? [...implementations].reverse() : implementations) {
    const item = outcomes.get(backend.id);
    if (!item.availability.available) continue;
    const started = performance.now();
    if (values.component === 'capture') {
      try {
        const png = await backend.capture(values.serial);
        item.samples.push({ ok: true, durationMs: round(performance.now() - started), bytes: png.length });
      } catch (error) {
        item.samples.push({ ok: false, durationMs: round(performance.now() - started), error: error.message.slice(0, 300) });
      }
    } else {
      const connection = backend.create({ serial: values.serial, log() {}, ...VIDEO_QUALITY[values.quality] });
      const measurement = { ok: true, frames: 0, bytes: 0, firstFrameMs: null };
      connection.on('packet', packet => {
        measurement.bytes += packet.data.length;
        if (!packet.config) { measurement.frames++; measurement.firstFrameMs ??= round(performance.now() - started); }
      });
      connection.on('end', () => { measurement.ok = false; measurement.error = 'Connection ended during measurement.'; });
      try {
        await connection.start();
        await pause(seconds * 1000); // The observation window being measured.
        measurement.durationMs = round(performance.now() - started);
        if (!measurement.frames) { measurement.ok = false; measurement.error = 'No encoded frames received.'; }
        if (connection.session) measurement.dimensions = connection.session;
      } catch (error) { measurement.ok = false; measurement.error = error.message.slice(0, 300); }
      finally { connection.stop(); }
      item.samples.push(measurement);
    }
  }
}
for (const item of result.implementations) {
  const successful = item.samples.filter(sample => sample.ok).map(sample => values.component === 'connection' ? sample.firstFrameMs : sample.durationMs).filter(Number.isFinite).sort((a,b) => a-b);
  item.summary = { successes: successful.length, failures: item.samples.filter(sample => !sample.ok).length,
    ...(successful.length ? { latencyMetric: values.component === 'connection' ? 'firstEncodedFrame' : 'capture', p50Ms: successful[Math.ceil(successful.length * .5)-1], p95Ms: successful[Math.ceil(successful.length * .95)-1] } : {}) };
}
const json = JSON.stringify(result, null, 2) + '\n';
if (values.output) fs.writeFileSync(values.output, json, { mode: 0o600 });
process.stdout.write(json);

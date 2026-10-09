import { adb } from './sdk.mjs';

function hardwareSerial(output) {
  const value = typeof output === 'string' ? output.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(value) || /^(unknown|null|none|undefined)$/i.test(value) || /^[0._:-]+$/.test(value)) return null;
  return value;
}

export function createConnectedDeviceCatalog({ listDevices, runAdb = adb, ttlMs = 3_000 }) {
  let cached, expiresAt = 0, pending;

  async function describe(row) {
    const device = { ...row, kind: 'physical', label: (row.model || row.product || row.device || row.serial).replaceAll('_', ' ') };
    let hardwareId = null;
    if (row.state === 'device') {
      for (const property of ['ro.serialno', 'ro.boot.serialno']) {
        try {
          const result = await runAdb(row.serial, ['shell', 'getprop', property], { timeoutMs: 2_000, maxBytes: 1_024 });
          if (result.code === 0 && !result.truncated) hardwareId = hardwareSerial(result.stdout);
        } catch { /* A transport may disappear between listing and inspection. */ }
        if (hardwareId) break;
      }
    }
    // DevicePins uses this locally to recognize USB and wireless transports of
    // the same handset. Public lists and ordinary spreads must not expose it.
    Object.defineProperty(device, 'hardwareId', { value: hardwareId });
    return device;
  }

  return {
    async list({ fresh = false } = {}) {
      if (pending) return pending;
      if (!fresh && cached && Date.now() < expiresAt) return cached;
      pending = Promise.resolve().then(listDevices).then(rows => {
        if (!Array.isArray(rows)) throw new Error('ADB did not return a device list. Retry connected-device discovery.');
        return Promise.all(rows.filter(row => !row.serial.startsWith('emulator-')).map(describe));
      }).then(devices => {
        cached = devices;
        expiresAt = Date.now() + ttlMs;
        return devices;
      }).catch(error => {
        expiresAt = 0;
        throw error;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

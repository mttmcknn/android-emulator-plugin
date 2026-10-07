// User preferences, shown on the host's settings page and used by the helper and panel.
import fs from 'node:fs';
import path from 'node:path';

export const VIDEO_QUALITY = {
  'Data saver': { maxSize: 1280, bitRate: 4_000_000, maxFps: 30 },
  Balanced: { maxSize: 1920, bitRate: 12_000_000, maxFps: 60 },
  High: { maxSize: 0, bitRate: 24_000_000, maxFps: 60 },
};

export const AUTOMATIC = 'Automatic';

const DEFAULTS = {
  defaultAvd: AUTOMATIC,
  keepCreatedDevices: false,
  idleMinutes: 60,
  videoQuality: 'Balanced',
};

export class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.values = Object.fromEntries(Object.entries(DEFAULTS).map(([name, value]) => [name, saved[name] ?? value]));
    } catch {
      this.values = { ...DEFAULTS };
    }
  }

  get(name) {
    return this.values[name];
  }

  // Settings page payload (SettingsReadResult).
  describe(avds) {
    const properties = {
      defaultAvd: {
        type: 'string',
        title: 'Default device',
        description: 'Started when a thread asks for an emulator without naming one. Automatic picks a device that is not already running.',
        enum: [AUTOMATIC, ...avds],
      },
      keepCreatedDevices: {
        type: 'boolean',
        title: 'Keep new devices after a thread is archived',
        description: 'When off, devices a thread creates are deleted when that thread is archived.',
      },
      idleMinutes: {
        type: 'integer',
        title: 'Stop idle emulators after (minutes)',
        description: 'Emulators nobody is watching or using are stopped after this long. 0 never stops them.',
        minimum: 0,
        maximum: 1440,
      },
      videoQuality: {
        type: 'string',
        title: 'Video quality',
        description: 'Higher quality uses more CPU while the panel is open.',
        enum: Object.keys(VIDEO_QUALITY),
      },
    };
    const values = { ...this.values };
    if (!properties.defaultAvd.enum.includes(values.defaultAvd)) values.defaultAvd = AUTOMATIC;
    return {
      schema: { type: 'object', properties },
      values,
      layout: [
        {
          kind: 'group',
          title: 'Devices',
          items: [
            { kind: 'property', property: 'defaultAvd' },
            { kind: 'property', property: 'keepCreatedDevices' },
            { kind: 'property', property: 'idleMinutes' },
            { kind: 'tool', tool: 'emulator_manager', title: 'Manage emulators…', description: 'Running emulators and devices across all threads.' },
          ],
        },
        {
          kind: 'group',
          title: 'Display',
          items: [{ kind: 'property', property: 'videoQuality' }],
        },
      ],
    };
  }

  update(changes) {
    const next = { ...this.values };
    for (const [name, value] of Object.entries(changes ?? {})) {
      if (!Object.hasOwn(DEFAULTS, name)) throw new Error(`Unknown setting "${name}".`);
      if (typeof value !== typeof DEFAULTS[name]) throw new Error(`Setting "${name}" must be a ${typeof DEFAULTS[name]}.`);
      if (name === 'idleMinutes' && !(Number.isInteger(value) && value >= 0 && value <= 1440)) throw new Error('idleMinutes must be an integer from 0 to 1440.');
      if (name === 'videoQuality' && !VIDEO_QUALITY[value]) throw new Error(`videoQuality must be one of ${Object.keys(VIDEO_QUALITY).join(', ')}.`);
      next[name] = value;
    }
    this.values = next;
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  }
}

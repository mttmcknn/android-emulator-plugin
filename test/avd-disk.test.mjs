import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-avd-disk-'));
const avdHome = path.join(root, 'avd');
process.env.ANDROID_AVD_HOME = avdHome;
const { avdDiskBytes } = await import('../runtime/core/lib/avds.mjs');

const allocatedBytes = (file) => fs.lstatSync(file).blocks * 512;

test('reports allocated AVD data without following symlinked files or directories', async () => {
  const avd = path.join(avdHome, 'disk_usage.avd');
  const nested = path.join(avd, 'snapshots', 'payload.bin');
  const config = path.join(avd, 'config.ini');
  const outside = path.join(root, 'outside');
  const outsideFile = path.join(outside, 'large.bin');
  const outsideDirectory = path.join(outside, 'directory');

  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.mkdirSync(outsideDirectory, { recursive: true });
  fs.writeFileSync(config, 'AvdId=disk_usage\n');
  fs.writeFileSync(nested, Buffer.alloc(12_000, 1));
  fs.writeFileSync(outsideFile, Buffer.alloc(1_000_000, 2));
  fs.writeFileSync(path.join(outsideDirectory, 'also-large.bin'), Buffer.alloc(1_000_000, 3));
  fs.symlinkSync(outsideFile, path.join(avd, 'outside-file'));
  fs.symlinkSync(outsideDirectory, path.join(avd, 'outside-directory'));

  const expected = allocatedBytes(config) + allocatedBytes(nested);
  assert.equal(await avdDiskBytes('disk_usage'), expected);
});

test('reports zero bytes when an AVD data directory is absent', async () => {
  assert.equal(await avdDiskBytes('missing_device'), 0);
});

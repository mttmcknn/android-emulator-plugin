import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyCaptureToClipboard } from '../runtime/core/lib/clipboard.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jxaScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'core', 'lib', 'clipboard.jxa');

function capture(t, name, bytes = Buffer.from('video')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emulator-plugin-clipboard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes);
  return file;
}

test('copies a PNG as native image data through a bounded JXA command', async (t) => {
  const file = capture(t, 'screenshot.png', PNG_SIGNATURE);
  const calls = [];
  const result = await copyCaptureToClipboard(file, 'image/png', {
    platform: 'darwin',
    runCommand: async (...args) => {
      calls.push(args);
      return { code: 0, timedOut: false, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result, { kind: 'image' });
  assert.deepEqual(calls, [[
    '/usr/bin/osascript',
    ['-l', 'JavaScript', jxaScript, file, 'image/png'],
    { timeoutMs: 5_000, maxBytes: 4_096 },
  ]]);
});

test('copies an MP4 as a native file URL through the same bounded command', async (t) => {
  const file = capture(t, 'recording.mp4');
  const calls = [];
  const result = await copyCaptureToClipboard(file, 'video/mp4', {
    platform: 'darwin',
    runCommand: async (...args) => {
      calls.push(args);
      return { code: 0, timedOut: false, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result, { kind: 'file' });
  assert.equal(calls[0][1].at(-2), file);
});

test('rejects unsupported, malformed, and unavailable captures before invoking a clipboard command', async (t) => {
  const png = capture(t, 'broken.png', Buffer.from('not a PNG'));
  const calls = [];
  const runCommand = async (...args) => calls.push(args);
  await assert.rejects(copyCaptureToClipboard(png, 'image/png', { platform: 'darwin', runCommand }), /not a PNG image/);
  await assert.rejects(copyCaptureToClipboard(png, 'image/jpeg', { platform: 'darwin', runCommand }), /Only image\/png and video\/mp4/);
  await assert.rejects(copyCaptureToClipboard(path.join(path.dirname(png), 'missing.mp4'), 'video/mp4', { platform: 'darwin', runCommand }), /Capture file is unavailable/);
  assert.deepEqual(calls, []);
});

test('returns actionable platform and command failures without reporting success', async (t) => {
  const file = capture(t, 'recording.mp4');
  await assert.rejects(copyCaptureToClipboard(file, 'video/mp4', { platform: 'linux' }), /supported on macOS only/);
  await assert.rejects(copyCaptureToClipboard(file, 'video/mp4', {
    platform: 'darwin',
    runCommand: async () => ({ code: 1, timedOut: false, stdout: '', stderr: 'clipboard unavailable' }),
  }), /macOS clipboard copy exited 1: clipboard unavailable/);
  await assert.rejects(copyCaptureToClipboard(file, 'video/mp4', {
    platform: 'darwin',
    runCommand: async () => ({ code: 124, timedOut: true, stdout: '', stderr: '' }),
  }), /macOS clipboard copy timed out/);
});

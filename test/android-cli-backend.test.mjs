import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createAndroidCliCapture } from '../runtime/core/backends/android-cli.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWVQAAAAASUVORK5CYII=', 'base64');

test('captures the explicit device through literal Android CLI argv and returns PNG bytes', async () => {
  const calls = [];
  const backend = createAndroidCliCapture({
    executable: '/fake/android',
    runCommand: async (file, args, options) => {
      calls.push({ file, args, options });
      fs.writeFileSync(args.find((arg) => arg.startsWith('--output=')).slice('--output='.length), PNG);
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  const serial = 'emulator-5558; --device=other-device';
  assert.deepEqual(await backend.capture(serial), PNG);
  const output = calls[0].args[3].slice('--output='.length);
  assert.deepEqual(calls, [{
    file: '/fake/android',
    args: ['screen', 'capture', `--device=${serial}`, `--output=${output}`],
    options: { timeoutMs: 20_000, maxBytes: 4 * 1024 },
  }]);
  assert.equal(calls[0].args.filter((arg) => arg.startsWith('--device=')).length, 1);
  assert.equal(calls[0].args[2], `--device=${serial}`);
  assert.equal(fs.existsSync(path.dirname(output)), false);
});

test('requires an explicit nonempty serial before invoking Android CLI', async () => {
  let called = false;
  const backend = createAndroidCliCapture({ runCommand: async () => { called = true; } });
  for (const serial of [undefined, '', '   ']) {
    await assert.rejects(backend.capture(serial), /requires an explicit device serial/);
  }
  assert.equal(called, false);
});

test('cleans private screenshot storage when Android CLI output is invalid', async () => {
  let output;
  const backend = createAndroidCliCapture({
    runCommand: async (_file, args) => {
      output = args.find((arg) => arg.startsWith('--output=')).slice('--output='.length);
      fs.writeFileSync(output, 'not a PNG');
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  await assert.rejects(backend.capture('emulator-5558'), /returned an invalid PNG/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(path.dirname(output)), false);
});

test('reports a missing Android CLI probe without exposing spawn output', async () => {
  const backend = createAndroidCliCapture({
    executable: '/missing/android',
    runCommand: async () => { throw Object.assign(new Error('spawn /missing/android ENOENT'), { code: 'ENOENT' }); },
  });

  assert.deepEqual(await backend.probe(), {
    available: false,
    reason: 'Android CLI was not found. Install it or set ANDROID_EMULATOR_ANDROID_CLI.',
  });
});

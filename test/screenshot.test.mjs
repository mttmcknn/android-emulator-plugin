import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWVQAAAAASUVORK5CYII=';

test('screenshots preserve binary PNG data despite multi-display warnings and reject invalid images', t => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-screenshot-sdk-'));
  t.after(() => fs.rmSync(sdk, { recursive: true, force: true }));
  fs.mkdirSync(path.join(sdk, 'platform-tools'));
  fs.mkdirSync(path.join(sdk, 'emulator'));
  fs.writeFileSync(path.join(sdk, 'emulator', 'emulator'), '');
  fs.writeFileSync(path.join(sdk, 'platform-tools', 'adb'), `#!${process.execPath}
const warning='[Warning] Multiple displays were found.\\n';
// ADB exec-out combines the remote streams; shell v2 separates them.
(process.argv.includes('exec-out') ? process.stdout : process.stderr).write(warning);
process.stdout.write(process.env.INVALID_CAPTURE ? Buffer.from('not an image') : Buffer.from('${PNG}','base64'));
`, { mode: 0o755 });
  const source = `import { Device } from ${JSON.stringify(new URL('../runtime/core/lib/device.mjs', import.meta.url).href)};
try { console.log(JSON.stringify({image:(await new Device('emulator-test').screenshot()).toString('base64')})); }
catch(error){console.log(JSON.stringify({error:error.message}));}`;
  const screenshot = (invalid = false) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, ANDROID_HOME: sdk, INVALID_CAPTURE: invalid ? '1' : '' }, encoding: 'utf8',
  }));
  assert.equal(screenshot().image, PNG);
  const invalid = screenshot(true);
  assert.equal(invalid.image, undefined);
  assert.match(invalid.error, /complete PNG screenshot/);
});

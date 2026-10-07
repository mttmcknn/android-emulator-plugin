import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { SCRCPY_VERSION } from '../runtime/core/lib/control.mjs';

// Official v5.0 SHA256SUMS.txt, verified against its maintainer signature.
const SERVER_SHA256 = '26cbc9ad0aced6c2282455bef4fb43462605c1f8758c74b4ab1dbf818c229daa';

test('source and packaged scrcpy servers match the official 5.0 release', () => {
  assert.equal(SCRCPY_VERSION, '5.0');
  for (const root of ['../runtime/core/', '../plugins/android-emulator-plugin/runtime/core/']) {
    const vendor = new URL(`${root}vendor/`, import.meta.url);
    assert.deepEqual(fs.readdirSync(vendor).filter((name) => name.startsWith('scrcpy-server-')), ['scrcpy-server-v5.0']);
    const server = fs.readFileSync(new URL(`scrcpy-server-v${SCRCPY_VERSION}`, vendor));
    assert.equal(createHash('sha256').update(server).digest('hex'), SERVER_SHA256);
  }
});

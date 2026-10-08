import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { SCRCPY_VERSION } from '../runtime/core/lib/control.mjs';

// Official v5.0.1 SHA256SUMS.txt and GitHub release-asset digest.
const SERVER_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';

test('source and packaged scrcpy servers match the official 5.0.1 release', () => {
  assert.equal(SCRCPY_VERSION, '5.0.1');
  for (const root of ['../runtime/core/', '../plugins/android-emulator-plugin/runtime/core/']) {
    const vendor = new URL(`${root}vendor/`, import.meta.url);
    assert.deepEqual(fs.readdirSync(vendor).filter((name) => name.startsWith('scrcpy-server-')), ['scrcpy-server-v5.0.1']);
    const server = fs.readFileSync(new URL(`scrcpy-server-v${SCRCPY_VERSION}`, vendor));
    assert.equal(createHash('sha256').update(server).digest('hex'), SERVER_SHA256);
    for (const notice of ['SCRCPY-LICENSE', 'SCRCPY-SOURCE.md', 'SCRCPY-NOTICES.md', 'KOTLIN-LICENSE', 'KOTLIN-BOOST-LICENSE', 'KOTLIN-THREETENBP-LICENSE']) {
      assert.ok(fs.statSync(new URL(notice, vendor)).size > 0, `${root}${notice}`);
    }
  }
});

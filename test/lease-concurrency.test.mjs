import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emulator-plugin-leases-'));
const sdkRoot = path.join(root, 'sdk');
const executable = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
};

// These stand in for the SDK only: no command talks to adb or launches an emulator.
executable(
  path.join(sdkRoot, 'emulator', 'emulator'),
  `#!/bin/sh
if [ "$1" = "-list-avds" ]; then
  printf 'Pixel_10\nPixel_10a\n'
  exit 0
fi
sleep 0.5
`,
);
executable(path.join(sdkRoot, 'platform-tools', 'adb'), '#!/bin/sh\nprintf "1\\n"\n');
process.env.ANDROID_HOME = sdkRoot;

const { LeaseManager } = await import('../runtime/core/lib/leases.mjs');

function manager() {
  return new LeaseManager({ dir: fs.mkdtempSync(path.join(root, 'state-')), log: () => {}, isPortFree: async () => true });
}

async function stopAll(leases) {
  await Promise.allSettled(Object.keys(leases.leases).map((threadId) => leases.stop(threadId)));
}

test('simultaneous automatic starts reserve different writable AVDs', async (t) => {
  const leases = manager();
  t.after(() => stopAll(leases));

  const [first, second] = await Promise.all([leases.start('thread-a'), leases.start('thread-b')]);

  assert.notEqual(first.avd, second.avd);
  assert.notEqual(first.serial, second.serial);
  assert.equal(first.readOnly, false);
  assert.equal(second.readOnly, false);
  assert.equal(leases.reservedAvds.size, 0);
  assert.equal(leases.reservedPorts.size, 0);
});

test('readOnly false cannot create a second writer for an already leased AVD', async (t) => {
  const leases = manager();
  t.after(() => stopAll(leases));

  const writer = await leases.start('thread-a', { avd: 'Pixel_10' });
  const secondInstance = await leases.start('thread-b', { avd: 'Pixel_10', readOnly: false });

  assert.equal(writer.readOnly, false);
  assert.equal(secondInstance.readOnly, true);
  assert.notEqual(secondInstance.serial, writer.serial);
});

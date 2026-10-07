import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A throwaway SDK and AVD home so tests never touch real devices.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-'));
const sdkRoot = path.join(root, 'sdk');
const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
const writeFile = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
writeFile(path.join(sdkRoot, 'emulator', 'emulator'), '');
writeFile(
  path.join(sdkRoot, 'system-images', 'android-36', 'google_apis_playstore', abi, 'source.properties'),
  `AndroidVersion.ApiLevel=36\nSystemImage.TagId=google_apis_playstore\nSystemImage.TagDisplay=Google Play\nSystemImage.Abi=${abi}\n`,
);
writeFile(
  path.join(sdkRoot, 'system-images', 'android-35', 'google_apis_playstore_tablet', abi, 'source.properties'),
  `AndroidVersion.ApiLevel=35\nSystemImage.TagId=google_apis_playstore,tablet\nSystemImage.TagDisplay=Google APIs PlayStore,Tablet\n`,
);
writeFile(path.join(sdkRoot, 'skins', 'pixel_9', 'layout'), 'parts {}\n');
process.env.ANDROID_HOME = sdkRoot;
process.env.ANDROID_AVD_HOME = path.join(root, 'avd');
const { createAvd, deleteAvd, systemImages } = await import('../runtime/core/lib/avds.mjs');

test('creates an AVD from a profile with the newest matching image and its skin', () => {
  const created = createAvd({ profileId: 'pixel_9', existingNames: [] });
  assert.equal(created.name, 'Pixel_9_API_36');
  const config = fs.readFileSync(path.join(root, 'avd', 'Pixel_9_API_36.avd', 'config.ini'), 'utf8');
  assert.match(config, /^image\.sysdir\.1=system-images\/android-36\/google_apis_playstore\/.+\/$/m);
  assert.match(config, /^hw\.lcd\.width=1080$/m);
  assert.match(config, /^skin\.name=pixel_9$/m);
  assert.match(fs.readFileSync(path.join(root, 'avd', 'Pixel_9_API_36.ini'), 'utf8'), /^path=.+Pixel_9_API_36\.avd$/m);
  assert.equal(createAvd({ profileId: 'pixel_9', existingNames: ['Pixel_9_API_36'] }).name, 'Pixel_9_API_36_2');
});

test('tablet profiles pick tablet images and reject unknown inputs', () => {
  assert.match(createAvd({ profileId: 'pixel_tablet', existingNames: [] }).image, /Tablet/);
  assert.throws(() => createAvd({ profileId: 'nokia_3310', existingNames: [] }), /Unknown device profile/);
  assert.throws(() => createAvd({ profileId: 'pixel_9', imageId: 'android-99/x/y', existingNames: [] }), /not installed/);
  assert.throws(() => createAvd({ profileId: 'pixel_9', name: '../escape', existingNames: [] }), /Invalid AVD name/);
  assert.equal(systemImages().length, 2);
});

test('deleting an AVD removes its definition and data directory', () => {
  deleteAvd('Pixel_9_API_36_2');
  assert.equal(fs.existsSync(path.join(root, 'avd', 'Pixel_9_API_36_2.avd')), false);
  assert.equal(fs.existsSync(path.join(root, 'avd', 'Pixel_9_API_36_2.ini')), false);
  assert.equal(fs.existsSync(path.join(root, 'avd', 'Pixel_9_API_36.avd')), true);
});

test('created foldables have hinge and cover-display hardware; capabilities come from config rather than name', async () => {
  const { avdPostures } = await import('../runtime/core/lib/avds.mjs');
  for (const [profileId, coverHeight] of [['pixel_10_pro_fold', '2364'], ['pixel_9_pro_fold', '2424']]) {
    const created = createAvd({ profileId, existingNames: [] });
    const configPath = path.join(root, 'avd', `${created.name}.avd`, 'config.ini');
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /^hw.sensor.hinge=yes$/m);
    assert.match(config, /^hw.sensor.hinge.areas=1038-0-0-2152$/m);
    assert.ok(config.includes(`hw.displayRegion.0.1.height=${coverHeight}\n`));
    assert.deepEqual(avdPostures(created.name), ['folded', 'half-folded', 'unfolded']);
    fs.writeFileSync(configPath, config.replace('hw.sensor.posture_list=1, 2, 3', 'hw.sensor.posture_list=1, 3'));
    assert.deepEqual(avdPostures(created.name), ['folded', 'unfolded']);
  }
  assert.deepEqual(avdPostures('Pixel_9_API_36'), []);
  assert.deepEqual(avdPostures('missing_fold'), []);
});

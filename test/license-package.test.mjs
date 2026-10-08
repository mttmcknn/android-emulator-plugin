import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { iconFor } from '../runtime/core/tools.mjs';

const repository = new URL('../', import.meta.url);
const plugin = new URL('plugins/android-emulator-plugin/', repository);

test('installable plugin and retained runtime include first-party license and notices', () => {
  for (const file of ['LICENSE', 'NOTICE']) {
    const original = fs.readFileSync(new URL(file, repository));
    for (const root of [plugin, new URL('runtime/', repository), new URL('runtime/', plugin)]) {
      assert.deepEqual(fs.readFileSync(new URL(file, root)), original);
    }
  }
  for (const root of [repository, new URL('runtime/core/', repository), plugin]) {
    const manifest = root === plugin ? '.codex-plugin/plugin.json' : 'package.json';
    assert.equal(JSON.parse(fs.readFileSync(new URL(manifest, root))).license, 'Apache-2.0');
  }
});

test('distributed Android robot SVGs retain attribution and license link', () => {
  const sources = ['assets/logo.svg', 'assets/logo-dark.svg'].map(file => fs.readFileSync(new URL(file, plugin), 'utf8'));
  sources.push(Buffer.from(iconFor('android')[0].src.split(',')[1], 'base64').toString('utf8'));
  sources.push(fs.readFileSync(new URL('runtime/core/web/index.html', repository), 'utf8'));
  for (const svg of sources) {
    assert.match(svg, /The Android robot is reproduced or modified from work created and shared by Google/);
    assert.match(svg, /https:\/\/creativecommons\.org\/licenses\/by\/3\.0\//);
    assert.match(svg, /Modified by/);
  }
});

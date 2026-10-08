import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { authorManifest, committedFiles, contrast, semanticVersion, validatePackage } from '../scripts/package-submission.mjs';
import { crc32, createZip, inspectZip } from '../scripts/submission-zip.mjs';
import { TOOLS } from '../runtime/hosts/codex/tools.mjs';

const plugin = new URL('../plugins/android-emulator-plugin/', import.meta.url);
const original = JSON.parse(fs.readFileSync(new URL('.codex-plugin/plugin.json', plugin), 'utf8'));
const metadata = JSON.parse(fs.readFileSync(new URL('../release/submission.json', import.meta.url), 'utf8'));
function packageFiles() {
  const files = new Map();
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name; const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) visit(url, relative + '/');
      else files.set(relative, { bytes: fs.readFileSync(url), mode: fs.statSync(url).mode });
    }
  }
  visit(plugin);
  files.set('.codex-plugin/plugin.json', { bytes: Buffer.from(JSON.stringify(authorManifest(original, metadata))), mode: 0o100644 });
  return files;
}

test('author-copy metadata preserves local integration and does not manufacture owner facts', () => {
  const copy = authorManifest(original, metadata);
  assert.equal(copy.name, original.name); assert.equal(copy.version, original.version);
  assert.equal(copy.mcpServers, original.mcpServers); assert.deepEqual(copy.skills, original.skills);
  assert.equal(copy.interface.websiteURL, original.interface.websiteURL);
  assert.equal(copy.extensions['com.openai'].onboardingSkill, original.extensions['com.openai'].onboardingSkill);
  assert.equal(copy.extensions['com.openai'].publication.countries, undefined);
  assert.equal(copy.extensions['com.openai'].review.commerce, undefined);
  assert.equal(copy.extensions['com.openai'].review.demo_recording_url, undefined);
  assert(contrast(copy.interface.brandColor) >= 2);
  assert(copy.interface.shortDescription.length <= 30);
  const checked = validatePackage(packageFiles(), original);
  assert.equal(checked.tool_count, TOOLS.length);
});

test('package checks reject app bindings in every manifest, escaping paths and mismatched versions', () => {
  const forbidden = packageFiles(); forbidden.set('.app.json', { bytes: Buffer.from('{}'), mode: 0o100644 });
  assert.throws(() => validatePackage(forbidden, original), /\.app\.json/);
  for (const file of ['plugin.json', 'nested/.codex-plugin/plugin.json']) {
    const files = packageFiles(); files.set(file, { bytes: Buffer.from('{"extensions":{"com.openai":{"apps":"./.app.json"}}}'), mode: 0o100644 });
    assert.throws(() => validatePackage(files, original), /Forbidden apps/);
  }
  const escaping = packageFiles(); const changed = authorManifest(original, metadata);
  changed.interface.logo = './../secret.svg'; escaping.set('.codex-plugin/plugin.json', { bytes: Buffer.from(JSON.stringify(changed)), mode: 0o100644 });
  assert.throws(() => validatePackage(escaping, original), /Unsafe contained/);
  const mismatch = packageFiles(); changed.interface.logo = original.interface.logo; changed.version = '0.0.0';
  mismatch.set('.codex-plugin/plugin.json', { bytes: Buffer.from(JSON.stringify(changed)), mode: 0o100644 });
  assert.throws(() => validatePackage(mismatch, original));
});

test('deterministic standard ZIP retains bytes/executable mode and rejects corruption and traversal', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const entries = [{ name: 'plugin/bin/launch', bytes: Buffer.from('#!/bin/sh\n'), executable: true }, { name: 'plugin/LICENSE', bytes: Buffer.from('license\n') }];
  const zip = createZip(entries); assert.deepEqual(createZip([...entries].reverse()), zip);
  const files = inspectZip(zip); assert.equal(files.get('plugin/bin/launch').mode, 0o100755);
  assert.deepEqual(files.get('plugin/LICENSE').bytes, entries[1].bytes);
  const corrupt = Buffer.from(zip); corrupt[zip.indexOf('license\n')] ^= 1;
  assert.throws(() => inspectZip(corrupt));
  assert.throws(() => createZip([{ name: 'plugin/../secret', bytes: Buffer.from('x') }]), /Unsafe ZIP/);
  assert.throws(() => createZip([entries[0], entries[0]]), /Duplicate ZIP/);
  assert(semanticVersion.test(original.version)); assert(!semanticVersion.test('2026.10.08'));
});

test('tool hints cover confirmed persistence, downloads and destructive panel messages', () => {
  const tools = new Map(TOOLS.map(tool => [tool.name, tool]));
  for (const name of ['emulator_screenshot', 'emulator_ui_tree', 'emulator_wait_for', 'emulator_observe']) assert.equal(tools.get(name).annotations.readOnlyHint, false, name);
  for (const name of ['emulator_navigate', 'emulator_apk', 'emulator_ui_tree', 'emulator_wait_for', 'emulator_tap', 'emulator_swipe', 'emulator_scroll_to', 'emulator_observe', 'emulator_type', 'emulator_app', 'emulator_key', 'emulator_open', 'emulator_stream']) assert.equal(tools.get(name).annotations.openWorldHint, true, name);
  assert.equal(tools.get('emulator_stream').annotations.destructiveHint, true);
});

test('ZIP inspection rejects inconsistent or unsupported local and central headers', () => {
  const zip = createZip([{ name: 'plugin/test.txt', bytes: Buffer.from('payload') }]);
  const central = zip.readUInt32LE(zip.length - 22 + 16);
  const mutations = [
    bytes => { bytes.writeUInt16LE(0x801, 6); bytes.writeUInt16LE(0x801, central + 8); },
    bytes => bytes.writeUInt16LE(0, 6),
    bytes => bytes.writeUInt32LE(0, central + 20),
    bytes => bytes.writeUInt32LE(0, 22),
    bytes => bytes.writeUInt32LE(0, 14),
    bytes => bytes.writeUInt16LE(8, central + 10),
    bytes => bytes.writeUInt16LE(8, 8),
    bytes => bytes.writeUInt32LE(central, central + 42),
    bytes => bytes.writeUInt16LE(2, zip.length - 22 + 8),
  ];
  for (const mutate of mutations) {
    const altered = Buffer.from(zip); mutate(altered);
    assert.throws(() => inspectZip(altered));
  }
});

test('packaging uses committed bytes and executable modes across clean host permission differences', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'android-plugin-git-mode-'));
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet'); fs.mkdirSync(path.join(repository, 'plugin'));
    const notice = path.join(repository, 'plugin/NOTICE'); const launcher = path.join(repository, 'plugin/launch');
    fs.writeFileSync(notice, 'notice\n'); fs.chmodSync(notice, 0o644);
    fs.writeFileSync(launcher, '#!/bin/sh\n'); fs.chmodSync(launcher, 0o755);
    git('add', 'plugin'); git('-c', 'user.name=Local Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    const archive = () => createZip([...committedFiles(repository, 'plugin/')].map(([name, file]) => ({ name: `plugin/${name}`, bytes: file.bytes, executable: Boolean(file.mode & 0o111) })));
    const before = archive();
    fs.chmodSync(notice, 0o654); assert.equal(git('status', '--porcelain'), '');
    git('config', 'core.filemode', 'false'); fs.chmodSync(launcher, 0o644);
    assert.equal(git('status', '--porcelain'), ''); assert.deepEqual(archive(), before);
    assert.equal(committedFiles(repository, 'plugin/').get('launch').mode, 0o100755);
  } finally { fs.rmSync(repository, { recursive: true, force: true }); }
});

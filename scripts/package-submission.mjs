import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../runtime/hosts/codex/tools.mjs';
import { createZip, inspectZip } from './submission-zip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectory = 'plugins/android-emulator-plugin/';
export const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = (files, file) => JSON.parse(files.get(file).bytes.toString('utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function clean() { assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '', 'Commit source changes before packaging; the release ZIP must have a clean source commit.'); }
function run(...args) { execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' }); }
export function committedFiles(repository = root, prefix = sourceDirectory) {
  const files = new Map();
  const tree = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD', '--', prefix], { cwd: repository, encoding: 'utf8' });
  for (const record of tree.split('\0').filter(Boolean)) {
    const match = record.match(/^([0-7]{6}) blob ([a-f0-9]+)\t(.+)$/s);
    assert(match, `Unsupported committed entry: ${record}`);
    const [, mode, object, file] = match;
    assert(['100644', '100755'].includes(mode), `Special committed file: ${file}`);
    assert(fs.lstatSync(path.join(repository, file)).isFile(), `Special source file: ${file}`);
    files.set(file.slice(prefix.length), {
      bytes: execFileSync('git', ['cat-file', 'blob', object], { cwd: repository, maxBuffer: 16 * 1024 * 1024 }),
      mode: parseInt(mode, 8),
    });
  }
  assert(files.size > 0, 'No committed plugin files found');
  return files;
}
function contained(file, files) {
  assert.equal(typeof file, 'string'); assert(file.startsWith('./'), `Expected ./-prefixed contained path: ${file}`);
  const relative = file.slice(2);
  assert(!relative.includes('\\') && !relative.split('/').some(p => !p || p === '.' || p === '..'), `Unsafe contained path: ${file}`);
  assert(files.has(relative), `Missing referenced file: ${file}`); return relative;
}
export function contrast(color, background = '#FFFFFF') {
  const luminance = value => {
    assert(/^#[0-9a-f]{6}$/i.test(value), `Invalid brand color: ${value}`);
    return [1, 3, 5].map(p => parseInt(value.slice(p, p + 2), 16) / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const a = luminance(color); const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function authorManifest(original, metadata) {
  const openai = original.extensions?.['com.openai'] ?? {};
  return { ...original, interface: { ...original.interface, ...metadata.interface }, extensions: {
    ...original.extensions, 'com.openai': { ...openai,
      review: { ...openai.review, ...metadata.review },
      publication: { ...openai.publication, ...metadata.publication },
    },
  } };
}

export function validatePackage(files, original) {
  assert(!files.has('.app.json'), 'Author uploads cannot contain root .app.json');
  for (const [file, entry] of files) {
    assert(!file.startsWith('/') && !file.includes('\\') && !file.split('/').some(p => !p || p === '.' || p === '..'), `Unsafe package path: ${file}`);
    assert.equal(entry.mode & 0o170000, 0o100000, `Special file: ${file}`);
    if (file === 'plugin.json' || file.endsWith('/plugin.json')) {
      const manifest = parse(files, file);
      assert(manifest.apps == null && manifest.extensions?.['com.openai']?.apps == null, `Forbidden apps declaration in ${file}`);
      assert(manifest.hooks == null && manifest.extensions?.['com.openai']?.hooks == null, `Lifecycle hooks need a separate public route: ${file}`);
    }
  }
  assert(!files.has('hooks/hooks.json'), 'Lifecycle hooks need a separate public route');
  const manifest = parse(files, '.codex-plugin/plugin.json');
  assert.equal(manifest.name, original.name); assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name) && manifest.name.length <= 64);
  assert.equal(manifest.version, original.version); assert(semanticVersion.test(manifest.version), 'Explicit valid semantic version required');
  assert.equal(manifest.license, original.license); assert.equal(manifest.author.name, original.author.name);
  assert.equal(manifest.mcpServers, original.mcpServers); assert.deepEqual(manifest.skills, original.skills);
  const listing = manifest.interface;
  for (const [field, limit] of [['displayName', 30], ['shortDescription', 30], ['longDescription', 4000], ['developerName', 80]]) {
    assert(typeof listing[field] === 'string' && listing[field].trim() && [...listing[field]].length <= limit, `Invalid listing ${field}`);
  }
  assert(typeof listing.category === 'string' && listing.category.trim());
  assert(Array.isArray(listing.capabilities) && listing.capabilities.length <= 20);
  const prompts = typeof listing.defaultPrompt === 'string' ? [listing.defaultPrompt] : listing.defaultPrompt ?? [];
  assert(prompts.length <= 3 && new Set(prompts.map(p => p.trim().replace(/\s+/g, ' '))).size === prompts.length);
  assert(prompts.every(p => typeof p === 'string' && p.trim() && !/[\r\n]|@/.test(p) && [...p].length <= 128));
  const urls = ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'].map(field => {
    const value = listing[field];
    if (value !== undefined) {
      const url = new URL(value); assert(url.protocol === 'https:' && !url.username && !url.password && value.length <= 1024, `Invalid ${field}`);
    }
    return { field, url: value ?? null, status: value ? 'present; HTTPS syntax checked, live content verification separate' : 'missing' };
  });
  const icons = [];
  for (const field of ['logo', 'composerIcon', 'logoDark', 'composerIconDark']) {
    if (!listing[field] && field.endsWith('Dark')) continue;
    const file = contained(listing[field], files); const bytes = files.get(file).bytes;
    assert(bytes.length <= 5 * 1024 * 1024 && file.endsWith('.svg'), 'This source uses existing SVG icons');
    const svg = bytes.toString('utf8'); const view = svg.match(/viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/);
    assert(view && Number(view[3]) === Number(view[4]) && Number(view[3]) >= 48, `Square SVG viewBox >=48 required: ${file}`);
    assert(!/<script|<foreignObject|(?:href|src)\s*=\s*["']https?:/i.test(svg), `External/scripted SVG: ${file}`);
    icons.push({ field, file, format: 'SVG', width: Number(view[3]), height: Number(view[4]), size_bytes: bytes.length });
  }
  if (listing.brandColor) assert(contrast(listing.brandColor) >= 2, 'brandColor needs 2:1 white contrast');
  if (listing.brandColorDark) assert(contrast(listing.brandColorDark, '#212121') >= 2, 'brandColorDark needs 2:1 dark contrast');
  contained(manifest.mcpServers, files);
  const mcp = parse(files, '.mcp.json'); const servers = Object.entries(mcp.mcpServers);
  assert.equal(servers.length, 1); assert.equal(servers[0][0], 'emulator');
  const server = servers[0][1]; contained(server.command, files);
  for (const arg of server.args ?? []) if (arg.startsWith('./')) contained(arg, files);
  assert.deepEqual(mcp, JSON.parse(fs.readFileSync(path.join(root, sourceDirectory, '.mcp.json'), 'utf8')), 'MCP behavior must stay intact');
  const skills = [...files.keys()].filter(p => /^skills\/[^/]+\/SKILL\.md$/.test(p)); assert(skills.length > 0);
  for (const file of skills) {
    const text = files.get(file).bytes.toString('utf8'); const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert(header && /^name:\s*\S+/m.test(header[1]) && /^description:\s*\S+/m.test(header[1]), `Skill frontmatter: ${file}`);
  }
  contained(manifest.extensions['com.openai'].onboardingSkill, files);
  const cases = manifest.extensions['com.openai'].review.test_cases;
  assert.equal(cases.positive.length, 5); assert.equal(cases.negative.length, 3);
  const names = new Set(TOOLS.map(tool => tool.name));
  for (const test of cases.positive) {
    for (const field of ['description', 'prompt', 'tools_triggered', 'expected_behavior']) assert(typeof test[field] === 'string' && test[field].trim());
    for (const name of test.tools_triggered.split(',').map(s => s.trim())) assert(names.has(name), `Unknown review tool: ${name}`);
  }
  assert(cases.negative.every(test => test.description?.trim() && test.prompt?.trim()));
  for (const tool of TOOLS) for (const field of ['readOnlyHint', 'openWorldHint', 'destructiveHint']) assert.equal(typeof tool.annotations[field], 'boolean');
  for (const file of ['LICENSE', 'NOTICE']) for (const location of [file, `runtime/${file}`]) {
    assert(files.get(location)?.bytes.equals(fs.readFileSync(path.join(root, file))), `Legal copy mismatch: ${location}`);
  }
  assert.equal(hash(files.get('runtime/core/vendor/scrcpy-server-v5.0.1').bytes), '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536');
  assert.equal(hash(files.get('runtime/core/vendor/MINIMAP-RUST-COPYRIGHT-library.html').bytes), '5647be074c8edf7339fd863055923a8fc80bc5610a8d4661ec3b767b9d392c27');
  return { manifest, urls, icons, skills, tool_count: TOOLS.length };
}

function main() {
  const args = process.argv.slice(2); const options = {};
  while (args.length) { const key = args.shift(); assert(['--version', '--tag'].includes(key) && args.length, `Unknown/incomplete option: ${key}`); options[key] = args.shift(); }
  clean();
  const commit = git('rev-parse', 'HEAD'); const original = JSON.parse(fs.readFileSync(path.join(root, sourceDirectory, '.codex-plugin/plugin.json'), 'utf8'));
  if (options['--version']) assert.equal(options['--version'], original.version, 'Requested version differs from manifest');
  if (options['--tag']) {
    assert.equal(options['--tag'], `v${original.version}`, 'Tag must be v<manifest version>');
    assert.equal(git('rev-parse', '--verify', `refs/tags/${options['--tag']}^{commit}`), commit, 'Existing local tag must resolve exactly to checkout HEAD');
  }
  run('scripts/build-plugin.mjs'); clean();
  run('scripts/build-plugin.mjs', '--check');
  run('--test', ...fs.readdirSync(path.join(root, 'test')).filter(p => p.endsWith('.test.mjs')).sort().map(p => `test/${p}`));
  clean();
  // Git's committed modes and blobs preserve provenance even when a host ignores
  // mode changes or has extra group/world execute bits invisible to Git status.
  const files = committedFiles();
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'release/submission.json'), 'utf8'));
  files.set('.codex-plugin/plugin.json', { bytes: Buffer.from(`${JSON.stringify(authorManifest(original, metadata), null, 2)}\n`), mode: 0o100644 });
  files.set('LICENSE-AUDIT.md', { bytes: fs.readFileSync(path.join(root, 'LICENSE-AUDIT.md')), mode: 0o100644 });
  files.set('PREPARATION.md', { bytes: Buffer.from(`Source commit: ${commit}\n\n${fs.readFileSync(path.join(root, 'SUBMISSION.md'), 'utf8')}`), mode: 0o100644 });
  const initial = validatePackage(files, original); const prefix = `${original.name}/`;
  const entries = [...files].map(([name, file]) => ({ name: prefix + name, bytes: file.bytes, executable: Boolean(file.mode & 0o111) }));
  const zip = createZip(entries); const actual = inspectZip(zip); const unpacked = new Map();
  assert.equal(actual.size, entries.length);
  for (const [name, entry] of actual) { assert(name.startsWith(prefix)); unpacked.set(name.slice(prefix.length), entry); }
  for (const [name, file] of files) assert(unpacked.get(name)?.bytes.equals(file.bytes), `Archive byte mismatch: ${name}`);
  validatePackage(unpacked, original);
  const output = path.join(root, 'dist'); fs.mkdirSync(output, { recursive: true });
  const filename = `${original.name}-${original.version}.zip`; const digest = hash(zip);
  const gaps = ['Public review needs an approved local-MCP route or a production HTTPS architecture preserving this local emulator behavior.',
    ...initial.urls.filter(item => !item.url).map(item => `${item.field} is missing.`),
    'Selected verified publisher identity, country targeting and commerce declaration need owner confirmation.',
    'Review cases are drafted, not run against a submitted host/version; no verified demo recording URL.',
    'Dashboard domain/developer verification, tool/skill scans, annotation justifications and attestations are not completed.',
    'Custom UI review screenshots per starter prompt are not prepared; repository screenshots are not automatically listing evidence.'];
  const report = { package_status: 'local_checks_passed', public_review_ready: false,
    source: { commit, tag: options['--tag'] ?? null, version: original.version, clean: true },
    archive: { file_name: filename, sha256: digest, size_bytes: zip.length, file_count: actual.size, format: 'Codex' },
    checks: ['shared runtime built and checked', 'full local test suite passed', 'single plugin root and explicit version', 'no root .app.json or non-null apps in any manifest', 'original local MCP configuration, skills, extensions, runtime and assets preserved', 'contained paths, regular files, CRC32 and exact ZIP bytes checked', 'LICENSE/NOTICE, server hash and exact Rust notice hash checked'],
    listing_urls: initial.urls, icons: initial.icons, tool_count: initial.tool_count,
    review_cases: { positive: 5, negative: 3, status: 'Not run; draft cases in manifest' }, gaps,
    inventory: [...actual].map(([name, file]) => ({ name, size_bytes: file.bytes.length, sha256: hash(file.bytes), mode: file.mode.toString(8) })),
  };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emulator-package-'));
  try {
    for (const [name, bytes] of [[filename, zip], [`${filename}.sha256`, Buffer.from(`${digest}  ${filename}\n`)], ['submission-report.json', Buffer.from(`${JSON.stringify(report, null, 2)}\n`)]]) {
      const temp = path.join(temporary, name); fs.writeFileSync(temp, bytes); fs.copyFileSync(temp, path.join(output, name));
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  console.log(JSON.stringify({ archive: path.join(output, filename), sha256: digest, file_count: actual.size, package_status: report.package_status, public_review_ready: false, gaps }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'runtime');
const plugin = path.join(root, 'plugins', 'android-emulator-plugin');
const target = path.join(plugin, 'runtime');
const manifest = path.join(plugin, '.codex-plugin', 'plugin.json');
const version = JSON.parse(fs.readFileSync(path.join(source, 'core', 'package.json'), 'utf8')).version;

function files(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return files(dir, relative);
    if (!entry.isFile()) throw new Error(`Runtime bundles cannot contain symlinks or special files: ${relative}`);
    return [relative];
  });
}
const sourceFiles = files(source);
if (process.argv.includes('--check')) {
  const builtFiles = fs.existsSync(target) ? files(target) : [];
  const matches = JSON.stringify(sourceFiles) === JSON.stringify(builtFiles)
    && sourceFiles.every(file => fs.readFileSync(path.join(source, file)).equals(fs.readFileSync(path.join(target, file))))
    && JSON.parse(fs.readFileSync(manifest, 'utf8')).version === version;
  if (!matches) throw new Error('The Codex plugin bundle is stale. Run npm run build, then rerun tests.');
  console.log(`Codex bundle matches shared runtime ${version}.`);
} else {
  // Codex installs only its plugin directory, so commit a self-contained bundle.
  // Source edits belong in runtime/, never in this generated copy.
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fs.writeFileSync(manifest, `${JSON.stringify({ ...metadata, version }, null, 2)}\n`);
  console.log(`Built Codex plugin ${version} from ${sourceFiles.length} runtime files.`);
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A host can remove an old plugin cache while its MCP process is still running.
// Retain a complete, immutable helper bundle before accepting any calls. Old chats
// can then restart their helper and render panels without the original cache.
export function retainRuntime(runtimeRoot, stateRoot) {
  const files = [];
  function visit(relative) {
    const file = path.join(runtimeRoot, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) files.push([relative, fs.readFileSync(file)]);
    else throw new Error(`Unsupported plugin runtime entry: ${relative}`);
  }
  visit('');
  const hash = crypto.createHash('sha256');
  for (const [name, bytes] of files) hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  const parent = path.join(stateRoot, 'runtimes');
  const target = path.join(parent, hash.digest('hex'));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) return target;
  const staging = fs.mkdtempSync(path.join(parent, '.prepare-'));
  try {
    for (const [name, bytes] of files) {
      const file = path.join(staging, name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { mode: 0o600 });
    }
    try { fs.renameSync(staging, target); } catch (error) {
      // Another chat may have retained the identical bundle concurrently.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !fs.existsSync(target)) throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

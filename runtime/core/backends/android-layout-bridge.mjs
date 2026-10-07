import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Android CLI now groups nodes in window.content. Minimap 0.2 traverses
// children, so adapt that boundary without changing window metadata or nodes.
export function minimapLayout(value) {
  if (Array.isArray(value)) return value.map(minimapLayout);
  if (!value || typeof value !== 'object') return value;
  const { content, children, ...node } = value;
  const descendants = [...(children ?? []), ...(Array.isArray(content) ? content : content ? [content] : [])];
  return { ...node, ...(descendants.length ? { children: descendants.map(minimapLayout) } : {}) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [executable, ...args] = process.argv.slice(2);
  const layout = args[0] === 'layout';
  const child = spawn(executable, ['--no-metrics', ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  const chunks = [];
  let bytes = 0, overflow = false;
  if (layout) child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); }
    else chunks.push(chunk);
  });
  else child.stdout.pipe(process.stdout);
  child.once('error', () => { process.stderr.write('Android CLI could not start.\n'); process.exitCode = 1; });
  child.once('close', code => {
    if (code !== 0 || overflow) { process.exitCode = code || 1; return; }
    if (!layout) return;
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object') throw new Error('unsupported layout');
      process.stdout.write(JSON.stringify(minimapLayout(value)));
    } catch { process.stderr.write('Android CLI returned an invalid layout.\n'); process.exitCode = 1; }
  });
}

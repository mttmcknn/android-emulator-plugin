import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseAndroidLayout } from '../runtime/core/backends/android-cli.mjs';
import { minimapLayout } from '../runtime/core/backends/android-layout-bridge.mjs';
import { createNavigationDependencies } from '../runtime/core/backends/navigation-dependencies.mjs';
import { Device, findNode } from '../runtime/core/lib/device.mjs';

const exec = promisify(execFile);
const layout = [{ type: 'APPLICATION', active: true, 'window-title': 'Settings', content: [
  { class: 'android.widget.LinearLayout', bounds: '[0,0][200,100]', interactions: ['CLICKABLE'], children: [
    { class: 'android.widget.TextView', text: 'Network & internet', bounds: '[10,10][180,50]' },
  ] },
  { class: 'android.widget.EditText', 'resource-id': 'app:id/search', bounds: '[0,100][200,150]', interactions: ['PASSWORD'], state: ['FOCUSED'] },
  { class: 'android.widget.Switch', bounds: '[0,150][200,200]', interactions: ['CHECKABLE'], state: ['CHECKED'], enabled: false },
  { hidden: true, children: [{ class: 'TextView', text: 'Hidden', bounds: '[0,0][200,100]' }] },
  { class: 'TextView', text: 'Offscreen', bounds: '[0,0][200,100]', 'off-screen': true },
] }];

test('full window hierarchies preserve tap, focus, password and checked semantics without exposing hidden nodes', async () => {
  const nodes = parseAndroidLayout(JSON.stringify(layout));
  assert.equal(nodes.length, 4);
  assert.deepEqual(findNode(nodes, { text: 'network' }).node.center, [95, 30]);
  assert.deepEqual(nodes.filter(n => n.editable).map(n => [n.resourceId, n.password, n.focused]), [['app:id/search', true, true]]);
  assert.equal(nodes[3].checked, true); assert.equal(nodes[3].enabled, false);
  // Device methods share the same reader, including valid empty screens. An
  // accidental native fallback would try ADB on this deliberately fake serial.
  let reads = 0;
  const device = new Device('not-a-device', { uiNodes: async () => { reads++; return nodes; } });
  assert.equal((await device.waitForNode({ resourceId: 'search' })).node.editable, true);
  assert.equal(reads, 1);
  assert.deepEqual(await new Device('not-a-device', { uiNodes: async () => [] }).uiNodes(), []);
  assert.equal(parseAndroidLayout(JSON.stringify(layout[0])).length, nodes.length);
});

test('the private Android wrapper preserves device argv, adapts current windows for Minimap and refuses invalid JSON', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'android-layout-adapter-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const android = path.join(dir, "custom cli's android");
  const minimap = path.join(dir, 'minimap');
  const argsFile = path.join(dir, 'args.json');
  await fs.writeFile(minimap, 'unused', { mode: 0o700 });
  await fs.writeFile(android, `#!${process.execPath}\nimport('node:fs').then(fs=>{fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));process.stdout.write(process.argv.includes('--broken')?'starting...':${JSON.stringify(JSON.stringify(layout))});});`, { mode: 0o700 });
  const deps = createNavigationDependencies({ dir, environment: { PATH: '', ANDROID_EMULATOR_MINIMAP: minimap, ANDROID_EMULATOR_ANDROID_CLI: android },
    runCommand: async file => ({ code: 0, stdout: file === minimap ? 'minimap 0.2.1' : '1.0.16500706' }),
  });
  const resolved = await deps.ensure();
  const wrapper = path.join(resolved.env.PATH.split(path.delimiter)[0], 'android');
  const { stdout } = await exec(wrapper, ['layout', '--device=owned-emulator']);
  assert.deepEqual(JSON.parse(await fs.readFile(argsFile)), ['--no-metrics', 'layout', '--device=owned-emulator']);
  const adapted = JSON.parse(stdout);
  assert.equal(adapted[0].content, undefined);
  assert.equal(adapted[0].children[0].children[0].text, 'Network & internet');
  assert.equal(adapted[0].type, 'APPLICATION');
  assert.deepEqual(minimapLayout(adapted), adapted);
  await assert.rejects(exec(wrapper, ['layout', '--broken']), error => error.code === 1 && error.stdout === '' && /invalid layout/.test(error.stderr));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { EMULATOR_INSTRUCTIONS } from '../runtime/core/tools.mjs';
import { AUTO_PANEL, INSTRUCTIONS, TOOLS, withPanelConnection } from '../runtime/hosts/cursor/tools.mjs';

test('replaces the automatic-panel guidance, which Cursor cannot honor, with an explicit emulator_panel step', () => {
  assert.ok(EMULATOR_INSTRUCTIONS.includes(AUTO_PANEL), 'shared instructions changed; update the Cursor replacement');
  assert.ok(!INSTRUCTIONS.includes(AUTO_PANEL));
  assert.match(INSTRUCTIONS, /call emulator_panel to show the device/);
});

test('omits tools that depend on Codex file and mention entrypoints', () => {
  const names = TOOLS.map(tool => tool.name);
  assert.ok(!names.includes('emulator_apk'));
  assert.ok(!names.includes('emulator_mentions'));
  assert.ok(names.includes('emulator_panel'));
});

test('copies the panel connection into structuredContent and offers the browser panel', () => {
  const panel = { panelUrl: 'http://127.0.0.1:1/t/a?k=b', channel: { thread: 'a', key: 'b' } };
  const result = withPanelConnection({ text: 'Started.', structuredContent: { emulator: null }, meta: { panel } });
  assert.deepEqual(result.structuredContent, { emulator: null, panel });
  assert.match(result.text, /^Started\.\nIf the panel does not appear inline, open it in a browser: http:\/\/127\.0\.0\.1:1\/t\/a\?k=b$/);
  const plain = { text: 'Tapped.' };
  assert.equal(withPanelConnection(plain), plain);
});

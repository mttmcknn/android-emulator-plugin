import assert from 'node:assert/strict';
import test from 'node:test';
import { EMULATOR_INSTRUCTIONS } from '../runtime/core/tools.mjs';
import { inspectOnlyNavigation } from '../runtime/hosts/cursor/backends.mjs';
import {
  AUTO_PANEL, SCREEN_NAMING, SCROLL_TO_DURATION_MS, cursorInstructions, cursorTools, screenMemoryEnabled, withCursorDefaults, withPanelConnection,
} from '../runtime/hosts/cursor/tools.mjs';

test('replaces the automatic-panel guidance, which Cursor cannot honor, with an explicit emulator_panel step', () => {
  assert.ok(EMULATOR_INSTRUCTIONS.includes(AUTO_PANEL), 'shared instructions changed; update the Cursor replacement');
  for (const screenMemory of [true, false]) {
    const instructions = cursorInstructions({ screenMemory });
    assert.ok(!instructions.includes(AUTO_PANEL));
    assert.match(instructions, /call emulator_panel to show the device/);
  }
});

test('keeps screen memory off unless EMULATOR_SCREEN_MEMORY=1, hiding its tool and screen-naming guidance', () => {
  assert.equal(screenMemoryEnabled({}), false);
  assert.equal(screenMemoryEnabled({ EMULATOR_SCREEN_MEMORY: '1' }), true);
  assert.ok(EMULATOR_INSTRUCTIONS.includes(SCREEN_NAMING), 'shared instructions changed; update the Cursor removal');
  assert.ok(!cursorInstructions({ screenMemory: false }).includes(SCREEN_NAMING));
  assert.ok(cursorInstructions({ screenMemory: true }).includes(SCREEN_NAMING));
  assert.ok(!cursorTools({ screenMemory: false }).some(tool => tool.name === 'emulator_navigate'));
  assert.ok(cursorTools({ screenMemory: true }).some(tool => tool.name === 'emulator_navigate'));
});

test('omits tools that depend on Codex file and mention entrypoints', () => {
  const names = cursorTools({ screenMemory: true }).map(tool => tool.name);
  assert.ok(!names.includes('emulator_apk'));
  assert.ok(!names.includes('emulator_mentions'));
  assert.ok(names.includes('emulator_panel'));
});

test('swipes slowly by default when scrolling to an element, without overriding an explicit duration', () => {
  assert.deepEqual(withCursorDefaults('emulator_scroll_to', { text: 'Display' }), { durationMs: SCROLL_TO_DURATION_MS, text: 'Display' });
  assert.deepEqual(withCursorDefaults('emulator_scroll_to', { text: 'Display', durationMs: 200 }), { durationMs: 200, text: 'Display' });
  assert.deepEqual(withCursorDefaults('emulator_tap', { text: 'OK' }), { text: 'OK' });
});

test('reads screens without a prepare step, so the runtime never routes actions through screen memory', async () => {
  const backend = inspectOnlyNavigation({ stateDir: '/tmp/unused' });
  const navigator = backend.create();
  assert.equal(navigator.prepare, undefined);
  assert.equal(typeof backend.uiNodes, 'function');
  assert.deepEqual(await backend.probe(), { available: true });
  assert.deepEqual(navigator.status('/projects/app', 'com.example'), { initialized: false, packageName: 'com.example', places: [], edges: [] });
  await assert.rejects(navigator.execute({}), /Screen memory is off/);
});

test('copies the panel connection into structuredContent and offers the browser panel', () => {
  const panel = { panelUrl: 'http://127.0.0.1:1/t/a?k=b', channel: { thread: 'a', key: 'b' } };
  const result = withPanelConnection({ text: 'Started.', structuredContent: { emulator: null }, meta: { panel } });
  assert.deepEqual(result.structuredContent, { emulator: null, panel });
  assert.match(result.text, /^Started\.\nIf the panel does not appear inline, open it in a browser: http:\/\/127\.0\.0\.1:1\/t\/a\?k=b$/);
  const plain = { text: 'Tapped.' };
  assert.equal(withPanelConnection(plain), plain);
});

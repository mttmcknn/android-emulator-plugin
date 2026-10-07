import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Recorder } from '../runtime/core/lib/recorder.mjs';

function fixture(t, deviceCommand) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-recorder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const children = [];
  const files = [];
  const recorder = new Recorder(dir, {
    adbPath: () => '/test/adb', deviceCommand,
    spawnProcess: (_command, args) => {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit('close'); };
      children.push(child); files.push(args.at(-1)); return child;
    },
  });
  return { recorder, children, files };
}

test('failed recording pulls can be retried and simultaneous stops share the same save', async t => {
  let pulls = 0;
  const { recorder, children, files } = fixture(t, async (_serial, args) => {
    if (args[0] === 'pull') return { code: ++pulls === 1 ? 1 : 0 };
    return { code: 0 };
  });
  recorder.start('emulator-5602', 'chat-a');
  children[0].emit('close');
  const first = recorder.stop('emulator-5602', 'Pixel');
  assert.equal(recorder.stop('emulator-5602', 'Pixel'), first);
  await assert.rejects(first, /Retry Stop/);
  assert.equal(recorder.isRecording('emulator-5602'), true);
  const saved = await recorder.stop('emulator-5602', 'Pixel');
  assert.match(saved.file, /Pixel-.*\.mp4$/);
  assert.equal(pulls, 2);
  assert.equal(recorder.isRecording('emulator-5602'), false);
  recorder.start('emulator-5602', 'chat-a');
  assert.notEqual(files[0], files[1], 'each recording uses a fresh device file');
});

test('lease cleanup clears only its recorder and never sends commands to a reused serial', async t => {
  const commands = [];
  const { recorder, children } = fixture(t, async (...args) => { commands.push(args); return { code: 0 }; });
  recorder.start('emulator-5602', 'chat-a');
  recorder.start('emulator-5604', 'chat-b');
  recorder.discardThread('chat-a');
  assert.equal(recorder.isRecording('emulator-5602'), false);
  assert.equal(recorder.isRecording('emulator-5604'), true);
  assert.equal(children[0].killed, true);
  assert.equal(children[1].killed, undefined);
  assert.deepEqual(commands, []);
  recorder.start('emulator-5602', 'chat-c');
  assert.equal(recorder.isRecording('emulator-5602'), true);
});

test('a failed recorder launch is handled and permits a new recording', async t => {
  const { recorder, children } = fixture(t, async () => ({ code: 0 }));
  recorder.start('emulator-5602', 'chat-a');
  children[0].emit('error', new Error('spawn failed'));
  await assert.rejects(recorder.stop('emulator-5602', 'Pixel'), /Could not start screen recording/);
  assert.equal(recorder.isRecording('emulator-5602'), false);
  recorder.start('emulator-5602', 'chat-a');
});

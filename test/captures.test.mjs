import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Captures } from '../runtime/core/lib/captures.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function storage(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-captures-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, captures: new Captures(root, options) };
}

test('captures persist across helpers, remain scoped to their chat, and reject path traversal and symlinks', async t => {
  const { root, captures } = storage(t);
  const capture = captures.create('chat-a', { png, serial: 'emulator-5602' });
  const reopened = new Captures(root);
  assert.equal(reopened.list('chat-a')[0].id, capture.id);
  captures.selection('chat-a', [capture.id]);
  assert.deepEqual(reopened.selection('chat-a'), [capture.id]);
  assert.deepEqual(reopened.selection('chat-b'), []);
  assert.throws(() => reopened.selection('chat-b', [capture.id]), /another chat/);
  reopened.selection('chat-a', []);
  assert.deepEqual(captures.selection('chat-a'), []);
  assert.deepEqual(reopened.list('chat-b'), []);
  assert.throws(() => reopened.get('chat-b', capture.id), /another chat/);
  assert.throws(() => reopened.get('chat-a', '../../token'), /Choose a capture/);
  assert.throws(() => reopened.get('manager', capture.id), /chat that owns/);
  const context = await reopened.context('chat-a', capture.id);
  assert.equal(context.images[0].data, png.toString('base64'));
  assert.match(context.text, /emulator-5602/);
  const other = captures.create('chat-b', { png, serial: 'emulator-5698' });
  fs.unlinkSync(capture.file);
  fs.symlinkSync(other.file, capture.file);
  assert.throws(() => reopened.get('chat-a', capture.id), /unavailable/);
});

test('video context uses the actual duration, four bounded samples, and retains the saved recording on failure', async t => {
  const calls = [];
  let fail = false;
  const { root, captures } = storage(t, {
    findExecutable: name => name,
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'ffprobe') return { code: 0, stdout: '{"format":{"duration":"9.15"}}' };
      return { code: fail ? 1 : 0, stdout: fail ? Buffer.alloc(0) : png };
    },
  });
  const original = path.join(root, 'original.mp4');
  fs.writeFileSync(original, 'video fixture');
  const capture = captures.create('chat-a', { recording: { file: original, seconds: 12 }, serial: 'emulator-5602' });
  const [first, second] = await Promise.all([captures.context('chat-a', capture.id), captures.context('chat-a', capture.id)]);
  assert.equal(calls.length, 5, 'concurrent requests share one extraction');
  assert.deepEqual(first.images.map(image => image.seconds), [0, 3, 6, 9]);
  assert.equal(second.images.length, 4);
  assert.equal(first.resource.mimeType, 'video/mp4');
  assert.match(first.resource.uri, /^file:\/\//);
  assert.match(first.text, /samples, not the full video/);
  assert.ok(calls.every(call => call.options.timeoutMs === 5000));
  assert.ok(calls.slice(1).every(call => call.options.maxBytes === 2 * 1024 * 1024));
  fail = true;
  await assert.rejects(captures.context('chat-a', capture.id), /Could not prepare video frames/);
  assert.equal(fs.readFileSync(capture.file, 'utf8'), 'video fixture');
  assert.equal(captures.preparing.size, 0);
});

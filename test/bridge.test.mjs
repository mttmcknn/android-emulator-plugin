import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeViewer } from '../runtime/core/lib/bridge.mjs';

test('a bridge poll waits for the next message, then returns everything queued in order with binary as base64', async () => {
  const viewer = new BridgeViewer();
  const started = Date.now();
  const poll = viewer.drain(5_000);
  setTimeout(() => {
    viewer.sendBinary([Buffer.from([1, 2]), Buffer.from([3])]);
    viewer.sendJson({ t: 'status' });
  }, 20);
  assert.deepEqual(await poll, [{ b: Buffer.from([1, 2, 3]).toString('base64') }, { j: { t: 'status' } }]);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(viewer.bufferedAmount, 0);
});

test('a bridge poll times out empty, and closing ends a held poll and drops later messages', async () => {
  const viewer = new BridgeViewer();
  assert.deepEqual(await viewer.drain(10), []);
  const held = viewer.drain(5_000);
  viewer.close();
  assert.deepEqual(await held, []);
  viewer.sendJson({ t: 'late' });
  assert.equal(viewer.bufferedAmount, 0);
});

test('a slow viewer discards stale video, preserves action replies, and resumes only at a keyframe', async () => {
  const viewer = new BridgeViewer();
  let requests = 0;
  viewer.on('keyframe', () => requests++);
  viewer.sendBinary(Buffer.from([1, 0, 1]));
  viewer.sendBinary(Buffer.from([2, 0, 2]));
  viewer.sendJson({ t: 'result', id: 7, ok: true });
  viewer.sendBinary(Buffer.from([3, 1, 1]));
  for (let i = 0; i < 200; i++) viewer.sendBinary(Buffer.from([3, 0, i]));
  assert.equal(requests, 0, 'an abandoned viewer must not reset active viewers');
  assert.ok(viewer.bufferedAmount < 1024);
  const beforeRecovery = await viewer.drain(0);
  assert.equal(requests, 1, 'request recovery when the viewer resumes polling');
  await viewer.drain(0);
  assert.equal(requests, 1, 'only one outstanding recovery request');
  viewer.sendBinary(Buffer.from([3, 1, 42]));
  viewer.sendBinary(Buffer.from([3, 0, 43]));
  const messages = [...beforeRecovery, ...await viewer.drain(0)];
  assert.deepEqual(messages.filter((item) => item.j).map((item) => item.j), [{ t: 'result', id: 7, ok: true }]);
  assert.deepEqual(messages.filter((item) => item.b).map((item) => [...Buffer.from(item.b, 'base64')]), [[1, 0, 1], [2, 0, 2], [3, 1, 42], [3, 0, 43]]);
});

test('a new keyframe replaces queued video and close releases queued payloads', async () => {
  const viewer = new BridgeViewer();
  viewer.sendBinary(Buffer.from([3, 1, 1]));
  viewer.sendBinary(Buffer.from([3, 0, 2]));
  viewer.sendBinary(Buffer.from([3, 1, 3]));
  assert.deepEqual((await viewer.drain(0)).map((item) => [...Buffer.from(item.b, 'base64')]), [[3, 1, 3]]);
  viewer.sendBinary(Buffer.alloc(1024));
  viewer.close();
  assert.equal(viewer.bufferedAmount, 0);
});

test('one large keyframe does not force an endless resync before its following frame', async () => {
  const viewer = new BridgeViewer();
  const keyframe = Buffer.alloc(600 * 1024);
  keyframe[0] = 3;
  keyframe[1] = 1;
  viewer.sendBinary(keyframe);
  viewer.sendBinary(Buffer.from([3, 0, 42]));
  const messages = await viewer.drain(0);
  assert.equal(messages.length, 2);
  assert.equal(viewer.needsKeyFrame, false);
});


test('new session discards old video and waits for its keyframe without resetting the encoder', async () => {
  const viewer = new BridgeViewer();
  let resets = 0;
  viewer.on('keyframe', () => resets++);
  viewer.sendBinary(Buffer.from([3, 1, 10]));
  viewer.sendBinary(Buffer.from([3, 0, 11]));
  viewer.sendBinary(Buffer.from([1, 1]));
  viewer.sendBinary(Buffer.from([2, 2]));
  const setup = await viewer.drain(0);
  assert.equal(resets, 0);
  assert.deepEqual(setup.map((item) => Buffer.from(item.b, 'base64')[0]), [1, 2]);
  viewer.sendBinary(Buffer.from([3, 0, 12]));
  viewer.sendBinary(Buffer.from([3, 1, 13]));
  assert.equal((await viewer.drain(0)).length, 1);
});

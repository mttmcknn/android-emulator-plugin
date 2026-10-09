import assert from 'node:assert/strict';
import test from 'node:test';
import * as control from '../runtime/core/lib/control.mjs';
import { VideoStreamParser } from '../runtime/core/lib/mirror.mjs';
import { encodeFrame, FrameParser, acceptKey } from '../runtime/core/lib/websocket.mjs';

test('touch event matches the scrcpy v5.0.1 32-byte layout', () => {
  const buf = control.touch({ action: control.MotionAction.DOWN, x: 100, y: 200, width: 1080, height: 2400 });
  assert.equal(buf.length, 32);
  assert.equal(buf[0], control.Type.INJECT_TOUCH_EVENT);
  assert.equal(buf[1], 0);
  assert.equal(buf.readBigUInt64BE(2), 0xfffffffffffffffen);
  assert.deepEqual([buf.readInt32BE(10), buf.readInt32BE(14), buf.readUInt16BE(18), buf.readUInt16BE(20)], [100, 200, 1080, 2400]);
  assert.equal(buf.readUInt16BE(22), 0xffff);
  const up = control.touch({ action: control.MotionAction.UP, x: 1, y: 1, width: 2, height: 2 });
  assert.equal(up.readUInt16BE(22), 0);
});

test('scroll, key, text, and clipboard messages use the v5.0.1 sizes', () => {
  const scroll = control.scroll({ x: 5, y: 6, width: 10, height: 20, vscroll: 16, hscroll: -32 });
  assert.equal(scroll.length, 21);
  assert.equal(scroll.readInt16BE(13), -0x8000);
  assert.equal(scroll.readInt16BE(15), 0x7fff);

  const key = control.keycode({ action: control.KeyAction.UP, keycode: 4, metaState: 0x1000 });
  assert.deepEqual([key.length, key[1], key.readInt32BE(2), key.readInt32BE(10)], [14, 1, 4, 0x1000]);

  const text = control.text('héllo');
  assert.equal(text.readUInt32BE(1), Buffer.byteLength('héllo'));

  const clip = control.setClipboard({ value: 'hi', paste: true });
  assert.deepEqual([clip[0], clip[9], clip.readUInt32BE(10), clip.subarray(14).toString()], [9, 1, 2, 'hi']);
});

test('text chunks stay within 300 bytes without splitting UTF-8 characters', () => {
  const chunks = control.textChunks('é'.repeat(400));
  assert.equal(chunks.join(''), 'é'.repeat(400));
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 300));
});

test('video parser handles codec, session, config, and frames split across chunks', () => {
  const sessions = [];
  const packets = [];
  const parser = new VideoStreamParser({ onSession: (s) => sessions.push(s), onPacket: (p) => packets.push(p) });
  const codec = Buffer.from('h264');
  const session = Buffer.alloc(12);
  session.writeUInt32BE(0x80000000, 0);
  session.writeUInt32BE(1080, 4);
  session.writeUInt32BE(2400, 8);
  const header = (flags, length) => {
    const h = Buffer.alloc(12);
    h.writeBigUInt64BE(flags, 0);
    h.writeUInt32BE(length, 8);
    return h;
  };
  const stream = Buffer.concat([
    codec,
    session,
    header(1n << 62n, 3),
    Buffer.from([7, 7, 7]),
    header((1n << 61n) | 1234n, 2),
    Buffer.from([5, 5]),
  ]);
  for (let i = 0; i < stream.length; i += 5) parser.push(stream.subarray(i, i + 5));
  assert.deepEqual(sessions, [{ width: 1080, height: 2400 }]);
  assert.deepEqual(packets.map(({ config, key, pts, data }) => [config, key, pts, [...data]]), [
    [true, false, 0n, [7, 7, 7]],
    [false, true, 1234n, [5, 5]],
  ]);
});

test('websocket accepts masked client frames and encodes large server frames', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const payload = Buffer.from('{"t":"touch"}');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]));
  const frames = [];
  const parser = new FrameParser((frame) => frames.push(frame));
  const wire = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
  parser.push(wire.subarray(0, 3));
  parser.push(wire.subarray(3));
  assert.equal(frames[0].payload.toString(), payload.toString());

  const [largeHeader] = encodeFrame(Buffer.alloc(70_000), 0x2);
  assert.deepEqual([largeHeader[0], largeHeader[1], Number(largeHeader.readBigUInt64BE(2))], [0x82, 127, 70_000]);
});

test('control replies acknowledge the right sequence across fragmented and coalesced messages', async () => {
  const { ControlStreamParser } = await import('../runtime/core/lib/mirror.mjs');
  const acknowledged = [];
  const parser = new ControlStreamParser((sequence) => acknowledged.push(sequence));
  const ack = Buffer.alloc(9);
  ack[0] = 1;
  ack.writeBigUInt64BE(42n, 1);
  const wire = Buffer.concat([Buffer.from([0, 0, 0, 0, 2, 97, 98]), ack, Buffer.from([2, 0, 1, 0, 1, 88]), ack]);
  for (let i = 0; i < wire.length; i += 3) parser.push(wire.subarray(i, i + 3));
  assert.deepEqual(acknowledged, [42n, 42n]);
  assert.throws(() => new ControlStreamParser(() => {}).push(Buffer.from([0, 0, 16, 0, 0])), /Oversized/);
});

test('mirror coalesces encoder resets and rejects unacknowledged input on disconnect', async () => {
  const { Mirror } = await import('../runtime/core/lib/mirror.mjs');
  const sent = [];
  const mirror = new Mirror({ serial: 'test', log: () => {} });
  mirror.controlSocket = { destroyed: false, write: (message) => sent.push(message), destroy() {} };
  mirror.requestKeyFrame();
  assert.equal(sent.length, 0);
  mirror.session = { width: 100, height: 200 };
  mirror.requestKeyFrame();
  mirror.requestKeyFrame();
  assert.equal(sent.length, 1);
  const pending = mirror.setClipboard('🙂');
  assert.equal(sent.at(-1).subarray(14).toString(), '🙂');
  mirror.stop();
  await assert.rejects(pending, /Inspect before retrying/);
  assert.equal(mirror.clipboardPending.size, 0);
});


test('display connection times out when a server accepts TCP but never sends its handshake', async () => {
  const { connectWithRetry } = await import('../runtime/core/lib/mirror.mjs');
  const net = await import('node:net');
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const started = Date.now();
    await assert.rejects(connectWithRetry(server.address().port, { expectDummyByte: true, deadline: started + 100 }), /Timed out connecting/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

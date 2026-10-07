// Encoders for the scrcpy v5.0 control protocol.
// Source of truth: app/src/control_msg.c at tag v5.0.

export const SCRCPY_VERSION = '5.0';

export const Type = Object.freeze({
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  SET_CLIPBOARD: 9,
  RESET_VIDEO: 17,
});

export const MotionAction = Object.freeze({ DOWN: 0, UP: 1, MOVE: 2 });
export const KeyAction = Object.freeze({ DOWN: 0, UP: 1 });
export const POINTER_ID_GENERIC_FINGER = 0xfffffffffffffffen;

const INJECT_TEXT_MAX_BYTES = 300;

function u16fp(value) {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped === 1 ? 0xffff : Math.floor(clamped * 0x10000);
}

function i16fp(value) {
  const clamped = Math.min(1, Math.max(-1, value));
  return clamped === 1 ? 0x7fff : Math.trunc(clamped * 0x8000);
}

function writePosition(buf, offset, { x, y, width, height }) {
  buf.writeInt32BE(Math.round(x), offset);
  buf.writeInt32BE(Math.round(y), offset + 4);
  buf.writeUInt16BE(width, offset + 8);
  buf.writeUInt16BE(height, offset + 10);
}

function truncatedUtf8(bytes, maxBytes) {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

export function touch({ action, x, y, width, height, pressure = action === MotionAction.UP ? 0 : 1 }) {
  const buf = Buffer.alloc(32);
  buf.writeUInt8(Type.INJECT_TOUCH_EVENT, 0);
  buf.writeUInt8(action, 1);
  buf.writeBigUInt64BE(POINTER_ID_GENERIC_FINGER, 2);
  writePosition(buf, 10, { x, y, width, height });
  buf.writeUInt16BE(u16fp(pressure), 22);
  buf.writeUInt32BE(0, 24);
  buf.writeUInt32BE(0, 28);
  return buf;
}

// Scroll amounts use scrcpy's client range [-16, 16]; one mouse-wheel notch is about 1.
export function scroll({ x, y, width, height, hscroll = 0, vscroll = 0 }) {
  const buf = Buffer.alloc(21);
  buf.writeUInt8(Type.INJECT_SCROLL_EVENT, 0);
  writePosition(buf, 1, { x, y, width, height });
  buf.writeInt16BE(i16fp(hscroll / 16), 13);
  buf.writeInt16BE(i16fp(vscroll / 16), 15);
  buf.writeUInt32BE(0, 17);
  return buf;
}

export function keycode({ action, keycode: code, repeat = 0, metaState = 0 }) {
  const buf = Buffer.alloc(14);
  buf.writeUInt8(Type.INJECT_KEYCODE, 0);
  buf.writeUInt8(action, 1);
  buf.writeInt32BE(code, 2);
  buf.writeInt32BE(repeat, 6);
  buf.writeInt32BE(metaState, 10);
  return buf;
}

export function text(value) {
  const payload = truncatedUtf8(Buffer.from(value, 'utf8'), INJECT_TEXT_MAX_BYTES);
  const buf = Buffer.alloc(5 + payload.length);
  buf.writeUInt8(Type.INJECT_TEXT, 0);
  buf.writeUInt32BE(payload.length, 1);
  payload.copy(buf, 5);
  return buf;
}

export function setClipboard({ sequence = 0n, value, paste }) {
  const payload = Buffer.from(value, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeUInt8(Type.SET_CLIPBOARD, 0);
  buf.writeBigUInt64BE(BigInt(sequence), 1);
  buf.writeUInt8(paste ? 1 : 0, 9);
  buf.writeUInt32BE(payload.length, 10);
  payload.copy(buf, 14);
  return buf;
}

export function resetVideo() {
  return Buffer.from([Type.RESET_VIDEO]);
}

// Splits text into protocol-sized chunks without breaking UTF-8 sequences.
export function textChunks(value) {
  const chunks = [];
  let rest = Buffer.from(value, 'utf8');
  while (rest.length > 0) {
    const chunk = truncatedUtf8(rest, INJECT_TEXT_MAX_BYTES);
    chunks.push(chunk.toString('utf8'));
    rest = rest.subarray(chunk.length);
  }
  return chunks;
}

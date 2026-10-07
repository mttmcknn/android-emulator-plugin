// Minimal RFC 6455 server used for the local emulator pane.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 1 << 20;

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

export function encodeFrame(payload, opcode) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return [header, payload];
}

export class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const bigLength = this.buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(MAX_MESSAGE_BYTES)) throw new Error('WebSocket frame is too large');
        length = Number(bigLength);
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) throw new Error('WebSocket frame is too large');
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      this.buffer = this.buffer.subarray(offset + length);
      this.onFrame({ fin, opcode, payload });
    }
  }
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.parser = new FrameParser((frame) => this.handleFrame(frame));
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      try {
        this.parser.push(chunk);
      } catch (error) {
        this.close(1009, error.message);
      }
    });
    socket.on('close', () => this.markClosed());
    socket.on('error', () => this.markClosed());
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.write(payload, 0xa);
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    } else if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      this.close(1003, 'Unsupported opcode');
      return;
    }
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    this.emit('message', this.fragmentOpcode === 0x1 ? message.toString('utf8') : message, this.fragmentOpcode === 0x2);
  }

  write(payload, opcode) {
    if (this.closed) return;
    const [header, body] = encodeFrame(payload, opcode);
    this.socket.cork();
    this.socket.write(header);
    this.socket.write(body);
    this.socket.uncork();
  }

  sendJson(value) {
    this.write(Buffer.from(JSON.stringify(value)), 0x1);
  }

  sendBinary(buffers) {
    const payload = Array.isArray(buffers) ? Buffer.concat(buffers) : buffers;
    this.write(payload, 0x2);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.write(body, 0x8);
    this.socket.end();
    this.markClosed();
  }

  markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

export function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WebSocketConnection(socket);
}

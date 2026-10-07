// Streams H.264 video from a device and forwards input through the scrcpy server.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as control from './control.mjs';
import { adb, adbOk, sdk } from './sdk.mjs';

const SERVER_JAR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', `scrcpy-server-v${control.SCRCPY_VERSION}`);
const DEVICE_JAR = '/data/local/tmp/android-emulator-scrcpy.jar';
const CODEC_H264 = 0x68323634;
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = FLAG_KEY_FRAME - 1n;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Incrementally parses scrcpy's video socket: codec id, then 12-byte packet headers.
export class VideoStreamParser {
  constructor({ onSession, onPacket }) {
    this.onSession = onSession;
    this.onPacket = onPacket;
    this.buffer = Buffer.alloc(0);
    this.codecRead = false;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (!this.codecRead) {
      if (this.buffer.length < 4) return;
      const codec = this.buffer.readUInt32BE(0);
      if (codec !== CODEC_H264) throw new Error(`Unexpected video codec 0x${codec.toString(16)}`);
      this.codecRead = true;
      this.buffer = this.buffer.subarray(4);
    }
    while (this.buffer.length >= 12) {
      if (this.buffer[0] & 0x80) {
        this.onSession({ width: this.buffer.readUInt32BE(4), height: this.buffer.readUInt32BE(8) });
        this.buffer = this.buffer.subarray(12);
        continue;
      }
      const length = this.buffer.readUInt32BE(8);
      if (this.buffer.length < 12 + length) return;
      const ptsFlags = this.buffer.readBigUInt64BE(0);
      const data = Buffer.from(this.buffer.subarray(12, 12 + length));
      this.buffer = this.buffer.subarray(12 + length);
      this.onPacket({
        config: (ptsFlags & FLAG_CONFIG) !== 0n,
        key: (ptsFlags & FLAG_KEY_FRAME) !== 0n,
        pts: ptsFlags & PTS_MASK,
        data,
      });
    }
  }
}

// The control socket can split or combine clipboard acknowledgements with other device messages.
export class ControlStreamParser {
  constructor(onAck) {
    this.onAck = onAck;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const type = this.buffer[0];
      const header = type === 1 ? 9 : 5;
      if (![0, 1, 2].includes(type)) throw new Error(`Unknown scrcpy device message ${type}.`);
      if (this.buffer.length < header) return;
      const size = type === 1 ? 9 : 5 + (type === 0 ? this.buffer.readUInt32BE(1) : this.buffer.readUInt16BE(3));
      if (size > 262144) throw new Error('Oversized scrcpy device message.');
      if (this.buffer.length < size) return;
      if (type === 1) this.onAck(this.buffer.readBigUInt64BE(1));
      this.buffer = this.buffer.subarray(size);
    }
  }
}

export async function connectWithRetry(port, { expectDummyByte, deadline }) {
  while (Date.now() < deadline) {
    const connection = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      const timer = setTimeout(() => finish(null), Math.min(1000, Math.max(1, deadline - Date.now())));
      const finish = (result) => {
        clearTimeout(timer);
        socket.removeListener('connect', connected);
        socket.removeListener('data', data);
        socket.removeListener('error', failed);
        socket.removeListener('close', failed);
        if (!result) socket.destroy();
        resolve(result);
      };
      const connected = () => { if (!expectDummyByte) finish({ socket, rest: Buffer.alloc(0) }); };
      const data = (first) => {
        socket.pause();
        finish({ socket, rest: first.subarray(1) });
      };
      const failed = () => finish(null);
      socket.once('connect', connected);
      if (expectDummyByte) socket.once('data', data);
      socket.once('error', failed);
      socket.once('close', failed);
    });
    if (connection) return connection;
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error('Timed out connecting to the on-device display server. Reconnect the display to try again.');
}

export class Mirror extends EventEmitter {
  constructor({ serial, log, video = true, maxSize = 1920, bitRate = 12_000_000, maxFps = 60 }) {
    super();
    this.serial = serial;
    this.log = log;
    this.options = { video, maxSize, bitRate, maxFps };
    this.session = null;
    this.config = null;
    this.stopped = false;
    this.clipboardSequence = 0n;
    this.clipboardPending = new Map();
    this.keyframeRequestedAt = 0;
  }

  async start() {
    try {
      await this.startConnection();
    } catch (error) {
      this.stop(); // Includes resources created while a previous stop was waiting on startup.
      throw error;
    }
  }

  assertRunning() {
    if (this.stopped) throw new Error('The device connection closed during startup.');
  }

  async startConnection() {
    this.assertRunning();
    const scid = crypto.randomInt(0, 0x7fffffff).toString(16).padStart(8, '0');
    this.localPort = await freePort();
    this.assertRunning();
    await adbOk(this.serial, ['push', SERVER_JAR, DEVICE_JAR], { timeoutMs: 30_000 });
    this.assertRunning();
    await adbOk(this.serial, ['forward', `tcp:${this.localPort}`, `localabstract:scrcpy_${scid}`]);
    this.assertRunning();

    const serverArgs = [
      control.SCRCPY_VERSION,
      `scid=${scid}`,
      'log_level=warn',
      'tunnel_forward=true',
      'audio=false',
      `video=${this.options.video}`,
      'control=true',
      'video_codec=h264',
      `max_size=${this.options.maxSize}`,
      `video_bit_rate=${this.options.bitRate}`,
      `max_fps=${this.options.maxFps}`,
      'send_device_meta=false',
      'clipboard_autosync=false',
      'cleanup=true',
      'power_on=true',
    ];
    this.process = spawn(
      sdk().adb,
      ['-s', this.serial, 'shell', `CLASSPATH=${DEVICE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', ...serverArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const serverOutput = (chunk) => this.log(`[scrcpy ${this.serial}] ${chunk.toString().trim()}`);
    this.process.stdout.on('data', serverOutput);
    this.process.stderr.on('data', serverOutput);
    this.process.on('exit', (code) => this.handleEnd(`scrcpy server exited with code ${code}`));

    const deadline = Date.now() + 15_000;
    let video;
    if (this.options.video) {
      video = await connectWithRetry(this.localPort, { expectDummyByte: true, deadline });
      this.videoSocket = video.socket;
      this.assertRunning();
    }
    // scrcpy sends its probe byte on the first enabled socket, including control-only sessions.
    const controlConnection = await connectWithRetry(this.localPort, { expectDummyByte: !this.options.video, deadline });
    this.controlSocket = controlConnection.socket;
    this.assertRunning();
    this.controlSocket.setNoDelay(true);
    const controlParser = new ControlStreamParser((sequence) => {
      const pending = this.clipboardPending.get(sequence);
      if (!pending) return;
      this.clipboardPending.delete(sequence);
      clearTimeout(pending.timer);
      pending.resolve();
    });
    this.controlSocket.on('data', (chunk) => {
      try { controlParser.push(chunk); } catch (error) { this.handleEnd(error.message); }
    });
    this.controlSocket.on('close', () => this.handleEnd('control socket closed'));
    this.controlSocket.on('error', () => {});
    if (controlConnection.rest.length) controlParser.push(controlConnection.rest);
    this.controlSocket.resume();
    if (!this.options.video) {
      this.log(`input connection started for ${this.serial} (video disabled)`);
      return;
    }

    const parser = new VideoStreamParser({
      onSession: (session) => {
        this.config = null;
        this.session = session;
        this.emit('session', session);
      },
      onPacket: (packet) => {
        if (packet.config) this.config = packet.data;
        if (packet.key) this.keyframeRequestedAt = 0;
        this.emit('packet', packet);
      },
    });
    const feed = (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        this.handleEnd(error.message);
      }
    };
    this.videoSocket.on('data', feed);
    this.videoSocket.on('close', () => this.handleEnd('video socket closed'));
    this.videoSocket.on('error', () => {});
    if (video.rest.length) feed(video.rest);
    this.videoSocket.resume();
    this.log(`mirror started for ${this.serial} on tcp:${this.localPort}`);
  }

  send(buffer) {
    if (this.controlSocket && !this.controlSocket.destroyed) this.controlSocket.write(buffer);
  }

  // Semantic input keeps scrcpy wire encoding inside this implementation.
  touch(options) { this.send(control.touch(options)); }
  scroll(options) { this.send(control.scroll(options)); }
  typeText(value) { for (const chunk of control.textChunks(value)) this.send(control.text(chunk)); }
  pasteText(value) { this.send(control.setClipboard({ value, paste: true })); }

  pressKey(keycode, metaState = 0) {
    if (!this.controlSocket || this.controlSocket.destroyed) throw new Error('Device input connection is closed.');
    this.send(control.keycode({ action: control.KeyAction.DOWN, keycode, metaState }));
    this.send(control.keycode({ action: control.KeyAction.UP, keycode, metaState }));
  }

  // An ACK confirms processing, not that Android has rendered the pasted text.
  setClipboard(value, { paste = true, timeoutMs = 3000 } = {}) {
    if (!this.controlSocket || this.controlSocket.destroyed) return Promise.reject(new Error('Device input connection is closed.'));
    if (Buffer.byteLength(value, 'utf8') > 262144 - 14) return Promise.reject(new Error('Text exceeds the clipboard protocol limit.'));
    const sequence = ++this.clipboardSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clipboardPending.delete(sequence);
        reject(new Error('Clipboard acknowledgement timed out; input may have reached the device. Inspect the field before retrying.'));
      }, timeoutMs);
      this.clipboardPending.set(sequence, { resolve, reject, timer });
      this.send(control.setClipboard({ sequence, value, paste }));
    });
  }

  requestKeyFrame(reason = 'viewer recovery') {
    // RESET_VIDEO restarts the shared encoder. Coalesce requests until recovery (or a bounded retry).
    // The server's capture is not initialized until video startup completes.
    if (!this.session || this.stopped || Date.now() - this.keyframeRequestedAt < 2000) return;
    this.keyframeRequestedAt = Date.now();
    this.log(`video reset for ${this.serial}: ${reason}`);
    this.send(control.resetVideo());
  }

  handleEnd(reason) {
    if (this.stopped) return;
    this.log(`mirror for ${this.serial} ended: ${reason}`);
    this.stop();
    this.emit('end', reason);
  }

  stop() {
    this.stopped = true;
    for (const { reject, timer } of this.clipboardPending.values()) {
      clearTimeout(timer);
      reject(new Error('Device input connection closed; input may have reached the device. Inspect before retrying.'));
    }
    this.clipboardPending.clear();
    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.process?.kill();
    this.process = null;
    if (this.localPort) adb(this.serial, ['forward', '--remove', `tcp:${this.localPort}`]).catch(() => {});
  }
}

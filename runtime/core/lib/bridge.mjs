// A pane viewer reached through MCP tool calls instead of a WebSocket. An MCP App sandbox only allows https/wss
// connections, so embedded panels long-poll `emulator_stream` through the host bridge; the helper treats them like any
// other viewer (same JSON and binary messages, same backpressure).
import { EventEmitter } from 'node:events';

export class BridgeViewer extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.bytes = 0;
    this.wake = null;
    this.polling = false;
    this.lastSeen = Date.now();
    this.closed = false;
    this.videoFrames = 0;
    this.deltaBytes = 0;
  }

  get bufferedAmount() {
    return this.bytes;
  }

  push(item, size) {
    if (this.closed) return;
    this.queue.push(item);
    this.bytes += size;
    this.wake?.();
  }

  sendJson(value) {
    this.push({ j: value }, 256);
  }

  sendBinary(buffers) {
    if (this.closed) return;
    const payload = Array.isArray(buffers) ? Buffer.concat(buffers) : buffers;
    if (payload[0] === 1 || payload[0] === 2) {
      this.discardVideo();
      // Keep only the newest setup of each kind, preserving status/action replies.
      this.queue = this.queue.filter((item) => !item.b || item.b[0] !== payload[0]);
      this.bytes = this.queue.reduce((sum, item) => sum + (item.b?.length ?? 256), 0);
      this.needsKeyFrame = true;
      this.recoveryNeeded = false;
    }
    if (payload[0] === 3) {
      const key = payload[1] === 1;
      if (key) {
        this.discardVideo();
        this.needsKeyFrame = false;
        this.recoveryNeeded = false;
        this.resyncRequested = false;
      } else if (this.needsKeyFrame) return;
      else if (this.videoFrames >= 8 || this.deltaBytes + payload.length > 512 * 1024) {
        this.recoveryReason = `${this.videoFrames} queued frames, ${this.deltaBytes} delta bytes, next ${payload.length} bytes`;
        this.discardVideo();
        this.needsKeyFrame = true;
        this.recoveryNeeded = true;
        return;
      }
      this.videoFrames++;
      if (!key) this.deltaBytes += payload.length;
    }
    this.push({ b: payload }, payload.length);
  }

  // Keep status/action replies and decoder setup; obsolete interdependent video must resume at a keyframe.
  discardVideo() {
    this.queue = this.queue.filter((item) => !item.b || item.b[0] !== 3);
    this.bytes = this.queue.reduce((sum, item) => sum + (item.b?.length ?? 256), 0);
    this.videoFrames = 0;
    this.deltaBytes = 0;
  }

  // Resolves with everything queued, waiting up to `waitMs` for the first message. Binary payloads become base64.
  async drain(waitMs) {
    this.lastSeen = Date.now();
    this.requestResync();
    if (!this.queue.length && waitMs > 0 && !this.closed) {
      this.polling = true;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
      this.polling = false;
      this.lastSeen = Date.now();
    }
    this.requestResync();
    const items = this.queue;
    this.queue = [];
    this.bytes = 0;
    this.videoFrames = 0;
    this.deltaBytes = 0;
    return items.map((item) => (item.b ? { b: item.b.toString('base64') } : item));
  }

  requestResync() {
    // A suspended/abandoned panel must not reset the encoder for panels that are still watching.
    // Ask for recovery only when this viewer actually comes back to collect frames.
    if (this.recoveryNeeded && (!this.resyncRequested || Date.now() - this.resyncRequested > 2000) && !this.closed) {
      this.resyncRequested = Date.now();
      this.emit('keyframe', this.recoveryReason);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.bytes = 0;
    this.videoFrames = 0;
    this.deltaBytes = 0;
    this.wake?.();
    this.emit('close');
  }
}

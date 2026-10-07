// Screen recording with the device's screenrecord tool, saved as MP4 in the helper's state directory.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { adb, sdk } from './sdk.mjs';

export class Recorder {
  constructor(dir, { deviceCommand = adb, spawnProcess = spawn, adbPath = () => sdk().adb } = {}) {
    this.dir = path.join(dir, 'recordings');
    fs.mkdirSync(this.dir, { recursive: true });
    this.active = new Map();
    this.deviceCommand = deviceCommand;
    this.spawnProcess = spawnProcess;
    this.adbPath = adbPath;
  }

  isRecording(serial) {
    return this.active.has(serial);
  }

  start(serial, threadId) {
    if (this.active.has(serial)) throw new Error('Already recording this emulator.');
    // screenrecord stops by itself after its 3-minute limit.
    const deviceFile = `/sdcard/android-emulator-${crypto.randomUUID()}.mp4`;
    const child = this.spawnProcess(this.adbPath(), ['-s', serial, 'shell', 'screenrecord', '--bit-rate', '8000000', deviceFile], { stdio: 'ignore' });
    const entry = { child, threadId, deviceFile, startedAt: Date.now() };
    entry.closed = new Promise(resolve => {
      child.once('error', error => { entry.error = error; resolve(); });
      child.once('close', () => { entry.endedAt = Date.now(); resolve(); });
    });
    this.active.set(serial, entry);
  }

  discardThread(threadId) {
    for (const [serial, entry] of this.active) {
      if (entry.threadId !== threadId) continue;
      this.active.delete(serial);
      entry.child.kill(); // Only the old local ADB process; the serial may be reused now.
    }
  }

  stop(serial, label) {
    const entry = this.active.get(serial);
    if (!entry) return Promise.reject(new Error('This emulator is not recording.'));
    // Retain failed pulls so Stop can retry, and share simultaneous Stop requests.
    entry.saving ??= this.save(serial, label, entry).finally(() => { entry.saving = null; });
    return entry.saving;
  }

  async save(serial, label, entry) {
    if (entry.error) {
      if (this.active.get(serial) === entry) this.active.delete(serial);
      throw new Error(`Could not start screen recording: ${entry.error.message}. Start a new recording.`);
    }
    await this.deviceCommand(serial, ['shell', 'pkill', '-INT', '-f', `[s]creenrecord.*${entry.deviceFile}`], { timeoutMs: 5_000 });
    let timer;
    try {
      await Promise.race([entry.closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Recording has not finished writing. Retry Stop to save it.')), 5_000);
      })]);
    } finally { clearTimeout(timer); }
    if (entry.error) {
      if (this.active.get(serial) === entry) this.active.delete(serial);
      throw new Error(`Screen recording failed: ${entry.error.message}. Start a new recording.`);
    }
    const name = `${label}-${path.basename(entry.deviceFile)}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const file = path.join(this.dir, name);
    const pulled = await this.deviceCommand(serial, ['pull', entry.deviceFile, file], { timeoutMs: 60_000 });
    if (pulled.code !== 0) throw new Error('Could not save the recording from Android. Retry Stop to retrieve it.');
    if (this.active.get(serial) === entry) this.active.delete(serial);
    await this.deviceCommand(serial, ['shell', 'rm', '-f', entry.deviceFile]);
    return { file, name, seconds: Math.round(((entry.endedAt ?? Date.now()) - entry.startedAt) / 1000) };
  }
}

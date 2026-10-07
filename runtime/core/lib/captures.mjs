import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './sdk.mjs';

const ID = /^[a-f0-9-]{36}$/;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const FRAME_COUNT = 4;

function executable(name) {
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* Next location. */ }
  }
  throw new Error('Video frames need FFmpeg (ffmpeg and ffprobe). Install it, then add the recording to chat again. The saved video is still available.');
}

export class Captures {
  constructor(dir, { runCommand = run, findExecutable = executable } = {}) {
    this.dir = path.join(dir, 'captures');
    this.runCommand = runCommand;
    this.findExecutable = findExecutable;
    this.preparing = new Map();
  }

  folder(threadId) {
    if (typeof threadId !== 'string' || !threadId || threadId === 'manager') throw new Error('Open captures from the chat that owns the emulator.');
    return path.join(this.dir, crypto.createHash('sha256').update(threadId).digest('hex'));
  }

  create(threadId, { png, recording, serial }) {
    const id = crypto.randomUUID();
    const folder = this.folder(threadId);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const video = Boolean(recording);
    const file = path.join(folder, `${id}.${video ? 'mp4' : 'png'}`);
    if (video) fs.renameSync(recording.file, file);
    else fs.writeFileSync(file, png, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const capture = { id, file, mimeType: video ? 'video/mp4' : 'image/png',
      name: `${video ? 'recording' : 'screenshot'}-${new Date().toISOString().replace(/[:.]/g, '-')}.${video ? 'mp4' : 'png'}`,
      serial, createdAt: new Date().toISOString(), ...(video ? { seconds: recording.seconds } : {}),
    };
    fs.writeFileSync(path.join(folder, `${id}.json`), JSON.stringify(capture), { mode: 0o600 });
    return capture;
  }

  get(threadId, id) {
    if (!ID.test(id ?? '')) throw new Error('Choose a capture from this chat.');
    const folder = this.folder(threadId);
    try {
      const capture = JSON.parse(fs.readFileSync(path.join(folder, `${id}.json`), 'utf8'));
      const extension = capture.mimeType === 'image/png' ? 'png' : capture.mimeType === 'video/mp4' ? 'mp4' : null;
      const file = path.join(folder, `${id}.${extension}`);
      if (!extension || capture.id !== id || fs.lstatSync(folder).isSymbolicLink() || !fs.lstatSync(file).isFile()) throw new Error('Invalid capture');
      return { ...capture, file };
    } catch { throw new Error('This capture is unavailable or belongs to another chat. Capture it again in this chat.'); }
  }

  list(threadId) {
    const folder = this.folder(threadId);
    let names;
    try { names = fs.readdirSync(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return names.filter(name => name.endsWith('.json')).flatMap(name => {
      try { return [this.get(threadId, name.slice(0, -5))]; } catch { return []; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  }

  selection(threadId, captureIds) {
    const folder = this.folder(threadId);
    const file = path.join(folder, 'selection.json');
    if (captureIds === undefined) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Could not restore capture context. Clear capture context before adding another.'); }
    }
    if (!Array.isArray(captureIds) || captureIds.length > 4 || new Set(captureIds).size !== captureIds.length) throw new Error('Choose at most four different captures from this chat.');
    for (const id of captureIds) this.get(threadId, id);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(captureIds), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return captureIds;
  }

  async context(threadId, id) {
    const capture = this.get(threadId, id);
    if (capture.mimeType === 'image/png') {
      if (fs.statSync(capture.file).size > MAX_IMAGE_BYTES) throw new Error('This screenshot is too large for chat context. Copy or save it instead.');
      return { capture, images: [{ data: fs.readFileSync(capture.file).toString('base64'), mimeType: 'image/png', title: capture.name }],
        text: `Screenshot from this chat's emulator ${capture.serial}, captured ${capture.createdAt}. Saved file: ${capture.file}` };
    }
    // Concurrent Copy + Add requests or repeated clicks reuse one extraction.
    const key = capture.file;
    if (!this.preparing.has(key)) this.preparing.set(key, this.videoFrames(capture).finally(() => this.preparing.delete(key)));
    const images = await this.preparing.get(key);
    return { capture, images, resource: { type: 'resource_link', uri: pathToFileURL(capture.file).href, name: capture.name, mimeType: 'video/mp4' },
      text: `Recording from this chat's emulator ${capture.serial}, captured ${capture.createdAt}. Saved video: ${capture.file}. The video is a local file reference; its bytes are not attached. The images are ${images.length} timestamped samples, not the full video. Inspect the saved MP4 for motion or events between samples.` };
  }

  async videoFrames(capture) {
    const ffmpeg = this.findExecutable('ffmpeg');
    const ffprobe = this.findExecutable('ffprobe');
    const probe = await this.runCommand(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', capture.file], { timeoutMs: 5000, maxBytes: 4096 });
    let seconds;
    try { seconds = Number(JSON.parse(probe.stdout).format.duration); } catch { /* Validated below. */ }
    if (probe.code !== 0 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 240) throw new Error('Could not read this recording’s duration. Copy or open the saved video instead.');
    const timestamps = [...new Set(Array.from({ length: FRAME_COUNT }, (_, i) => Math.round(Math.max(0, seconds - 0.15) * i / (FRAME_COUNT - 1) * 100) / 100))];
    const images = [];
    for (const timestamp of timestamps) {
      const frame = await this.runCommand(ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(timestamp), '-i', capture.file,
        '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'],
      { timeoutMs: 5000, maxBytes: 2 * 1024 * 1024, binary: true });
      if (frame.code !== 0 || frame.truncated || !frame.stdout?.length) throw new Error('Could not prepare video frames. Copy or open the saved video instead.');
      images.push({ data: frame.stdout.toString('base64'), mimeType: 'image/png', title: `${capture.name} at ${timestamp.toFixed(2)}s`, seconds: timestamp });
    }
    return images;
  }
}

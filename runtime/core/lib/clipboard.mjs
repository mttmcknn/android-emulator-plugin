import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './sdk.mjs';

const MACOS_CLIPBOARD_SCRIPT = fileURLToPath(new URL('./clipboard.jxa', import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CAPTURE_TYPES = new Map([
  ['image/png', 'image'],
  ['video/mp4', 'file'],
]);

function supportedKind(mimeType) {
  const kind = CAPTURE_TYPES.get(mimeType);
  if (!kind) throw new Error(`Unsupported capture MIME type ${JSON.stringify(mimeType)}. Only image/png and video/mp4 can be copied.`);
  return kind;
}

function validateCapture(file, mimeType) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`Capture file is unavailable: ${file}. Create the capture again and retry.`);
  }
  if (!stat.isFile()) throw new Error(`Capture path is not a file: ${file}. Create the capture again and retry.`);
  if (mimeType !== 'image/png') return;

  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(PNG_SIGNATURE.length);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== PNG_SIGNATURE.length || !header.equals(PNG_SIGNATURE)) {
      throw new Error(`Capture is not a PNG image: ${file}. Create the screenshot again and retry.`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function commandFailure(result) {
  const detail = String(result.stderr || result.stdout || '').trim().replaceAll(/\s+/g, ' ').slice(0, 500);
  const reason = result.timedOut ? 'timed out' : `exited ${result.code}`;
  return new Error(`macOS clipboard copy ${reason}${detail ? `: ${detail}` : ''}. Verify pasteboard services are available and retry.`);
}

/**
 * Copies an owned screenshot or recording to the host clipboard.
 *
 * PNG captures become real image data. MP4 captures become native file URLs so
 * compatible apps receive a pasteable file rather than a path string.
 */
export async function copyCaptureToClipboard(file, mimeType, {
  platform = process.platform,
  runCommand = run,
} = {}) {
  const kind = supportedKind(mimeType);
  validateCapture(file, mimeType);

  if (platform !== 'darwin') {
    throw new Error(`Clipboard capture export is supported on macOS only; ${platform} cannot copy ${mimeType} without a compatible clipboard helper.`);
  }

  let result;
  try {
    result = await runCommand('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      MACOS_CLIPBOARD_SCRIPT,
      file,
      mimeType,
    ], { timeoutMs: 5_000, maxBytes: 4_096 });
  } catch (error) {
    throw new Error(`Unable to start macOS clipboard copy. Verify /usr/bin/osascript is available and retry. (${error.message})`);
  }
  if (result.code !== 0 || result.timedOut) throw commandFailure(result);
  return { kind };
}

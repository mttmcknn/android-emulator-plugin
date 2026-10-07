import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../lib/sdk.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const PROBE_MAX_BYTES = 4 * 1024;

// Normalize Android CLI's full hierarchy to the device inspection contract.
// Use the full tree so editable fields and clickable containers are retained.
export function parseAndroidLayout(output) {
  const layout = JSON.parse(output);
  if (!layout || typeof layout !== 'object') throw new Error('Android CLI returned an unsupported layout.');
  const nodes = [];
  const visit = item => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== 'object' || item.hidden || item['off-screen']) return;
    const bounds = item.bounds?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)?.slice(1).map(Number);
    if (item.class && bounds && bounds[2] > bounds[0] && bounds[3] > bounds[1]) {
      const flags = new Set([...(item.interactions ?? []), ...(item.state ?? [])].map(value => value.toLowerCase().replaceAll('_', '-')));
      const flag = name => item[name] === true || flags.has(name);
      const node = {
        text: item.text ?? '', description: item['content-desc'] ?? '', resourceId: item['resource-id'] ?? '',
        className: item.class.split('.').pop(), bounds,
        center: [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)],
        clickable: flag('clickable') || flag('long-clickable'), scrollable: flag('scrollable'),
        checkable: flag('checkable'), checked: flag('checked'), focused: flag('focused'), selected: flag('selected'),
        enabled: item.enabled !== false && !flag('disabled'), password: flag('password'),
        editable: item.class.includes('EditText') || flag('editable'),
      };
      if (node.text || node.description || node.clickable || node.scrollable || node.checkable || node.editable) nodes.push({ index: nodes.length, ...node });
    }
    for (const child of item.children ?? []) visit(child);
    if (item.content) visit(item.content);
  };
  visit(layout);
  return nodes;
}

function unavailableReason(error) {
  if (error?.code === 'ENOENT') return 'Android CLI was not found. Install it or set ANDROID_EMULATOR_ANDROID_CLI.';
  return 'Android CLI could not be checked.';
}

function captureFailure(result) {
  if (result?.timedOut) return 'Android CLI screenshot capture timed out.';
  if (result?.truncated) return 'Android CLI screenshot capture exceeded its output limit.';
  return 'Android CLI could not capture a screenshot.';
}

function version(output) {
  return String(output ?? '').match(/^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9]+)?$/m)?.[0];
}

/**
 * Captures a selected Android device through the external Android CLI.
 * The CLI writes the image into a private temporary directory so no device
 * output or temporary path is exposed to callers.
 */
export function createAndroidCliCapture({
  executable = process.env.ANDROID_EMULATOR_ANDROID_CLI ?? 'android',
  runCommand = run,
} = {}) {
  return {
    id: 'android-cli',
    label: 'Android CLI PNG capture (experimental)',
    version: 'external',
    async probe() {
      try {
        const result = await runCommand(executable, ['--version'], {
          timeoutMs: PROBE_TIMEOUT_MS,
          maxBytes: PROBE_MAX_BYTES,
        });
        if (result?.code !== 0 || result?.timedOut || result?.truncated) {
          return { available: false, reason: result?.timedOut ? 'Android CLI probe timed out.' : 'Android CLI could not be checked.' };
        }
        const detectedVersion = version(result.stdout);
        return { available: true, ...(detectedVersion ? { version: detectedVersion } : {}) };
      } catch (error) {
        return { available: false, reason: unavailableReason(error) };
      }
    },
    async capture(serial) {
      if (typeof serial !== 'string' || !serial.trim()) {
        throw new Error('Android CLI screenshot capture requires an explicit device serial.');
      }

      let directory;
      try {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-cli-capture-'));
      } catch {
        throw new Error('Could not create private temporary storage for Android CLI screenshot capture.');
      }
      const output = path.join(directory, 'screen.png');

      try {
        let result;
        try {
          result = await runCommand(executable, [
            'screen',
            'capture',
            `--device=${serial}`,
            `--output=${output}`,
          ], {
            timeoutMs: CAPTURE_TIMEOUT_MS,
            maxBytes: PROBE_MAX_BYTES,
          });
        } catch (error) {
          throw new Error(error?.code === 'ENOENT'
            ? 'Android CLI was not found. Install it or set ANDROID_EMULATOR_ANDROID_CLI.'
            : 'Android CLI could not capture a screenshot.');
        }
        if (result?.code !== 0 || result?.timedOut || result?.truncated) throw new Error(captureFailure(result));

        let image;
        try {
          const stat = await fs.stat(output);
          if (!stat.isFile() || stat.size > MAX_PNG_BYTES) throw new Error('invalid output');
          image = await fs.readFile(output);
        } catch {
          throw new Error('Android CLI did not create a readable PNG screenshot.');
        }
        if (image.length > MAX_PNG_BYTES || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          throw new Error('Android CLI returned an invalid PNG. Multi-display devices can include warnings in the image file. Select the adb capture backend or test a newer CLI.');
        }
        return image;
      } finally {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

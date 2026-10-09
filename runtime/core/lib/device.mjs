import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { adb, adbOk, run, sdk, shellQuote } from './sdk.mjs';

const UI_WAIT_DEFAULT_TIMEOUT_MS = 10_000;
const UI_WAIT_MAX_TIMEOUT_MS = 30_000;
const UI_WAIT_POLL_MS = 250;
const LONG_PRESS_MAX_DURATION_MS = 10_000;
const SCROLL_TO_DEFAULT_MAX_SWIPES = 5;
const SCROLL_TO_MAX_SWIPES = 10;
const SCROLL_TO_DEFAULT_DURATION_MS = 300;
const QUALIFIED_ANDROID_NAME = /^(?:[A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*$/;

export const KEYCODES = Object.freeze({
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  VOLUME_MUTE: 164,
  APP_SWITCH: 187,
  SLEEP: 223,
  WAKEUP: 224,
  CUT: 277,
  COPY: 278,
  PASTE: 279,
});

const KEY_ALIASES = { RECENTS: 'APP_SWITCH', OVERVIEW: 'APP_SWITCH', BACKSPACE: 'DEL', DELETE: 'FORWARD_DEL', RETURN: 'ENTER' };

export function resolveKeycode(key) {
  if (Number.isInteger(key)) return key;
  const name = String(key).trim().toUpperCase().replace(/^KEYCODE_/, '');
  if (/^\d+$/.test(name)) return Number(name);
  const code = KEYCODES[KEY_ALIASES[name] ?? name];
  if (code === undefined) throw new Error(`Unknown key "${key}". Use one of: ${Object.keys(KEYCODES).join(', ')}, or a numeric Android keycode.`);
  return code;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value) {
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[entity] ?? match;
  });
}

export function parseUiHierarchy(xml) {
  const nodes = [];
  for (const [, attributes] of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[name] = decodeXml(value);
    const bounds = attrs.bounds?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)?.slice(1).map(Number);
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds;
    if (x2 <= x1 || y2 <= y1) continue;
    const flag = (name) => attrs[name] === 'true';
    const node = {
      text: attrs.text ?? '',
      description: attrs['content-desc'] ?? '',
      resourceId: attrs['resource-id'] ?? '',
      className: (attrs.class ?? '').split('.').pop(),
      bounds,
      center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
      clickable: flag('clickable') || flag('long-clickable'),
      scrollable: flag('scrollable'),
      checkable: flag('checkable'),
      checked: flag('checked'),
      focused: flag('focused'),
      selected: flag('selected'),
      enabled: attrs.enabled !== 'false',
      password: flag('password'),
      editable: (attrs.class ?? '').includes('EditText'),
    };
    const meaningful = node.text || node.description || node.clickable || node.scrollable || node.checkable || node.editable;
    if (meaningful) nodes.push({ index: nodes.length, ...node });
  }
  return nodes;
}

export function formatNodes(nodes) {
  return nodes
    .map((node) => {
      const parts = [`[${node.index}] ${node.className || 'View'}`];
      if (node.text) parts.push(JSON.stringify(node.text.slice(0, 120)));
      if (node.description) parts.push(`desc=${JSON.stringify(node.description.slice(0, 120))}`);
      if (node.resourceId) parts.push(`id=${node.resourceId.replace(/^.*:id\//, '')}`);
      parts.push(`center=(${node.center.join(',')})`);
      const flags = ['clickable', 'scrollable', 'editable', 'checked', 'focused', 'selected', 'password']
        .filter((name) => node[name])
        .concat(node.enabled ? [] : ['disabled']);
      if (flags.length) parts.push(`{${flags.join(',')}}`);
      return parts.join(' ');
    })
    .join('\n');
}

// Parses `aapt2 dump badging` output into the facts the APK viewer shows.
export function parseBadging(output) {
  const field = (pattern) => output.match(pattern)?.[1] ?? null;
  return {
    packageName: field(/^package: name='([^']+)'/m),
    versionName: field(/versionName='([^']*)'/),
    versionCode: field(/versionCode='([^']*)'/),
    label: field(/^application-label:'([^']*)'/m),
    minSdk: field(/^(?:minSdkVersion|sdkVersion):'([^']*)'/m),
    targetSdk: field(/^targetSdkVersion:'([^']*)'/m),
    launchActivity: field(/^launchable-activity: name='([^']+)'/m),
    permissions: [...output.matchAll(/^uses-permission: name='([^']+)'/gm)].map((match) => match[1]),
  };
}

export async function apkInfo(file) {
  if (!fs.existsSync(file)) throw new Error(`APK not found: ${file}`);
  const { aapt2 } = sdk();
  if (!aapt2) throw new Error('aapt2 was not found in Android SDK build-tools. Install build-tools with the SDK Manager.');
  const result = await run(aapt2, ['dump', 'badging', file], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`Could not read ${file}: ${result.stderr.trim().slice(0, 300)}`);
  return { ...parseBadging(result.stdout), file, bytes: fs.statSync(file).size };
}

// Names from `adb emu avd snapshot list`, taking only the loadable section (not partial snapshots).
export function parseSnapshotList(output) {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('present on all disks'));
  if (start < 0) return [];
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.startsWith('List of')) break;
    const [id, name] = line.trim().split(/\s+/);
    if (/^\d+$/.test(id) && name && name !== 'default_boot') names.push(name);
  }
  return names;
}

export function findNode(nodes, { text, description, resourceId }) {
  const norm = (value) => String(value ?? '').trim().toLowerCase();
  const checks = [
    ['text', text],
    ['description', description],
    ['resourceId', resourceId],
  ].filter(([, value]) => value !== undefined && value !== '');
  if (checks.length === 0) return { node: null, matches: 0 };
  const matchesWith = (exact) =>
    nodes.filter((node) =>
      checks.every(([field, value]) => {
        const actual = field === 'resourceId' ? norm(node.resourceId).replace(/^.*:id\//, '') : norm(node[field]);
        const wanted = field === 'resourceId' ? norm(value).replace(/^.*:id\//, '') : norm(value);
        return exact ? actual === wanted : actual.includes(wanted);
      }),
    );
  const candidates = matchesWith(true).length ? matchesWith(true) : matchesWith(false);
  const node = candidates.find((candidate) => candidate.clickable && candidate.enabled) ?? candidates[0] ?? null;
  return { node, matches: candidates.length };
}

function hasSelector({ text, description, resourceId }) {
  return [text, description, resourceId].some((value) => typeof value === 'string' && value.trim());
}

function selectorLabel({ text, description, resourceId }) {
  return [
    text && `text=${JSON.stringify(text)}`,
    description && `description=${JSON.stringify(description)}`,
    resourceId && `resourceId=${JSON.stringify(resourceId)}`,
  ].filter(Boolean).join(', ');
}

function viewportFingerprint(nodes) {
  return nodes.map((node) => [
    node.text,
    node.description,
    node.resourceId,
    node.className,
    node.bounds.join(','),
    node.clickable,
    node.scrollable,
    node.editable,
    node.checked,
    node.focused,
    node.selected,
    node.enabled,
  ].join('|')).join('\n');
}

function uniqueNode(nodes, selector) {
  const result = findNode(nodes, selector);
  if (result.matches > 1) {
    throw new Error(`More than one visible UI node matches ${selectorLabel(selector)}. Refine the selector before continuing.`);
  }
  return result.node;
}

function validatePackageName(packageName) {
  if (typeof packageName !== 'string' || !QUALIFIED_ANDROID_NAME.test(packageName)) {
    throw new Error('packageName must be a qualified Android package name, for example com.example.app.');
  }
}

function validatePermissionName(permission) {
  if (typeof permission !== 'string' || !QUALIFIED_ANDROID_NAME.test(permission)) {
    throw new Error('permission must be a qualified Android permission name, for example android.permission.CAMERA.');
  }
}

function stateVerb(state) {
  return state === 'appears' ? 'appear' : 'disappear';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Device {
  constructor(serial, { capture, uiNodes, kind = 'emulator' } = {}) {
    if (!['emulator', 'physical'].includes(kind)) throw new Error('Device kind must be emulator or physical.');
    this.serial = serial;
    this.kind = kind;
    this.capture = capture;
    this.readUiNodes = uiNodes;
  }

  shell(command, options) {
    return adbOk(this.serial, ['shell', command], options);
  }

  async screenshot() {
    if (this.capture) return this.capture(this.serial);
    // Shell v2 separates stderr; exec-out mixes foldable display warnings into PNG bytes.
    const result = await adbOk(this.serial, ['shell', '-T', 'screencap', '-p'], { binary: true, timeoutMs: 20_000 });
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (result.truncated || !result.stdout.subarray(0, 8).equals(signature)) {
      throw new Error('Android did not return a complete PNG screenshot. Retry the capture.');
    }
    return result.stdout;
  }

  async uiNodes({ timeoutMs = 30_000 } = {}) {
    const shared = await this.readUiNodes?.(this.serial, { timeoutMs });
    if (shared) return shared;
    const file = `/data/local/tmp/android-emulator-ui-${randomUUID()}.xml`;
    const cleanup = `status=$?; rm -f ${file}; exit "$status"`;
    const command = `trap '${cleanup}' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; uiautomator dump ${file} >/dev/null && cat ${file}`;
    const result = await adbOk(this.serial, ['exec-out', command], { timeoutMs });
    const xml = result.stdout.slice(result.stdout.indexOf('<?xml'));
    if (!xml.startsWith('<?xml')) throw new Error(`uiautomator returned no hierarchy: ${result.stdout.slice(0, 300)}`);
    return parseUiHierarchy(xml);
  }

  async waitForNode(selector, { state = 'appears', timeoutMs = UI_WAIT_DEFAULT_TIMEOUT_MS } = {}) {
    if (!hasSelector(selector)) throw new Error('Provide text, description, or resourceId to wait for.');
    if (!['appears', 'disappears'].includes(state)) throw new Error('state must be appears or disappears.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > UI_WAIT_MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer between 1 and ${UI_WAIT_MAX_TIMEOUT_MS}.`);
    }
    const label = selectorLabel(selector);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // A stalled uiautomator dump must end before this wait's deadline.
      let result;
      try {
        result = await this.uiNodes({ timeoutMs: remaining });
      } catch (error) {
        if (/\(exit 124\)/.test(error.message) && Date.now() >= deadline) break;
        throw error;
      }
      const { node, matches } = findNode(result, selector);
      if ((state === 'appears' && node) || (state === 'disappears' && !node)) return { node, matches };
      const pause = Math.min(UI_WAIT_POLL_MS, deadline - Date.now());
      if (pause <= 0) break;
      await delay(pause);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for UI node to ${stateVerb(state)}: ${label}.`);
  }

  async screenSize() {
    const { stdout } = await this.shell('wm size');
    const sizes = [...stdout.matchAll(/(\d+)x(\d+)/g)].map((match) => [Number(match[1]), Number(match[2])]);
    const [width, height] = sizes.at(-1) ?? [];
    if (!width) throw new Error(`Could not read screen size from: ${stdout.trim()}`);
    return { width, height };
  }

  async foregroundActivity() {
    const { stdout } = await adbOk(this.serial, ['shell', 'dumpsys activity activities'], { timeoutMs: 5_000 });
    const resumed = stdout.split('\n').find((line) => /topResumedActivity|mResumedActivity/.test(line));
    return resumed?.match(/\s([\w.]+\/[\w.$]+)/)?.[1] ?? null;
  }

  // The values are gathered concurrently, so they are useful together but not an atomic device snapshot.
  async observe() {
    const [screenshot, nodes, foregroundActivity] = await Promise.allSettled([
      this.screenshot(),
      this.uiNodes(),
      this.foregroundActivity(),
    ]);
    const errors = {};
    const value = (result, key) => {
      if (result.status === 'fulfilled') return result.value;
      errors[key] = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return null;
    };
    return {
      screenshot: value(screenshot, 'screenshot'),
      nodes: value(nodes, 'uiNodes'),
      foregroundActivity: value(foregroundActivity, 'foregroundActivity'),
      errors,
    };
  }

  async installedPackages() {
    const { stdout } = await this.shell('pm list packages -3');
    return stdout.split('\n').map((line) => line.replace(/^package:/, '').trim()).filter(Boolean).sort();
  }

  async snapshots(action, name) {
    if (action === 'list') return parseSnapshotList(await this.emu(['avd', 'snapshot', 'list']));
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name ?? '')) throw new Error('Snapshot names use 1-64 letters, digits, ".", "_", or "-".');
    if (!['save', 'load', 'delete'].includes(action)) throw new Error('action must be list, save, load, or delete.');
    await this.emu(['avd', 'snapshot', action, name]);
    return this.snapshots('list');
  }

  async tap(x, y, durationMs) {
    if (![x, y].every(Number.isFinite)) throw new Error('x and y must be finite numbers.');
    if (durationMs === undefined) {
      await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
      return;
    }
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > LONG_PRESS_MAX_DURATION_MS) {
      throw new Error(`durationMs must be an integer from 1 to ${LONG_PRESS_MAX_DURATION_MS}.`);
    }
    const point = `${Math.round(x)} ${Math.round(y)}`;
    await this.shell(`input swipe ${point} ${point} ${durationMs}`);
  }

  async swipe(x1, y1, x2, y2, durationMs = 300) {
    await this.shell(`input swipe ${[x1, y1, x2, y2].map(Math.round).join(' ')} ${Math.round(durationMs)}`);
  }

  async scrollTo(selector, { direction = 'up', maxSwipes = SCROLL_TO_DEFAULT_MAX_SWIPES, tap = false, durationMs = SCROLL_TO_DEFAULT_DURATION_MS } = {}) {
    if (!hasSelector(selector)) throw new Error('Provide text, description, or resourceId to scroll to.');
    if (!['up', 'down', 'left', 'right'].includes(direction)) throw new Error('direction must be up, down, left, or right.');
    if (!Number.isInteger(maxSwipes) || maxSwipes < 1 || maxSwipes > SCROLL_TO_MAX_SWIPES) {
      throw new Error(`maxSwipes must be an integer from 1 to ${SCROLL_TO_MAX_SWIPES}.`);
    }
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > LONG_PRESS_MAX_DURATION_MS) {
      throw new Error(`durationMs must be an integer from 1 to ${LONG_PRESS_MAX_DURATION_MS}.`);
    }

    let nodes = await this.uiNodes();
    let node = uniqueNode(nodes, selector);
    if (node) {
      if (tap && !node.enabled) throw new Error('The matching element is disabled; it was not tapped.');
      if (tap) await this.tap(...node.center);
      return { node, swipes: 0 };
    }

    const { width, height } = await this.screenSize();
    const cx = width / 2;
    const cy = height / 2;
    const dx = width * 0.35;
    const dy = height * 0.3;
    const vectors = {
      up: [cx, cy + dy, cx, cy - dy],
      down: [cx, cy - dy, cx, cy + dy],
      left: [cx + dx, cy, cx - dx, cy],
      right: [cx - dx, cy, cx + dx, cy],
    };

    for (let swipes = 1; swipes <= maxSwipes; swipes += 1) {
      await this.swipe(...vectors[direction], durationMs);
      const nextNodes = await this.uiNodes();
      node = uniqueNode(nextNodes, selector);
      if (node) {
        if (tap && !node.enabled) throw new Error('The matching element is disabled; it was not tapped.');
        if (tap) await this.tap(...node.center);
        return { node, swipes };
      }
      if (viewportFingerprint(nodes) === viewportFingerprint(nextNodes)) {
        throw new Error(`The UI did not change after swipe ${swipes}; ${selectorLabel(selector)} was not found.`);
      }
      nodes = nextNodes;
    }
    throw new Error(`Could not find ${selectorLabel(selector)} after ${maxSwipes} ${direction} swipes.`);
  }

  async key(key) {
    const code = resolveKeycode(key);
    await this.shell(`input keyevent ${code}`);
    return code;
  }

  async app({ action, packageName, permission }) {
    validatePackageName(packageName);
    if (!['restart', 'stop', 'grant_permission', 'revoke_permission'].includes(action)) {
      throw new Error('action must be restart, stop, grant_permission, or revoke_permission.');
    }
    const needsPermission = action === 'grant_permission' || action === 'revoke_permission';
    if (needsPermission) validatePermissionName(permission);
    else if (permission !== undefined) throw new Error('permission is only valid for grant_permission or revoke_permission.');

    if (action === 'restart') {
      await this.shell(`am force-stop ${shellQuote(packageName)}`);
      return { action, packageName, output: await this.open({ packageName }) };
    }
    if (action === 'stop') {
      await this.shell(`am force-stop ${shellQuote(packageName)}`);
      return { action, packageName };
    }
    await this.shell(`pm ${action === 'grant_permission' ? 'grant' : 'revoke'} ${shellQuote(packageName)} ${shellQuote(permission)}`);
    return { action, packageName, permission };
  }

  async install(paths, { grantPermissions = false } = {}) {
    const apks = Array.isArray(paths) ? paths : [paths];
    for (const apk of apks) {
      if (!fs.existsSync(apk)) throw new Error(`APK not found: ${apk}`);
    }
    const flags = ['-r', '-t', ...(grantPermissions ? ['-g'] : [])];
    const command = apks.length > 1 ? ['install-multiple', ...flags, ...apks] : ['install', ...flags, apks[0]];
    const result = await adbOk(this.serial, command, { timeoutMs: 300_000 });
    return result.stdout.trim().split('\n').slice(-3).join('\n');
  }

  async open({ url, packageName, component }) {
    const summary = (output) => output.split('\n').filter((line) => /^(Status|Activity|Error|Warning)/.test(line.trim())).join('\n');
    if (url) {
      const target = packageName ? ` -p ${shellQuote(packageName)}` : '';
      return summary((await this.shell(`am start -W -a android.intent.action.VIEW -d ${shellQuote(url)}${target}`)).stdout);
    }
    if (component) return summary((await this.shell(`am start -W -n ${shellQuote(component)}`)).stdout);
    if (packageName) {
      const { stdout } = await this.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${shellQuote(packageName)}`);
      const launcher = stdout.trim().split('\n').at(-1);
      if (!launcher?.includes('/')) throw new Error(`${packageName} has no launcher activity or is not installed.`);
      return summary((await this.shell(`am start -W -n ${shellQuote(launcher)}`)).stdout);
    }
    throw new Error('Provide url, packageName, or component.');
  }

  async emu(args) {
    if (this.kind === 'physical') throw new Error('Emulator console commands are unavailable on physical devices. Select an emulator for this operation.');
    const result = await adbOk(this.serial, ['emu', ...args], { timeoutMs: 10_000 });
    if (/^KO/m.test(result.stdout)) throw new Error(`Emulator console rejected "${args.join(' ')}": ${result.stdout.trim()}`);
    return result.stdout.trim();
  }

  async rotate(direction) {
    const turns = direction === 'left' ? 3 : 1;
    for (let i = 0; i < turns; i += 1) await this.emu(['rotate']);
  }

  async posture() {
    const { stdout: output } = await this.shell('cmd device_state state', { timeoutMs: 5_000 });
    const name = output.match(/Committed state:[^\n]*\bname=['"]([^'"]+)['"]/i)?.[1];
    return { CLOSED: 'folded', HALF_OPENED: 'half-folded', OPENED: 'unfolded' }[name] ?? null;
  }

  async applySettings({ darkMode, fontScale, location, battery, rotate, posture }) {
    if (this.kind === 'physical') {
      const unsupported = Object.entries({ location, battery, rotate, posture }).filter(([, value]) => value !== undefined).map(([name]) => name);
      if (unsupported.length) throw new Error(`Physical devices do not support emulator settings: ${unsupported.join(', ')}. Select an emulator to change these settings.`);
    }
    const postureId = { folded: 1, 'half-folded': 2, unfolded: 3 }[posture];
    if (posture !== undefined && !Number.isInteger(postureId)) throw new Error('posture must be folded, half-folded, or unfolded.');
    const applied = [];
    if (posture !== undefined) {
      await this.emu(['posture', String(postureId)]);
      applied.push(`posture ${posture}`);
    }
    if (darkMode !== undefined) {
      await this.shell(`cmd uimode night ${darkMode ? 'yes' : 'no'}`);
      applied.push(`dark mode ${darkMode ? 'on' : 'off'}`);
    }
    if (fontScale !== undefined) {
      if (!(fontScale >= 0.5 && fontScale <= 3)) throw new Error('fontScale must be between 0.5 and 3.');
      await this.shell(`settings put system font_scale ${fontScale}`);
      applied.push(`font scale ${fontScale}`);
    }
    if (location) {
      await this.emu(['geo', 'fix', String(location.longitude), String(location.latitude)]);
      applied.push(`location ${location.latitude},${location.longitude}`);
    }
    if (battery) {
      if (battery.level !== undefined) await this.emu(['power', 'capacity', String(Math.round(battery.level))]);
      if (battery.charging !== undefined) {
        await this.emu(['power', 'ac', battery.charging ? 'on' : 'off']);
        await this.emu(['power', 'status', battery.charging ? 'charging' : 'discharging']);
      }
      applied.push(`battery ${JSON.stringify(battery)}`);
    }
    if (rotate) {
      await this.rotate(rotate);
      applied.push(`rotated ${rotate}`);
    }
    return applied;
  }
}

const BLOCKED_ADB = new Set(['connect', 'disconnect', 'devices', 'kill-server', 'start-server', 'reconnect', 'pair', 'mdns', 'host-features']);

// Runs adb against only this thread's emulator.
export async function scopedAdb(serial, args, { timeoutMs = 60_000 } = {}) {
  if (!Array.isArray(args) || args.length === 0 || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('args must be a non-empty array of strings, for example ["shell", "pm", "list", "packages"].');
  }
  if (args[0].startsWith('-')) throw new Error('Do not pass adb global options; the plugin selects this thread\'s emulator automatically.');
  if (BLOCKED_ADB.has(args[0])) throw new Error(`adb ${args[0]} affects devices outside this thread and is not allowed here.`);
  const result = await adb(serial, args, { timeoutMs, maxBytes: 4 * 1024 * 1024 });
  const limit = 20_000;
  const clip = (value) => (value.length > limit ? `${value.slice(0, limit)}\n… truncated ${value.length - limit} chars` : value);
  return { exitCode: result.code, stdout: clip(result.stdout), stderr: clip(result.stderr) };
}

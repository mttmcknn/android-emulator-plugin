import { PROFILES } from './lib/avds.mjs';

// MCP tool definitions. Every call is bound to the calling session by the server.

export const PANEL_URI = 'ui://android-emulator/panel.html';
export const MANAGER_URI = 'ui://android-emulator/manager.html';
export const APK_URI = 'ui://android-emulator/apk.html';

// Monochrome 20×20 outline icons that follow the host theme.
const GLYPHS = {
  android: '<path d="M2.8 15.8a7.2 7.2 0 0 1 14.4 0z"/><path d="m5.4 5.2 1.7 2.7M14.6 5.2l-1.7 2.7"/><circle cx="7.3" cy="12.3" r=".75" fill="currentColor"/><circle cx="12.7" cy="12.3" r=".75" fill="currentColor"/>',
  devices: '<rect x="3" y="3.5" width="8.5" height="13" rx="1.6"/><path d="M14 5.5h1.4a1.6 1.6 0 0 1 1.6 1.6v7.8a1.6 1.6 0 0 1-1.6 1.6H14M6 14h2.5"/>',
  phone: '<rect x="5.5" y="2.5" width="9" height="15" rx="2"/><path d="M9 14.8h2"/>',
  create: '<rect x="5.5" y="2.5" width="9" height="15" rx="2"/><path d="M10 7.5v4.5M7.75 9.75h4.5"/>',
  start: '<path d="M7 5.3v9.4L14.5 10z"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/>',
  camera: '<path d="M7 5.5 8.2 4h3.6L13 5.5h2.5A1.5 1.5 0 0 1 17 7v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5V7a1.5 1.5 0 0 1 1.5-1.5z"/><circle cx="10" cy="10.5" r="2.6"/>',
  tree: '<path d="M4 5h2M4 10h2M4 15h2M9 5h7M9 10h7M9 15h7"/>',
  tap: '<path d="M8.5 9.5V4.8a1.4 1.4 0 0 1 2.8 0v4"/><path d="M11.3 8.8a1.4 1.4 0 0 1 2.8 0v2.5a5 5 0 0 1-5 5h-.4a4.3 4.3 0 0 1-3.7-2.1L3.6 12a1.35 1.35 0 0 1 2.2-1.5L8.5 13"/>',
  swipe: '<path d="M3.5 10h13M13 6.5l3.5 3.5-3.5 3.5"/>',
  keyboard: '<rect x="2.5" y="5" width="15" height="10" rx="1.6"/><path d="M6 12h8M5.5 8.5h.01M8.5 8.5h.01M11.5 8.5h.01M14.5 8.5h.01"/>',
  key: '<rect x="4" y="4" width="12" height="12" rx="2.5"/><path d="M8 10h4"/>',
  install: '<path d="M10 3.5v9M6.5 9 10 12.5 13.5 9M4 16h12"/>',
  open: '<path d="M8.5 4h-3A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-3M11.5 4H16v4.5M16 4l-6.5 6.5"/>',
  sliders: '<path d="M4 6.5h7M15 6.5h1M4 13.5h1M9 13.5h7"/><circle cx="13" cy="6.5" r="1.8"/><circle cx="7" cy="13.5" r="1.8"/>',
  terminal: '<rect x="3" y="4" width="14" height="12" rx="1.6"/><path d="m6.5 8 2 2-2 2M10.5 12h3"/>',
  record: '<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2.6" fill="currentColor"/>',
  snapshot: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.4 1.5"/>',
  apk: '<path d="m10 2.8 6.5 3.6v7.2L10 17.2l-6.5-3.6V6.4z"/><path d="m3.5 6.4 6.5 3.6 6.5-3.6M10 10v7.2"/>',
};

export function iconFor(glyph) {
  const attribution = glyph === 'android'
    ? '<desc>Android is a trademark of Google LLC. The Android robot is reproduced or modified from work created and shared by Google and used according to terms described in the Creative Commons 3.0 Attribution License: https://creativecommons.org/licenses/by/3.0/. Modified by redrawing and scaling.</desc>'
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round">${attribution}${GLYPHS[glyph]}</svg>`;
  return [{ src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['20x20'] }];
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const action = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
// Navigation/UI inspection can prepare missing tools from public upstream URLs.
const navigationAction = { ...action, openWorldHint: true };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const appOnly = { ui: { visibility: ['app'] } };
const fileInput = obj({ name: { type: 'string' }, resourceUri: { type: 'string' } }, ['name', 'resourceUri']);

export const TOOLS = [
  {
    name: 'emulator_devices',
    description: 'List devices pinned to this chat and connected Android devices available to pin. Use the returned device ID on every device action when more than one is pinned. Unauthorized devices require allowing USB debugging on the phone.',
    inputSchema: obj({}), annotations: { title: 'List devices', ...readOnly }, icons: iconFor('phone'),
  },
  {
    name: 'emulator_pin', title: 'Android Emulator',
    description: 'Pin a connected Android device to this chat and open its live panel. Supply a serial from emulator_devices. A device already pinned elsewhere requires the user to confirm moving it in the panel; agents cannot confirm the move. Unpin physical devices with emulator_stop; this never shuts down the phone.',
    inputSchema: obj({ serial: { type: 'string' } }, ['serial']), annotations: { title: 'Pin device', ...action }, icons: iconFor('phone'),
  },
  {
    name: 'emulator_navigate',
    description: "Navigate this chat's app using automatically remembered screens and routes. Ordinary app opens, observations, taps, directional swipes and Back actions prepare and learn the map automatically. status reads saved metadata without observing the device; whereami locates and remembers a screen; go replays a saved route with optional expected selectors. When currentPlace.needsLabel is true, inspect the screen and call whereami with a short descriptive label before leaving it. This also renames existing numbered screens while preserving their IDs and routes. Never ask the user to name screens. Missing navigation dependencies are prepared locally on first use. Maps are local to this host/project/app unless an existing matching project map is present. Inspect every returned status; blocked/action_failed are not success. Never retry a lost or failed action automatically. cancel stops navigation before releasing input; completed actions are not undone. init is an optional advanced override, not required setup.",
    inputSchema: obj({
      action: { type: 'string', enum: ['status', 'init', 'doctor', 'whereami', 'layout', 'go', 'tap', 'scroll', 'back', 'cancel'] },
      packageName: { type: 'string', description: 'Required only for advanced init; ordinary actions select the foreground app automatically.' },
      target: { type: 'string', description: 'Place ID or slug from status; required for go.' },
      selector: { type: 'string', description: 'Required for tap, e.g. text=Settings, resource_id=com.example:id/settings, content_desc=Settings.' },
      label: { type: 'string', minLength: 1, maxLength: 120, description: 'Short screen purpose from fresh UI evidence, e.g. Settings or Sign in. Use whereami to replace numbered placeholders. Preserve useful existing names; omit personal data, record names and entered text. If label_mismatch is returned, inspect and choose a distinct descriptive name; do not merge screens.' },
      reason: { type: 'string', description: 'Optional tap intent for the saved route.' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Required for scroll. Minimap content direction; down reveals content below.' },
      expect: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'go must verify all selectors at the destination. Use for specific item or state checks.' },
    }, ['action']),
    annotations: { title: 'Navigate app', ...navigationAction },
    icons: iconFor('tree'),
  },
  {
    name: 'emulator_backends',
    description: "Inspect available implementations, select backends for only this chat, or read content-free performance metrics. Defaults preserve the current behavior. Finish active actions/recordings before selecting. Changing the connection backend reconnects this chat’s display. Optional dependencies must be installed separately; failures never silently fall back. Metrics are helper-side, not panel render latency.",
    inputSchema: obj({ action: { type: 'string', enum: ['list', 'select', 'metrics'], description: 'Default list.' },
      set: obj(Object.fromEntries(['capture', 'device', 'connection', 'recording', 'navigation'].map(name => [name, { type: 'string', description: 'Implementation ID from list.' }]))) }),
    annotations: { title: 'Manage device tools', ...action },
    icons: iconFor('sliders'),
  },
  {
    name: 'emulator_status',
    description:
      "Show this chat's pinned Android devices, connected phones, and available virtual devices. Pass deviceId for one device's stream and foldable details.",
    inputSchema: obj({ deviceId: { type: 'string', minLength: 1, description: 'Optional device ID from emulator_devices for detailed status.' } }),
    annotations: { title: 'Check device status', ...readOnly },
    icons: iconFor('phone'),
  },
  {
    name: 'emulator_diagnostics',
    description: "Diagnose this chat's emulator or panel without starting or restarting anything. Returns plugin/helper versions, SDK availability, device process and stream state, stable diagnostic codes, and host diagnostics when the integration supports them. Excludes access keys, raw logs, and device content. Use before retrying a failed action or restarting the emulator; historical host events may be unrelated.",
    inputSchema: obj({}),
    annotations: { title: 'Diagnose device issues', ...readOnly },
    icons: iconFor('terminal'),
  },
  {
    name: 'emulator_panel',
    title: 'Android Emulator',
    description: "Show this chat's live Android emulator. Reuse the existing panel during testing; call this only when the panel is closed or the user asks to show it.",
    inputSchema: obj({}),
    annotations: { title: 'Show device panel', ...readOnly },
    icons: iconFor('android'),
    _meta: {
      ui: { resourceUri: PANEL_URI },
    },
  },
  {
    name: 'emulator_manager',
    title: 'Android Emulators',
    description: 'View running Android emulators and virtual devices stored on this computer.',
    inputSchema: obj({}),
    annotations: { title: 'Manage Android devices', ...readOnly },
    icons: iconFor('devices'),
    _meta: { ...appOnly, ui: { ...appOnly.ui, resourceUri: MANAGER_URI } },
  },
  {
    name: 'emulator_apk',
    title: 'APK',
    description: "Show an APK file and install it on this chat's Android emulator.",
    inputSchema: obj({ file: fileInput, action: { type: 'string', enum: ['info', 'install'] } }, ['file']),
    annotations: { title: 'Open APK', ...navigationAction },
    icons: iconFor('apk'),
    _meta: { ui: { visibility: ['app'], resourceUri: APK_URI } },
  },
  {
    name: 'emulator_create',
    title: 'Android Emulator',
    description:
      "Create an Android virtual device from a device profile and installed system image. It starts in this chat by default and is removed when the chat is archived unless you keep it.",
    inputSchema: obj(
      {
        profile: { type: 'string', enum: PROFILES.map(({ id }) => id), description: 'Hardware profile, for example pixel_9 or pixel_tablet.' },
        systemImage: { type: 'string', description: 'Installed image id such as "android-36/google_apis_playstore/arm64-v8a". Omit for the newest suitable image.' },
        name: { type: 'string', description: 'AVD name (letters, digits, ".", "_", "-"). Omit to derive one.' },
        keep: { type: 'boolean', description: 'Keep the virtual device after this chat ends. Defaults to the setting.' },
        start: { type: 'boolean', description: 'Start it after creating. Default true.' },
      },
      ['profile'],
    ),
    annotations: { title: 'Create emulator', ...action },
    icons: iconFor('create'),
  },
  {
    name: 'emulator_start',
    title: 'Android Emulator',
    description:
      "Start this chat's Android emulator. If the selected virtual device is already running elsewhere, a temporary read-only copy starts instead.",
    inputSchema: obj({
      avd: { type: 'string', description: 'AVD name from emulator_status. Omit for the default.' },
      readOnly: { type: 'boolean', description: 'Force an ephemeral instance that does not save AVD state.' },
      coldBoot: { type: 'boolean', description: 'Skip the Quick Boot snapshot and cold boot.' },
      deviceId: { type: 'string', description: 'Reuse a specific emulator pinned to this chat.' },
      newInstance: { type: 'boolean', description: 'Start an additional emulator, including another instance of the same AVD, for comparison.' },
    }),
    annotations: { title: 'Start emulator', ...action },
    icons: iconFor('start'),
  },
  {
    name: 'emulator_stop',
    description:
      "Stop this chat's Android emulator. You can also delete a virtual device created for this chat.",
    inputSchema: obj({ deleteDevice: { type: 'boolean', description: 'Also delete a virtual device created for this chat.' } }),
    annotations: { title: 'Stop or unpin device', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    icons: iconFor('stop'),
  },
  {
    name: 'emulator_screenshot',
    description: "Capture this chat's Android emulator screen as an image. Set save to keep a reusable capture for clipboard or chat sharing; ordinary screenshots are not saved.",
    inputSchema: obj({ save: { type: 'boolean', description: 'Save a reusable capture and return its ID. Default false.' } }),
    annotations: { title: 'Take screenshot', ...action },
    icons: iconFor('camera'),
  },
  {
    name: 'emulator_capture',
    description: "List this chat's recent screenshots and recordings, copy a capture to the macOS clipboard, or inspect it. PNGs copy as images; MP4s copy as files for apps that accept file paste. Context returns a screenshot or up to four timestamped video frames plus the saved video path (requires FFmpeg). Video frames are samples, not the full recording. Capture IDs come from emulator_screenshot, emulator_record, or list. Never acts on another chat's captures.",
    inputSchema: obj({ action: { type: 'string', enum: ['list', 'copy', 'context'] }, captureId: { type: 'string', description: 'Required for copy/context.' } }, ['action']),
    annotations: { title: 'View or copy captures', ...action },
    icons: iconFor('camera'),
  },
  {
    name: 'emulator_ui_tree',
    description:
      'List meaningful on-screen UI elements from the accessibility hierarchy with text, content description, resource id, center coordinates, and state. Prefer this over screenshots for finding tap targets.',
    inputSchema: obj({ query: { type: 'string', description: 'Optional case-insensitive filter on text, description, or resource id.' } }),
    annotations: { title: 'Read screen elements', ...navigationAction },
    icons: iconFor('tree'),
  },
  {
    name: 'emulator_wait_for',
    description:
      'Wait for the best visible UI element matching text, description, and/or resourceId to appear or disappear. Returns the matched node when it appears. This only reads this chat\'s emulator.',
    inputSchema: obj({
      text: { type: 'string' },
      description: { type: 'string', description: 'Content description (accessibility label).' },
      resourceId: { type: 'string', description: 'View id, with or without the package prefix.' },
      state: { type: 'string', enum: ['appears', 'disappears'], description: 'Default appears.' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 30_000, description: 'Default 10000; maximum 30000.' },
    }),
    annotations: { title: 'Wait for screen', ...navigationAction },
    icons: iconFor('tree'),
  },
  {
    name: 'emulator_tap',
    description:
      'Tap the screen at device pixel coordinates, or tap the best UI element matching text, description, and/or resourceId (exact match preferred, then substring). Set durationMs for a long press. The user sees the tap in the panel.',
    inputSchema: obj({
      x: { type: 'number' },
      y: { type: 'number' },
      text: { type: 'string' },
      description: { type: 'string', description: 'Content description (accessibility label).' },
      resourceId: { type: 'string', description: 'View id, with or without the package prefix.' },
      durationMs: { type: 'integer', minimum: 1, maximum: 10_000, description: 'Long-press duration; maximum 10000.' },
    }),
    annotations: { title: 'Tap screen', ...navigationAction },
    icons: iconFor('tap'),
  },
  {
    name: 'emulator_swipe',
    description: 'Swipe in a direction (content scrolls opposite to finger movement: "up" reveals content below) or between two device pixel coordinates.',
    inputSchema: obj({
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      x1: { type: 'number' },
      y1: { type: 'number' },
      x2: { type: 'number' },
      y2: { type: 'number' },
      durationMs: { type: 'number', description: 'Default 300.' },
    }),
    annotations: { title: 'Swipe screen', ...navigationAction },
    icons: iconFor('swipe'),
  },
  {
    name: 'emulator_scroll_to',
    description:
      'Look for one unambiguous UI element matching text, content description, and/or resourceId, scrolling at most five times by default (maximum ten). Stops when the element is found or the viewport does not change; optionally taps the matched element.',
    inputSchema: obj({
      text: { type: 'string' },
      description: { type: 'string', description: 'Content description (accessibility label).' },
      resourceId: { type: 'string', description: 'View id, with or without the package prefix.' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Default up.' },
      maxSwipes: { type: 'integer', minimum: 1, maximum: 10, description: 'Default 5; maximum 10.' },
      tap: { type: 'boolean', description: 'Default false. Tap the element only after it is found.' },
      durationMs: { type: 'integer', minimum: 1, maximum: 10_000, description: 'Swipe duration; default 300.' },
    }),
    annotations: { title: 'Scroll to element', ...navigationAction },
    icons: iconFor('swipe'),
  },
  {
    name: 'emulator_observe',
    description:
      'Read the screenshot, meaningful UI elements, and foreground app concurrently. This is not an atomic snapshot; partial read errors are returned explicitly. If navigation.currentPlace.needsLabel is true, use this observation to give the screen a short descriptive name with emulator_navigate (whereami + label) before navigating away.',
    inputSchema: obj({}),
    annotations: { title: 'Inspect screen', ...navigationAction },
    icons: iconFor('camera'),
  },
  {
    name: 'emulator_type',
    description: 'Enter Unicode text (including emoji) into one enabled editable field, optionally targeting it by text, content description, or resourceId. Uses the device clipboard. Set replace to select all first. Reports whether visible text confirmed the result; inspect before retrying unverified input. Enter is only pressed after verification.',
    inputSchema: obj({
      text: { type: 'string' },
      target: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          description: { type: 'string', description: 'Content description (accessibility label).' },
          resourceId: { type: 'string', description: 'View id, with or without the package prefix.' },
        },
        minProperties: 1,
        additionalProperties: false,
      },
      replace: { type: 'boolean', description: 'Default false. Select all and replace only in a known editable field.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards.' },
    }, ['text']),
    annotations: { title: 'Type text', ...navigationAction },
    icons: iconFor('keyboard'),
  },
  {
    name: 'emulator_app',
    description:
      'Restart or force-stop an installed app, or explicitly grant or revoke one named runtime permission. This never clears app data or uninstalls an app.',
    inputSchema: obj({
      action: { type: 'string', enum: ['restart', 'stop', 'grant_permission', 'revoke_permission'] },
      packageName: { type: 'string', description: 'Qualified Android package name, for example com.example.app.' },
      permission: { type: 'string', description: 'Required only for grant_permission or revoke_permission, for example android.permission.CAMERA.' },
    }, ['action', 'packageName']),
    annotations: { title: 'Manage app', ...navigationAction },
    icons: iconFor('open'),
  },
  {
    name: 'emulator_key',
    description: 'Press a key: BACK, HOME, APP_SWITCH, ENTER, DEL, TAB, ESCAPE, DPAD_UP/DOWN/LEFT/RIGHT, POWER, VOLUME_UP, VOLUME_DOWN, MENU, or a numeric Android keycode.',
    inputSchema: obj({ key: { type: ['string', 'integer'] } }, ['key']),
    annotations: { title: 'Press device key', ...navigationAction },
    icons: iconFor('key'),
  },
  {
    name: 'emulator_install',
    description: "Install or update one APK, or install several split APKs together, on this chat's Android emulator.",
    inputSchema: obj(
      {
        apkPaths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Absolute APK paths.' },
        grantPermissions: { type: 'boolean', description: 'Grant all runtime permissions at install time.' },
      },
      ['apkPaths'],
    ),
    annotations: { title: 'Install app', ...action },
    icons: iconFor('install'),
  },
  {
    name: 'emulator_open',
    description: 'Open a deep link or URL (optionally restricted to packageName), launch an app by packageName, or start an explicit component such as "com.example/.MainActivity".',
    inputSchema: obj({ url: { type: 'string' }, packageName: { type: 'string' }, component: { type: 'string' } }),
    annotations: { title: 'Open app or link', ...navigationAction },
    icons: iconFor('open'),
  },
  {
    name: 'emulator_settings',
    description: 'Change device conditions: dark mode, font scale, GPS location, battery level/charging, rotate the device left/right, or change a foldable device posture.',
    inputSchema: obj({
      darkMode: { type: 'boolean' },
      fontScale: { type: 'number', description: '0.5 to 3; 1 is default.' },
      location: obj({ latitude: { type: 'number' }, longitude: { type: 'number' } }, ['latitude', 'longitude']),
      battery: obj({ level: { type: 'number', description: '0-100' }, charging: { type: 'boolean' } }),
      rotate: { type: 'string', enum: ['left', 'right'] },
      posture: { type: 'string', enum: ['folded', 'half-folded', 'unfolded'], description: 'Foldable AVDs only. half-folded simulates a partially open hinge.' },
    }),
    annotations: { title: 'Change device settings', ...action },
    icons: iconFor('sliders'),
  },
  {
    name: 'emulator_record',
    description: "Start or stop a screen recording of this chat's Android emulator. Stopping saves an MP4 up to three minutes long.",
    inputSchema: obj({ action: { type: 'string', enum: ['start', 'stop'] } }, ['action']),
    annotations: { title: 'Record screen', ...action },
    icons: iconFor('record'),
  },
  {
    name: 'emulator_snapshot',
    description: "List, save, load, or delete Quick Boot snapshots for this chat's Android emulator.",
    inputSchema: obj({ action: { type: 'string', enum: ['list', 'save', 'load', 'delete'] }, name: { type: 'string' } }, ['action']),
    annotations: { title: 'Manage emulator snapshots', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    icons: iconFor('snapshot'),
  },
  {
    name: 'emulator_adb',
    description:
      "Run an adb command against this chat's Android emulator. Output is limited to 20,000 characters.",
    inputSchema: obj({ args: { type: 'array', items: { type: 'string' }, minItems: 1 }, timeoutMs: { type: 'number', description: 'Default 60000.' } }, ['args']),
    annotations: { title: 'Run device command', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    icons: iconFor('terminal'),
  },
  {
    name: 'emulator_mentions',
    description: 'Search virtual devices and installed apps for composer @-mentions.',
    inputSchema: obj({ query: { type: 'string' } }, ['query']),
    annotations: { title: 'Find devices and apps', ...readOnly },
    icons: iconFor('android'),
    _meta: appOnly,
  },
  {
    name: 'settings_read',
    description: 'Read Android Emulators settings.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { schema: { type: 'object' }, values: { type: 'object' }, layout: { type: 'array', items: { type: 'object' } } },
      required: ['schema', 'values'],
    },
    annotations: { title: 'Read plugin settings', ...readOnly },
    _meta: appOnly,
  },
  {
    name: 'settings_update',
    description: 'Update Android Emulators settings.',
    inputSchema: obj(
      {
        set: {
          type: 'object',
          properties: {
            defaultAvd: { type: 'string' },
            keepCreatedDevices: { type: 'boolean' },
            idleMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
            videoQuality: { type: 'string', enum: ['Data saver', 'Balanced', 'High'] },
          },
          minProperties: 1,
          additionalProperties: false,
        },
      },
      ['set'],
    ),
    outputSchema: { type: 'object', properties: { values: { type: 'object' } }, required: ['values'] },
    annotations: { title: 'Update plugin settings', ...action },
    _meta: appOnly,
  },
  {
    name: 'emulator_stream',
    description: 'Transport for the embedded emulator panel: sends pane input and long-polls video and status.',
    inputSchema: obj(
      {
        thread: { type: 'string' },
        key: { type: 'string' },
        session: { type: 'string', maxLength: 64 },
        send: { type: 'array', items: { type: 'object' } },
        wait: { type: 'boolean' },
        workspace: { type: 'boolean' },
      },
      ['thread', 'key', 'session'],
    ),
    annotations: { title: 'Stream device display', ...navigationAction, destructiveHint: true },
    icons: iconFor('phone'),
    _meta: appOnly,
  },
].map(tool => {
  tool = { ...tool, title: tool.title ?? tool.annotations.title };
  const scoped = ['emulator_navigate', 'emulator_backends', 'emulator_stop', 'emulator_screenshot', 'emulator_capture', 'emulator_record', 'emulator_snapshot', 'emulator_observe', 'emulator_ui_tree', 'emulator_tap', 'emulator_swipe', 'emulator_key', 'emulator_type', 'emulator_wait_for', 'emulator_scroll_to', 'emulator_app', 'emulator_install', 'emulator_open', 'emulator_settings', 'emulator_adb', 'emulator_apk', 'emulator_capture_selection'];
  return scoped.includes(tool.name) ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, deviceId: { type: 'string', description: 'Device ID from emulator_devices. Required when this chat has multiple pinned devices; cannot target another chat’s device.' } } } } : tool;
});

// Callable without a calling session (settings page, sidebar, and the panel transport, which carries its own key).
export const THREADLESS = new Set(['settings_read', 'settings_update', 'emulator_manager', 'emulator_stream']);

export const EMULATOR_INSTRUCTIONS =
  'A chat can pin multiple Android emulators and connected devices. Each device belongs exclusively to one chat. List emulator_devices and pass deviceId on actions when several are pinned; never guess the target. Use emulator_pin for connected phones; a move from another chat requires user confirmation in the panel. emulator_stop releases a physical pin without shutting down the phone. ' +
  'Start with emulator_status, then emulator_start (or emulator_create when no AVD fits). Successful startup returns the device panel automatically in supported hosts; do not follow it with emulator_panel. Use emulator_panel to reopen a closed panel or when the user asks to show it. Reuse the existing panel during testing. ' +
  'Use emulator_observe for the screen, elements, and foreground app together; emulator_ui_tree for lighter target lookup. Use emulator_scroll_to for off-screen targets and emulator_type for verified Unicode text entry. ' +
  'Name screens as you inspect them: when navigation reports currentPlace.needsLabel, call emulator_navigate with action whereami and a short descriptive label based on fresh UI evidence. Replace numbered placeholders on revisit, preserve useful names, omit personal data, and never ask the user to manage screen names. ' +
  'When the panel or tools fail, use emulator_diagnostics before restarting anything. It works without a running helper and returns safe, chat-scoped diagnostics.';

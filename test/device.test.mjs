import assert from 'node:assert/strict';
import test from 'node:test';
import { Device, findNode, formatNodes, parseUiHierarchy, resolveKeycode, scopedAdb } from '../runtime/core/lib/device.mjs';
import { choosePort, parseAdbDevices, parseAvdList } from '../runtime/core/lib/leases.mjs';

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
<node index="1" text="Sign in" resource-id="com.example:id/login" class="android.widget.Button" clickable="true" enabled="true" bounds="[100,1000][980,1100]" />
<node index="2" text="Sign in with Google &amp; more" resource-id="" class="android.widget.TextView" clickable="false" enabled="true" bounds="[100,1200][980,1300]" />
<node index="3" text="" content-desc="Email" resource-id="com.example:id/email" class="android.widget.EditText" clickable="true" enabled="true" focused="true" bounds="[100,800][980,900]" />
<node index="4" text="" resource-id="" class="android.view.View" clickable="false" enabled="true" bounds="[0,0][0,0]" />
</node></hierarchy>`;

test('ui hierarchy keeps meaningful nodes with centers and decoded text', () => {
  const nodes = parseUiHierarchy(XML);
  assert.deepEqual(nodes.map((node) => node.text || node.description), ['Sign in', 'Sign in with Google & more', 'Email']);
  assert.deepEqual(nodes[0].center, [540, 1050]);
  assert.match(formatNodes(nodes), /\[2\] EditText desc="Email" id=email center=\(540,850\) \{clickable,editable,focused\}/);
});

test('findNode prefers exact matches and accepts ids without package prefix', () => {
  const nodes = parseUiHierarchy(XML);
  assert.equal(findNode(nodes, { text: 'sign in' }).node.resourceId, 'com.example:id/login');
  assert.equal(findNode(nodes, { text: 'google' }).node.text, 'Sign in with Google & more');
  assert.equal(findNode(nodes, { resourceId: 'email' }).node.description, 'Email');
  assert.equal(findNode(nodes, { text: 'missing' }).node, null);
});

test('waitForNode observes matching nodes appearing and disappearing without a live device', async () => {
  const nodes = parseUiHierarchy(XML);
  const appearing = new Device('emulator-test');
  appearing.uiNodes = async () => nodes;
  assert.equal((await appearing.waitForNode({ text: 'Sign in' }, { timeoutMs: 100 })).node.resourceId, 'com.example:id/login');

  const disappearing = new Device('emulator-test');
  const frames = [nodes, []];
  disappearing.uiNodes = async () => frames.shift() ?? [];
  assert.deepEqual(await disappearing.waitForNode({ description: 'Email' }, { state: 'disappears', timeoutMs: 500 }), { node: null, matches: 0 });
});

test('waitForNode gives a busy hierarchy its remaining caller budget', async () => {
  const device = new Device('emulator-test');
  let timeoutMs;
  device.uiNodes = async (options) => {
    timeoutMs = options.timeoutMs;
    return parseUiHierarchy(XML);
  };
  await device.waitForNode({ text: 'Sign in' }, { timeoutMs: 5_000 });
  assert.ok(timeoutMs > 3_000);
});

test('waitForNode turns a deadline dump timeout into its wait diagnostic', async () => {
  const device = new Device('emulator-test');
  const timeouts = [];
  device.uiNodes = async ({ timeoutMs }) => {
    timeouts.push(timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    throw new Error('adb exec-out failed on emulator-test (exit 124)');
  };
  await assert.rejects(device.waitForNode({ resourceId: 'missing' }, { timeoutMs: 20 }), /Timed out after 20ms waiting for UI node to appear/);
  assert.ok(timeouts.length > 0);
  assert.ok(timeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 20));
  await assert.rejects(device.waitForNode({ text: 'missing' }, { timeoutMs: 0 }), /timeoutMs must be an integer between 1 and 30000/);
});

test('tap emits a same-point swipe for a bounded long press and validates input', async () => {
  const device = new Device('emulator-test');
  const commands = [];
  device.shell = async (command) => commands.push(command);
  await device.tap(12.2, 4.7, 800);
  assert.deepEqual(commands, ['input swipe 12 5 12 5 800']);
  await assert.rejects(device.tap(Number.NaN, 4), /x and y must be finite/);
  await assert.rejects(device.tap(1, 2, 10_001), /durationMs must be an integer from 1 to 10000/);
});

test('scrollTo finds one named element with bounded swipes and taps only when requested', async () => {
  const device = new Device('emulator-test');
  const nodes = parseUiHierarchy(XML);
  const frames = [[], nodes];
  const swipes = [];
  const taps = [];
  device.uiNodes = async () => frames.shift() ?? nodes;
  device.screenSize = async () => ({ width: 1_000, height: 2_000 });
  device.swipe = async (...args) => swipes.push(args);
  device.tap = async (...args) => taps.push(args);

  const result = await device.scrollTo({ text: 'Sign in' }, { maxSwipes: 1, tap: true });
  assert.equal(result.node.resourceId, 'com.example:id/login');
  assert.equal(result.swipes, 1);
  assert.deepEqual(swipes, [[500, 1_600, 500, 400, 300]]);
  assert.deepEqual(taps, [[540, 1050]]);
});

test('scrollTo fails clearly for ambiguous targets, an unchanged viewport, or invalid bounds', async () => {
  const nodes = parseUiHierarchy(XML);
  const ambiguous = new Device('emulator-test');
  ambiguous.uiNodes = async () => [nodes[0], { ...nodes[0], index: 99 }];
  await assert.rejects(ambiguous.scrollTo({ text: 'Sign in' }), /More than one visible UI node/);

  const unchanged = new Device('emulator-test');
  unchanged.uiNodes = async () => nodes;
  unchanged.screenSize = async () => ({ width: 1_000, height: 2_000 });
  unchanged.swipe = async () => {};
  await assert.rejects(unchanged.scrollTo({ text: 'Missing' }), /UI did not change after swipe 1/);
  await assert.rejects(unchanged.scrollTo({ text: 'Missing' }, { maxSwipes: 11 }), /maxSwipes must be an integer from 1 to 10/);
});

test('observe keeps successful reads when the UI hierarchy is unavailable', async () => {
  const device = new Device('emulator-test');
  device.screenshot = async () => Buffer.from('png');
  device.uiNodes = async () => { throw new Error('uiautomator is busy'); };
  device.foregroundActivity = async () => 'com.example/.MainActivity';
  const observed = await device.observe();
  assert.deepEqual(observed.screenshot, Buffer.from('png'));
  assert.equal(observed.nodes, null);
  assert.equal(observed.foregroundActivity, 'com.example/.MainActivity');
  assert.deepEqual(observed.errors, { uiNodes: 'uiautomator is busy' });
});

test('app controls only validate qualified package and permission names before issuing explicit commands', async () => {
  const device = new Device('emulator-test');
  const commands = [];
  device.shell = async (command) => commands.push(command);
  device.open = async ({ packageName }) => `opened ${packageName}`;

  assert.deepEqual(await device.app({ action: 'restart', packageName: 'com.example.app' }), {
    action: 'restart', packageName: 'com.example.app', output: 'opened com.example.app',
  });
  assert.deepEqual(await device.app({ action: 'grant_permission', packageName: 'com.example.app', permission: 'android.permission.CAMERA' }), {
    action: 'grant_permission', packageName: 'com.example.app', permission: 'android.permission.CAMERA',
  });
  assert.deepEqual(commands, [
    "am force-stop 'com.example.app'",
    "pm grant 'com.example.app' 'android.permission.CAMERA'",
  ]);
  await assert.rejects(device.app({ action: 'stop', packageName: 'com.example.app; rm -rf /' }), /qualified Android package name/);
  await assert.rejects(device.app({ action: 'revoke_permission', packageName: 'com.example.app', permission: 'CAMERA' }), /qualified Android permission name/);
  await assert.rejects(device.app({ action: 'stop', packageName: 'com.example.app', permission: 'android.permission.CAMERA' }), /only valid for grant_permission or revoke_permission/);
});

test('keys resolve by name, alias, KEYCODE_ prefix, or number', () => {
  assert.deepEqual(['back', 'RECENTS', 'KEYCODE_ENTER', '26', 187].map(resolveKeycode), [4, 187, 66, 26, 187]);
  assert.throws(() => resolveKeycode('LAUNCH_MISSILES'), /Unknown key/);
});

test('scoped adb rejects commands that could target another device', async () => {
  await assert.rejects(scopedAdb('emulator-5600', ['-s', 'emulator-5554', 'shell', 'ls']), /global options/);
  await assert.rejects(scopedAdb('emulator-5600', ['kill-server']), /outside this thread/);
  await assert.rejects(scopedAdb('emulator-5600', []), /non-empty array/);
});

test('avd and adb device parsing ignores emulator log noise', () => {
  assert.deepEqual(parseAvdList('INFO    | Storing crashdata\nPixel_9a\nPixel_Tablet\n'), ['Pixel_9a', 'Pixel_Tablet']);
  assert.deepEqual(parseAdbDevices('List of devices attached\nemulator-5554\tdevice\nemulator-5600\toffline\n\n'), [
    { serial: 'emulator-5554', state: 'device' },
    { serial: 'emulator-5600', state: 'offline' },
  ]);
});

test('port choice skips serials in use and ports that are not free', async () => {
  const busy = new Set([5603]);
  const port = await choosePort(new Set(['emulator-5600']), async (candidate) => !busy.has(candidate));
  assert.equal(port, 5604);
});

test('fold posture settings use emulator posture IDs and reject invalid values before changing anything', async () => {
  const device = new Device('emulator-test');
  const commands = [];
  device.emu = async (args) => { commands.push(args); return 'OK'; };
  for (const posture of ['folded', 'half-folded', 'unfolded']) await device.applySettings({ posture });
  assert.deepEqual(commands, [['posture', '1'], ['posture', '2'], ['posture', '3']]);
  await assert.rejects(device.applySettings({ posture: 'tent', darkMode: true }), /posture must be/);
  assert.equal(commands.length, 3);
  device.emu = async () => { throw new Error('KO: Failed to set posture'); };
  await assert.rejects(device.applySettings({ posture: 'folded' }), /Failed to set posture/);
});

test("fold posture reads Android's committed state and leaves unknown readings unselected", async () => {
  const device = new Device('emulator-test');
  for (const [name, expected] of [['CLOSED', 'folded'], ['HALF_OPENED', 'half-folded'], ['OPENED', 'unfolded'], ['REAR_DISPLAY_MODE', null]]) {
    device.shell = async (command) => {
      assert.equal(command, 'cmd device_state state');
      return { stdout: `Committed state: DeviceState{identifier=1, name='${name}', app_accessible=true}\n` };
    };
    assert.equal(await device.posture(), expected);
  }
});

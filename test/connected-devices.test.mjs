import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectedDeviceCatalog } from '../runtime/core/lib/connected-devices.mjs';

test('connected inventory omits emulators and labels unavailable transports without querying them', async () => {
  const calls = [];
  const catalog = createConnectedDeviceCatalog({
    listDevices: async () => [
      { serial: 'emulator-5600', state: 'device' },
      { serial: 'USB_TEST', state: 'device', model: 'Example_Phone', product: 'example', device: 'sample', transport_id: '3' },
      { serial: 'USB_UNAUTHORIZED', state: 'unauthorized' },
      { serial: '192.0.2.1:5555', state: 'offline', model: 'Other_Phone' },
    ],
    runAdb: async (serial, args) => { calls.push([serial, args]); return { code: 0, stdout: 'HARDWARE_TEST\n' }; },
  });
  const devices = await catalog.list();
  assert.deepEqual(devices.map(device => [device.serial, device.state, device.label]), [
    ['USB_TEST', 'device', 'Example Phone'], ['USB_UNAUTHORIZED', 'unauthorized', 'USB UNAUTHORIZED'], ['192.0.2.1:5555', 'offline', 'Other Phone'],
  ]);
  assert.equal(devices[0].kind, 'physical');
  assert.equal(devices[0].transport_id, '3');
  assert.equal(devices[0].hardwareId, 'HARDWARE_TEST');
  assert.equal(devices[1].hardwareId, null);
  assert.deepEqual(calls, [['USB_TEST', ['shell', 'getprop', 'ro.serialno']]]);
  assert.doesNotMatch(JSON.stringify(devices), /HARDWARE_TEST|hardwareId/);
  assert.equal({ ...devices[0] }.hardwareId, undefined);
});

test('USB and wireless aliases retain the same private hardware identity', async () => {
  const catalog = createConnectedDeviceCatalog({
    listDevices: async () => [{ serial: 'USB_TEST', state: 'device' }, { serial: '192.0.2.1:5555', state: 'device' }],
    runAdb: async () => ({ code: 0, stdout: 'SHARED_HARDWARE_TEST\n' }),
  });
  const [usb, wireless] = await catalog.list();
  assert.notEqual(usb.serial, wireless.serial);
  assert.equal(usb.hardwareId, wireless.hardwareId);
  assert.equal(usb.hardwareId, 'SHARED_HARDWARE_TEST');
});

test('hardware identity falls back to the boot serial after placeholders, errors, or truncated replies', async () => {
  const primaryReplies = ['', ' unknown\n', 'UNKNOWN', 'null', '00000000', '0000-0000-0000', 'https://private/?token=secret'];
  const rows = primaryReplies.map((_, index) => ({ serial: `USB_${index}`, state: 'device' }));
  rows.push({ serial: 'USB_ERROR', state: 'device' }, { serial: 'USB_TRUNCATED', state: 'device' }, { serial: 'USB_FAILED', state: 'device' });
  const calls = [];
  const catalog = createConnectedDeviceCatalog({ listDevices: async () => rows, runAdb: async (serial, args, options) => {
    calls.push({ serial, property: args[2] });
    assert.ok(options.timeoutMs <= 2_000);
    assert.ok(options.maxBytes <= 1_024);
    if (args[2] === 'ro.boot.serialno') return { code: 0, stdout: `BOOT_${serial}` };
    if (serial === 'USB_ERROR') throw new Error('transport disappeared');
    if (serial === 'USB_TRUNCATED') return { code: 0, stdout: 'INCOMPLETE', truncated: true };
    if (serial === 'USB_FAILED') return { code: 1, stdout: 'FAILED_OUTPUT' };
    return { code: 0, stdout: primaryReplies[Number(serial.slice(4))] };
  } });
  const devices = await catalog.list();
  assert.equal(calls.length, rows.length * 2);
  assert.deepEqual(devices.map(device => device.hardwareId), rows.map(row => `BOOT_${row.serial}`));
});

test('identity probe failure leaves the transport listed without manufacturing a shared identity', async () => {
  const catalog = createConnectedDeviceCatalog({
    listDevices: async () => [{ serial: 'USB_TEST', state: 'device' }],
    runAdb: async () => ({ code: 0, stdout: '000000' }),
  });
  const [device] = await catalog.list();
  assert.equal(device.serial, 'USB_TEST');
  assert.equal(device.state, 'device');
  assert.equal(device.hardwareId, null);
});

test('inventory requests coalesce, expire, and can force an early refresh', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  let release;
  let calls = 0;
  const catalog = createConnectedDeviceCatalog({ ttlMs: 3_000, listDevices: async () => {
    calls += 1;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return [{ serial: 'USB_TEST', state: calls === 1 ? 'offline' : 'unauthorized' }];
  } });
  const first = catalog.list();
  const second = catalog.list({ fresh: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await first, await second);
  assert.equal((await catalog.list())[0].state, 'offline');
  assert.equal(calls, 1);
  assert.equal((await catalog.list({ fresh: true }))[0].state, 'unauthorized');
  assert.equal(calls, 2);
  t.mock.timers.tick(2_999);
  await catalog.list();
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  await catalog.list();
  assert.equal(calls, 3);
});

test('listing failures propagate to all waiters and are not cached as an empty inventory', async () => {
  let calls = 0;
  const catalog = createConnectedDeviceCatalog({ listDevices: async () => {
    calls += 1;
    if (calls === 1) throw new Error('ADB server unavailable');
    return [];
  } });
  const results = await Promise.allSettled([catalog.list(), catalog.list()]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'ADB server unavailable'));
  assert.deepEqual(await catalog.list(), []);
  assert.equal(calls, 2);
  const invalid = createConnectedDeviceCatalog({ listDevices: async () => null });
  await assert.rejects(invalid.list(), /ADB did not return a device list/);
});

test('failed forced refresh expires the previous inventory instead of serving it as current', async () => {
  let calls = 0;
  const catalog = createConnectedDeviceCatalog({ listDevices: async () => {
    calls += 1;
    if (calls === 2) throw new Error('ADB server unavailable');
    return [{ serial: 'USB_TEST', state: calls === 1 ? 'offline' : 'unauthorized' }];
  } });
  await catalog.list();
  await assert.rejects(catalog.list({ fresh: true }), /ADB server unavailable/);
  assert.equal((await catalog.list())[0].state, 'unauthorized');
  assert.equal(calls, 3);
});

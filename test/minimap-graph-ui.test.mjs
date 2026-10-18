import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeGraph } from '../runtime/core/web/screen-graph.mjs';

const source = fs.readFileSync(new URL('../runtime/core/web/app.js', import.meta.url), 'utf8');
const screenMap = source.slice(source.indexOf('// ---- Screen map'), source.indexOf('async function runAction('));
const events = source.slice(source.indexOf("$('minimap-close').addEventListener"), source.indexOf("$('snapshot-form').addEventListener"));
const graph = (ids = ['home', 'detail']) => ({ schema_version: 'minimap.screen-graph.v1', places: ids.map(id => ({ id, slug: id, label: id })), edges: ids.length > 1 ? [{ id: 'open', from: ids[0], to: ids[1], steps: 1, requiresHistory: false }] : [] });
const result = value => ({ structuredContent: { graph: value, graphStatus: { status: 'ok', message: 'Saved graph.' } } });

function fixture() {
  const nodes = new Map(), calls = [], mounts = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, children: [], attributes: {}, dataset: {}, listeners: new Map(), classList: { toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      focus() { this.focused = true; },
    });
    return nodes.get(id);
  };
  const context = vm.createContext({ $, normalizeGraph, console,
    element: (tag, props = {}, children = []) => ({ tag, ...props, children, addEventListener() {} }),
    mountScreenGraph(container, input, options) {
      let selected = input.places.some(p => p.id === options.selectedID) ? options.selectedID : input.places[0]?.id;
      const mounted = { input, options, getSelection: () => selected, destroy() { container.replaceChildren(); },
        choose(id) { selected = id; options.onSelect(id); } };
      mounts.push(mounted); return mounted;
    },
    call: async (tool, args) => { calls.push({ tool, args }); return context.reply(tool, args); },
  });
  context.reply = () => ({});
  vm.runInContext(`
    let minimapMap = null, minimapBusyUI = false, minimapCancelling = false, minimapRefreshId = 0;
    let minimapGraph = null, minimapGraphStatus = {status:'uninitialized',message:'No saved graph.'}, minimapGraphLoading = false;
    let minimapGraphViewer = null, minimapGraphFingerprint = null, minimapGraphSelection = null, minimapView = 'graph';
    let minimapEnabled = true, minimapSettingsUpdating = false, minimapSettingsTarget = null, minimapSettingsError = '', minimapLifecycleId = 0;
    let minimapSettingsRevision = null, minimapConfirmedEnabled = null;
    let lastStatus = {emulator:{state:'ready'}}, connected = true;
    const minimapDrawer = $('minimap-drawer'), drawer = $('drawer'), pretty = value => value.replaceAll('_',' ');
    ${screenMap}
    ${events}
  `, context);
  const run = code => vm.runInContext(code, context);
  const load = (value = graph()) => {
    context.next = result(value);
    context.map = { initialized: true, projectName: 'Fixture', packageName: 'example.fixture', places: value.places, edges: value.edges, currentPlace: value.places[0]?.id };
    run('minimapMap = map; applyMinimapGraphResult(next); renderMinimap();');
  };
  return { $, calls, mounts, context, run, load };
}

test('graph selection only inspects; Go deliberately uses the existing device channel', async () => {
  const p = fixture(); p.load();
  p.mounts[0].choose('detail');
  assert.equal(p.run('minimapMap.currentPlace'), 'home');
  assert.equal(p.$('minimap-current').textContent, 'home');
  assert.equal(p.calls.length, 0);
  assert.match(p.$('minimap-graph-selected').textContent, /inspection: detail/);
  p.$('minimap-graph-go').listeners.get('click')();
  await new Promise(setImmediate);
  assert.equal(p.calls[0].tool, 'emulator_navigate');
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls[0].args)), { action: 'go', target: 'detail' });
});

test('automatic graph refresh preserves navigation outcomes and failures on a legacy CLI', async () => {
  for (const fails of [false, true]) {
    const p = fixture(); p.load();
    const refreshedMap = { ...p.context.map, places: [...p.context.map.places, { id: 'new', label: 'New', slug: 'new' }] };
    p.context.reply = (_tool, args) => {
      if (args.action === 'go') {
        if (fails) throw new Error('Navigation interrupted. Inspect the device before continuing.');
        return { structuredContent: { result: { status: 'no_known_path', summary: 'No saved path to Detail.' }, map: p.context.map } };
      }
      if (args.action === 'status') return { structuredContent: { map: refreshedMap } };
      return { structuredContent: { graph: null, graphStatus: { status: 'unsupported', message: 'This CLI does not support graph export.' } } };
    };
    await p.run("runMinimapAction({action:'go',target:'detail'},'Navigation finished.')");
    await new Promise(setImmediate);
    assert.equal(p.$('minimap-status').textContent, fails ? 'Navigation interrupted. Inspect the device before continuing.' : 'no known path: No saved path to Detail.');
    assert.equal(p.run('minimapMap.places.length'), 3, 'saved navigation metadata must still refresh');
    assert.equal(p.run('minimapGraphStatus.status'), 'unsupported');
    assert.deepEqual(p.calls.map(({ args }) => args.action), ['go', 'status', 'graph']);
    await p.run('refreshMinimap()');
    assert.equal(p.$('minimap-status').textContent, 'Screen map refreshed.', 'a deliberate refresh may replace the outcome');
  }
});

test('automatic graph refresh preserves the cancellation result', async () => {
  const p = fixture(); p.load();
  p.context.reply = (_tool, args) => args.action === 'graph'
    ? result(graph()) : { structuredContent: { map: p.context.map } };
  await p.$('minimap-cancel').listeners.get('click')();
  await new Promise(setImmediate);
  assert.equal(p.$('minimap-status').textContent, 'Navigation stopped.');
  assert.deepEqual(p.calls.map(({ args }) => args.action), ['cancel', 'status', 'graph']);
});

test('empty, unsupported, error and invalid graphs show honest states without invented nodes', () => {
  const p = fixture(); p.load();
  for (const status of ['uninitialized', 'unsupported', 'unavailable', 'error']) {
    p.context.next = { structuredContent: { graph: null, graphStatus: { status, message: status } } };
    p.run('applyMinimapGraphResult(next)');
    assert.equal(p.$('minimap-graph').hidden, true);
    assert.equal(p.$('minimap-graph-go').disabled, true);
    assert.equal(p.$('minimap-graph-status').textContent, status);
  }
  p.load(graph([]));
  assert.equal(p.mounts.at(-1).input.places.length, 0);
  assert.equal(p.$('minimap-graph-selection').hidden, true);
  p.context.next = result({ schema_version: 'other', places: [], edges: [] });
  p.run('applyMinimapGraphResult(next)');
  assert.equal(p.$('minimap-graph').hidden, true);
  assert.match(p.$('minimap-graph-status').textContent, /invalid/);
});

test('refresh preserves selection when unchanged, falls back if removed and resets on app association changes', () => {
  const p = fixture(); p.load(); p.mounts[0].choose('detail');
  p.load(); assert.equal(p.mounts.length, 1); assert.equal(p.run('minimapGraphSelection'), 'detail');
  p.load(graph(['home'])); assert.equal(p.run('minimapGraphSelection'), 'home');
  p.context.nextMap = { structuredContent: { map: { projectName: 'Other', packageName: 'other.app', places: [], edges: [] } } };
  p.run("applyMinimapResult(nextMap, 'refreshed')");
  assert.equal(p.run('minimapGraphSelection'), null);
  assert.equal(p.run('minimapGraph'), null);
});

test('busy, disconnected and unmatched map metadata disable graph Go without changing last located', () => {
  const p = fixture(); p.load();
  for (const change of ['minimapMap.busy = true', "lastStatus.emulator.state = 'disconnected'", 'connected = false', 'minimapMap.places = []']) {
    p.run(`${change}; renderMinimapGraphSelection();`);
    assert.equal(p.$('minimap-graph-go').disabled, true);
    assert.equal(p.run('minimapMap.currentPlace'), 'home');
    p.load(); p.run("lastStatus.emulator.state = 'ready'; connected = true");
  }
});

test('graph and navigation tabs support arrows/Home/End with focus and ARIA state', () => {
  const p = fixture(); p.load();
  const press = key => p.$('minimap-graph-tab').listeners.get('keydown')({ key, preventDefault() {} });
  press('End');
  assert.equal(p.$('minimap-navigation-tab').attributes['aria-selected'], 'true');
  assert.equal(p.$('minimap-navigation-tab').focused, true);
  assert.equal(p.$('minimap-graph-panel').hidden, true);
  press('Home');
  assert.equal(p.$('minimap-graph-tab').tabIndex, 0);
  assert.equal(p.$('minimap-navigation-tab').tabIndex, -1);
  assert.equal(p.$('minimap-navigation-panel').hidden, true);
  assert.equal(p.calls.length, 0);
});

test('new refresh and closing invalidate earlier graph/status responses', async () => {
  const p = fixture(); p.load();
  const pending = [];
  p.context.reply = (_tool, args) => new Promise(resolve => pending.push({ args, resolve }));
  const first = p.run('refreshMinimap()');
  const second = p.run('refreshMinimap()');
  pending[2].resolve({ structuredContent: { map: p.context.map } });
  pending[3].resolve(result(graph(['new'])));
  await second;
  pending[0].resolve({ structuredContent: { map: p.context.map } });
  pending[1].resolve(result(graph(['old'])));
  await first;
  assert.equal(p.run('minimapGraph.places[0].id'), 'new');
  const closing = p.run('refreshMinimap()'); p.run('closeMinimap()');
  pending[4].resolve({}); pending[5].resolve(result(graph(['closed']))); await closing;
  assert.equal(p.run('minimapGraph.places[0].id'), 'new');
});

test('two fixed-device frame instances retain independent inspection selections', () => {
  const a = fixture(), b = fixture(); a.load(); b.load();
  a.mounts[0].choose('detail');
  assert.equal(a.run('minimapGraphSelection'), 'detail');
  assert.equal(b.run('minimapGraphSelection'), 'home');
  assert.equal(a.calls.length + b.calls.length, 0);
});

test('disabled Minimap clears stale graphs and every panel navigation entry point is inert', async () => {
  const p = fixture(); p.load();
  p.run('applyMinimapSettings({minimapEnabled:false}); openMinimap()');
  await p.run('refreshMinimap()');
  await p.run("runMinimapAction({action:'whereami'},'located')");
  p.run("navigateToPlace('detail')");
  await p.$('minimap-cancel').listeners.get('click')();
  p.$('minimap-graph-go').listeners.get('click')();
  assert.equal(p.calls.length, 0);
  assert.equal(p.run('minimapMap'), null);
  assert.equal(p.run('minimapGraph'), null);
  assert.equal(p.run('minimapGraphViewer'), null);
  assert.equal(p.$('minimap-enabled').checked, false);
  assert.equal(p.$('minimap-disabled').hidden, false);
  assert.equal(p.$('minimap-refresh').disabled, true);
  assert.equal(p.$('minimap-locate').disabled, true);
  assert.equal(p.$('minimap-graph-go').disabled, true);
  assert.match(p.$('minimap-status').textContent, /tracking is off/);
});

test('panel toggle saves through native settings, suppresses work while saving, and enables only an open map', async () => {
  const p = fixture(); p.load();
  let save;
  p.context.reply = (tool, args) => tool === 'settings_update'
    ? new Promise(resolve => { save = resolve; })
    : args.action === 'graph' ? result(graph()) : { structuredContent: { map: p.context.map } };
  const disable = p.$('minimap-enabled').listeners.get('change')({ target: { checked: false } });
  assert.equal(p.run('minimapEnabled'), false);
  assert.equal(p.$('minimap-enabled').disabled, true);
  p.run('applyMinimapSettings({minimapEnabled:true})');
  await p.run('refreshMinimap()');
  assert.equal(p.calls.length, 1, 'a stale enabled status must not start graph work during disable');
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls[0])), { tool: 'settings_update', args: { set: { minimapEnabled: false } } });
  save({ structuredContent: { values: { minimapEnabled: false } } }); await disable;
  assert.equal(p.$('minimap-enabled').disabled, false);
  const enable = p.$('minimap-enable').listeners.get('click')();
  assert.equal(p.run('minimapEnabled'), false, 'enabling waits for saved confirmation');
  save({ structuredContent: { values: { minimapEnabled: true } } }); await enable;
  await new Promise(setImmediate);
  assert.deepEqual(p.calls.map(({ tool, args }) => args?.action ?? tool), ['settings_update', 'settings_update', 'status', 'graph']);
  p.run('closeMinimap(); applyMinimapSettings({minimapEnabled:false}); applyMinimapSettings({minimapEnabled:true})');
  assert.equal(p.calls.length, 4, 'a closed map does not load on enable');
});

test('disable invalidates pending graph responses even if tracking is re-enabled first', async () => {
  const p = fixture(); p.load();
  const pending = [];
  p.context.reply = (_tool, args) => new Promise(resolve => pending.push({ args, resolve }));
  const old = p.run('refreshMinimap()');
  p.run('applyMinimapSettings({minimapEnabled:false}); applyMinimapSettings({minimapEnabled:true})');
  pending[2].resolve({ structuredContent: { map: p.context.map } });
  pending[3].resolve(result(graph(['fresh'])));
  await new Promise(setImmediate);
  pending[0].resolve({ structuredContent: { map: p.context.map } });
  pending[1].resolve(result(graph(['stale']))); await old;
  assert.equal(p.run('minimapGraph.places[0].id'), 'fresh');
});

for (const action of ['go', 'cancel']) {
  test(`disabling during ${action} ignores its late result and starts no follow-up requests`, async () => {
    const p = fixture(); p.load();
    let finish;
    p.context.reply = () => new Promise(resolve => { finish = resolve; });
    const running = action === 'cancel' ? p.$('minimap-cancel').listeners.get('click')()
      : p.run("runMinimapAction({action:'go',target:'detail'},'finished')");
    p.run('applyMinimapSettings({minimapEnabled:false})');
    finish({ structuredContent: { map: p.context.map } }); await running;
    assert.equal(p.calls.length, 1);
    assert.equal(p.run('minimapMap'), null);
    assert.match(p.$('minimap-status').textContent, /tracking is off/);
  });
}

test('an uncertain setting save stays off until confirmed state can be read', async () => {
  const p = fixture(); p.load();
  p.context.reply = () => { throw new Error('Connection interrupted'); };
  await p.run('updateMinimapSetting(false)');
  assert.equal(p.run('minimapEnabled'), false);
  assert.deepEqual(p.calls.map(({ tool }) => tool), ['settings_update', 'settings_read']);
  assert.match(p.$('minimap-setting-status').textContent, /Connection interrupted/);
  p.context.reply = (tool, args) => tool === 'settings_read'
    ? { structuredContent: { values: { minimapEnabled: false } } }
    : (() => { throw new Error('Could not save'); })();
  await p.run('updateMinimapSetting(true)');
  assert.equal(p.run('minimapEnabled'), false);
  assert.equal(p.calls.filter(({ tool }) => tool === 'emulator_navigate').length, 0);
});

test('delayed enabled status from before a saved disable cannot re-enable Minimap or request graphs', async () => {
  const p = fixture(); p.load();
  p.run('applyMinimapSettings({minimapEnabled:true}, 4)');
  p.context.reply = () => ({ structuredContent: { values: { minimapEnabled: false }, revision: 5 } });
  await p.run('updateMinimapSetting(false)');
  p.run('applyMinimapSettings({minimapEnabled:true}, 4); applyMinimapSettings({minimapEnabled:true}); openMinimap()');
  await p.run('refreshMinimap()');
  assert.equal(p.run('minimapSettingsRevision'), 5);
  assert.equal(p.run('minimapEnabled'), false);
  assert.equal(p.$('minimap-enabled').checked, false);
  assert.deepEqual(p.calls.map(({ tool }) => tool), ['settings_update']);
});

test('newer external settings win over a delayed earlier save reply', async () => {
  const p = fixture(); p.load();
  let finish;
  p.context.reply = () => new Promise(resolve => { finish = resolve; });
  const disabling = p.run('updateMinimapSetting(false)');
  p.run('applyMinimapSettings({minimapEnabled:true}, 7)');
  assert.equal(p.run('minimapEnabled'), false, 'suppress new work until the pending disable finishes');
  p.run('closeMinimap()');
  finish({ structuredContent: { values: { minimapEnabled: false }, revision: 6 } });
  await disabling;
  assert.equal(p.run('minimapEnabled'), true);
  assert.equal(p.run('minimapSettingsRevision'), 7);
  assert.equal(p.calls.length, 1, 'a closed map stays idle');
  p.run('applyMinimapSettings({minimapEnabled:false}, 6)');
  assert.equal(p.run('minimapEnabled'), true);
});

test('settings read reconciliation also rejects an older revision', async () => {
  const p = fixture(); p.load();
  p.run('applyMinimapSettings({minimapEnabled:false}, 5)');
  p.context.reply = tool => {
    if (tool === 'settings_update') throw new Error('Connection interrupted');
    return { structuredContent: { values: { minimapEnabled: true }, revision: 4 } };
  };
  await p.run('updateMinimapSetting(true)');
  assert.equal(p.run('minimapEnabled'), false);
  assert.equal(p.run('minimapSettingsRevision'), 5);
  assert.deepEqual(p.calls.map(({ tool }) => tool), ['settings_update', 'settings_read']);
});

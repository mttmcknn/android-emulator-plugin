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
    if (!nodes.has(id)) nodes.set(id, { hidden: false, children: [], attributes: {}, listeners: new Map(), classList: { toggle() {} },
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { panelResource } from '../runtime/mcp/resources.mjs';

const webDir = fileURLToPath(new URL('../runtime/core/web', import.meta.url));

test('MCP panel contains its graph renderer and styles without resource requests', () => {
  const resource = panelResource({ uri: 'ui://graph-test', view: 'device', webDir });
  assert.doesNotMatch(resource.text, /(?:href|src)="\/static\/(?:screen-graph\.(?:mjs|css)|app\.(?:js|css))"/);
  const module = resource.text.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(module);
  assert.doesNotMatch(module, /^\s*import /m);
  assert.match(module, /function mountScreenGraph/);
  assert.match(module, /function normalizeGraph/);
  // Compilation catches lexical collisions between renderer and panel code.
  assert.doesNotThrow(() => new vm.Script(module.replace(/^export /gm, '')));
  assert.ok(resource.text.includes(fs.readFileSync(path.join(webDir, 'screen-graph.css'), 'utf8')));
  assert.deepEqual(resource._meta.ui.csp.resourceDomains, []);
  assert.deepEqual(resource._meta.ui.csp.frameDomains, ['blob:']);
});

test('launcher and device resources preserve host appearance and isolated graph scope', () => {
  for (const view of ['device', 'launcher']) {
    const { text } = panelResource({ uri: 'ui://graph-test', view, webDir, theme: 'dark' });
    assert.match(text, /<meta name="emulator-theme" content="&quot;dark&quot;"/);
    assert.ok(text.includes(`<body data-view="${view}">`));
    assert.match(text, /const \{ mountScreenGraph, normalizeGraph \} = \(\(\) => \{/);
    assert.match(text, /const deviceTemplate = !deviceFrame \? document.documentElement.cloneNode\(true\)/);
  }
});

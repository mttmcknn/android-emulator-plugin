import fs from 'node:fs';
import path from 'node:path';
import { themeAttribute } from '../core/lib/appearance.mjs';

// No network dependency: the host script, graph renderer and shared panel are
// inlined. Device comparison frames clone this HTML into blob URLs, so relative
// module imports cannot work there even when the daemon serves them normally.
export function panelResource({ uri, view, webDir, panelScript, theme = null, meta = {} }) {
  const read = name => fs.readFileSync(path.join(webDir, name), 'utf8');
  const graphModule = read('screen-graph.mjs').replace(/^export /gm, '');
  const panelModule = read('app.js').replace(
    "import { mountScreenGraph, normalizeGraph } from './screen-graph.mjs';",
    () => `const { mountScreenGraph, normalizeGraph } = (() => {\n${graphModule}\nreturn { mountScreenGraph, normalizeGraph };\n})();`,
  );
  const html = read('index.html')
    .replace('<link rel="stylesheet" href="/static/app.css" />', () => `<style>${read('app.css')}</style>`)
    .replace('<link rel="stylesheet" href="/static/screen-graph.css" />', () => `<style>${read('screen-graph.css')}</style>`)
    .replace('<script src="/host/panel.js"></script>', () => panelScript ? `<script>${fs.readFileSync(panelScript, 'utf8')}</script>` : '')
    .replace('<script type="module" src="/static/app.js"></script>', () => `<script type="module">${panelModule}</script>`)
    .replace('<meta name="emulator-theme" content="" />', () => `<meta name="emulator-theme" content="${themeAttribute(theme)}" />`)
    .replace('<body>', `<body data-view="${view}">`);
  return { uri, mimeType: 'text/html;profile=mcp-app', text: html,
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], ...(view === 'device' ? { frameDomains: ['blob:'] } : {}) }, prefersBorder: false }, ...meta } };
}

export function mentionResource(uri) {
  const match = uri.match(/^emulator:\/\/(avd|app)\/(.+)$/);
  if (!match) return null;
  const name = decodeURIComponent(match[2]);
  const text = match[1] === 'avd'
    ? `Android virtual device "${name}". Start it for this chat using this name as avd.`
    : `Android app "${name}", installed on this chat's device. Open it using this name as packageName.`;
  return { uri, mimeType: 'text/plain', text };
}

import fs from 'node:fs';
import path from 'node:path';
import { themeAttribute } from '../core/lib/appearance.mjs';

// No network dependency: the host script and shared panel are both inlined.
export function panelResource({ uri, view, webDir, panelScript, theme = null, meta = {} }) {
  const read = name => fs.readFileSync(path.join(webDir, name), 'utf8');
  const html = read('index.html')
    .replace('<link rel="stylesheet" href="/static/app.css" />', () => `<style>${read('app.css')}</style>`)
    .replace('<script src="/host/panel.js"></script>', () => panelScript ? `<script>${fs.readFileSync(panelScript, 'utf8')}</script>` : '')
    .replace('<script type="module" src="/static/app.js"></script>', () => `<script type="module">${read('app.js')}</script>`)
    .replace('<meta name="emulator-theme" content="" />', () => `<meta name="emulator-theme" content="${themeAttribute(theme)}" />`)
    .replace('<body>', `<body data-view="${view}">`);
  return { uri, mimeType: 'text/html;profile=mcp-app', text: html,
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false }, ...meta } };
}

export function mentionResource(uri) {
  const match = uri.match(/^emulator:\/\/(avd|app)\/(.+)$/);
  if (!match) return null;
  const name = decodeURIComponent(match[2]);
  const text = match[1] === 'avd'
    ? `Android virtual device "${name}". Start it for this chat with emulator_start {"avd": "${name}"}.`
    : `Android app "${name}", installed on this chat's emulator. Open it with emulator_open {"packageName": "${name}"}.`;
  return { uri, mimeType: 'text/plain', text };
}

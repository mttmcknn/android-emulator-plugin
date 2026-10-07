// Reads the Codex desktop appearance (light/dark/system and each mode's chrome colors) from $CODEX_HOME/config.toml,
// so the panel can use the same surface, ink, accent, contrast, and fonts as the rest of the app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const codexConfigFile = () => path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');

const COLOR = /^#[0-9a-f]{3,8}$/i;
const FONT = /^[\w .-]{1,64}$/;

// Minimal TOML reader for the `[desktop…]` tables: headers and `key = "string" | number | boolean` lines.
export function parseDesktopTables(text) {
  const tables = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1].trim().startsWith('desktop') ? (tables[header[1].trim()] ??= {}) : null;
      continue;
    }
    const pair = current && line.match(/^([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s#]+)\s*(?:#.*)?$/);
    if (!pair) continue;
    const [, key, value] = pair;
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) current[key] = JSON.parse(value);
    else if (value === 'true' || value === 'false') current[key] = value === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(value)) current[key] = Number(value);
  }
  return tables;
}

function chrome(table = {}, fonts = {}) {
  const color = (value) => (typeof value === 'string' && COLOR.test(value) ? value : null);
  const font = (value) => (typeof value === 'string' && FONT.test(value) ? value : null);
  const contrast = Number.isFinite(table.contrast) ? Math.min(100, Math.max(0, table.contrast)) : null;
  return { surface: color(table.surface), ink: color(table.ink), accent: color(table.accent), contrast, fontUi: font(fonts.ui), fontCode: font(fonts.code) };
}

// { mode: 'light' | 'dark' | 'system', light: {...}, dark: {...} }, or null when Codex has no readable config.
export function readCodexTheme(file = codexConfigFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const tables = parseDesktopTables(text);
  const desktop = tables.desktop ?? {};
  const mode = ['light', 'dark'].includes(desktop.appearanceTheme) ? desktop.appearanceTheme : 'system';
  const light = chrome(tables['desktop.appearanceLightChromeTheme'], tables['desktop.appearanceLightChromeTheme.fonts']);
  const dark = chrome(tables['desktop.appearanceDarkChromeTheme'], tables['desktop.appearanceDarkChromeTheme.fonts']);
  return { mode, light, dark };
}

export function watchTheme(listener) {
  const file = codexConfigFile();
  const onChange = () => listener(readCodexTheme());
  fs.watchFile(file, { interval: 1500, persistent: false }, onChange);
  return () => fs.unwatchFile(file, onChange);
}

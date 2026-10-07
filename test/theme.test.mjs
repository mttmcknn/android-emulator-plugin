import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCodexTheme } from '../runtime/hosts/codex/theme.mjs';
import { themeAttribute } from '../runtime/core/lib/appearance.mjs';

const CONFIG = `model = "x"
[desktop]
appearanceTheme = "dark" # comment
[desktop.appearanceLightChromeTheme]
accent = "#3d755d"
contrast = 45
ink = "#2f312d"
surface = "#f5f3ed"
[desktop.appearanceDarkChromeTheme]
accent = "red; background: url(x)"
surface = "#0f0f11"
[desktop.appearanceDarkChromeTheme.fonts]
ui = "Inter"
[projects."/tmp/x"]
surface = "#ffffff"
`;

test('reads each mode of the Codex chrome theme and rejects values that are not plain colors or font names', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theme-')), 'config.toml');
  fs.writeFileSync(file, CONFIG);
  const theme = readCodexTheme(file);
  assert.equal(theme.mode, 'dark');
  assert.deepEqual(theme.light, { surface: '#f5f3ed', ink: '#2f312d', accent: '#3d755d', contrast: 45, fontUi: null, fontCode: null });
  assert.deepEqual(theme.dark, { surface: '#0f0f11', ink: null, accent: null, contrast: null, fontUi: 'Inter', fontCode: null });
  assert.equal(readCodexTheme(path.join(path.dirname(file), 'missing.toml')), null);
  assert.doesNotMatch(themeAttribute(theme), /["<]/);
});

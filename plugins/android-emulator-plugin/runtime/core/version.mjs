import fs from 'node:fs';

export const RUNTIME_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

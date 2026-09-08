import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const assetsDir = join(root, 'plugins/saucers/client/assets');

const assets = {};
for (const key of ['a', 'b', 'c']) {
  assets[key] = readFileSync(join(assetsDir, `saucer-${key}.glb`)).toString('base64');
}

const moduleTs = readFileSync(join(root, 'client/src/render/skyEnvironment.ts'), 'utf8');
const moduleJs = stripTypeScriptTypes(moduleTs, { mode: 'strip' })
  .replace(/^export /gm, '');

const template = readFileSync(join(here, 'hangar.template.html'), 'utf8');
for (const marker of ['__SKY_ENVIRONMENT_MODULE__', '__ASSETS__']) {
  if (template.split(marker).length !== 2) throw new Error(`template must contain ${marker} exactly once`);
}
const html = template
  .replace('__SKY_ENVIRONMENT_MODULE__', () => moduleJs)
  .replace('__ASSETS__', () => JSON.stringify(assets));
const out = join(here, 'saucer-hangar.html');
writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1e6).toFixed(2)} MB`);

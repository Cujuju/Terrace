// Builds .saucer-hangar/saucer-hangar.html from the template: embeds the three
// GLBs as base64 and inlines the GAME'S sky-environment module (types stripped
// by Node, no bundler) so the viewer lights the hulls with the same code path.
//   node .saucer-hangar/embed.mjs
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
  // The type-only import of SkyRigState is erased by the strip; nothing else
  // in the file reaches outside `three`.
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

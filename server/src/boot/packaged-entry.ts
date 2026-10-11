// Packaged desktop entry. Node refuses to type-strip a workspace package copied under
// node_modules, and the package ships no symlinks, so the workspace import is mapped here.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHARED_PACKAGE_NAME = '@terrace/shared';
const sharedDir = resolve(import.meta.dirname, '..', '..', '..', 'shared');
const sharedManifest = JSON.parse(readFileSync(join(sharedDir, 'package.json'), 'utf8')) as {
  exports: { '.': string };
};
const sharedEntryUrl = pathToFileURL(join(sharedDir, sharedManifest.exports['.'])).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SHARED_PACKAGE_NAME) return { url: sharedEntryUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

await import('../index.ts');

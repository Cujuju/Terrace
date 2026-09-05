// Static build of preview-species.html into .smoke-shots/species/site — see
// shootSpeciesPreview.mjs for why a dev server is not enough on this drive.
//
// Roots are resolved from THIS FILE rather than written down, so the same
// config builds the shared checkout and any worktree of it — the twin of
// buildWildlifePreview.config.mjs, which already did.
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..');
export default defineConfig({
  root,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: resolve(repo, '.smoke-shots/species/site'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: { input: { preview: resolve(root, 'preview-species.html') } },
  },
});

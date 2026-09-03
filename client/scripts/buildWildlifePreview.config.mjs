// Static build of preview-wildlife.html into .smoke-shots/species/wired/site —
// the twin of buildSpeciesPreview.config.mjs, and there for the same reason
// (shootSpeciesPreview.mjs's header: Vite's dev server does not watch files on
// this drive, so an EDITED model is only reliably seen through a static build).
//
// Roots are resolved from THIS FILE rather than written down, so the same
// config builds the shared checkout and any worktree of it.
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
    outDir: resolve(repo, '.smoke-shots/species/wired/site'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: { input: { preview: resolve(root, 'preview-wildlife.html') } },
  },
});

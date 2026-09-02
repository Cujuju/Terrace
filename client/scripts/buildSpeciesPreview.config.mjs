// Static build of preview-species.html into .smoke-shots/species/site — see
// shootSpeciesPreview.mjs for why a dev server is not enough on this drive.
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
const root = resolve('/mnt/e/Development/Projects/Terrace/client');
export default defineConfig({
  root,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: resolve('/mnt/e/Development/Projects/Terrace/.smoke-shots/species/site'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: { input: { preview: resolve(root, 'preview-species.html') } },
  },
});

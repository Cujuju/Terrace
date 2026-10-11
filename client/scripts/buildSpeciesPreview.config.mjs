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

// Throwaway Vite config for AGENT SCREENSHOTS ONLY (not part of the app).
// A private port and a private dep cache, so iterating on a preview fixture
// never restarts — or shares optimizer state with — the stack the owner is
// running. TERRACE_WATCH=1 turns on the polling watcher this mount requires.
import base from './vite.config.ts';

export default {
  ...base,
  cacheDir: process.env['PREVIEW_SHOT_CACHE_DIR'] ?? './node_modules/.vite-preview-shot',
  server: { ...(base as { server?: object }).server, port: 5399, strictPort: true, host: '127.0.0.1' },
};

import { defineConfig } from 'vitest/config';
import base from '../vitest.base.config.ts';

// The shared settings, wrapped where `vitest/config` actually resolves —
// see vitest.base.config.ts for why the import cannot live there.
//
// THE CLIENT STAYS ON VITE'S RUNNER (2026-09-02). The base config hands module
// execution to Node itself, which is right for every package that ships to
// Node — but this one ships through Vite, and its code is entitled to Vite's
// semantics: src/config.ts reads `import.meta.env.DEV`, which only Vite
// provides, and it is the app's real contract, not something to bend for a
// test runner. Isolation stays on too: controlPrefs and hudState hold
// module-level state that a shared worker leaks between files (measured as
// order-dependent failures with `isolate: false`).
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    experimental: {
      ...base.test.experimental,
      viteModuleRunner: true,
    },
    isolate: true,
  },
});

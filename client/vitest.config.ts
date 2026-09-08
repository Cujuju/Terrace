import { defineConfig } from 'vitest/config';
import base from '../vitest.base.config.ts';

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

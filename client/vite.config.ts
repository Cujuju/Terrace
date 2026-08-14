// `vitest/config` re-exports Vite's defineConfig with the `test` block typed,
// so one file configures both the dev/build pipeline and the test runner.
import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: {
    // Colyseus owns 2567 (design doc §8 "Configuration"); keep the dev server
    // clear of it so both can run side by side.
    port: 5173,
  },
  test: {
    // Every client test is pure logic (see test/ — picking math, terrain mirror
    // diffs, chunk seams, colour ramp). Rendering is verified manually per
    // design doc §8 "Testing": no headless GL rig. So a plain node environment
    // is correct here — nothing under test touches the DOM or WebGL.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

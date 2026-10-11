export default {
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    experimental: {
      viteModuleRunner: false,
    },
    isolate: false,
  },
};

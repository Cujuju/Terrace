import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

it.each([
  ['https:', 'secure.example:8443', 'wss://secure.example:8443'],
  ['http:', 'local.example:2567', 'ws://local.example:2567'],
])('uses the page transport in production (%s)', async (protocol, host, expected) => {
  vi.resetModules();
  vi.stubEnv('DEV', false);
  vi.stubGlobal('location', { protocol, host, hostname: host.split(':')[0] });
  const config = await import('../src/config.ts');
  expect(config.DEFAULT_SERVER_URL).toBe(expected);
});

it('retains an explicit deployment endpoint', async () => {
  vi.resetModules();
  vi.stubEnv('DEV', false);
  vi.stubEnv('VITE_SERVER_URL', 'wss://relay.example');
  vi.stubGlobal('location', { protocol: 'https:', host: 'page.example', hostname: 'page.example' });
  expect((await import('../src/config.ts')).SERVER_URL).toBe('wss://relay.example');
});

import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import electron from 'vite-plugin-electron/simple';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { resolveAppVersion } from '../server/src/app-version.ts';
import { MAX_PORT } from './electron/contract.ts';

/** The dev page's preferred port; the first fully free port from here up is used. */
const DEV_PAGE_PORT = 5173;
/**
 * Every address a listener can hold a port on. Vite's own fallback binds only `::`, which Windows
 * allows beside another app's `::1` listener, and `localhost` then reaches that app instead.
 */
const PORT_PROBE_HOSTS = ['127.0.0.1', '::1', '0.0.0.0', '::'];
/** Bind errors meaning the address family is absent here, not that the port is taken. */
const ABSENT_ADDRESS_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolveBindable) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) =>
      resolveBindable(err.code !== undefined && ABSENT_ADDRESS_CODES.has(err.code)),
    );
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolveBindable(true)));
  });
}

/** Probes one host at a time: concurrent probes would collide with each other (wildcard vs loopback). */
async function portFree(port: number): Promise<boolean> {
  for (const host of PORT_PROBE_HOSTS) {
    if (!(await bindable(port, host))) return false;
  }
  return true;
}

async function freeDevPagePort(): Promise<number> {
  for (let port = DEV_PAGE_PORT; port <= MAX_PORT; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error(`No port from ${DEV_PAGE_PORT} to ${MAX_PORT} is free for the dev page.`);
}

function watchEnabled(): boolean {
  const raw = process.env['TERRACE_WATCH'];
  return raw !== undefined && raw.trim() !== '' && raw.trim() !== '0';
}

const PERF_SINK_ENV = 'TERRACE_PERF_SINK';

const PERF_SINK_PATH = '/__perf';

function perfSink() {
  const configured = process.env[PERF_SINK_ENV]?.trim();
  const target = configured === undefined || configured === '' ? null : configured;
  if (target !== null && !isAbsolute(target)) {
    throw new Error(`${PERF_SINK_ENV} must be an absolute path; got "${target}"`);
  }
  return {
    name: 'terrace-perf-sink',
    configureServer(server: {
      middlewares: {
        use(
          fn: (
            req: { url?: string; method?: string; on: (e: string, f: (c: Buffer) => void) => void },
            res: { statusCode: number; end: (body?: string) => void },
            next: () => void,
          ) => void,
        ): void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== PERF_SINK_PATH || req.method !== 'POST') {
          next();
          return;
        }
        if (target === null) {
          res.statusCode = 503;
          res.end(`${PERF_SINK_ENV} is not set: this dev server has no perf sink`);
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          appendFileSync(target, `${Buffer.concat(chunks).toString()}\n`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

/** `vite --mode electron` also builds the desktop main process and, when serving, launches it. */
const ELECTRON_MODE = 'electron';

const versionDefine = {
  __CLIENT_VERSION__: JSON.stringify(resolveAppVersion(resolve(import.meta.dirname, '..'))),
};

export default defineConfig(async ({ command, mode }) => ({
  plugins: [
    solid(),
    perfSink(),
    ...(mode === ELECTRON_MODE
      ? [electron({ main: { entry: 'electron/main.ts', vite: { define: versionDefine } } })]
      : []),
  ],
  assetsInclude: ['**/*.glb'],
  define: versionDefine,
  server: {
    headers: { 'Document-Policy': 'js-profiling' },
    // A `--port` flag overrides this; strict either way, since Vite's fallback check misses `::1` listeners.
    port: command === 'serve' ? await freeDevPagePort() : DEV_PAGE_PORT,
    strictPort: true,
    host: true,
    allowedHosts: ['.local'],
    watch: watchEnabled()
      ? {
          usePolling: true,
          interval: 300,
        }
      : null,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
}));

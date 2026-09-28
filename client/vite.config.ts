import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { appendFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { resolveAppVersion } from '../server/src/app-version.ts';

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

export default defineConfig({
  plugins: [solid(), perfSink()],
  assetsInclude: ['**/*.glb'],
  define: {
    __CLIENT_VERSION__: JSON.stringify(resolveAppVersion(resolve(import.meta.dirname, '..'))),
  },
  server: {
    headers: { 'Document-Policy': 'js-profiling' },
    port: 5173,
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
});

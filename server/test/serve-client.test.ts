// The static-file handler is security-sensitive (path traversal) and is the
// only thing standing between a self-hoster's filesystem and the internet
// once a client build is wired in, so it is tested against a REAL HTTP
// server bound to an ephemeral port rather than by hand-mocking
// IncomingMessage/ServerResponse — that would risk testing the mock instead
// of the handler's actual header/streaming/error-path behaviour.
//
// No real `vite build` output is needed: the fixture below is a minimal
// stand-in (index.html + assets/app.js + assets/app.css) that exercises
// every code path — exact file, SPA fallback, directory (no listing),
// traversal rejection — without depending on the client package building.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStaticFileHandler } from '../src/static/serve-client.ts';

const INDEX_HTML = '<!doctype html><html><body>INDEX</body></html>';
const APP_JS = 'console.log("app");';
const APP_CSS = 'body { margin: 0; }';

describe('createStaticFileHandler', () => {
  let dir: string;
  let server: HttpServer;
  let base: string;
  let port: number;

  /**
   * Issues a request with `rawPath` written VERBATIM onto the request line —
   * unlike `fetch`/undici, `http.request`'s `path` option is not run through
   * the WHATWG URL parser, so a percent-encoded (or even literal) dot-segment
   * survives transport exactly as written. That is the only way to actually
   * exercise this handler's own traversal defense from outside: a
   * spec-compliant fetch client normalises "/../" and even "%2e%2e" out of a
   * URL before ever sending it (verified — see the traversal tests below for
   * what that means for a `fetch`-based test), but nothing requires a real
   * TCP client sending raw bytes to a Node `http.Server` to be spec-compliant,
   * so the server-side defense is exactly as necessary as this test proves.
   */
  function rawRequest(
    rawPath: string,
    method: 'GET' | 'HEAD' | 'POST' = 'GET',
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolvePromise, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: rawPath, method },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
          });
          res.on('end', () => {
            resolvePromise({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'terrace-static-test-'));
    writeFileSync(join(dir, 'index.html'), INDEX_HTML);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), APP_JS);
    writeFileSync(join(dir, 'assets', 'app.css'), APP_CSS);

    const handler = createStaticFileHandler(dir);
    server = createServer(handler);
    await new Promise<void>((resolvePromise) => {
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves index.html at the root, with the right content type', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('serves an existing asset with its own content type', async () => {
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await js.text()).toBe(APP_JS);

    const css = await fetch(`${base}/assets/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await css.text()).toBe(APP_CSS);
  });

  it('falls back to index.html for an unknown route (SPA index-fallback)', async () => {
    const res = await fetch(`${base}/some/client/side/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('falls back to index.html for a real directory instead of listing it', async () => {
    // /assets/ is a real directory on disk with no index.html of its own —
    // must not enumerate app.js/app.css back to the client.
    const res = await fetch(`${base}/assets/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(INDEX_HTML);
    expect(body).not.toContain('app.js');
    expect(body).not.toContain('app.css');
  });

  it('answers HEAD with headers only, no body', async () => {
    const res = await fetch(`${base}/assets/app.js`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('content-length')).toBe(String(APP_JS.length));
    expect(await res.text()).toBe('');
  });

  it('rejects a raw ../ traversal attempt with 403, never the escaped file', async () => {
    writeFileSync(join(dir, '..', 'terrace-static-test-secret1.txt'), 'secret');
    try {
      const res = await rawRequest('/../terrace-static-test-secret1.txt');
      expect(res.status).toBe(403);
    } finally {
      rmSync(join(dir, '..', 'terrace-static-test-secret1.txt'), { force: true });
    }
  });

  it('rejects a percent-encoded traversal attempt with 403', async () => {
    writeFileSync(join(dir, '..', 'terrace-static-test-secret2.txt'), 'secret');
    try {
      const res = await rawRequest('/%2e%2e/terrace-static-test-secret2.txt');
      expect(res.status).toBe(403);
    } finally {
      rmSync(join(dir, '..', 'terrace-static-test-secret2.txt'), { force: true });
    }
  });

  it('rejects a deep percent-encoded traversal that escapes further than it descended', async () => {
    writeFileSync(join(dir, '..', 'terrace-static-test-secret3.txt'), 'secret');
    try {
      // %2f decodes to '/': .. / .. / <secret>, climbing past root.
      const res = await rawRequest(
        '/assets/%2e%2e%2f%2e%2e%2fterrace-static-test-secret3.txt',
      );
      expect(res.status).toBe(403);
    } finally {
      rmSync(join(dir, '..', 'terrace-static-test-secret3.txt'), { force: true });
    }
  });

  it('rejects malformed percent-encoding with 400', async () => {
    const res = await rawRequest('/%');
    expect(res.status).toBe(400);
  });

  it('answers 404 for a non-GET/HEAD method rather than falling back', async () => {
    const res = await fetch(`${base}/assets/app.js`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

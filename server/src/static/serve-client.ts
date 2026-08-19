// Static file serving for a built client bundle (issue #20: "one process =
// playable URL"). This is deliberately NOT built on express, even though
// Colyseus's `ServerOptions.express` hook is the officially supported way to
// add HTTP routes: `express` is only a PEER dependency of @colyseus/core and
// @colyseus/ws-transport, not a declared dependency of @terrace/server, and
// pnpm's per-package node_modules isolation proves it — `import express from
// 'express'` from server/src fails at runtime with MODULE_NOT_FOUND even
// though express is present elsewhere in the workspace's node_modules (it is
// only resolvable from inside @colyseus/ws-transport's own dependency tree).
// Adding express as a real dependency for one static-file route was rejected
// (see index.ts wiring) in favour of a plain node:http handler mounted onto
// the transport's own `http.Server` via the SAME express hook — Colyseus
// constructs the Express app itself and hands it to the callback, and a bare
// `(req, res) => void` function is a valid Connect/Express middleware, so this
// module never has to import express to be used as one.
//
// SECURITY: every request path is resolved against `rootDir` and checked to
// still be inside it before touching the filesystem (path traversal), and a
// directory never gets its contents listed — a directory (or any missing
// file) always falls through to the SPA's index.html rather than to a
// directory read.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

/**
 * Content-Type per file extension. Vite's own asset pipeline recognises this
 * exact set — verified against the installed vite@8.2.1 package: its
 * `KNOWN_ASSET_TYPES` constant, in the "dist/node/chunks" bundle under
 * vite's own installed location — plus the four extensions Vite's core
 * build emits outside that asset list (html, js, mjs, css), which is also
 * exactly what this project's own `vite build` produces today (js, css,
 * html — verified by running the build). MIME types follow IANA's current
 * registrations (`text/javascript` per RFC 9239, superseding the
 * historical `application/javascript`).
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.apng': 'image/apng',
  '.bmp': 'image/bmp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.vtt': 'text/vtt',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

/** Sent for any extension not in the table above — never guessed as text. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** True if `path` is an existing regular file (not a directory, not ENOENT). */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Streams `filePath` to `res` with the correct Content-Type, or answers 404
 * if it has gone missing between the existence check and now (a real race —
 * `dist/` can be rebuilt or removed under a live server).
 */
function streamFile(filePath: string, headOnly: boolean, res: ServerResponse): void {
  stat(filePath)
    .then((stats) => {
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_CONTENT_TYPE,
        'Content-Length': String(stats.size),
      });
      if (headOnly) {
        res.end();
        return;
      }
      const stream = createReadStream(filePath);
      // A read error mid-stream (e.g. the file vanished under us) must not
      // crash the process via an unhandled 'error' event; end the response
      // with whatever was already flushed rather than hang the connection.
      stream.on('error', () => res.end());
      stream.pipe(res);
    })
    .catch(() => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    });
}

/**
 * Builds a static-file request handler rooted at `rootDir`, with SPA
 * index-fallback: any path that is not an existing regular file under
 * `rootDir` (including a directory, which is never listed) serves
 * `rootDir/index.html` instead, so client-side routes and reloads on a
 * deep link both work exactly like Vite's own dev server and every standard
 * static host's `try_files $uri /index.html` config.
 *
 * The handler's signature — `(req, res) => void`, no `next` parameter — is
 * intentionally the minimal Node HTTP shape, not an Express-specific type:
 * it is valid Connect/Express middleware (Express calls it with 3 args;
 * extra args a function does not declare are simply unused) AND a valid bare
 * `http.Server` `'request'` listener, so it works whichever transport wires
 * it up.
 */
export function createStaticFileHandler(
  rootDir: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(rootDir);
  const indexPath = join(root, 'index.html');

  return function handleStaticRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const rawPath = (req.url ?? '/').split('?')[0]!.split('#')[0]!;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      // Malformed percent-encoding (e.g. a lone "%") — reject outright rather
      // than guess at intent, same as a traversal attempt below.
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    // path.join collapses ".." segments arithmetically before the string
    // ever touches the filesystem (verified: path.join('/root','..','..',
    // 'etc') === '/etc' on POSIX, which is what every deployment target here
    // runs — Docker's node:24-bookworm-slim and this repo's dev/CI hosts).
    // The prefix check below is defense in depth on top of that collapse,
    // not the only guard: it is what actually REJECTS a traversal attempt
    // (an escaped path is answered 403, not silently clamped back to root).
    const target = resolve(join(root, decodedPath));
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    isRegularFile(target)
      .then((isFile) => {
        streamFile(isFile ? target : indexPath, method === 'HEAD', res);
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
      });
  };
}

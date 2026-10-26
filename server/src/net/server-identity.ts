// Answers SERVER_IDENTITY_PATH so a client can confirm a Terrace server, not just an open port.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SERVER_IDENTITY_APP, SERVER_IDENTITY_PATH, type ServerIdentity } from '@terrace/shared';
import { SERVER_VERSION } from '../version.ts';

export function createServerIdentityHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void {
  const body = JSON.stringify({ app: SERVER_IDENTITY_APP, version: SERVER_VERSION } satisfies ServerIdentity);

  return function handleServerIdentity(req, res, next): void {
    const path = (req.url ?? '/').split('?')[0];
    const method = req.method ?? 'GET';
    if (path !== SERVER_IDENTITY_PATH || (method !== 'GET' && method !== 'HEAD')) {
      next();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : body);
  };
}

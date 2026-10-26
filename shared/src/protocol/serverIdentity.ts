/** A Terrace server's answer at SERVER_IDENTITY_PATH, telling it apart from any other listener on its port. */
export interface ServerIdentity {
  app: 'terrace';
  version: string;
}

export const SERVER_IDENTITY_APP: ServerIdentity['app'] = 'terrace';

/** Plain HTTP GET on the game port (RFC 8615 well-known location). */
export const SERVER_IDENTITY_PATH = '/.well-known/terrace';

export function validateServerIdentity(body: unknown): ServerIdentity | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.app !== SERVER_IDENTITY_APP) return null;
  if (typeof b.version !== 'string' || b.version === '') return null;
  return { app: SERVER_IDENTITY_APP, version: b.version };
}

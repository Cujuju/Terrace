// What holds a port on this machine. No Electron imports: vite.config.ts uses it too.
import { createServer } from 'node:net';
import { SERVER_IDENTITY_PATH, validateServerIdentity, type ServerIdentity } from '../../shared/src/protocol/serverIdentity.ts';
import { MAX_PORT } from './contract.ts';

const LOOPBACK = '127.0.0.1';
/** Estimate: outlasts a large world's stalled tick; a listener that is not HTTP never answers. */
const IDENTITY_TIMEOUT_MS = 5_000;
/** A port is free only if all bind: Windows lets `::` sit beside another app's `::1`, and `localhost` reaches that app. */
const BIND_PROBE_HOSTS = ['127.0.0.1', '::1', '0.0.0.0', '::'];
/** Bind errors meaning the address family is absent here, not that the port is taken. */
const ABSENT_ADDRESS_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) =>
      resolve(err.code !== undefined && ABSENT_ADDRESS_CODES.has(err.code)),
    );
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** Whether nothing holds `port` on any address. One host at a time: concurrent probes collide. */
export async function portFree(port: number): Promise<boolean> {
  for (const host of BIND_PROBE_HOSTS) {
    if (!(await bindable(port, host))) return false;
  }
  return true;
}

/** The first port from `first` up that nothing holds on any address. */
export async function freePortFrom(first: number): Promise<number> {
  for (let port = first; port <= MAX_PORT; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error(`No port from ${first} to ${MAX_PORT} is free.`);
}

/** The Terrace server answering at `origin`; null for anything else or no answer. */
export async function serverIdentityAt(origin: string): Promise<ServerIdentity | null> {
  try {
    const res = await fetch(new URL(SERVER_IDENTITY_PATH, origin), {
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    return res.ok ? validateServerIdentity(await res.json()) : null;
  } catch {
    return null;
  }
}

/** The address of a server on this machine, as the window loads it. */
export const loopbackOrigin = (port: number): string => `http://${LOOPBACK}:${port}`;

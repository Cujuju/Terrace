import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedPlugin } from './plugins/types.ts';
import { SERVER_VERSION } from './version.ts';

const BUILD_IDENTITY_LENGTH = 12;

const NO_CLIENT_DIST = 'no-client-dist';

export const UNKNOWN_BUILD_IDENTITY = 'unknown';

let identity: string = UNKNOWN_BUILD_IDENTITY;

let clientManifest: string = NO_CLIENT_DIST;

function digestOf(plugins: readonly LoadedPlugin[]): string {
  const hash = createHash('sha256');
  hash.update(`server:${SERVER_VERSION}\n`);
  for (const loaded of plugins) {
    hash.update(`plugin:${loaded.plugin.name}:${loaded.version}\n`);
  }
  hash.update(`client:${clientManifest}\n`);
  return hash.digest('hex').slice(0, BUILD_IDENTITY_LENGTH);
}

export function initBuildIdentity(args: {
  readonly plugins: readonly LoadedPlugin[];
  readonly clientDistPath: string;
}): string {
  if (identity !== UNKNOWN_BUILD_IDENTITY) {
    throw new Error('initBuildIdentity() called twice — boot order bug');
  }

  try {
    clientManifest = readFileSync(join(args.clientDistPath, 'index.html'), 'utf8');
  } catch {
  }

  identity = digestOf(args.plugins);
  return identity;
}

export function rebindBuildIdentity(plugins: readonly LoadedPlugin[]): string {
  identity = digestOf(plugins);
  return identity;
}

export function buildIdentity(): string {
  return identity;
}

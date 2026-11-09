import { createHash, type Hash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CORE_SOURCE_DIRECTORIES = ['server/src', 'shared/src'] as const;
const CORE_MANIFESTS = ['server/package.json', 'shared/package.json', 'pnpm-lock.yaml'] as const;

function hashDirectory(hash: Hash, root: string, relative: string): void {
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) hashDirectory(hash, root, path);
    else if (entry.isFile()) {
      hash.update(`${path}\0`);
      hash.update(readFileSync(join(root, path)));
      hash.update('\0');
    }
  }
}

/** Content at boot identifies the code this process loaded, including uncommitted changes. */
export function coreVersionStamp(repoRoot: string): string {
  const hash = createHash('sha256');
  for (const directory of CORE_SOURCE_DIRECTORIES) hashDirectory(hash, repoRoot, directory);
  for (const path of CORE_MANIFESTS) {
    hash.update(`${path}\0`);
    try {
      hash.update(readFileSync(join(repoRoot, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Packaged installations do not carry the workspace lockfile.
      hash.update('absent');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

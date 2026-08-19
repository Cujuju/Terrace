// Build identity of the running server process.
//
// WHY: on 2026-08-19 the dev stack spent a morning with the client bundle
// built from newer shared/ math than the server was running (a Vite-only
// restart after a shared/ commit), and every sculpt previewed one thing and
// applied another. The fix at the process level is "restart both halves
// together"; the fix at the OBSERVABILITY level is this stamp — the client
// compares it to its own (ui/VersionWatermark.tsx) and shouts on mismatch.
//
// The stamp is DERIVED FROM GIT, never hand-bumped: `<commit count>.<short
// hash>` — the count is monotonic so "which is newer" is readable at a
// glance, the hash is exact so "which commit" is unambiguous. It bumps on
// every commit by construction; there is no number anyone can forget to
// update. vite.config.ts derives the client's stamp the same way at
// dev-server/build start — the two derivations live in their own build
// contexts on purpose (this one runs at server boot, that one inside Vite's
// node process); keep the FORMAT in sync with it.
//
// TERRACE_VERSION overrides for git-less environments (the docker host,
// issue #8, ships no .git). No git and no override degrades to 'unversioned'
// rather than refusing to boot: the stamp is diagnostic chrome, never a
// gameplay input.

import { execSync, type ExecSyncOptions } from 'node:child_process';

function deriveGitVersion(): string | null {
  try {
    const opts: ExecSyncOptions = { stdio: ['ignore', 'pipe', 'ignore'] };
    const count = execSync('git rev-list --count HEAD', opts).toString().trim();
    const hash = execSync('git rev-parse --short HEAD', opts).toString().trim();
    // Both outputs are validated before use: a git that answers with anything
    // but a number and a hex hash (odd wrappers, localized errors on stdout)
    // must degrade, not produce a garbage stamp the watermark then "verifies".
    if (/^\d+$/.test(count) && /^[0-9a-f]+$/.test(hash)) {
      return `${count}.${hash}`;
    }
    return null;
  } catch {
    return null;
  }
}

const fromEnv = process.env['TERRACE_VERSION'];

/** Stamped once at module load — i.e. at boot, which is the honest scope: a
 *  commit made while the server is running is exactly the skew the stamp
 *  exists to expose, so it must NOT be picked up until a restart. */
export const SERVER_VERSION: string =
  fromEnv !== undefined && fromEnv.trim() !== ''
    ? fromEnv.trim()
    : (deriveGitVersion() ?? 'unversioned');

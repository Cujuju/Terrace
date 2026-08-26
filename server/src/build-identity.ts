// THE BUILD IDENTITY: one token that changes when the CODE a client is playing
// against changes, and does not change when it does not.
//
// WHY NOT `serverVersion`. That stamp is `<commit count>.<short hash>` from git
// HEAD (version.ts), which is the wrong instrument for this job in both
// directions: an UNCOMMITTED plugin or client edit leaves it byte-identical
// across a restart, and in docker — no `.git`, no TERRACE_VERSION — it is the
// constant `'unversioned'` forever. A client keying a page reload on it would
// reload in neither case it exists for. Research:
// docs/plans/plugin-hot-unload.md §1.4, §7 Phase 1 step 3.
//
// WHAT IT IS DERIVED FROM, and why each input is needed:
//
//   SERVER_VERSION        core's own commit — a core-only server change.
//   every plugin's stamp  plugin-version.ts, content-derived and dirty-aware,
//                         so an uncommitted edit to either half of any plugin
//                         moves it (this is what serverVersion cannot see).
//   the served client's
//   asset manifest        the digest of the built client's index.html, whose
//                         script/link URLs carry Vite's content hashes — so a
//                         core-client change, which belongs to no plugin, moves
//                         it too. Absent in dev (Vite serves the client, and
//                         its own HMR covers that case).
//
// NO PER-BOOT NONCE. A nonce would change on every restart, so a client would
// reload after a restart that changed nothing — the exact false positive the
// "restart with NO edit → no reload" half of the contract rules out. The only
// place a per-boot value survives is inside a plugin stamp's own last-resort
// fallback, where nothing better exists (see plugin-version.ts).
//
// A DIGEST, NOT A CONCATENATION: it is only ever compared for equality, and a
// join snapshot must not grow by sixteen stamps to say one word.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedPlugin } from './plugins/types.ts';
import { SERVER_VERSION } from './version.ts';

/** Characters of the digest published. See plugin-version.ts's own bound. */
const BUILD_IDENTITY_LENGTH = 12;

/** Stands in for the client manifest when no built client is being served. */
const NO_CLIENT_DIST = 'no-client-dist';

/**
 * What a client that has not been told anything must assume.
 *
 * A DISTINGUISHED VALUE, NOT A DIGEST: it is what the join snapshot omits the
 * field for, and a client treats "not stated" as "leave the page alone" rather
 * than as an identity that could differ from the next one.
 */
export const UNKNOWN_BUILD_IDENTITY = 'unknown';

let identity: string = UNKNOWN_BUILD_IDENTITY;

/**
 * The client manifest this process was booted with, held so the identity can be
 * recomputed without reading the dist again.
 *
 * The BUNDLE cannot change under a running process — it is served from disk as
 * it was at boot, and a new one arrives only with a restart — so re-reading it
 * on a plugin reload would be a file read that can only produce what is already
 * here.
 */
let clientManifest: string = NO_CLIENT_DIST;

/** The digest, from the two things it is made of. See this file's header. */
function digestOf(plugins: readonly LoadedPlugin[]): string {
  const hash = createHash('sha256');
  hash.update(`server:${SERVER_VERSION}\n`);
  // Load order is deterministic (discovery sorts directories), so the digest is
  // too — the same tree on two machines must produce the same identity.
  for (const loaded of plugins) {
    hash.update(`plugin:${loaded.plugin.name}:${loaded.version}\n`);
  }
  hash.update(`client:${clientManifest}\n`);
  return hash.digest('hex').slice(0, BUILD_IDENTITY_LENGTH);
}

/**
 * Computes the identity and binds it for the process.
 *
 * A PROCESS-WIDE BINDING, on bindRoomContext's precedent and for its reason:
 * this is a boot-time constant that has to reach `buildJoinSnapshot`, which is
 * called from the room, from a world switch and from a rollback — three callers
 * that would each have to thread it through for no gain. Called exactly once,
 * from boot; calling it twice is a boot-order bug and throws rather than
 * silently redefining what build everybody is playing.
 */
export function initBuildIdentity(args: {
  readonly plugins: readonly LoadedPlugin[];
  readonly clientDistPath: string;
}): string {
  if (identity !== UNKNOWN_BUILD_IDENTITY) {
    throw new Error('initBuildIdentity() called twice — boot order bug');
  }

  try {
    // index.html rather than the asset files: its script/link URLs already
    // carry every asset's content hash, so one small read covers the whole
    // bundle. A dev stack has no dist and lands on NO_CLIENT_DIST, which is
    // correct — Vite serves that client and hot-swaps it itself.
    clientManifest = readFileSync(join(args.clientDistPath, 'index.html'), 'utf8');
  } catch {
    // Unbuilt or unreadable; both mean "this process serves no client bundle".
  }

  identity = digestOf(args.plugins);
  return identity;
}

/**
 * Recomputes the identity after a plugin was RE-IMPORTED in this process
 * (issue #198), and returns the new value.
 *
 * WHY THE BOOT-TIME BINDING IS NOT THE WHOLE STORY ANY MORE. The identity was a
 * boot constant because the code a client plays against could only change with
 * a restart. An in-process reload breaks that assumption in exactly one way — a
 * plugin's stamp moves — and a client whose page is running the old plugin's
 * client half has to hear about it, which it does through the join snapshot the
 * reload's reopen already sends every player (see world-manager.ts). Without
 * this call the server would be on new code and every open page on old.
 *
 * SEPARATE FROM `initBuildIdentity`, whose double-call throw is a real boot-order
 * guard worth keeping: this is a deliberate, operator-triggered rebind, and
 * saying so at the call site is the point.
 */
export function rebindBuildIdentity(plugins: readonly LoadedPlugin[]): string {
  identity = digestOf(plugins);
  return identity;
}

/** The bound identity, or UNKNOWN_BUILD_IDENTITY before boot has bound one. */
export function buildIdentity(): string {
  return identity;
}

// THE ONE-SHOT PAGE RELOAD: how a new client bundle actually reaches a browser
// after an operator restarts the server.
//
// THE PROBLEM IT SOLVES. Client halves are statically compiled into the bundle
// (DESIGN Q6), so "update a plugin" means a new build with new asset hashes,
// and a page already open keeps running the old one forever. The client
// reconnects silently across a restart — which is the right behaviour and
// exactly why nothing tells the player their code is stale. Research:
// docs/plans/plugin-hot-unload.md §1.4, §7 Phase 1 step 3.
//
// WHAT IT KEYS ON: `JoinSnapshotMessage.buildIdentity`, a digest over core's
// stamp, every plugin's stamp and the served bundle's asset manifest (see the
// server's build-identity.ts). NOT `serverVersion`, which is a git-HEAD stamp
// that cannot see an uncommitted edit and is a constant in docker.
//
// THE RULES, and why each one is here:
//
//   1. THE FIRST IDENTITY IS THE BASELINE, never a reload. A page that has just
//      loaded is by definition current with whatever it was served.
//   2. ABSENT MEANS LEAVE THE PAGE ALONE. A server too old to state an identity
//      must not be read as "the identity changed".
//   3. AN UNCHANGED IDENTITY RELOADS NOTHING. A world switch and a rollback
//      both re-send the snapshot, and a restart that picked up no edit sends
//      the same identity — none of the three is a new bundle.
//   4. AT MOST ONE RELOAD PER IDENTITY, EVER, remembered in sessionStorage.
//      Belt and suspenders against the one way this could become a loop: if the
//      browser hands the reload a CACHED index.html, the page comes back on the
//      old bundle, sees the same difference again, and reloads forever. Refusing
//      the second attempt turns an infinite loop into one warning line.

/** sessionStorage key; per the project's `appName:camelCase` convention. */
const RELOADED_FOR_BUILD_KEY = 'terrace:reloadedForBuild';

/** The identity this page joined under; null until the first snapshot. */
let joinedUnder: string | null = null;
/** Set once a reload has been asked for, so a second snapshot cannot re-ask. */
let reloadRequested = false;

/**
 * Reads the remembered identity, tolerating a browser that refuses storage.
 * A private window or a blocked-site-data setting THROWS on access, and a
 * failure to read must degrade to "nothing remembered" rather than break the
 * snapshot handler this runs inside.
 */
function lastReloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR_BUILD_KEY);
  } catch {
    return null;
  }
}

function rememberReloadedFor(identity: string): void {
  try {
    sessionStorage.setItem(RELOADED_FOR_BUILD_KEY, identity);
  } catch {
    // Storage unavailable. The reload still happens; only the loop guard is
    // lost, which is the right way round — the guard protects against a rare
    // caching failure, and refusing to reload at all would break the feature.
  }
}

function forgetReloadedFor(): void {
  try {
    sessionStorage.removeItem(RELOADED_FOR_BUILD_KEY);
  } catch {
    // See lastReloadedFor.
  }
}

/**
 * Called with every join snapshot's `buildIdentity`. Reloads the page exactly
 * once when the server has come back on a different build.
 *
 * `reload` is injectable so the decision is testable without a real navigation;
 * production passes nothing and gets `location.reload()`.
 */
export function noteBuildIdentity(
  identity: string | undefined,
  reload: () => void = () => {
    window.location.reload();
  },
): void {
  if (identity === undefined) return; // rule 2

  if (joinedUnder === null) {
    joinedUnder = identity;
    // This page is current with `identity`, so any remembered reload is spent:
    // clearing it is what lets a LATER genuine change reload again.
    if (lastReloadedFor() === identity) forgetReloadedFor();
    return; // rule 1
  }

  if (identity === joinedUnder) return; // rule 3
  if (reloadRequested) return;

  if (lastReloadedFor() === identity) {
    // rule 4. Reached only when a reload already happened for this identity and
    // the page still came back on the old bundle — a caching failure, not a
    // server one, so it is stated rather than retried.
    console.warn(
      `[terrace] server is on build ${identity} but this page did not come back on it ` +
        'after a reload — refusing to reload again; reload manually (Ctrl-Shift-R) to clear a stale cache',
    );
    reloadRequested = true;
    return;
  }

  reloadRequested = true;
  rememberReloadedFor(identity);
  console.info(`[terrace] server rebuilt (${joinedUnder} → ${identity}) — reloading for the new bundle`);
  reload();
}

const RELOADED_FOR_BUILD_KEY = 'terrace:reloadedForBuild';

let joinedUnder: string | null = null;
let reloadRequested = false;

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
  }
}

function forgetReloadedFor(): void {
  try {
    sessionStorage.removeItem(RELOADED_FOR_BUILD_KEY);
  } catch {
  }
}

export function noteBuildIdentity(
  identity: string | undefined,
  reload: () => void = () => {
    window.location.reload();
  },
): void {
  if (identity === undefined) return;

  if (joinedUnder === null) {
    joinedUnder = identity;
    if (lastReloadedFor() === identity) forgetReloadedFor();
    return;
  }

  if (identity === joinedUnder) return;
  if (reloadRequested) return;

  if (lastReloadedFor() === identity) {
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

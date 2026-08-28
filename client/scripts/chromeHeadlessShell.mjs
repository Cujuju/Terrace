// WHERE chrome-headless-shell IS — resolved, never written down.
//
// THE BUG THIS EXISTS TO END. Both CDP drivers in this folder used to open with
// the same two lines, an absolute path into one developer's own machine:
//
//   const CHROME =
//     '/.../.cache/ms-playwright/chromium_headless_shell-1234/…';
//
// which is wrong three ways, and the same three ways in each copy:
//
//   1. IT ONLY EVER WORKED ON ONE MACHINE. A second contributor, a CI runner, or
//      the same person on another box gets a silent no-op.
//   2. IT PINS A PLAYWRIGHT BUILD NUMBER. `chromium_headless_shell-1234` stops
//      existing the next time Playwright updates, and the failure is an ENOENT
//      from `spawn` several frames later rather than anything that names the
//      cause.
//   3. AN ENVIRONMENT-SPECIFIC ABSOLUTE PATH IS NOT SHARED-SCRIPT MATERIAL. Where
//      a tool lives is a property of the machine running it, so it is discovered
//      or configured, never committed.
//
// One resolver, imported by both drivers, so a new driver cannot reintroduce any
// of the three by copying its neighbour's header — which is exactly how the
// second copy got here.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Explicit override, and the thing the error message tells you to set. */
export const CHROME_ENV_VAR = 'CHROME_HEADLESS_SHELL';

/** Playwright's own override for where it keeps browsers. */
const PLAYWRIGHT_ROOT_ENV_VAR = 'PLAYWRIGHT_BROWSERS_PATH';

/** The directory Playwright installs into when nothing overrides it. */
function playwrightRoot() {
  return process.env[PLAYWRIGHT_ROOT_ENV_VAR] ?? join(homedir(), '.cache', 'ms-playwright');
}

/**
 * The headless SHELL, not the full browser — and the two live under different
 * leaf directories, which is a trap worth naming: the full build is
 * `chromium-<n>/chrome-linux64/chrome` and the shell is
 * `chromium_headless_shell-<n>/chrome-headless-shell-linux64/chrome-headless-shell`.
 * Getting it wrong yields a path that does not exist and a driver that silently
 * does nothing.
 */
const SHELL_DIR_PREFIX = 'chromium_headless_shell-';
const SHELL_RELATIVE_PATH = join('chrome-headless-shell-linux64', 'chrome-headless-shell');

/**
 * Resolves the binary, or throws with an actionable message.
 *
 * NEWEST BUILD WINS. Playwright leaves old builds in place after an update, so
 * the directory usually holds several; picking the highest build number means a
 * version bump is invisible here instead of being a broken script.
 */
export function resolveChromeHeadlessShell() {
  const override = process.env[CHROME_ENV_VAR];
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) {
      throw new Error(`${CHROME_ENV_VAR} is set to "${override}", which does not exist.`);
    }
    return override;
  }

  const root = playwrightRoot();
  if (!existsSync(root)) {
    throw new Error(
      `No Playwright browser directory at ${root}. Install it (npx playwright install ` +
        `chromium-headless-shell) or set ${CHROME_ENV_VAR} to the binary.`,
    );
  }

  const builds = readdirSync(root)
    .filter((name) => name.startsWith(SHELL_DIR_PREFIX))
    // Numeric, not lexicographic: "chromium_headless_shell-9" must not sort
    // above "chromium_headless_shell-1234".
    .sort((a, b) => Number(b.slice(SHELL_DIR_PREFIX.length)) - Number(a.slice(SHELL_DIR_PREFIX.length)));

  for (const build of builds) {
    const candidate = join(root, build, SHELL_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `No chrome-headless-shell found under ${root}. Install it ` +
      `(npx playwright install chromium-headless-shell) or set ${CHROME_ENV_VAR}.`,
  );
}

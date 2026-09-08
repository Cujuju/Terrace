import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CHROME_ENV_VAR = 'CHROME_HEADLESS_SHELL';

const PLAYWRIGHT_ROOT_ENV_VAR = 'PLAYWRIGHT_BROWSERS_PATH';

function playwrightRoot() {
  return process.env[PLAYWRIGHT_ROOT_ENV_VAR] ?? join(homedir(), '.cache', 'ms-playwright');
}

const SHELL_DIR_PREFIX = 'chromium_headless_shell-';
const SHELL_RELATIVE_PATH = join('chrome-headless-shell-linux64', 'chrome-headless-shell');

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

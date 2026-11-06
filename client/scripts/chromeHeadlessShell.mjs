import { existsSync, readdirSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { join } from 'node:path';

export const CHROME_ENV_VAR = 'CHROME_HEADLESS_SHELL';

const PLAYWRIGHT_ROOT_ENV_VAR = 'PLAYWRIGHT_BROWSERS_PATH';

// Playwright's default browser cache per OS.
const PLAYWRIGHT_CACHE_DIRS = {
  linux: ['.cache', 'ms-playwright'],
  darwin: ['Library', 'Caches', 'ms-playwright'],
  win32: ['AppData', 'Local', 'ms-playwright'],
};

// Playwright's headless-shell folder and binary per OS.
const SHELL_RELATIVE_PATHS = {
  linux: join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
  darwin: join(`chrome-headless-shell-mac-${arch() === 'arm64' ? 'arm64' : 'x64'}`, 'chrome-headless-shell'),
  win32: join('chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
};

function forPlatform(table) {
  const entry = table[platform()];
  if (entry === undefined) throw new Error(`No chrome-headless-shell layout known for ${platform()}; set ${CHROME_ENV_VAR}.`);
  return entry;
}

function playwrightRoot() {
  return process.env[PLAYWRIGHT_ROOT_ENV_VAR] ?? join(homedir(), ...forPlatform(PLAYWRIGHT_CACHE_DIRS));
}

const SHELL_DIR_PREFIX = 'chromium_headless_shell-';

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

  const relativePath = forPlatform(SHELL_RELATIVE_PATHS);
  for (const build of builds) {
    const candidate = join(root, build, relativePath);
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `No chrome-headless-shell found under ${root}. Install it ` +
      `(npx playwright install chromium-headless-shell) or set ${CHROME_ENV_VAR}.`,
  );
}

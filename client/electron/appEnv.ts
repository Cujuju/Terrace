// Where this run's pieces live, and what the environment fixes about it.
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { app } from 'electron';
import { DEFAULT_SERVER_PORT, MAX_PORT, MIN_PORT } from './contract.ts';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

export const APP_NAME = 'Terrace';
/** Also the Windows AUMID on the installed shortcut (electron-builder.ts appId). */
export const APP_ID = 'com.cujuju.terrace';

export const isPackaged = app.isPackaged;
/** Set by vite-plugin-electron while `vite --mode electron` serves the client. */
export const devServerUrl = process.env['VITE_DEV_SERVER_URL'] ?? null;

/** Runs the embedded server with no window, tray or single-instance lock. */
const HEADLESS_ARG = '--headless';
export const isHeadless = process.argv.includes(HEADLESS_ARG);

/** A checkout's client/ is the app path; its parent is the repository. */
const repoRoot = resolve(app.getAppPath(), '..');
/** Holds server/, shared/, plugins/ and node_modules/. */
const serverRoot = isPackaged ? join(process.resourcesPath, 'server') : repoRoot;

export const serverCwd = join(serverRoot, 'server');
export const serverEntry = isPackaged
  ? join(serverCwd, 'src', 'boot', 'packaged-entry.ts')
  : join(serverCwd, 'src', 'index.ts');
export const pluginsDir = join(serverRoot, 'plugins');
export const clientDist = isPackaged
  ? join(process.resourcesPath, 'renderer')
  : join(repoRoot, 'client', 'dist');

/** Windows reads its icon sizes from the .ico; other systems cannot load one. */
const ICON_FILE = IS_WINDOWS ? 'icon.ico' : 'icon.png';
/** The app icon for the tray and dev windows; null when the file is absent. */
export function appIconPath(): string | null {
  const path = isPackaged
    ? join(process.resourcesPath, ICON_FILE)
    : join(app.getAppPath(), 'build', ICON_FILE);
  return existsSync(path) ? path : null;
}

/** Fixes the data folder for this run, over the saved setting. */
const DATA_DIR_ENV = 'TERRACE_DATA_DIR';
/** The server's own variable. */
const SERVER_PORT_ENV = 'PORT';
/** The port Vite builds into a dev page (client/src/config.ts). */
const DEV_PAGE_PORT_ENV = 'VITE_SERVER_PORT';

export function envDataDir(): string | null {
  const raw = process.env[DATA_DIR_ENV]?.trim();
  if (raw === undefined || raw === '') return null;
  if (!isAbsolute(raw)) throw new Error(`${DATA_DIR_ENV} must be an absolute path, got "${raw}".`);
  return raw;
}

function portFrom(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`${name} must be a port between ${MIN_PORT} and ${MAX_PORT}, got "${raw}".`);
  }
  return port;
}

/** The port fixed for this run; null when the setting decides. A dev page dials the port Vite built in. */
export function fixedPort(): number | null {
  if (devServerUrl !== null) return portFrom(DEV_PAGE_PORT_ENV) ?? DEFAULT_SERVER_PORT;
  return portFrom(SERVER_PORT_ENV);
}

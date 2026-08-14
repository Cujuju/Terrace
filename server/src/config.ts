// Environment configuration. Every value has a working default (design §8:
// "nothing sensitive should ever be required to boot a world"), and every value
// is validated at boot so a typo fails fast with an actionable message rather
// than corrupting a world hours later.

import { CHUNK_SIZE, DEFAULT_WORLD_SIZE } from '@terrace/shared';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Colyseus's conventional default port. */
export const DEFAULT_PORT = 2567;

/** Relative to the process CWD; `data/` is gitignored. */
export const DEFAULT_DB_PATH = './data/world.db';

/** Design §3.2: fixed ~10 Hz simulation tick. */
export const DEFAULT_TICK_HZ = 10;

/** Design open question 4, decided 2026-08-13: snapshot every 60 s if dirty. */
export const DEFAULT_SNAPSHOT_INTERVAL_S = 60;

/**
 * Tick-rate bounds. Below 1 Hz a "fixed tick" stops being a simulation clock in
 * any useful sense; above 60 Hz the loop would out-run the 20 fps patch rate and
 * burn CPU for no visible benefit (rendering interpolates — design §3.2).
 */
export const MIN_TICK_HZ = 1;
export const MAX_TICK_HZ = 60;

/**
 * Snapshot-cadence bounds. 1 s is the floor because a full 512² snapshot is a
 * ~512 KB synchronous write; the ceiling of one hour bounds how much sculpting
 * a crash can cost.
 */
export const MIN_SNAPSHOT_INTERVAL_S = 1;
export const MAX_SNAPSHOT_INTERVAL_S = 3600;

/** TCP port range, excluding 0 (which would bind an arbitrary ephemeral port). */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Directory name of the auto-discovered plugin folder (design §3.5). */
const PLUGINS_DIR_NAME = 'plugins';

export interface ServerConfig {
  /** Cells per world edge. Must be a positive multiple of CHUNK_SIZE. */
  readonly worldSize: number;
  readonly port: number;
  readonly dbPath: string;
  readonly tickHz: number;
  readonly snapshotIntervalS: number;
  /** Absolute path to the folder scanned for plugins at boot. */
  readonly pluginsDir: string;
}

/** Thrown for any invalid environment value; the boot path prints and exits. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

interface IntegerRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Parses one integer environment variable. Rejects empty strings, non-numeric
 * text, floats and out-of-range values — `parseInt` is deliberately NOT used
 * because it silently accepts "10abc" and "1.9".
 */
function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  range: IntegerRange,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  }
  if (value < range.min || value > range.max) {
    throw new ConfigError(
      `${name} must be between ${range.min} and ${range.max}, got ${value}`,
    );
  }
  return value;
}

/** Default plugins folder: the repo-root `plugins/` sibling of `server/`. */
function defaultPluginsDir(): string {
  // import.meta.url is <repo>/server/src/config.ts → up two levels is <repo>/server.
  const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return resolve(serverDir, '..', PLUGINS_DIR_NAME);
}

/**
 * Reads and validates the whole server configuration. Called once at boot;
 * accepts an explicit env object so tests never touch `process.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const worldSize = readInteger(env, 'WORLD_SIZE', DEFAULT_WORLD_SIZE, {
    min: CHUNK_SIZE,
    // Int16 heights: 4096² = 32 MB, already far past the design's 512² target.
    max: 4096,
  });
  // The unlock mask and every chunk operation assume whole chunks. A partial
  // trailing chunk would be permanently unreachable, so this is fatal, not a
  // rounding opportunity.
  if (worldSize % CHUNK_SIZE !== 0) {
    throw new ConfigError(
      `WORLD_SIZE must be a positive multiple of CHUNK_SIZE (${CHUNK_SIZE}), got ${worldSize}`,
    );
  }

  const dbPath = env.DB_PATH?.trim() || DEFAULT_DB_PATH;
  const pluginsDir = env.PLUGINS_DIR?.trim()
    ? resolve(env.PLUGINS_DIR.trim())
    : defaultPluginsDir();

  return {
    worldSize,
    port: readInteger(env, 'PORT', DEFAULT_PORT, { min: MIN_PORT, max: MAX_PORT }),
    dbPath,
    tickHz: readInteger(env, 'TICK_HZ', DEFAULT_TICK_HZ, {
      min: MIN_TICK_HZ,
      max: MAX_TICK_HZ,
    }),
    snapshotIntervalS: readInteger(env, 'SNAPSHOT_INTERVAL_S', DEFAULT_SNAPSHOT_INTERVAL_S, {
      min: MIN_SNAPSHOT_INTERVAL_S,
      max: MAX_SNAPSHOT_INTERVAL_S,
    }),
    pluginsDir,
  };
}

// Environment configuration. Every value has a working default (design §8:
// "nothing sensitive should ever be required to boot a world"), and every value
// is validated at boot so a typo fails fast with an actionable message rather
// than corrupting a world hours later.

import { CHUNK_SIZE, DEFAULT_WORLD_SIZE } from '@terrace/shared';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { logWarn } from './log.ts';

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

// ─────────────────────────────────────────────────────────────────────────────
// WORLD DIFFICULTY (decided 2026-08-14 with the owner — see docs/DESIGN.md)
//
// A NEUTRAL per-world scalar: 1 = warm/forgiving, 100 = punishing. Core owns the
// number and NOTHING ELSE — it attaches no mechanic to it, reads it in no
// simulation path, and never changes behaviour because of it. Interpreting it is
// entirely the business of plugins (mana is the first consumer; monster
// aggression and relic counts are the expected next ones), which is what keeps
// it inside the "nothing gamey in core" rule: core is publishing a dial, not a
// difficulty system.
//
// The scale is 1–100 rather than a named enum because plugins interpolate
// against it — a continuous scalar lets each consumer pick its own two anchor
// values and lerp, without core having to know what any of them mean.
// ─────────────────────────────────────────────────────────────────────────────

/** The warmest, most forgiving world. */
export const MIN_WORLD_DIFFICULTY = 1;

/** The most punishing world. */
export const MAX_WORLD_DIFFICULTY = 100;

/**
 * Dead centre of the band. A self-hoster who has never heard of this setting
 * gets a world that is neither the gentlest nor the harshest one on offer, and
 * every consumer's interpolation lands mid-range for them.
 */
export const DEFAULT_WORLD_DIFFICULTY = 50;

/** TCP port range, excluding 0 (which would bind an arbitrary ephemeral port). */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Directory name of the auto-discovered plugin folder (design §3.5). */
const PLUGINS_DIR_NAME = 'plugins';

/** Sibling-of-`server/` path to a `vite build` of the client (issue #20). */
const CLIENT_DIST_PATH_SEGMENTS = ['client', 'dist'] as const;

export interface ServerConfig {
  /** Cells per world edge. Must be a positive multiple of CHUNK_SIZE. */
  readonly worldSize: number;
  readonly port: number;
  readonly dbPath: string;
  readonly tickHz: number;
  readonly snapshotIntervalS: number;
  /**
   * This world's difficulty rating, 1 (warm/forgiving) to 100 (punishing).
   * Core attaches no mechanics to it — plugins interpret it. See the block
   * comment above MIN_WORLD_DIFFICULTY.
   */
  readonly difficulty: number;
  /** Absolute path to the folder scanned for plugins at boot. */
  readonly pluginsDir: string;
  /**
   * Absolute path a `vite build` of the client would be found at (issue #20:
   * "one process = playable URL"). Resolved the same way as `pluginsDir` —
   * always an absolute path, whether or not anything actually exists there
   * yet. Boot decides what to do with that: see index.ts, which serves it
   * over HTTP when `index.html` is present and logs that Vite remains the dev
   * path otherwise.
   */
  readonly clientDistPath: string;
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
 * Parses one integer environment variable, WITHOUT range checking. Rejects empty
 * strings, non-numeric text and floats — `parseInt` is deliberately NOT used
 * because it silently accepts "10abc" and "1.9".
 *
 * Text that is not an integer is fatal for EVERY variable, range policy aside:
 * `TICK_HZ=fast` states no intent that could be honoured, so there is nothing to
 * recover to but a guess.
 */
function parseIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  }
  return value;
}

/**
 * An integer variable whose range is a HARD requirement: out of range is fatal.
 *
 * This is the default policy, and it is right whenever an out-of-range value
 * would produce a world that boots but is wrong (a 1000 Hz tick, port 0 binding
 * an arbitrary ephemeral port). Failing at boot is the only moment a self-hoster
 * is still watching.
 */
function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  range: IntegerRange,
): number {
  const value = parseIntegerEnv(env, name, fallback);
  if (value < range.min || value > range.max) {
    throw new ConfigError(
      `${name} must be between ${range.min} and ${range.max}, got ${value}`,
    );
  }
  return value;
}

/**
 * An integer variable whose range is a SCALE, so out of range is clamped with a
 * warning rather than refused.
 *
 * The distinction against readInteger is one question: does the out-of-range
 * value state an intent the clamp can honour? `WORLD_DIFFICULTY=250` says "as
 * hard as you can make it" and the ceiling delivers exactly that, so refusing to
 * boot would cost a self-hoster their world over a value whose meaning was never
 * in doubt. `PORT=70000` says nothing of the kind. Clamping is only safe because
 * a scale has no correctness cliff — no stored data, no protocol, and no other
 * setting depends on where in the band the value lands.
 */
function readClampedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  range: IntegerRange,
): number {
  const value = parseIntegerEnv(env, name, fallback);
  if (value < range.min) {
    logWarn(`${name} ${value} is below ${range.min}; clamped to ${range.min}`);
    return range.min;
  }
  if (value > range.max) {
    logWarn(`${name} ${value} is above ${range.max}; clamped to ${range.max}`);
    return range.max;
  }
  return value;
}

/** Absolute path to `<repo>/server`, shared by every sibling-of-server default. */
function serverDir(): string {
  // import.meta.url is <repo>/server/src/config.ts → up two levels is <repo>/server.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Default plugins folder: the repo-root `plugins/` sibling of `server/`. */
function defaultPluginsDir(): string {
  return resolve(serverDir(), '..', PLUGINS_DIR_NAME);
}

/** Default client build: `client/dist`, sibling of `server/` (issue #20). */
function defaultClientDistPath(): string {
  return resolve(serverDir(), '..', ...CLIENT_DIST_PATH_SEGMENTS);
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
  const clientDistPath = env.CLIENT_DIST_PATH?.trim()
    ? resolve(env.CLIENT_DIST_PATH.trim())
    : defaultClientDistPath();

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
    // CLAMPED, not fatal: difficulty is a scale, and 0 or 250 names an end of it
    // unambiguously. See readClampedInteger for the rule that splits the two.
    difficulty: readClampedInteger(env, 'WORLD_DIFFICULTY', DEFAULT_WORLD_DIFFICULTY, {
      min: MIN_WORLD_DIFFICULTY,
      max: MAX_WORLD_DIFFICULTY,
    }),
    pluginsDir,
    clientDistPath,
  };
}

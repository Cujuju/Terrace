// Environment configuration. Every value has a working default (design §8:
// "nothing sensitive should ever be required to boot a world"), and every value
// is validated at boot so a typo fails fast with an actionable message rather
// than corrupting a world hours later.

import { CHUNK_SIZE, DEFAULT_WORLD_SIZE } from '@terrace/shared';
import { SNAPSHOT_RETENTION } from './persistence/snapshot-store.ts';
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
// WORLD ROLLBACK (2026-08-21). See shared/src/protocol.ts's WORLD ROLLBACK
// section for the feature, and world/rollback.ts for what a rollback does.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many restore points to keep. The floor of 1 is "only ever the newest",
 * which is what the server did before restore points were listable.
 *
 * The CEILING is set by the listing, not by the disk: opening the rollback
 * panel decodes and compares every retained heightmap (see
 * SnapshotStore.listRestorePoints), so retention is also how much work that
 * one request is. 100 restore points is ~100 minutes of history at the default
 * cadence, ~51 MB for a 512² world, and ~400 ms to list — the point past which
 * a self-hoster would be waiting on their own safety net.
 */
export const MIN_SNAPSHOT_RETENTION = 1;
export const MAX_SNAPSHOT_RETENTION = 100;

/**
 * The key world rollback accepts when ROLLBACK_KEY is not set (owner decision,
 * 2026-08-21).
 *
 * NOT A SECRET, AND NOT TREATED AS ONE. It is in this file, so it is in the
 * repository, so it is known to anyone who can read it — which means the
 * out-of-the-box deployment is one where anybody able to reach the server can
 * roll the world back. That is a deliberate reversal of the original "off
 * unless configured" decision (docs/DESIGN.md, world rollback decision 2),
 * traded for a self-hoster being able to use their own safety net without
 * first editing an environment file. The boot log says so out loud every time
 * the default is in use.
 *
 * ROLLBACK_KEY overrides it; `ROLLBACK_KEY=` (explicitly empty) turns rollback
 * off entirely. See readRollbackKey.
 */
export const DEFAULT_ROLLBACK_KEY = 'terrace';

/**
 * Shortest ROLLBACK_KEY a self-hoster may CHOOSE.
 *
 * Applies to a key set in the environment, and deliberately NOT to
 * DEFAULT_ROLLBACK_KEY above — which is shorter than this and is allowed to
 * be, because the two are different kinds of thing. The default announces
 * itself as public and warns on every boot; a key someone types into their own
 * `.env` is meant to be a secret, and a three-character secret is a mistake
 * worth refusing to boot over, at the one moment they are watching.
 */
export const MIN_ROLLBACK_KEY_LENGTH = 8;

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

  /** How many restore points the database keeps; see MAX_SNAPSHOT_RETENTION. */
  readonly snapshotRetention: number;

  /**
   * The operator key that gates world rollback.
   *
   * DEFAULT_ROLLBACK_KEY when ROLLBACK_KEY is unset, so rollback works out of
   * the box; null only when it is set to nothing at all, which turns the
   * feature off. See readRollbackKey for all three cases.
   *
   * NEVER LOGGED when it is a key the self-hoster chose. The built-in default
   * IS named in the boot warning, because it is not a secret and telling them
   * which key is live is the point of that line.
   */
  readonly rollbackKey: string | null;
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

/**
 * Reads ROLLBACK_KEY. Three cases, and the distinction between the first two
 * is the whole of it:
 *
 *  - UNSET (the variable is absent)   → DEFAULT_ROLLBACK_KEY. Rollback works
 *    out of the box, with a key that is public knowledge.
 *  - SET BUT EMPTY (`ROLLBACK_KEY=`)  → null. Rollback is off entirely; no
 *    request to list or apply a restore point is ever honoured.
 *  - SET to a value                   → that value, subject to
 *    MIN_ROLLBACK_KEY_LENGTH.
 *
 * "Absent" and "present but empty" mean OPPOSITE things here, which is unusual
 * enough to be worth stating: `ROLLBACK_KEY=` in a `.env` file is how a
 * self-hoster says "I do not want this feature", and it is the only spelling
 * that could mean that once an unset variable has a working default. A
 * whitespace-only value is treated as empty, because nobody types spaces to
 * mean a key.
 *
 * A key is trimmed, and that is a deliberate exception to the "a secret is
 * matched verbatim" rule applied on the wire (protocol.ts's
 * validateRollbackKey does NOT trim). The two sit on opposite sides of the
 * same comparison on purpose: here the value came from a `.env` file a human
 * edited, where a trailing space is a typo that would otherwise lock them out
 * of their own rollback with no diagnosable symptom; there it came from a
 * network peer, where accepting a padded variant would widen the secret.
 */
function readRollbackKey(env: NodeJS.ProcessEnv): string | null {
  const configured = env.ROLLBACK_KEY;
  if (configured === undefined) return DEFAULT_ROLLBACK_KEY;

  const raw = configured.trim();
  if (raw === '') return null; // explicitly disabled — see the doc comment
  if (raw.length < MIN_ROLLBACK_KEY_LENGTH) {
    // The message states the length rule and NOT the key.
    throw new ConfigError(
      `ROLLBACK_KEY must be at least ${MIN_ROLLBACK_KEY_LENGTH} characters ` +
        `(got ${raw.length}); set it to nothing at all (ROLLBACK_KEY=) to ` +
        'disable world rollback',
    );
  }
  return raw;
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
    snapshotRetention: readInteger(env, 'SNAPSHOT_RETENTION', SNAPSHOT_RETENTION, {
      min: MIN_SNAPSHOT_RETENTION,
      max: MAX_SNAPSHOT_RETENTION,
    }),
    rollbackKey: readRollbackKey(env),
  };
}

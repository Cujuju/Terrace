
import { CHUNK_SIZE, DEFAULT_WORLD_SIZE, NEIGHBOURHOOD_CELLS } from '@terrace/shared';
import { SNAPSHOT_RETENTION } from './persistence/snapshot-store.ts';
import { INITIAL_UNLOCK_CHUNK_SPAN } from './world/initial-unlock.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { logWarn } from './log.ts';

export const DEFAULT_PORT = 2567;

export const DEFAULT_DB_PATH = './data/world.db';
export const DEFAULT_WORLDS_DIR = './data/worlds';
export const MIN_WORLD_SIZE =
  INITIAL_UNLOCK_CHUNK_SPAN * CHUNK_SIZE + 2 * NEIGHBOURHOOD_CELLS;
export const MAX_WORLD_SIZE = 4096;
export const DEFAULT_WORLD_SWITCH_COUNTDOWN_S = 10;
export const MIN_WORLD_SWITCH_COUNTDOWN_S = 0;
export const MAX_WORLD_SWITCH_COUNTDOWN_S = 300;
export const DEFAULT_WORLD_ADMIN_KEY = 'terrace';

export const DEFAULT_TICK_HZ = 10;
export const DEFAULT_SNAPSHOT_INTERVAL_S = 60;
export const MIN_TICK_HZ = 1;
export const MAX_TICK_HZ = 60;
export const MIN_SNAPSHOT_INTERVAL_S = 1;
export const MAX_SNAPSHOT_INTERVAL_S = 3600;
export const MIN_SNAPSHOT_RETENTION = 1;
export const MAX_SNAPSHOT_RETENTION = 100;
export const DEFAULT_ROLLBACK_KEY = 'terrace';
export const MIN_ROLLBACK_KEY_LENGTH = 8;

export const MIN_WORLD_DIFFICULTY = 1;
export const MAX_WORLD_DIFFICULTY = 100;
export const DEFAULT_WORLD_DIFFICULTY = 50;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const PLUGINS_DIR_NAME = 'plugins';
const CLIENT_DIST_PATH_SEGMENTS = ['client', 'dist'] as const;
export interface ServerConfig {
  readonly worldSize: number;
  readonly port: number;
  readonly dbPath: string;
  readonly tickHz: number;
  readonly snapshotIntervalS: number;
  readonly difficulty: number;
  readonly pluginsDir: string;

  readonly clientDistPath: string;

  readonly snapshotRetention: number;
  readonly rollbackKey: string | null;
  readonly worldsDir: string;

  readonly worldAdminKey: string | null;
  readonly worldSwitchCountdownS: number;
}

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
function parseIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  }
  return value;
}
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
function readRollbackKey(env: NodeJS.ProcessEnv): string | null {
  const configured = env.ROLLBACK_KEY;
  if (configured === undefined) return DEFAULT_ROLLBACK_KEY;
  const raw = configured.trim();
  if (raw === '') return null;
  if (raw.length < MIN_ROLLBACK_KEY_LENGTH) {

    throw new ConfigError(
      `ROLLBACK_KEY must be at least ${MIN_ROLLBACK_KEY_LENGTH} characters ` +
        `(got ${raw.length}); set it to nothing at all (ROLLBACK_KEY=) to ` +
        'disable world rollback',
    );
  }
  return raw;
}

function readWorldAdminKey(env: NodeJS.ProcessEnv): string | null {
  const configured = env.WORLD_ADMIN_KEY;
  if (configured === undefined) return DEFAULT_WORLD_ADMIN_KEY;

  const raw = configured.trim();
  if (raw.length === 0) return null;

  if (raw.length < MIN_ROLLBACK_KEY_LENGTH) {
    throw new ConfigError(
      `WORLD_ADMIN_KEY must be at least ${MIN_ROLLBACK_KEY_LENGTH} characters ` +
        `(got ${raw.length}); set it to nothing at all (WORLD_ADMIN_KEY=) to ` +
        'turn world management off',
    );
  }
  return raw;
}
function serverDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}
function defaultPluginsDir(): string {
  return resolve(serverDir(), '..', PLUGINS_DIR_NAME);
}
function defaultClientDistPath(): string {
  return resolve(serverDir(), '..', ...CLIENT_DIST_PATH_SEGMENTS);
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const worldSize = readInteger(env, 'WORLD_SIZE', DEFAULT_WORLD_SIZE, {
    min: MIN_WORLD_SIZE,
    max: MAX_WORLD_SIZE,
  });
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
    worldsDir: env.WORLDS_DIR?.trim() ? resolve(env.WORLDS_DIR.trim()) : resolve(DEFAULT_WORLDS_DIR),
    worldAdminKey: readWorldAdminKey(env),
    worldSwitchCountdownS: readClampedInteger(
      env,
      'WORLD_SWITCH_COUNTDOWN_S',
      DEFAULT_WORLD_SWITCH_COUNTDOWN_S,
      { min: MIN_WORLD_SWITCH_COUNTDOWN_S, max: MAX_WORLD_SWITCH_COUNTDOWN_S },
    ),
  };
}

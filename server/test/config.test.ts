// Config validation is a boot-time gate: a bad value must stop the server with
// a message a self-hoster can act on, never boot a subtly broken world.

import { CHUNK_SIZE, DEFAULT_WORLD_SIZE } from '@terrace/shared';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_SNAPSHOT_INTERVAL_S,
  DEFAULT_TICK_HZ,
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
  loadConfig,
} from '../src/config.ts';

describe('loadConfig', () => {
  it('applies the documented defaults when the environment is empty', () => {
    const config = loadConfig({});
    expect(config.worldSize).toBe(DEFAULT_WORLD_SIZE);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.tickHz).toBe(DEFAULT_TICK_HZ);
    expect(config.snapshotIntervalS).toBe(DEFAULT_SNAPSHOT_INTERVAL_S);
    expect(config.difficulty).toBe(DEFAULT_WORLD_DIFFICULTY);
    expect(config.dbPath).toBe('./data/world.db');
    expect(config.pluginsDir.endsWith('plugins')).toBe(true);
    // Sibling of pluginsDir's own repo-root convention, but under client/dist
    // (issue #20) rather than the repo-root plugins/ folder.
    expect(config.clientDistPath.endsWith(join('client', 'dist'))).toBe(true);
  });

  it('reads overrides', () => {
    const config = loadConfig({
      WORLD_SIZE: '128',
      PORT: '3000',
      TICK_HZ: '20',
      SNAPSHOT_INTERVAL_S: '5',
      WORLD_DIFFICULTY: '73',
      DB_PATH: '/tmp/other.db',
    });
    expect(config).toMatchObject({
      worldSize: 128,
      port: 3000,
      tickHz: 20,
      snapshotIntervalS: 5,
      difficulty: 73,
      dbPath: '/tmp/other.db',
    });
  });

  it('rejects a WORLD_SIZE that is not a multiple of the chunk size', () => {
    expect(() => loadConfig({ WORLD_SIZE: String(CHUNK_SIZE * 4 + 1) })).toThrow(ConfigError);
    expect(() => loadConfig({ WORLD_SIZE: '100' })).toThrow(/multiple of CHUNK_SIZE/);
  });

  it('rejects non-integers, junk and out-of-range values', () => {
    expect(() => loadConfig({ WORLD_SIZE: '512.5' })).toThrow(/must be an integer/);
    expect(() => loadConfig({ PORT: '2567abc' })).toThrow(/must be an integer/);
    expect(() => loadConfig({ PORT: '0' })).toThrow(/must be between/);
    expect(() => loadConfig({ TICK_HZ: '0' })).toThrow(/must be between/);
    expect(() => loadConfig({ TICK_HZ: '1000' })).toThrow(/must be between/);
    expect(() => loadConfig({ SNAPSHOT_INTERVAL_S: '-1' })).toThrow(/must be between/);
  });

  it('treats an empty value as unset rather than as zero', () => {
    expect(loadConfig({ TICK_HZ: '', DB_PATH: '  ', WORLD_DIFFICULTY: '' })).toMatchObject({
      tickHz: DEFAULT_TICK_HZ,
      difficulty: DEFAULT_WORLD_DIFFICULTY,
      dbPath: './data/world.db',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CLIENT_DIST_PATH (issue #20): resolved the same way as PLUGINS_DIR — always
// an absolute path, never validated for existence here (that is index.ts's
// job at boot: serve it if index.html is there, log "unbuilt" if not).
// ────────────────────────────────────────────────────────────────────────────

describe('loadConfig — CLIENT_DIST_PATH', () => {
  it('defaults to client/dist next to server/, as an absolute path', () => {
    const config = loadConfig({});
    expect(isAbsolute(config.clientDistPath)).toBe(true);
    expect(config.clientDistPath.endsWith(join('client', 'dist'))).toBe(true);
  });

  it('accepts an override and resolves it to an absolute path', () => {
    const config = loadConfig({ CLIENT_DIST_PATH: 'somewhere/else' });
    expect(config.clientDistPath).toBe(resolve('somewhere/else'));
  });

  it('treats an empty value as unset, like every other path variable', () => {
    const config = loadConfig({ CLIENT_DIST_PATH: '   ' });
    expect(config.clientDistPath.endsWith(join('client', 'dist'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WORLD_DIFFICULTY is the one setting that CLAMPS instead of refusing to boot
// (decided 2026-08-14): it is a scale, so an out-of-range value states an intent
// the clamp can honour, unlike PORT=70000. Everything else about it follows the
// house idiom — unset means the default, non-integer text is still fatal.
// ────────────────────────────────────────────────────────────────────────────

describe('loadConfig — WORLD_DIFFICULTY', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Silences the clamp warning so a run full of bad input stays readable. */
  function silenceWarnings(): void {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  it('defaults to the midpoint of the band when unset', () => {
    expect(loadConfig({}).difficulty).toBe(DEFAULT_WORLD_DIFFICULTY);
    expect(DEFAULT_WORLD_DIFFICULTY).toBeGreaterThan(MIN_WORLD_DIFFICULTY);
    expect(DEFAULT_WORLD_DIFFICULTY).toBeLessThan(MAX_WORLD_DIFFICULTY);
  });

  it('accepts every value in the band, both ends included', () => {
    for (const value of [MIN_WORLD_DIFFICULTY, 25, DEFAULT_WORLD_DIFFICULTY, 99, MAX_WORLD_DIFFICULTY]) {
      expect(loadConfig({ WORLD_DIFFICULTY: String(value) }).difficulty).toBe(value);
    }
  });

  it('clamps out-of-band values into it, loudly, rather than refusing to boot', () => {
    silenceWarnings();

    expect(loadConfig({ WORLD_DIFFICULTY: '0' }).difficulty).toBe(MIN_WORLD_DIFFICULTY);
    expect(loadConfig({ WORLD_DIFFICULTY: '-40' }).difficulty).toBe(MIN_WORLD_DIFFICULTY);
    expect(loadConfig({ WORLD_DIFFICULTY: '101' }).difficulty).toBe(MAX_WORLD_DIFFICULTY);
    // A typo'd extra zero: "as hard as you can make it", honoured.
    expect(loadConfig({ WORLD_DIFFICULTY: '1000' }).difficulty).toBe(MAX_WORLD_DIFFICULTY);

    expect(console.warn).toHaveBeenCalledTimes(4);
  });

  it('is silent for a value inside the band', () => {
    silenceWarnings();
    loadConfig({ WORLD_DIFFICULTY: String(MAX_WORLD_DIFFICULTY) });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('still refuses text that states no honourable intent', () => {
    // Clamping is for a value that names an end of the scale. "hard" and "50.5"
    // name nothing the server could act on, so they stay fatal like every other
    // integer variable.
    expect(() => loadConfig({ WORLD_DIFFICULTY: 'hard' })).toThrow(ConfigError);
    expect(() => loadConfig({ WORLD_DIFFICULTY: '50.5' })).toThrow(/must be an integer/);
    expect(() => loadConfig({ WORLD_DIFFICULTY: '50abc' })).toThrow(/must be an integer/);
  });
});

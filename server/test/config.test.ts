// Config validation is a boot-time gate: a bad value must stop the server with
// a message a self-hoster can act on, never boot a subtly broken world.

import { CHUNK_SIZE, DEFAULT_WORLD_SIZE } from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_SNAPSHOT_INTERVAL_S,
  DEFAULT_TICK_HZ,
  loadConfig,
} from '../src/config.ts';

describe('loadConfig', () => {
  it('applies the documented defaults when the environment is empty', () => {
    const config = loadConfig({});
    expect(config.worldSize).toBe(DEFAULT_WORLD_SIZE);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.tickHz).toBe(DEFAULT_TICK_HZ);
    expect(config.snapshotIntervalS).toBe(DEFAULT_SNAPSHOT_INTERVAL_S);
    expect(config.dbPath).toBe('./data/world.db');
    expect(config.pluginsDir.endsWith('plugins')).toBe(true);
  });

  it('reads overrides', () => {
    const config = loadConfig({
      WORLD_SIZE: '128',
      PORT: '3000',
      TICK_HZ: '20',
      SNAPSHOT_INTERVAL_S: '5',
      DB_PATH: '/tmp/other.db',
    });
    expect(config).toMatchObject({
      worldSize: 128,
      port: 3000,
      tickHz: 20,
      snapshotIntervalS: 5,
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
    expect(loadConfig({ TICK_HZ: '', DB_PATH: '  ' })).toMatchObject({
      tickHz: DEFAULT_TICK_HZ,
      dbPath: './data/world.db',
    });
  });
});

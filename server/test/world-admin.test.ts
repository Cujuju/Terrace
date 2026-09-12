import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, validateWorldAdminRequest } from '@terrace/shared';
import { MIN_WORLD_SIZE, type ServerConfig } from '../src/config.ts';
import { WorldRegistry } from '../src/persistence/world-registry.ts';
import { ServerRestartService } from '../src/restart.ts';
import { OPERATOR_MAX_FAILED_ATTEMPTS, OPERATOR_LOCKOUT_MS } from '../src/world/operator-gate.ts';
import { WorldAdminService } from '../src/world/world-admin.ts';
import { InstalledPlugins } from '../src/plugins/installed.ts';
import { WorldManager } from '../src/world/world-manager.ts';

const WORLD_SIZE = MIN_WORLD_SIZE;
const KEY = 'admin-key-long-enough';
const CLIENT = 'connection-1';

let root: string;
let registry: WorldRegistry;
let manager: WorldManager;
let admin: WorldAdminService;
let now = 1_787_000_000_000;

function makeConfig(worldsDir: string, worldAdminKey: string | null): ServerConfig {
  return {
    worldSize: WORLD_SIZE,
    port: 0,
    dbPath: join(worldsDir, 'no-legacy.db'),
    tickHz: 10,
    snapshotIntervalS: 60,
    difficulty: 50,
    pluginsDir: worldsDir,
    clientDistPath: worldsDir,
    snapshotRetention: 5,
    rollbackKey: 'rollback-key-long-enough',
    worldsDir,
    serverSettingsPath: join(worldsDir, 'server-settings.json'),
    worldAdminKey,
    worldSwitchCountdownS: 0,
    pluginsEnabled: null,
  };
}

function setUp(worldAdminKey: string | null = KEY): void {
  root = mkdtempSync(join(tmpdir(), 'terrace-admin-'));
  registry = new WorldRegistry(join(root, 'worlds'));
  const config = makeConfig(registry.worldsDir, worldAdminKey);
  manager = new WorldManager({ config, registry, plugins: new InstalledPlugins([]), switchCountdownS: 0 });
  const restart = new ServerRestartService({
    shutdown: () => Promise.resolve(),
    exit: () => {},
    countdownS: 0,
    defer: () => {},
  });
  admin = new WorldAdminService({ manager, registry, config, restart, now: () => now });
}

beforeEach(() => {
  now = 1_787_000_000_000;
  setUp();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function create(name: string): string {
  const result = admin.handle(CLIENT, { type: 'worldCreate', key: KEY, name });
  expect(result.ok).toBe(true);
  return result.id as string;
}

describe('the gate', () => {
  it('refuses every action with the wrong key, and does nothing', () => {
    const id = create('Frostwick Hollows');

    for (const request of [
      { type: 'worldLoad', key: 'wrong', id },
      { type: 'worldArchive', key: 'wrong', id },
      { type: 'worldRename', key: 'wrong', id, name: 'Renamed' },
      { type: 'worldUnload', key: 'wrong' },
    ] as const) {
      const result = admin.handle(CLIENT, request);
      expect(result.ok).toBe(false);
      expect(result.refused).toBe('badKey');
    }

    expect(registry.has(id)).toBe(true);
    expect(registry.summaryFor(id, null)?.name).toBe('Frostwick Hollows');
    expect(manager.activeId).toBeNull();
  });

  it('locks a connection out after enough wrong keys, then lets it back in', () => {
    const id = create('Frostwick Hollows');
    for (let attempt = 0; attempt < OPERATOR_MAX_FAILED_ATTEMPTS; attempt++) {
      admin.handle(CLIENT, { type: 'worldLoad', key: 'wrong', id });
    }
    expect(admin.handle(CLIENT, { type: 'worldLoad', key: KEY, id }).refused).toBe('throttled');

    now += OPERATOR_LOCKOUT_MS + 1;
    expect(admin.handle(CLIENT, { type: 'worldLoad', key: KEY, id }).ok).toBe(true);
  });

  it('keeps lockouts per connection', () => {
    const id = create('Frostwick Hollows');
    for (let attempt = 0; attempt < OPERATOR_MAX_FAILED_ATTEMPTS; attempt++) {
      admin.handle('noisy', { type: 'worldLoad', key: 'wrong', id });
    }
    expect(admin.handle('quiet', { type: 'worldLoad', key: KEY, id }).ok).toBe(true);
  });

  it('requires no key at all when none is configured', () => {
    rmSync(root, { recursive: true, force: true });
    setUp(null);
    expect(admin.keyed).toBe(false);
    expect(admin.list(CLIENT, '').refused).toBeUndefined();
  });

  it('refuses a listing with the wrong key and reveals no worlds', () => {
    create('Frostwick Hollows');
    const listing = admin.list(CLIENT, 'wrong');
    expect(listing.refused).toBe('badKey');
    expect(listing.worlds).toEqual([]);
    expect(listing.archived).toEqual([]);
    expect(listing.activeId).toBeNull();
  });
});

describe('purge, the only destructive action', () => {
  it('refuses a world that is live', () => {
    const id = create('Frostwick Hollows');
    admin.handle(CLIENT, { type: 'worldLoad', key: KEY, id });

    expect(admin.handle(CLIENT, { type: 'worldArchive', key: KEY, id }).refused).toBe(
      'worldIsActive',
    );
    expect(
      admin.handle(CLIENT, {
        type: 'worldPurge',
        key: KEY,
        id,
        confirmName: 'Frostwick Hollows',
      }).refused,
    ).toBe('notArchived');
    expect(registry.has(id)).toBe(true);
  });

  it('refuses when the typed name does not match, and destroys nothing', () => {
    const id = create('Frostwick Hollows');
    const archived = admin.handle(CLIENT, { type: 'worldArchive', key: KEY, id });
    expect(archived.ok).toBe(true);
    const archivedId = registry.listArchived()[0].id;

    for (const wrong of ['frostwick hollows', 'Frostwick Hollow', '', 'yes']) {
      const result = admin.handle(CLIENT, {
        type: 'worldPurge',
        key: KEY,
        id: archivedId,
        confirmName: wrong,
      });
      expect(result.refused).toBe('confirmationMismatch');
    }
    expect(registry.listArchived()).toHaveLength(1);
  });

  it('destroys the world when the name matches exactly', () => {
    const id = create('Frostwick Hollows');
    admin.handle(CLIENT, { type: 'worldArchive', key: KEY, id });
    const archivedId = registry.listArchived()[0].id;

    const result = admin.handle(CLIENT, {
      type: 'worldPurge',
      key: KEY,
      id: archivedId,
      confirmName: 'Frostwick Hollows',
    });

    expect(result.ok).toBe(true);
    expect(registry.listArchived()).toEqual([]);
  });

  it('reports where an archived world went', () => {
    const id = create('Frostwick Hollows');
    const result = admin.handle(CLIENT, { type: 'worldArchive', key: KEY, id });
    expect(result.archivedPath).toBeTruthy();
    expect(result.archivedPath).toContain('.trash');
  });
});

describe('renaming and duplicating', () => {
  it('renames a world that is not loaded', () => {
    const id = create('Frostwick Hollows');
    expect(admin.handle(CLIENT, { type: 'worldRename', key: KEY, id, name: 'Thornfall' }).ok)
      .toBe(true);
    expect(registry.summaryFor(id, null)?.name).toBe('Thornfall');
    expect(registry.has(id)).toBe(true);
  });

  it('renames the live world so the new name survives a reload', () => {
    const id = create('Frostwick Hollows');
    admin.handle(CLIENT, { type: 'worldLoad', key: KEY, id });
    admin.handle(CLIENT, { type: 'worldRename', key: KEY, id, name: 'Thornfall' });

    expect(manager.current?.world.name).toBe('Thornfall');
    manager.unload();
    manager.requestLoad(id);
    expect(manager.current?.world.name).toBe('Thornfall');
  });

  it('duplicates under a new id without touching the original', () => {
    const id = create('Frostwick Hollows');
    const copy = admin.handle(CLIENT, {
      type: 'worldDuplicate',
      key: KEY,
      id,
      name: 'Frostwick Redux',
    });

    expect(copy.ok).toBe(true);
    expect(copy.id).not.toBe(id);
    expect(registry.summaryFor(id, null)?.name).toBe('Frostwick Hollows');
    expect(registry.summaryFor(copy.id as string, null)?.name).toBe('Frostwick Redux');
  });

  it('never overwrites an existing world on create', () => {
    const first = create('Frostwick Hollows');
    const second = create('Frostwick Hollows');
    expect(second).not.toBe(first);
    expect(registry.list(null)).toHaveLength(2);
  });
});

describe('the protocol validator', () => {
  it('rejects ids that could escape the worlds folder', () => {
    for (const id of ['../escape', 'a/b', 'UPPER', '', 'has space']) {
      expect(validateWorldAdminRequest({ type: 'worldLoad', key: KEY, id })).toBeNull();
    }
  });

  it('rejects a missing or oversized key, and accepts an empty one', () => {
    expect(validateWorldAdminRequest({ type: 'worldList' })).toBeNull();
    expect(validateWorldAdminRequest({ type: 'worldList', key: '' })).toEqual({
      type: 'worldList',
      key: '',
    });
    expect(validateWorldAdminRequest({ type: 'worldList', key: 'x'.repeat(1000) })).toBeNull();
  });

  it('rejects a name with control characters in it', () => {
    expect(
      validateWorldAdminRequest({ type: 'worldCreate', key: KEY, name: 'a\nb' }),
    ).toBeNull();
  });

  it('accepts the shapes the panel actually sends', () => {
    expect(validateWorldAdminRequest({ type: 'worldList', key: KEY })).toEqual({
      type: 'worldList',
      key: KEY,
    });
    expect(
      validateWorldAdminRequest({ type: 'worldPin', key: KEY, pointId: 3, pinned: true }),
    ).toEqual({ type: 'worldPin', key: KEY, pointId: 3, pinned: true });
    expect(validateWorldAdminRequest({ type: 'worldPin', key: KEY, pointId: 0, pinned: true }))
      .toBeNull();
  });
});

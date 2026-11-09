import { join } from 'node:path';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import { createChunkMask } from '@terrace/shared';
import { loadConfig } from '../src/config.ts';
import { openWorlds } from '../src/boot/open-worlds.ts';
import { WorldRegistry } from '../src/persistence/world-registry.ts';
import { InstalledPlugins } from '../src/plugins/installed.ts';
import { WorldManager } from '../src/world/world-manager.ts';
import type { TerracePlugin } from '../src/plugins/types.ts';
import { bindRoomContext, TerraceRoom } from '../src/net/terrace-room.ts';
import { ServerRestartService } from '../src/restart.ts';
import { WorldAdminService } from '../src/world/world-admin.ts';
import { PerfLoggingSetting } from '../src/perf-logging-setting.ts';
import { asLoadedPlugin, RecordingSink } from './support/harness.ts';
import { makeTempRoot, removeTempRoot } from './support/tempRoot.ts';

const WORLD_SIZE = 64;
const SQLITE_DATABASE_HEADER_BYTES = 100;
// SQLite's default busy timeout is five seconds; leave time for cleanup.
const CONTENDED_CHECKPOINT_TIMEOUT_MS = 15_000;
const fixtures: { manager: WorldManager; root: string }[] = [];

function fixture(plugins: TerracePlugin[] = [], retention = 10) {
  const root = makeTempRoot('terrace-engine-contract-');
  const registry = new WorldRegistry(join(root, 'worlds'));
  const config = {
    ...loadConfig({}), worldSize: WORLD_SIZE, worldsDir: registry.worldsDir,
    dbPath: join(root, 'absent.db'), snapshotRetention: retention, worldSwitchCountdownS: 0,
    serverSettingsPath: join(root, 'settings.json'), perfLogPath: join(root, 'perf.log'),
  };
  const manager = new WorldManager({
    registry, config, plugins: new InstalledPlugins(plugins.map(asLoadedPlugin)), switchCountdownS: 0,
  });
  fixtures.push({ manager, root });
  const store = registry.createStore('audit', retention);
  store.saveSnapshot({ worldSize: WORLD_SIZE, name: 'Audit',
    cells: new Int16Array(WORLD_SIZE * WORLD_SIZE).fill(32),
    mask: createChunkMask(WORLD_SIZE).fill(255), pluginSlices: {} });
  store.close();
  manager.requestLoad('audit');
  manager.snapshotIfDirty();
  return { manager, registry, config };
}

afterEach(() => {
  for (const { manager, root } of fixtures.splice(0)) {
    manager.shutdown();
    removeTempRoot(root);
  }
});

describe('engine persistence contracts', () => {
  it('saves changed slices without terrain changes and skips equal detached snapshots', () => {
    let value = 0;
    const plugin: TerracePlugin = { name: 'counter', persistence: {
      version: 1, save: () => ({ value }),
      load(data) { value = (data as { value: number }).value; },
    } };
    const { manager } = fixture([plugin]);
    expect(manager.snapshotIfDirty()).toBe(false);
    value = 42;
    expect(manager.current!.world.dirty).toBe(false);
    expect(manager.snapshotIfDirty()).toBe(true);
    expect(manager.snapshotIfDirty()).toBe(false);
    value = 43;
    expect(manager.shutdown()).toBe(true);
    value = 0;
    manager.requestLoad('audit');
    expect(value).toBe(43);
  });

  it.each(['cycle', 'bigint'])('isolates a %s slice and retains its valid prior data', (kind) => {
    let bad = false;
    const plugin: TerracePlugin = { name: 'broken', persistence: {
      version: 1, load() {}, save() {
        if (!bad) return { value: 1 };
        if (kind === 'bigint') return { value: 1n };
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        return cycle;
      },
    } };
    const { manager } = fixture([plugin]);
    bad = true;
    manager.current!.world.rename('Still saved');
    expect(manager.snapshotIfDirty()).toBe(true);
    expect(manager.current!.host.faultCount('broken')).toBe(1);
    expect(manager.current!.store.loadLatest()!.pluginSlices['broken']).toEqual({ v: 1, data: { value: 1 } });
    bad = false;
  });

  it('ignores a deferred confirmation delivered after a newer blocking save', () => {
    let value = 0;
    const plugin: TerracePlugin = { name: 'counter', persistence: {
      version: 1, save: () => ({ value }), load() {},
    } };
    const { manager } = fixture([plugin]);
    const store = manager.current!.store;
    let settled: ((error: string | null) => void) | undefined;
    store.saveSnapshotDeferred = (input, onSettled) => {
      store.saveSnapshot(input);
      settled = onSettled;
    };
    value = 1;
    manager.snapshotIfDirty({ defer: true });
    value = 2;
    manager.snapshotIfDirty();
    settled!(null);
    value = 1;
    expect(manager.snapshotIfDirty()).toBe(true);
    expect(store.loadLatest()!.pluginSlices['counter']).toEqual({ v: 1, data: { value: 1 } });
  });

  it('rejects competing room attachment and ignores cleanup by a nonowner', () => {
    const { manager } = fixture();
    const first = { sink: new RecordingSink(), players: () => [], clientCount: () => 0 };
    const second = { sink: new RecordingSink(), players: () => [], clientCount: () => 0 };
    expect(manager.attachRoom(first)).toBe(true);
    expect(manager.attachRoom(second)).toBe(false);
    expect(manager.detachRoom(second)).toBe(false);
    expect(manager.current!.world.messageSink).toBe(first.sink);
    expect(manager.detachRoom(first)).toBe(true);
    expect(manager.attachRoom(second)).toBe(true);
  });

  it('rejects a second Room before its cleanup can detach the first', () => {
    const { manager, registry, config } = fixture();
    const restart = new ServerRestartService({
      shutdown: async () => {}, exit() {}, countdownS: 0, defer(run) { run(); },
    });
    bindRoomContext({ manager, restart,
      admin: new WorldAdminService({ manager, registry, config, restart }),
      perfLogging: new PerfLoggingSetting(config.serverSettingsPath, {}),
    });
    const first = new TerraceRoom();
    const second = new TerraceRoom();
    try {
      first.onCreate();
      const sink = manager.current!.world.messageSink;
      expect(() => second.onCreate()).toThrow('already exists');
      second.onDispose();
      expect(manager.current!.world.messageSink).toBe(sink);
    } finally {
      first.onDispose();
      second.onDispose();
    }
  });

  it('keeps a missing active selection unloaded without replacing its pointer', () => {
    const { manager, registry, config } = fixture();
    manager.shutdown();
    registry.writeActive('missing');
    expect(openWorlds(config, registry, manager).loadedId).toBeNull();
    expect(manager.current).toBeNull();
    expect(registry.hasActiveSelection()).toBe(true);
  });

  it('retains the returned undo point with retention one', () => {
    const { manager } = fixture([], 1);
    const { store, world, rollback } = manager.current!;
    const target = store.loadLatest()!.id;
    store.setPinned(target, true);
    world.applySculpt(32, 32, 2, 16);
    const result = rollback.rollback('operator', '', target);
    expect(result.ok).toBe(true);
    if (!result.ok || result.undoId === undefined) throw new Error('rollback did not return an undo point');
    expect(store.loadSnapshot(result.undoId)).not.toBeNull();
  });

  it('refuses a copy while committed WAL changes cannot be checkpointed', () => {
    const { registry } = fixture();
    const path = registry.pathFor('audit');
    const writer = new DatabaseConstructor(path);
    const reader = new DatabaseConstructor(path, { readonly: true });
    try {
      writer.pragma('wal_autocheckpoint = 0');
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM snapshots').get();
      writer.prepare('UPDATE snapshots SET world_name = ?').run('In WAL');
      expect(() => registry.duplicate('audit', 'copy')).toThrow('checkpoint is busy');
      expect(registry.has('copy')).toBe(false);
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      writer.close();
    }
  }, CONTENDED_CHECKPOINT_TIMEOUT_MS);

  it.each(['notadb', 'corrupt', 'corrupt-data'] as const)('preserves unreadable files and their WAL on archive/adopt (%s)', (format) => {
    const { registry } = fixture();
    const source = registry.pathFor('broken');
    const external = join(registry.worldsDir, '.external.db');
    let contents = Buffer.from('not a sqlite database');
    if (format !== 'notadb') {
      const sample = new DatabaseConstructor(source);
      sample.exec('CREATE TABLE snapshots (world_name TEXT, world_size INTEGER, created_at INTEGER)');
      const rootPage = (sample.prepare("SELECT rootpage FROM sqlite_master WHERE name='snapshots'").get() as { rootpage: number }).rootpage;
      const pageSize = sample.pragma('page_size', { simple: true }) as number;
      sample.close();
      contents = readFileSync(source);
      const offset = format === 'corrupt' ? SQLITE_DATABASE_HEADER_BYTES : (rootPage - 1) * pageSize;
      contents[offset] = 0; // Invalid b-tree page type; data corruption leaves sqlite_master readable.
    }
    for (const path of [source, external]) {
      writeFileSync(path, contents);
      writeFileSync(path + '-wal', 'unreadable WAL bytes');
      writeFileSync(path + '-shm', 'unreadable SHM bytes');
    }
    const archived = registry.archive('broken', Date.now());
    const adopted = registry.adopt(external, 'imported')!;
    expect(adopted).toBe('imported');
    for (const path of [archived.path, registry.pathFor(adopted)]) {
      expect(readFileSync(path).equals(contents)).toBe(true);
      expect(readFileSync(path + '-wal', 'utf8')).toBe('unreadable WAL bytes');
      expect(existsSync(path + '-shm')).toBe(true);
    }
    expect(existsSync(source)).toBe(false);
    expect(existsSync(external)).toBe(true);
    expect(readFileSync(external + '-wal', 'utf8')).toBe('unreadable WAL bytes');
    expect(() => registry.duplicate(adopted, 'invalid-copy')).toThrow();
    expect(registry.has('invalid-copy')).toBe(false);
    expect(readFileSync(registry.pathFor(adopted) + '-wal', 'utf8')).toBe('unreadable WAL bytes');
  });

  it('preserves real committed WAL frames across corrupt archive/adopt and refused copies', () => {
    const { registry } = fixture();
    const source = join(registry.worldsDir, '.wal-source.db');
    const writer = new DatabaseConstructor(source);
    try {
      writer.pragma('journal_mode = WAL');
      writer.exec('CREATE TABLE snapshots (id INTEGER PRIMARY KEY, world_name TEXT, world_size INTEGER, created_at INTEGER); CREATE TABLE extra (value TEXT)');
      writer.exec("INSERT INTO snapshots VALUES (1, 'Legacy', 64, 1)");
      writer.pragma('wal_checkpoint(TRUNCATE)');
      writer.exec("INSERT INTO extra VALUES ('committed after checkpoint')");
      const page = (writer.prepare("SELECT rootpage FROM sqlite_master WHERE name='snapshots'").get() as { rootpage: number }).rootpage;
      const pageSize = writer.pragma('page_size', { simple: true }) as number;
      const wal = readFileSync(source + '-wal');
      expect(wal.length).toBeGreaterThan(0);
      const stage = (target: string) => {
        copyFileSync(source, target);
        copyFileSync(source + '-wal', target + '-wal');
        const bytes = readFileSync(target);
        bytes[(page - 1) * pageSize] = 0;
        writeFileSync(target, bytes);
        return bytes;
      };
      const bytes = stage(registry.pathFor('broken'));
      const archived = registry.archive('broken', Date.now());
      expect(readFileSync(archived.path).equals(bytes)).toBe(true);
      expect(readFileSync(archived.path + '-wal').equals(wal)).toBe(true);
      const external = join(registry.worldsDir, '.external-wal.db');
      stage(external);
      const adopted = registry.adopt(external, 'imported')!;
      expect(readFileSync(registry.pathFor(adopted) + '-wal').equals(wal)).toBe(true);
      expect(readFileSync(external + '-wal').equals(wal)).toBe(true);
      expect(() => registry.duplicate(adopted, 'copy')).toThrow();
      expect(registry.has('copy')).toBe(false);
      expect(readFileSync(registry.pathFor(adopted) + '-wal').equals(wal)).toBe(true);
    } finally { writer.close(); }
  });

  it('keeps world management available after legacy integrity refusal without selecting a replacement', () => {
    const { manager, registry, config } = fixture();
    manager.shutdown();
    registry.writeActive(null);
    const legacy = join(registry.worldsDir, '.legacy.db');
    const db = new DatabaseConstructor(legacy);
    db.exec('CREATE TABLE snapshots (id INTEGER PRIMARY KEY, world_name TEXT, world_size INTEGER, created_at INTEGER); CREATE TABLE extra (value TEXT)');
    db.exec("INSERT INTO snapshots VALUES (1, 'Legacy', 64, 1)");
    const page = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name='extra'").get() as { rootpage: number }).rootpage;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    db.close();
    const bytes = readFileSync(legacy);
    bytes[(page - 1) * pageSize] = 0;
    writeFileSync(legacy, bytes);
    const result = openWorlds({ ...config, dbPath: legacy }, registry, manager);
    expect(result).toEqual({ adopted: [], createdFirstWorld: false, loadedId: null });
    expect(manager.current).toBeNull();
    expect(registry.has('audit')).toBe(true);
    expect(readFileSync(legacy).equals(bytes)).toBe(true);
  });
});

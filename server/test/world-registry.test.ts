import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import { SnapshotStore } from '../src/persistence/snapshot-store.ts';
import { TRASH_DIR_NAME, WorldRegistry } from '../src/persistence/world-registry.ts';
import { World } from '../src/world/world.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;

const TEST_RETENTION = 3;

let root: string;
let registry: WorldRegistry;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terrace-worlds-'));
  registry = new WorldRegistry(join(root, 'worlds'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeWorld(name: string, retention = TEST_RETENTION): string {
  const id = registry.uniqueIdFor(name);
  if (id === null) throw new Error(`no id for "${name}"`);
  const store = registry.createStore(id, retention);
  const world = World.createFresh(WORLD_SIZE, 50, name);
  store.saveSnapshot({
    worldSize: world.size,
    name: world.name,
    cells: world.map.cells,
    mask: world.mask,
    pluginSlices: {},
  });
  store.close();
  return id;
}

function writeSnapshots(id: string, count: number, retention = TEST_RETENTION): void {
  const store = registry.openStore(id, retention);
  const latest = store.loadLatest();
  if (latest === null) throw new Error(`world "${id}" has no snapshot`);
  for (let i = 0; i < count; i++) {
    store.saveSnapshot({
      worldSize: latest.worldSize,
      name: latest.name ?? id,
      cells: latest.cells,
      mask: latest.mask,
      pluginSlices: {},
    });
  }
  store.close();
}

function snapshotCount(id: string, archived = false): number {
  const store = SnapshotStore.open(registry.pathFor(id, archived), TEST_RETENTION);
  try {
    return store.countSnapshots();
  } finally {
    store.close();
  }
}

describe('a world is a file', () => {
  it('does not let one world’s writes prune another world’s history', () => {
    const kept = makeWorld('Frostwick Hollows');
    const busy = makeWorld('Galewick Downs');

    const keptBefore = snapshotCount(kept);
    writeSnapshots(busy, TEST_RETENTION * 10);

    expect(snapshotCount(kept)).toBe(keptBefore);
    expect(snapshotCount(busy)).toBe(TEST_RETENTION);
  });

  it('keeps every world listed with its own name, size and depth', () => {
    makeWorld('Frostwick Hollows');
    makeWorld('Moonreach');

    const listed = registry.list(null);
    expect(listed.map((world) => world.name).sort()).toEqual([
      'Frostwick Hollows',
      'Moonreach',
    ]);
    for (const world of listed) {
      expect(world.worldSize).toBe(WORLD_SIZE);
      expect(world.restorePoints).toBeGreaterThan(0);
      expect(world.unreadable).toBeUndefined();
    }
  });

  it('lists an unreadable file WITH its problem rather than hiding it', () => {
    writeFileSync(join(registry.worldsDir, 'corrupt.db'), 'not a database at all');
    const listed = registry.list(null);
    const corrupt = listed.find((world) => world.id === 'corrupt');
    expect(corrupt).toBeDefined();
    expect(corrupt?.unreadable).toBeTruthy();
  });
});

describe('pinned restore points', () => {
  it('survive any number of later snapshots', () => {
    const id = makeWorld('Frostwick Hollows');
    const store = registry.openStore(id, TEST_RETENTION);
    const pinned = store.listRestorePoints()[0].id;
    expect(store.setPinned(pinned, true)).toBe(true);
    store.close();

    writeSnapshots(id, TEST_RETENTION * 5);

    const after = registry.openStore(id, TEST_RETENTION);
    try {
      const ids = after.listRestorePoints().map((point) => point.id);
      expect(ids).toContain(pinned);
      expect(after.countPinned()).toBe(1);
    } finally {
      after.close();
    }
  });

  it('do not consume the retention window', () => {
    const id = makeWorld('Frostwick Hollows');
    const store = registry.openStore(id, TEST_RETENTION);
    store.setPinned(store.listRestorePoints()[0].id, true);
    store.close();

    writeSnapshots(id, TEST_RETENTION * 5);

    const after = registry.openStore(id, TEST_RETENTION);
    try {
      expect(after.countSnapshots()).toBe(TEST_RETENTION + 1);
    } finally {
      after.close();
    }
  });

  it('can be unpinned, after which they prune normally', () => {
    const id = makeWorld('Frostwick Hollows');
    const store = registry.openStore(id, TEST_RETENTION);
    const pinned = store.listRestorePoints()[0].id;
    store.setPinned(pinned, true);
    store.setPinned(pinned, false);
    store.close();

    writeSnapshots(id, TEST_RETENTION * 5);
    expect(snapshotCount(id)).toBe(TEST_RETENTION);
  });
});

describe('archiving is not deleting', () => {
  it('moves the file to the trash and leaves it readable there', () => {
    const id = makeWorld('Frostwick Hollows');
    const before = snapshotCount(id);

    const { archivedId, path } = registry.archive(id, 1_787_000_000_000);

    expect(existsSync(registry.pathFor(id))).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain(TRASH_DIR_NAME);
    expect(snapshotCount(archivedId, true)).toBe(before);
    expect(registry.listArchived().map((world) => world.name)).toEqual([
      'Frostwick Hollows',
    ]);
  });

  it('restores an archived world under a free id', () => {
    const id = makeWorld('Frostwick Hollows');
    const { archivedId } = registry.archive(id, 1_787_000_000_000);
    const restored = registry.unarchive(archivedId);

    expect(registry.has(restored)).toBe(true);
    expect(registry.listArchived()).toEqual([]);
    expect(registry.summaryFor(restored, null)?.name).toBe('Frostwick Hollows');
  });

  it('never overwrites a world that took the name while it was in the trash', () => {
    const original = makeWorld('Frostwick Hollows');
    const { archivedId } = registry.archive(original, 1_787_000_000_000);
    const usurper = makeWorld('Frostwick Hollows');
    expect(usurper).toBe(original);

    const restored = registry.unarchive(archivedId);
    expect(restored).not.toBe(usurper);
    expect(registry.has(usurper)).toBe(true);
    expect(registry.has(restored)).toBe(true);
  });

  it('reserves archived ids so a new world cannot collide with one', () => {
    const id = makeWorld('Frostwick Hollows');
    registry.archive(id, 1_787_000_000_000);
    const next = registry.uniqueIdFor('Frostwick Hollows');
    expect(next).not.toBeNull();
    expect(registry.hasArchived(next as string)).toBe(false);
  });
});

describe('purge', () => {
  it('destroys an archived world and nothing else', () => {
    const doomed = makeWorld('Galewick Downs');
    const keeper = makeWorld('Frostwick Hollows');
    const { archivedId } = registry.archive(doomed, 1_787_000_000_000);

    registry.purge(archivedId);

    expect(registry.listArchived()).toEqual([]);
    expect(registry.has(keeper)).toBe(true);
    expect(snapshotCount(keeper)).toBeGreaterThan(0);
  });

  it('refuses a world that is not archived', () => {
    const id = makeWorld('Frostwick Hollows');
    expect(() => registry.purge(id)).toThrow();
    expect(registry.has(id)).toBe(true);
  });
});

describe('ids are paths, so they are validated', () => {
  it('refuses anything that could escape the worlds folder', () => {
    for (const hostile of ['../escape', 'a/b', '.active', 'UPPER', 'has space', '-lead']) {
      expect(() => registry.pathFor(hostile)).toThrow();
    }
  });

  it('ignores files in the folder whose names are not usable ids', () => {
    writeFileSync(join(registry.worldsDir, 'Not An Id.db'), '');
    expect(registry.list(null)).toEqual([]);
  });
});

describe('adopting a legacy world', () => {
  it('copies it in, leaving the original exactly where it was', () => {
    const legacyDir = mkdtempSync(join(root, 'legacy-'));
    const legacyPath = join(legacyDir, 'world.db');
    const store = SnapshotStore.open(legacyPath, TEST_RETENTION);
    const world = World.createFresh(WORLD_SIZE, 50, 'Frostwick Hollows');
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
    });
    store.close();

    const adopted = registry.adopt(legacyPath, null);

    expect(adopted).toBe('frostwick-hollows');
    expect(existsSync(legacyPath)).toBe(true);
    expect(registry.summaryFor('frostwick-hollows', null)?.name).toBe('Frostwick Hollows');
  });

  it('is idempotent, so it can run on every boot forever', () => {
    const legacyDir = mkdtempSync(join(root, 'legacy-'));
    const legacyPath = join(legacyDir, 'world.db');
    const store = SnapshotStore.open(legacyPath, TEST_RETENTION);
    const world = World.createFresh(WORLD_SIZE, 50, 'Frostwick Hollows');
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
    });
    store.close();

    expect(registry.adopt(legacyPath, null)).toBe('frostwick-hollows');
    expect(registry.adopt(legacyPath, null)).toBeNull();
    expect(registry.adopt(legacyPath, null)).toBeNull();

    expect(readdirSync(registry.worldsDir).filter((n) => n.endsWith('.db'))).toHaveLength(1);
  });
});

describe('the active pointer', () => {
  it('round-trips the loaded world', () => {
    const id = makeWorld('Frostwick Hollows');
    registry.writeActive(id);
    expect(registry.readActive()).toBe(id);
  });

  it('reports nothing rather than inventing a world when it is stale', () => {
    const id = makeWorld('Frostwick Hollows');
    registry.writeActive(id);
    registry.archive(id, 1_787_000_000_000);
    expect(registry.readActive()).toBeNull();
  });

  it('ignores a pointer that does not name a valid id', () => {
    writeFileSync(join(registry.worldsDir, '.active'), '../../etc/passwd');
    expect(registry.readActive()).toBeNull();
  });

  it('clears to nothing loaded', () => {
    const id = makeWorld('Frostwick Hollows');
    registry.writeActive(id);
    registry.writeActive(null);
    expect(registry.readActive()).toBeNull();
  });
});

describe('duplicate', () => {
  it('copies the whole history, not just the current state', () => {
    const id = makeWorld('Frostwick Hollows');
    writeSnapshots(id, 2);
    const before = snapshotCount(id);

    registry.duplicate(id, 'frostwick-copy');

    expect(snapshotCount('frostwick-copy')).toBe(before);
  });

  it('refuses to overwrite an existing world', () => {
    const a = makeWorld('Frostwick Hollows');
    const b = makeWorld('Moonreach');
    expect(() => registry.duplicate(a, b)).toThrow();
    expect(registry.summaryFor(b, null)?.name).toBe('Moonreach');
  });
});

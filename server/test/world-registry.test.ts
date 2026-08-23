// World registry + per-file retention (multi-world, 2026-08-22).
//
// THESE ARE CONTRACT TESTS, NOT WIRING TESTS. The bug this whole arc exists to
// fix — a world losing 298 of its 308 snapshots to another world's writes —
// was not a mistake at any call site. It was the contract: retention kept "the
// newest N rows" of a table that held every world. So the tests that matter
// assert the CONTRACT: that one world's writes cannot reach another world's
// history, that archiving never unlinks, and that only purge does.
//
// Real files in a temp directory, never `:memory:`: every guarantee here is
// about what is on disk after an operation, and an in-memory database would
// test the wrong thing.

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import { SnapshotStore } from '../src/persistence/snapshot-store.ts';
import { TRASH_DIR_NAME, WorldRegistry } from '../src/persistence/world-registry.ts';
import { World } from '../src/world/world.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;

/** Retention small enough that a handful of writes exercises the window. */
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

/** Creates a world file with one genesis snapshot and returns its id. */
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

/** Writes `count` further snapshots into an existing world. */
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
    // THE REGRESSION TEST FOR THE INCIDENT. Frostwick Hollows lost 298
    // snapshots because Wilds-of-Thornfall-shaped writes kept walking a shared
    // window forward. With one file per world that is not expressible.
    const kept = makeWorld('Frostwick Hollows');
    const busy = makeWorld('Galewick Downs');

    const keptBefore = snapshotCount(kept);
    // Far more writes than the retention window, into the OTHER world.
    writeSnapshots(busy, TEST_RETENTION * 10);

    expect(snapshotCount(kept)).toBe(keptBefore);
    // ...and the busy world pruned itself, exactly as retention should.
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
    // A world you can see and cannot open is a bug report. A world that
    // silently vanished from the list is indistinguishable, to its owner,
    // from one that was deleted.
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
    // Pinning a moment must not cost undo depth, or an operator learns to
    // avoid the feature that exists to protect them.
    const id = makeWorld('Frostwick Hollows');
    const store = registry.openStore(id, TEST_RETENTION);
    store.setPinned(store.listRestorePoints()[0].id, true);
    store.close();

    writeSnapshots(id, TEST_RETENTION * 5);

    const after = registry.openStore(id, TEST_RETENTION);
    try {
      // The pin, PLUS a full window of ordinary points.
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
    // The world is intact, not merely present.
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
    // Something else claims the name in the meantime.
    const usurper = makeWorld('Frostwick Hollows');
    expect(usurper).toBe(original);

    const restored = registry.unarchive(archivedId);
    expect(restored).not.toBe(usurper);
    // Both survive.
    expect(registry.has(usurper)).toBe(true);
    expect(registry.has(restored)).toBe(true);
  });

  it('reserves archived ids so a new world cannot collide with one', () => {
    const id = makeWorld('Frostwick Hollows');
    registry.archive(id, 1_787_000_000_000);
    // The archived file is named `<id>-<stamp>`, so the bare id is free again;
    // what must not happen is a NEW world silently taking a name that an
    // archived world would land back on.
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
    // The live file must be unreachable by the only destructive call in the
    // codebase: archiving first is a mandatory step, not a convention.
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
    // MIGRATION MUST BE INCAPABLE OF LOSING THE ORIGINAL. If this build's copy
    // is wrong, the file the operator started with is still there.
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

    // One world, not three.
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
    // THE RULE THAT COST SOMEBODY A WORLD, INVERTED. "I cannot find the world
    // I expected" must never become "make a new one".
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
    // "Let me experiment without risking the real one" is what duplicate
    // means; a copy that dropped the safety net would be the opposite.
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

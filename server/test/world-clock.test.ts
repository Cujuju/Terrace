// THE WORLD CLOCK AGAINST REAL TIME (2026-08-23).
//
// World time is an offset against the wall clock — `simMillis` is the same
// number in every world alive, and only `genesisMillis` says which world it is
// happening to. This suite pins the seam where those two meet: the anchor that
// runs once per session, the three cases it has to reconstruct a birthday
// from, and the column that carries a birthday between sessions.

import DatabaseConstructor from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  DAY_LENGTH_MILLIS,
  WORLD_EPOCH_REAL_MILLIS,
  simMillisAtRealTime,
  worldAgeDays,
} from '@terrace/shared';
import { SnapshotStore } from '../src/persistence/snapshot-store.ts';
import { World } from '../src/world/world.ts';
import { worldWithUnlockedChunks } from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;

/** A fixed real instant, well after the epoch, so no assertion below drifts. */
const NOW = WORLD_EPOCH_REAL_MILLIS + 500 * DAY_LENGTH_MILLIS + 12_345;

describe('anchoring the world clock to real time', () => {
  it('leaves an unanchored world exactly as it always was', () => {
    // EVERY TEST WORLD IN THIS REPO IS UNANCHORED, and that is the whole reason
    // the anchor is a separate call at the boot seam rather than something the
    // constructor does: a synthetic world still starts its clock at zero and
    // moves it only by ticking, which is the behaviour every plugin suite was
    // written against.
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    expect(world.simMillis).toBe(0);
    expect(world.genesisMillis).toBe(0);

    world.advanceClock(1.5);
    expect(world.simMillis).toBe(1500);
    // Age equals the clock on such a world, so nothing downstream has to know.
    expect(world.simMillis - world.genesisMillis).toBe(1500);
  });

  it('starts a brand-new world at the hour real time says, born now', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.anchorClockToRealTime(NOW);

    expect(world.simMillis).toBe(simMillisAtRealTime(NOW));
    expect(world.genesisMillis).toBe(world.simMillis);
    expect(worldAgeDays(world.simMillis, world.genesisMillis)).toBe(0);
  });

  it('keeps a stored birthday and only moves the clock', () => {
    // The ordinary restore: the snapshot knows when the world was born, so the
    // anchor has nothing to reconstruct and must not overwrite it.
    const born = simMillisAtRealTime(NOW) - 40 * DAY_LENGTH_MILLIS;
    const world = World.restore(
      WORLD_SIZE,
      new Int16Array(WORLD_SIZE * WORLD_SIZE),
      worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]).mask,
      undefined,
      'Testfall',
      new Map(),
      0,
      born,
    );
    world.anchorClockToRealTime(NOW);

    expect(world.genesisMillis).toBe(born);
    expect(world.simMillis).toBe(simMillisAtRealTime(NOW));
    expect(worldAgeDays(world.simMillis, world.genesisMillis)).toBe(40);
  });

  it('reconstructs a pre-anchor world\'s birthday from the age it stored', () => {
    // THE MIGRATION CASE, and the reason `genesisMillis` is nullable rather
    // than defaulted to 0 at the reader: a snapshot written before this change
    // stored the world's AGE in `sim_millis`. Dating such a world to the epoch
    // would make it 500 days old; dating it to now would restart its saga at
    // Day 1. Neither is what its history says, and the subtraction is.
    const storedAge = 40 * DAY_LENGTH_MILLIS;
    const world = World.restore(
      WORLD_SIZE,
      new Int16Array(WORLD_SIZE * WORLD_SIZE),
      worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]).mask,
      undefined,
      'Testfall',
      new Map(),
      storedAge,
      null,
    );
    world.anchorClockToRealTime(NOW);

    expect(world.simMillis).toBe(simMillisAtRealTime(NOW));
    expect(world.genesisMillis).toBe(simMillisAtRealTime(NOW) - storedAge);
    expect(worldAgeDays(world.simMillis, world.genesisMillis)).toBe(40);
  });

  it('does not make the world younger when it ticks on', () => {
    // The clock moves, the birthday does not — the invariant every "Day N"
    // heading rests on.
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.anchorClockToRealTime(NOW);
    const born = world.genesisMillis;

    for (let tick = 0; tick < 100; tick++) world.advanceClock(0.1);

    expect(world.genesisMillis).toBe(born);
    expect(world.simMillis).toBe(simMillisAtRealTime(NOW) + 10_000);
  });
});

describe('the birthday on disk', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'terrace-clock-'));
    dbPath = join(dir, 'world.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function save(input: { simMillis?: number; genesisMillis?: number }): void {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const store = SnapshotStore.open(dbPath);
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
      ...input,
    });
    store.close();
  }

  it('round-trips a genesis across a restart', () => {
    const born = simMillisAtRealTime(NOW) - 7 * DAY_LENGTH_MILLIS;
    save({ simMillis: simMillisAtRealTime(NOW), genesisMillis: born });

    const store = SnapshotStore.open(dbPath);
    const snapshot = store.loadLatest();
    store.close();

    expect(snapshot?.genesisMillis).toBe(born);
    expect(snapshot?.simMillis).toBe(simMillisAtRealTime(NOW));
  });

  it('reads a row that never had a genesis as null, not as the epoch', () => {
    // Zero is a legitimate birthday (a world born at the epoch), so it cannot
    // also mean "unknown" — which is exactly why the column is nullable and
    // why the reader must not default it. A writer that omits it is standing
    // in for the pre-column build here.
    save({ simMillis: 3 * DAY_LENGTH_MILLIS });

    const store = SnapshotStore.open(dbPath);
    const snapshot = store.loadLatest();
    store.close();

    expect(snapshot?.genesisMillis).toBeNull();
    expect(snapshot?.simMillis).toBe(3 * DAY_LENGTH_MILLIS);
  });

  it('adds the column to a database that predates it, without a migration', () => {
    // The additive-column contract this file's column comment claims: an older
    // database opens, gains the column, and its existing row reads back as a
    // world with no recorded birthday rather than as a refused start.
    save({ simMillis: 3 * DAY_LENGTH_MILLIS, genesisMillis: 1 });
    const raw = new DatabaseConstructor(dbPath);
    raw.exec('ALTER TABLE snapshots DROP COLUMN genesis_millis');
    raw.close();

    const store = SnapshotStore.open(dbPath);
    const snapshot = store.loadLatest();
    store.close();

    expect(snapshot?.genesisMillis).toBeNull();
    expect(snapshot?.simMillis).toBe(3 * DAY_LENGTH_MILLIS);
  });
});

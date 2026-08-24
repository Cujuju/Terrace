// The on-disk shape of the CA board, and the defensive read-back. Separate
// from life.ts on purpose, in flora's house style: that module owns LIVE
// state and its rules, this one owns the SERIALIZED format and its
// validation.
//
// EVERYTHING PERSISTS: the live cells (with age AND tier — tier is no longer
// derivable from age alone once the neighbour-count gate can leave it lagging
// behind, see tiers.ts), the generation counter, and the RNG state. Dropping
// any of these on restart would be a visible regression: a block three
// generations from its next tier that restarts as a fresh age-0 birth is the
// same kind of bug flora's persistence section exists to rule out for trees.
//
// WHAT IS NOT PERSISTED: nothing. Unlike flora (which drops its 1 MB
// stability map because restoring it buys nothing observable) this plugin has
// no equivalent per-cell timing state outside the live cells themselves — the
// CA reads terrain fresh every generation, so there is nothing else to carry.

import {
  cellOfKey,
  isStructureTier,
  structureKey,
  STRUCTURES_CAP,
} from '../protocol.ts';
import { STRUCTURES_RNG_DEFAULT_SEED, type StructuresRng } from './rng.ts';
import type { LiveCellRecord } from './life.ts';

/**
 * Schema version of this plugin's persistence slice.
 *
 * 2 as of 2026-08-23: the weekday seeding rule (life.ts's shouldSeed) needs one
 * fact that survives a restart — which day settlers last arrived on. (How much
 * time the world has lived is the WORLD's business now, not this plugin's:
 * WorldApi.simMillis.) A v1 slice loads with lastSeedDay at -1, i.e. "never
 * seeded", so the worst case is one extra Monday.
 */
export const STRUCTURES_SLICE_VERSION = 2;

interface StoredLiveCell {
  readonly x: number;
  readonly y: number;
  readonly age: number;
  readonly tier: number;
}

export interface StructuresSlice {
  readonly version: number;
  readonly rngState: number;
  readonly generation: number;
  readonly live: readonly StoredLiveCell[];
  /**
   * The world-day settlers last arrived on, or -1 for never.
   *
   * PERSISTED because it is what makes "once a week" once a week: without it a
   * restart on a Monday re-arms the seeder, and a world restarted a few times
   * in one day would be repopulated a few times in one day.
   */
  readonly lastSeedDay: number;
}

export function saveStructures(
  live: ReadonlyMap<number, LiveCellRecord>,
  generation: number,
  rng: StructuresRng,
  lastSeedDay: number,
): StructuresSlice {
  const stored: StoredLiveCell[] = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    stored.push({ x: cell.x, y: cell.y, age: record.age, tier: record.tier });
  }
  return {
    version: STRUCTURES_SLICE_VERSION,
    rngState: rng.state(),
    generation,
    live: stored,
    lastSeedDay,
  };
}

export interface RestoredStructures {
  readonly live: Map<number, LiveCellRecord>;
  readonly generation: number;
  readonly rngState: number;
  readonly lastSeedDay: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Reads a persisted slice defensively, in flora's and relics' house style:
 * the row comes from this server's own SQLite file, but a truncated,
 * forward-versioned or hand-edited one must degrade to "an empty board that
 * re-seeds itself" and never crash a boot.
 *
 * Cells are NOT checked against a real world here — there is none yet
 * (persistence restores before onWorldCreate). Anything restored onto ground
 * that can no longer hold it dies at the very next generation, the same way
 * any other invalid cell would (life.ts's stepGeneration recomputes
 * buildability for the whole board from scratch every time; there is no
 * separate cull path to bypass).
 */
export function loadStructures(data: unknown): RestoredStructures {
  const empty: RestoredStructures = {
    live: new Map(),
    generation: 0,
    rngState: STRUCTURES_RNG_DEFAULT_SEED,
    // -1, not 0: day 0 is a real Monday, and "never seeded" must not read as
    // "already seeded on the world's first day".
    lastSeedDay: -1,
  };

  if (typeof data !== 'object' || data === null) return empty;
  const slice = data as Partial<StructuresSlice>;
  // A v1 slice is READ, not refused: it carries a live board and an rng state
  // that are still valid, and only lacks the two clock fields — which default
  // to "this world's calendar starts now". Refusing it would demolish every
  // standing settlement in an existing world to add a weekday.
  const legacy = slice.version === 1;
  if (slice.version !== STRUCTURES_SLICE_VERSION && !legacy) return empty;

  const live = new Map<number, LiveCellRecord>();
  if (Array.isArray(slice.live)) {
    for (const entry of slice.live) {
      if (live.size >= STRUCTURES_CAP) break;
      if (typeof entry !== 'object' || entry === null) continue;
      const { x, y, age, tier } = entry as Partial<StoredLiveCell>;
      if (!isNonNegativeInteger(x) || !isNonNegativeInteger(y) || !isNonNegativeInteger(age)) continue;
      if (!isStructureTier(tier)) continue;
      const key = structureKey(x, y);
      if (live.has(key)) continue; // hand-edited duplicate: first entry wins
      live.set(key, { age, tier });
    }
  }

  const generation = isNonNegativeInteger(slice.generation) ? slice.generation : 0;
  const rngState =
    isNonNegativeInteger(slice.rngState) ? slice.rngState : STRUCTURES_RNG_DEFAULT_SEED;

  const lastSeedDay = Number.isInteger(slice.lastSeedDay)
    ? (slice.lastSeedDay as number)
    : -1;

  return { live, generation, rngState, lastSeedDay };
}

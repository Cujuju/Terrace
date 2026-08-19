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

/** Schema version of this plugin's persistence slice. */
export const STRUCTURES_SLICE_VERSION = 1;

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
}

export function saveStructures(
  live: ReadonlyMap<number, LiveCellRecord>,
  generation: number,
  rng: StructuresRng,
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
  };
}

export interface RestoredStructures {
  readonly live: Map<number, LiveCellRecord>;
  readonly generation: number;
  readonly rngState: number;
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
  };

  if (typeof data !== 'object' || data === null) return empty;
  const slice = data as Partial<StructuresSlice>;
  if (slice.version !== STRUCTURES_SLICE_VERSION) return empty;

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

  return { live, generation, rngState };
}

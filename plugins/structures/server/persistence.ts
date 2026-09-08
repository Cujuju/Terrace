import {
  cellOfKey,
  isStructureTier,
  structureKey,
  STRUCTURES_CAP,
} from '../protocol.ts';
import { STRUCTURES_RNG_DEFAULT_SEED, type StructuresRng } from './rng.ts';
import type { BoardCellRecord } from './growth-model.ts';

export const STRUCTURES_SLICE_VERSION = 2;

interface StoredLiveCell {
  readonly x: number;
  readonly y: number;
  readonly age: number;
  readonly tier: number;
  readonly population?: number;
}

export interface StructuresSlice {
  readonly version: number;
  readonly rngState: number;
  readonly generation: number;
  readonly live: readonly StoredLiveCell[];
  readonly lastSeedDay: number;
}

export function saveStructures(
  live: ReadonlyMap<number, BoardCellRecord>,
  generation: number,
  rng: StructuresRng,
  lastSeedDay: number,
): StructuresSlice {
  const stored: StoredLiveCell[] = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    stored.push(
      record.population === undefined
        ? { x: cell.x, y: cell.y, age: record.age, tier: record.tier }
        : { x: cell.x, y: cell.y, age: record.age, tier: record.tier, population: record.population },
    );
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
  readonly live: Map<number, BoardCellRecord>;
  readonly generation: number;
  readonly rngState: number;
  readonly lastSeedDay: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function loadStructures(data: unknown): RestoredStructures {
  const empty: RestoredStructures = {
    live: new Map(),
    generation: 0,
    rngState: STRUCTURES_RNG_DEFAULT_SEED,
    lastSeedDay: -1,
  };

  if (typeof data !== 'object' || data === null) return empty;
  const slice = data as Partial<StructuresSlice>;
  const legacy = slice.version === 1;
  if (slice.version !== STRUCTURES_SLICE_VERSION && !legacy) return empty;

  const live = new Map<number, BoardCellRecord>();
  if (Array.isArray(slice.live)) {
    for (const entry of slice.live) {
      if (live.size >= STRUCTURES_CAP) break;
      if (typeof entry !== 'object' || entry === null) continue;
      const { x, y, age, tier, population } = entry as Partial<StoredLiveCell>;
      if (!isNonNegativeInteger(x) || !isNonNegativeInteger(y) || !isNonNegativeInteger(age)) continue;
      if (!isStructureTier(tier)) continue;
      const key = structureKey(x, y);
      if (live.has(key)) continue;
      live.set(
        key,
        isNonNegativeInteger(population) ? { age, tier, population } : { age, tier },
      );
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

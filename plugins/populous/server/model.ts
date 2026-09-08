export interface PopulousWorld {
  readonly worldSize: number;
}

export interface PopulousCellRecord {
  readonly age: number;
  readonly tier: number;
  readonly population?: number;
}

export interface PopulousStructureCell {
  readonly x: number;
  readonly y: number;
  readonly tier: number;
}

export interface PopulousContext {
  isBuildable(x: number, y: number): boolean;
  readonly maxTier: number;
  hasBuildingWithinSeparation(
    cells: ReadonlyMap<number, PopulousCellRecord>,
    x: number,
    y: number,
  ): boolean;
}

export interface PopulousStepResult {
  readonly nextLive: Map<number, PopulousCellRecord>;
  readonly born: PopulousStructureCell[];
  readonly upgraded: PopulousStructureCell[];
  readonly died: Array<{ x: number; y: number }>;
  readonly emitted: ReadonlyArray<{ x: number; y: number }>;
}

export const POPULOUS_CELL_KEY_STRIDE = 65536;

function cellOfKey(key: number): { x: number; y: number } {
  return {
    x: key % POPULOUS_CELL_KEY_STRIDE,
    y: Math.floor(key / POPULOUS_CELL_KEY_STRIDE),
  };
}

const MOORE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

export const POPULOUS_TIER_BY_FLAT_NEIGHBORS: readonly number[] = [0, 0, 1, 2, 2, 3, 4, 4, 5];

export const POPULOUS_GROWTH_PER_STEP = 1;

export const POPULOUS_CAPACITY_BY_TIER: readonly number[] = [8, 7, 6, 5, 4, 3];

export const POPULOUS_POPULATION_AFTER_EMIT = 0;

export const POPULOUS_TIER_CLIMB_PER_STEP = 1;

export function rampedTier(current: number, earned: number): number {
  return Math.min(earned, current + POPULOUS_TIER_CLIMB_PER_STEP);
}

export function populousTierFor(flatNeighbors: number, maxTier: number): number {
  const index = Math.max(0, Math.min(POPULOUS_TIER_BY_FLAT_NEIGHBORS.length - 1, flatNeighbors));
  const tier = POPULOUS_TIER_BY_FLAT_NEIGHBORS[index];
  return Math.max(0, Math.min(maxTier, tier));
}

function capacityForTier(tier: number): number {
  const index = Math.max(0, Math.min(POPULOUS_CAPACITY_BY_TIER.length - 1, tier));
  return POPULOUS_CAPACITY_BY_TIER[index];
}

function flatNeighborsAround(
  world: PopulousWorld,
  ctx: PopulousContext,
  x: number,
  y: number,
): number {
  let count = 0;
  for (const [ox, oy] of MOORE_OFFSETS) {
    const nx = x + ox;
    const ny = y + oy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
    if (ctx.isBuildable(nx, ny)) count++;
  }
  return count;
}

export function stepPopulous(
  world: PopulousWorld,
  live: ReadonlyMap<number, PopulousCellRecord>,
  ctx: PopulousContext,
): PopulousStepResult {
  const nextLive = new Map<number, PopulousCellRecord>();
  const upgraded: PopulousStructureCell[] = [];
  const died: Array<{ x: number; y: number }> = [];
  const emitted: Array<{ x: number; y: number }> = [];

  const keys = [...live.keys()].sort((a, b) => a - b);

  const surviving = new Map<number, PopulousCellRecord>();
  for (const key of keys) {
    const { x, y } = cellOfKey(key);
    if (!ctx.isBuildable(x, y)) {
      died.push({ x, y });
      continue;
    }
    surviving.set(key, live.get(key)!);
  }

  const undecided = new Map(surviving);
  for (const key of keys) {
    const record = surviving.get(key);
    if (record === undefined) continue;
    const { x, y } = cellOfKey(key);
    undecided.delete(key);

    if (
      ctx.hasBuildingWithinSeparation(nextLive, x, y) ||
      ctx.hasBuildingWithinSeparation(undecided, x, y)
    ) {
      died.push({ x, y });
      continue;
    }

    const earned = populousTierFor(flatNeighborsAround(world, ctx, x, y), ctx.maxTier);
    const tier = rampedTier(record.tier, earned);
    if (tier !== record.tier) upgraded.push({ x, y, tier });

    const capacity = capacityForTier(tier);
    let population = (record.population ?? 0) + POPULOUS_GROWTH_PER_STEP;
    if (population >= capacity) {
      population = POPULOUS_POPULATION_AFTER_EMIT;
      emitted.push({ x, y });
    }

    nextLive.set(key, { age: record.age + 1, tier, population });
  }

  return { nextLive, born: [], upgraded, died, emitted };
}

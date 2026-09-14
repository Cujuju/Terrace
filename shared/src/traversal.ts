import {
  BAND_HEIGHT,
  CELL_WORLD_SIZE,
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  MAX_STEP,
  MIN_HEIGHT,
  RELAX_SLACK,
  SEA_LEVEL,
} from './constants.ts';
import { NO_FRESHWATER, type Freshwater, type FreshwaterMap } from './freshwater.ts';

export interface TerrainSampler {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  readonly freshwater?: FreshwaterMap;
}

export type TerrainGround = 'dry' | 'shallow' | 'deep';

export const DEEP_WATER_DEPTH = 192;

export const DEEP_WATER_BANDS_BELOW_SEA = DEEP_WATER_DEPTH / BAND_HEIGHT;

export const DEEP_WATER_MAX_HEIGHT = SEA_LEVEL - DEEP_WATER_DEPTH;

export function groundOf(height: number): TerrainGround {
  if (height > SEA_LEVEL) return 'dry';
  return height <= DEEP_WATER_MAX_HEIGHT ? 'deep' : 'shallow';
}

export const UNCONSTRAINED_GRADIENT_PER_CELL = Infinity;

export const LAND_WALKER_MAX_GRADIENT_PER_CELL = MAX_STEP / 2;

export const HEIGHT_UNITS_PER_CELL_OF_RUN =
  (CELL_WORLD_SIZE * MAX_HEIGHT) / MAX_RELIEF_WORLD_UNITS;

export const SHEER_RISE_TO_RUN = 4;

export const SHEER_RISE_HEIGHT_UNITS_PER_CELL = SHEER_RISE_TO_RUN * HEIGHT_UNITS_PER_CELL_OF_RUN;

export const LAND_WALKER_MIN_GROUND_HEIGHT = BAND_HEIGHT;

export const UNCONSTRAINED_MIN_GROUND_HEIGHT = MIN_HEIGHT;

export const UNCONSTRAINED_MAX_GROUND_HEIGHT = MAX_HEIGHT;

export interface TraversalProfile {
  readonly grounds: readonly TerrainGround[];
  readonly minGroundHeight: number;
  readonly maxGroundHeight?: number;
  readonly freshwater: FreshwaterPassability;
  readonly maxGradientPerCell: number;
  readonly climb?: ClimbRule | null;
}

export interface ClimbRule {
  readonly fallChance: number;
  readonly secondsPerBand?: number;
  readonly bodyHalfWidthCells?: number;
}

export function exceedsWalkableGradient(profile: TraversalProfile, heightDifference: number): boolean {
  const limit = walkableGradientLimit(profile);
  if (!Number.isFinite(limit)) return false;
  return Math.abs(heightDifference) > limit;
}

export function walkableGradientLimit(profile: TraversalProfile): number {
  const limit = profile.maxGradientPerCell;
  if (profile.climb === undefined || profile.climb === null) return limit;
  return Math.max(limit, SHEER_RISE_HEIGHT_UNITS_PER_CELL);
}

export type FreshwaterPassability = 'blocked' | 'channels' | 'all';

function admitsFreshwater(passability: FreshwaterPassability, water: Freshwater): boolean {
  if (water === 'none' || passability === 'all') return true;
  return passability === 'channels' && water === 'channel';
}

export function isWalkableCell(
  world: TerrainSampler,
  profile: TraversalProfile,
  x: number,
  y: number,
): boolean {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= world.worldSize || cy >= world.worldSize) return false;

  if (!admitsHeight(profile, world.heightAt(cx, cy))) return false;

  const freshwater = (world.freshwater ?? NO_FRESHWATER).at(cx, cy);
  return admitsFreshwater(profile.freshwater, freshwater);
}

export function admitsHeight(profile: TraversalProfile, height: number): boolean {
  if (height < profile.minGroundHeight) return false;
  if (height > (profile.maxGroundHeight ?? UNCONSTRAINED_MAX_GROUND_HEIGHT)) return false;
  return profile.grounds.includes(groundOf(height));
}

export function canTraverseSegment(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const limit = walkableGradientLimit(profile);
  if (!Number.isFinite(limit)) return true;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(distance));

  let previousHeight = world.heightAt(Math.floor(fromX), Math.floor(fromY));
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const sampleX = Math.floor(fromX + dx * t);
    const sampleY = Math.floor(fromY + dy * t);
    const height = world.heightAt(sampleX, sampleY);
    if (exceedsWalkableGradient(profile, height - previousHeight)) return false;
    previousHeight = height;
  }
  return true;
}

export function canProceedAlong(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(distance));

  let previousHeight = world.heightAt(Math.floor(fromX), Math.floor(fromY));
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const sampleX = Math.floor(fromX + dx * t);
    const sampleY = Math.floor(fromY + dy * t);
    if (
      sampleX < 0 ||
      sampleY < 0 ||
      sampleX >= world.worldSize ||
      sampleY >= world.worldSize
    ) {
      return false;
    }

    const height = world.heightAt(sampleX, sampleY);
    if (exceedsWalkableGradient(profile, height - previousHeight)) return false;
    previousHeight = height;

    if (!admitsHeight(profile, height)) return false;
    const freshwater = (world.freshwater ?? NO_FRESHWATER).at(sampleX, sampleY);
    if (!admitsFreshwater(profile.freshwater, freshwater)) return false;
  }
  return true;
}

export const LAND_WALKER_PROFILE: TraversalProfile = {
  grounds: ['dry'],
  minGroundHeight: LAND_WALKER_MIN_GROUND_HEIGHT,
  freshwater: 'blocked',
  maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL,
};

export function climbingWalkerProfile(fallChance: number): TraversalProfile {
  return withClimb(LAND_WALKER_PROFILE, fallChance);
}

export function withClimb(profile: TraversalProfile, fallChance: number): TraversalProfile {
  return { ...profile, climb: { fallChance } };
}

export const RIVER_FORDING_WALKER_PROFILE: TraversalProfile = {
  ...LAND_WALKER_PROFILE,
  freshwater: 'channels',
};

export const AMPHIBIOUS_WALKER_PROFILE: TraversalProfile = {
  grounds: ['dry', 'shallow', 'deep'],
  minGroundHeight: UNCONSTRAINED_MIN_GROUND_HEIGHT,
  freshwater: 'all',
  maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL,
};

export const OPEN_WATER_PROFILE: TraversalProfile = {
  grounds: ['shallow', 'deep'],
  minGroundHeight: UNCONSTRAINED_MIN_GROUND_HEIGHT,
  freshwater: 'all',
  maxGradientPerCell: UNCONSTRAINED_GRADIENT_PER_CELL,
};

export function waterBandProfile(ground: 'shallow' | 'deep'): TraversalProfile {
  return {
    grounds: [ground],
    minGroundHeight: UNCONSTRAINED_MIN_GROUND_HEIGHT,
    freshwater: 'all',
    maxGradientPerCell: UNCONSTRAINED_GRADIENT_PER_CELL,
  };
}

export function navigableWaterProfile(draftHeightUnits: number): TraversalProfile {
  return {
    ...OPEN_WATER_PROFILE,
    maxGroundHeight: SEA_LEVEL - draftHeightUnits,
  };
}

/** Clearance discs shared by every `withClearance` wrapper with the same
 * radius, instead of one offset list per call. Fixed construction order (dy
 * outer, dx inner), so sharing never changes query results. */
const clearanceDiscs = new Map<number, ReadonlyArray<readonly [dx: number, dy: number]>>();

function discForClearance(radiusCells: number): ReadonlyArray<readonly [dx: number, dy: number]> {
  const cached = clearanceDiscs.get(radiusCells);
  if (cached !== undefined) return cached;
  const radiusSquared = radiusCells * radiusCells;
  const bound = Math.ceil(radiusCells);
  const offsets: Array<readonly [dx: number, dy: number]> = [];
  for (let dy = -bound; dy <= bound; dy++) {
    for (let dx = -bound; dx <= bound; dx++) {
      if (dx * dx + dy * dy <= radiusSquared) offsets.push([dx, dy]);
    }
  }
  clearanceDiscs.set(radiusCells, offsets);
  return offsets;
}

export function withClearance<T extends TerrainSampler>(
  world: T,
  radiusCells: number,
): TerrainSampler {
  if (radiusCells <= 0) return world;
  const offsets = discForClearance(radiusCells);
  const size = world.worldSize;
  return {
    worldSize: size,
    freshwater: world.freshwater,
    heightAt(x: number, y: number): number {
      // Integer offsets commute with the floor the backing store applies,
      // so flooring once matches per-offset flooring exactly on every
      // integer input (all shared callers floor first) while keeping each
      // downstream read on integer cells.
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      let max = -Infinity;
      for (let i = 0; i < offsets.length; i++) {
        const nx = cx + offsets[i][0];
        const ny = cy + offsets[i][1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const height = world.heightAt(nx, ny);
        if (height > max) max = height;
      }
      return max;
    },
  };
}

/** Default bound for `withCachedClearance`: holds a busy tick's working set
 * (trials, steering probes and hull checks re-query the same cells) in well
 * under a megabyte. Full-map scans stay on the uncached wrapper, where a
 * cache would be all insert cost and no hits. */
export const CLEARANCE_CACHE_DEFAULT_MAX_ENTRIES = 16384;

/** Memoizing `withClearance`: the same dilation, but each in-bounds cell's
 * max is computed once per wrapper and served from a bounded map after.
 * A* re-queries a cell once per incoming edge (up to 8x per search), so one
 * tick of boat searches hits the same cells thousands of times; this turns
 * the repeats into single map lookups. Pure memo: identical values for
 * identical base terrain, and clear-on-overflow is deterministic given the
 * callers' fixed query order.
 *
 * The cache is per-wrapper with no invalidation: re-wrap after the backing
 * terrain mutates (the boats plugin wraps fresh every tick). Out-of-bounds
 * queries bypass the cache. */
export function withCachedClearance(
  world: TerrainSampler,
  radiusCells: number,
  maxEntries: number = CLEARANCE_CACHE_DEFAULT_MAX_ENTRIES,
): TerrainSampler {
  if (radiusCells <= 0) return world;
  const base = withClearance(world, radiusCells);
  const size = world.worldSize;
  const cap = Math.max(1, Math.floor(maxEntries));
  const cache = new Map<number, number>();
  return {
    worldSize: size,
    freshwater: world.freshwater,
    heightAt(x: number, y: number): number {
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      if (cx < 0 || cy < 0 || cx >= size || cy >= size) return base.heightAt(cx, cy);
      const key = cy * size + cx;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const height = base.heightAt(cx, cy);
      if (cache.size >= cap) cache.clear();
      cache.set(key, height);
      return height;
    },
  };
}

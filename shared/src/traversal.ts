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
import { drawnBandOfSample } from './bands.ts';
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

/**
 * Steps climbed rather than walked. `sheer`: rises past `SHEER_RISE_HEIGHT_UNITS_PER_CELL`.
 * `band-edge`: every drawn band change; treads draw flat, so in-band steps are walked.
 */
export type ClimbTrigger = 'sheer' | 'band-edge';

/** `climb`: scale the face at `secondsPerBand`. `leap`: one ballistic bound between cell centres. */
export type ClimbMotion = 'climb' | 'leap';

/** `wall`: face the riser, turning round to descend. `travel`: face the way the step goes. */
export type ClimbFacing = 'wall' | 'travel';

export interface ClimbRule {
  readonly fallChance: number;
  readonly secondsPerBand?: number;
  readonly bodyHalfWidthCells?: number;
  readonly trigger?: ClimbTrigger;
  /** Tallest climbable step in drawn bands; absent means any height. */
  readonly maxRiseBands?: number;
  /**
   * Flat run, in cells, that separates two risers into separate faces. When set,
   * `maxRiseBands` caps the whole face, not each riser.
   */
  readonly faceTreadCells?: number;
  readonly motion?: ClimbMotion;
  readonly facing?: ClimbFacing;
}

export type StepKind = 'walk' | 'climb' | 'blocked';

/** The one rule for moving between two adjacent cells' heights. */
export function stepKind(profile: TraversalProfile, fromHeight: number, toHeight: number): StepKind {
  const rise = Math.abs(toHeight - fromHeight);
  const rule = profile.climb;
  if (rule === undefined || rule === null) {
    return rise > profile.maxGradientPerCell ? 'blocked' : 'walk';
  }
  const bands = Math.abs(drawnBandOfSample(toHeight) - drawnBandOfSample(fromHeight));
  if (rule.maxRiseBands !== undefined && bands > rule.maxRiseBands) return 'blocked';
  if ((rule.trigger ?? 'sheer') === 'band-edge') return bands === 0 ? 'walk' : 'climb';
  return rise > Math.max(profile.maxGradientPerCell, SHEER_RISE_HEIGHT_UNITS_PER_CELL) ? 'climb' : 'walk';
}

/**
 * Drawn-band span of the face a step crosses. Along the step's line, the face runs on
 * past flat runs shorter than `treadCells`, up to `scanCells` per side.
 */
export function climbFaceBands(
  world: TerrainSampler,
  treadCells: number,
  scanCells: number,
  fromCellX: number,
  fromCellY: number,
  toCellX: number,
  toCellY: number,
): number {
  const dx = Math.sign(toCellX - fromCellX);
  const dy = Math.sign(toCellY - fromCellY);
  const fromBand = drawnBandOfSample(world.heightAt(fromCellX, fromCellY));
  const toBand = drawnBandOfSample(world.heightAt(toCellX, toCellY));
  const span = { lowest: Math.min(fromBand, toBand), highest: Math.max(fromBand, toBand) };
  walkFace(world, treadCells, scanCells, toCellX, toCellY, dx, dy, toBand, span);
  walkFace(world, treadCells, scanCells, fromCellX, fromCellY, -dx, -dy, fromBand, span);
  return span.highest - span.lowest;
}

function walkFace(
  world: TerrainSampler,
  treadCells: number,
  scanCells: number,
  startX: number,
  startY: number,
  dx: number,
  dy: number,
  startBand: number,
  span: { lowest: number; highest: number },
): void {
  let band = startBand;
  let flatRun = 1;
  for (let k = 1; k <= scanCells && flatRun < treadCells; k++) {
    const x = startX + dx * k;
    const y = startY + dy * k;
    if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return;
    const next = drawnBandOfSample(world.heightAt(x, y));
    if (next === band) {
      flatRun++;
      continue;
    }
    band = next;
    flatRun = 1;
    if (band < span.lowest) span.lowest = band;
    if (band > span.highest) span.highest = band;
  }
}

/**
 * `stepKind` between two adjacent cells, plus the face cap: a climb whose face spans
 * more than `maxRiseBands` is blocked. Heights may be passed when already read.
 */
export function stepKindAt(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromCellX: number,
  fromCellY: number,
  toCellX: number,
  toCellY: number,
  fromHeight: number = world.heightAt(fromCellX, fromCellY),
  toHeight: number = world.heightAt(toCellX, toCellY),
): StepKind {
  const kind = stepKind(profile, fromHeight, toHeight);
  const rule = profile.climb;
  if (kind !== 'climb' || rule === undefined || rule === null) return kind;
  if (rule.faceTreadCells === undefined || rule.maxRiseBands === undefined) return kind;
  // A face past the cap needs at most cap + 1 risers, each within one tread.
  const scanCells = (rule.maxRiseBands + 1) * rule.faceTreadCells;
  const face = climbFaceBands(world, rule.faceTreadCells, scanCells, fromCellX, fromCellY, toCellX, toCellY);
  return face > rule.maxRiseBands ? 'blocked' : kind;
}

/** True when no pair of heights is ever blocked, so flood fills need not read heights. */
export function admitsEveryRise(profile: TraversalProfile): boolean {
  const rule = profile.climb;
  if (rule === undefined || rule === null) return !Number.isFinite(profile.maxGradientPerCell);
  return rule.maxRiseBands === undefined;
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
  const climbs = profile.climb !== undefined && profile.climb !== null;
  if (!climbs && !Number.isFinite(profile.maxGradientPerCell)) return true;

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
    if (stepKind(profile, previousHeight, height) !== 'walk') return false;
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
    if (stepKind(profile, previousHeight, height) !== 'walk') return false;
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

export function climbingWalkerProfile(fallChance: number, secondsPerBand?: number): TraversalProfile {
  return withClimb(LAND_WALKER_PROFILE, fallChance, secondsPerBand);
}

/** Omitting `secondsPerBand` keeps the shared default climb speed. */
export function withClimb(
  profile: TraversalProfile,
  fallChance: number,
  secondsPerBand?: number,
): TraversalProfile {
  const climb: ClimbRule = secondsPerBand === undefined ? { fallChance } : { fallChance, secondsPerBand };
  return { ...profile, climb };
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

/** Clearance discs shared by every `withClearance` wrapper of the same
 * radius. Fixed construction order keeps sharing result-neutral. */
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
      // Integer offsets commute with the backing store's floor, so flooring
      // once matches per-offset flooring on integer inputs.
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

/** Default bound for `withCachedClearance`: holds a busy tick's working set.
 * Full-map scans stay uncached. */
export const CLEARANCE_CACHE_DEFAULT_MAX_ENTRIES = 16384;

/** Memoizing `withClearance`: each in-bounds cell's max computes once per
 * wrapper, served from a bounded map after. Per-wrapper cache, no
 * invalidation: re-wrap after terrain mutates. Out-of-bounds queries bypass. */
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

import {
  AVOID_TURN_ATTEMPTS,
  AVOID_TURN_STEP_RADIANS,
  BAND_HEIGHT,
  CHUNK_SIZE,
  LAND_WALKER_PROFILE,
  SEA_LEVEL,
  admitsHeight,
  canProceedAlong,
  canTraverseSegment,
  cellsOverArea,
  isWalkableCell as sharedIsWalkableCell,
  stepKind,
  waterBandProfile,
  type FreshwaterMap,
  type TraversalProfile,
} from '@terrace/shared';
import { WILDLIFE_HABITAT_SPECIES, type WildlifeHabitatSpecies } from '../protocol.ts';
import { profileOf, spawnGroundConstrains } from './species.ts';
import { NO_MIN_WATER_DEPTH, SPAWN_AT_ANY_HEIGHT } from './species/profile.ts';

export function walkerProfileOf(species: WildlifeHabitatSpecies): TraversalProfile {
  return WALKER_PROFILES[species];
}

function walkerProfileFor(species: WildlifeHabitatSpecies): TraversalProfile {
  const profile = profileOf(species);
  const archetype =
    profile.habitat === 'land' ? LAND_WALKER_PROFILE : waterBandProfile(profile.habitat);
  const depth = profile.minWaterDepthBands;
  return {
    ...archetype,
    maxGradientPerCell: profile.maxGradientPerCell,
    ...(profile.climb === undefined || profile.climb === null ? {} : { climb: profile.climb }),
    ...(depth === NO_MIN_WATER_DEPTH ? {} : { maxGroundHeight: SEA_LEVEL - depth * BAND_HEIGHT }),
  };
}

const WALKER_PROFILES: Readonly<Record<WildlifeHabitatSpecies, TraversalProfile>> =
  Object.fromEntries(
    WILDLIFE_HABITAT_SPECIES.map((species) => [species, walkerProfileFor(species)]),
  ) as Record<WildlifeHabitatSpecies, TraversalProfile>;

export interface HabitatWorld {
  readonly worldSize: number;
  readonly chunksPerEdge: number;
  heightAt(x: number, y: number): number;
  isChunkUnlocked(cx: number, cy: number): boolean;
  isCellUnlocked(x: number, y: number): boolean;
  readonly freshwater?: FreshwaterMap;
}

import { WILDLIFE_POPULATION_CAP } from '../protocol.ts';
export { WILDLIFE_POPULATION_CAP };

export const HABITAT_CENSUS_INTERVAL_SECONDS = 5;

export function isValidCellFor(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): boolean {
  const x = Math.floor(cellX);
  const y = Math.floor(cellY);
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  return sharedIsWalkableCell(world, walkerProfileOf(species), x, y);
}

export function canTraverse(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  return canTraverseSegment(world, walkerProfileOf(species), fromX, fromY, toX, toY);
}

export function openDirectionCount(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): number {
  const profile = walkerProfileOf(species);
  const probeCells = profileOf(species).bodyLengthCells;
  let open = 0;

  for (let direction = 0; direction < AVOID_TURN_ATTEMPTS; direction++) {
    const heading = direction * AVOID_TURN_STEP_RADIANS;
    const toX = cellX + Math.cos(heading) * probeCells;
    const toY = cellY + Math.sin(heading) * probeCells;
    if (!canProceedAlong(world, profile, cellX, cellY, toX, toY)) continue;
    if (!isValidCellFor(world, species, toX, toY)) continue;
    open++;
  }

  return open;
}

export interface ClimbStep {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}

/** First climbable step along `heading` within `distance`, sampled per cell like `canProceedAlong`. */
export function climbStepAhead(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  x: number,
  y: number,
  heading: number,
  distance: number,
): ClimbStep | null {
  const profile = walkerProfileOf(species);
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const samples = Math.max(1, Math.ceil(distance));
  let fromX = Math.floor(x);
  let fromY = Math.floor(y);
  for (let sample = 1; sample <= samples; sample++) {
    const along = (distance * sample) / samples;
    const toX = Math.floor(x + cos * along);
    const toY = Math.floor(y + sin * along);
    if (toX === fromX && toY === fromY) continue;
    if (!isValidCellFor(world, species, toX, toY)) return null;
    const kind = stepKind(profile, world.heightAt(fromX, fromY), world.heightAt(toX, toY));
    if (kind === 'blocked') return null;
    if (kind === 'climb') return { fromX, fromY, toX, toY };
    fromX = toX;
    fromY = toY;
  }
  return null;
}

/** Headings, among the steering fan, that reach a climbable step within one body length. */
export function climbDirectionCount(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): number {
  const rule = walkerProfileOf(species).climb;
  if (rule === undefined || rule === null) return 0;
  const probeCells = profileOf(species).bodyLengthCells;
  let climbable = 0;
  for (let direction = 0; direction < AVOID_TURN_ATTEMPTS; direction++) {
    const heading = direction * AVOID_TURN_STEP_RADIANS;
    if (climbStepAhead(world, species, cellX, cellY, heading, probeCells) !== null) climbable++;
  }
  return climbable;
}

export function steepDirectionCount(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): number {
  const profile = walkerProfileOf(species);
  const probeCells = profileOf(species).bodyLengthCells;
  let steep = 0;

  for (let direction = 0; direction < AVOID_TURN_ATTEMPTS; direction++) {
    const heading = direction * AVOID_TURN_STEP_RADIANS;
    const toX = cellX + Math.cos(heading) * probeCells;
    const toY = cellY + Math.sin(heading) * probeCells;
    if (canProceedAlong(world, LAND_WALKER_PROFILE, cellX, cellY, toX, toY)) continue;
    if (!canProceedAlong(world, profile, cellX, cellY, toX, toY)) continue;
    if (!isValidCellFor(world, species, toX, toY)) continue;
    steep++;
  }

  return steep;
}

export function satisfiesSpawnGround(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): boolean {
  const rule = profileOf(species).spawnGround;
  if (!spawnGroundConstrains(rule)) return true;
  return rule.kind === 'open'
    ? openDirectionCount(world, species, cellX, cellY) >= rule.minOpenDirections
    : steepDirectionCount(world, species, cellX, cellY) >= rule.minSteepDirections;
}

export function withinSpawnHeights(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): boolean {
  const heights = profileOf(species).spawnHeights;
  if (heights === SPAWN_AT_ANY_HEIGHT) return true;
  const height = world.heightAt(Math.floor(cellX), Math.floor(cellY));
  return height >= heights.minHeight && height < heights.maxHeightExclusive;
}

export interface Census {
  readonly cellsBySpecies: Readonly<Record<WildlifeHabitatSpecies, number>>;
  readonly chunks: ReadonlyArray<readonly [number, number]>;
}

export const CENSUS_SLOT_COUNT = WILDLIFE_HABITAT_SPECIES.length;

export const CENSUS_SLOT: Readonly<Record<WildlifeHabitatSpecies, number>> = Object.fromEntries(
  WILDLIFE_HABITAT_SPECIES.map((species, slot) => [species, slot]),
) as Record<WildlifeHabitatSpecies, number>;

export function countChunkHabitat(
  world: HabitatWorld,
  cx: number,
  cy: number,
  out: Int32Array,
  offset: number,
): void {
  for (let slot = 0; slot < CENSUS_SLOT_COUNT; slot++) out[offset + slot] = 0;

  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  for (let dy = 0; dy < CHUNK_SIZE; dy++) {
    for (let dx = 0; dx < CHUNK_SIZE; dx++) {
      const height = world.heightAt(baseX + dx, baseY + dy);
      for (let slot = 0; slot < CENSUS_SLOT_COUNT; slot++) {
        if (admitsHeight(WALKER_PROFILES[WILDLIFE_HABITAT_SPECIES[slot]!], height)) out[offset + slot]++;
      }
    }
  }
}

export function takeCensus(world: HabitatWorld): Census {
  const cellsBySpecies = emptySpeciesCounts();
  const chunks: Array<readonly [number, number]> = [];
  const chunkCounts = new Int32Array(CENSUS_SLOT_COUNT);

  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      if (!world.isChunkUnlocked(cx, cy)) continue;
      chunks.push([cx, cy]);

      countChunkHabitat(world, cx, cy, chunkCounts, 0);
      for (let slot = 0; slot < CENSUS_SLOT_COUNT; slot++) {
        cellsBySpecies[WILDLIFE_HABITAT_SPECIES[slot]!] += chunkCounts[slot]!;
      }
    }
  }

  return { cellsBySpecies, chunks };
}

export function emptySpeciesCounts(): Record<WildlifeHabitatSpecies, number> {
  return Object.fromEntries(WILDLIFE_HABITAT_SPECIES.map((species) => [species, 0])) as Record<
    WildlifeHabitatSpecies,
    number
  >;
}

export const FOUNDING_POPULATION = 2;

export const MIN_FOUNDING_HABITAT_CELLS = cellsOverArea(64);

export function targetsFor(
  cellsBySpecies: Readonly<Record<WildlifeHabitatSpecies, number>>,
): Record<WildlifeHabitatSpecies, number> {
  const raw = emptySpeciesCounts();
  let total = 0;
  for (const species of WILDLIFE_HABITAT_SPECIES) {
    const profile = profileOf(species);
    const cells = cellsBySpecies[species];
    const byDensity = Math.floor(cells / profile.habitatCellsPerIndividual);
    const count =
      cells >= MIN_FOUNDING_HABITAT_CELLS ? Math.max(byDensity, FOUNDING_POPULATION) : byDensity;
    raw[species] = count;
    total += count;
  }

  if (total <= WILDLIFE_POPULATION_CAP) return raw;

  const scale = WILDLIFE_POPULATION_CAP / total;
  const capped = emptySpeciesCounts();
  for (const species of WILDLIFE_HABITAT_SPECIES) capped[species] = Math.floor(raw[species] * scale);
  return capped;
}

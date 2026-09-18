import {
  isWalkableCell as sharedIsWalkableCell,
  withClearance,
  type TerrainSampler,
  type TraversalProfile,
} from '@terrace/shared';
import {
  WILDLIFE_SIZE_MODEL_SCALE,
  type WildlifeHabitatSpecies,
  type WildlifeSizeClass,
} from '../protocol.ts';
import { type HabitatWorld, isValidCellFor, walkerProfileOf } from './census.ts';
import { profileOf } from './species.ts';

/**
 * Oriented capsule collision for swimmers: bow/stern/beam/centre probes at the
 * candidate heading, as in boats' isHullPose. Length from bodyLengthCells,
 * beam from hullBeamCells; beam-less species keep centre checks.
 */

export function hullHalfLengthCellsOf(
  species: WildlifeHabitatSpecies,
  size: WildlifeSizeClass,
): number {
  return (profileOf(species).bodyLengthCells * WILDLIFE_SIZE_MODEL_SCALE[size]) / 2;
}

export function hullHalfBeamCellsOf(
  species: WildlifeHabitatSpecies,
  size: WildlifeSizeClass,
): number {
  const beam = profileOf(species).hullBeamCells;
  if (beam === undefined) return 0;
  return (beam * WILDLIFE_SIZE_MODEL_SCALE[size]) / 2;
}

export function hasHull(species: WildlifeHabitatSpecies): boolean {
  return profileOf(species).hullBeamCells !== undefined;
}

const erodedByWorld = new WeakMap<HabitatWorld, Map<number, TerrainSampler>>();

/**
 * Beam-eroded sampler. Skips the wrapper when the scaled beam is under one
 * cell (zero overhead). Uncached `withClearance` reads live terrain, so
 * retained wrappers never go stale.
 */
export function erodedSamplerFor(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  size: WildlifeSizeClass,
): TerrainSampler {
  const halfBeam = hullHalfBeamCellsOf(species, size);
  if (halfBeam < 1) return world;
  let byRadius = erodedByWorld.get(world);
  if (byRadius === undefined) {
    byRadius = new Map();
    erodedByWorld.set(world, byRadius);
  }
  let eroded = byRadius.get(halfBeam);
  if (eroded === undefined) {
    eroded = withClearance(world, halfBeam);
    byRadius.set(halfBeam, eroded);
  }
  return eroded;
}

function probeValid(
  world: HabitatWorld,
  eroded: TerrainSampler,
  profile: TraversalProfile,
  probeX: number,
  probeY: number,
): boolean {
  const cx = Math.floor(probeX);
  const cy = Math.floor(probeY);
  if (cx < 0 || cy < 0 || cx >= world.worldSize || cy >= world.worldSize) return false;
  if (!world.isCellUnlocked(cx, cy)) return false;
  return sharedIsWalkableCell(eroded, profile, cx, cy);
}

/**
 * Whether the whole capsule at (x, y, heading) sits in valid habitat.
 * Bow-first ordering early-outs the common failure; beams under half a cell
 * skip the side pair.
 */
export function isHullPoseValid(
  world: HabitatWorld,
  eroded: TerrainSampler,
  species: WildlifeHabitatSpecies,
  size: WildlifeSizeClass,
  x: number,
  y: number,
  heading: number,
): boolean {
  if (!hasHull(species)) return isValidCellFor(world, species, x, y);
  const profile = walkerProfileOf(species);
  const halfLength = hullHalfLengthCellsOf(species, size);
  const halfBeam = hullHalfBeamCellsOf(species, size);
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  if (!probeValid(world, eroded, profile, x + cos * halfLength, y + sin * halfLength)) {
    return false;
  }
  if (!probeValid(world, eroded, profile, x - cos * halfLength, y - sin * halfLength)) {
    return false;
  }
  if (halfBeam >= 0.5) {
    if (!probeValid(world, eroded, profile, x - sin * halfBeam, y + cos * halfBeam)) {
      return false;
    }
    if (!probeValid(world, eroded, profile, x + sin * halfBeam, y - cos * halfBeam)) {
      return false;
    }
  }
  return probeValid(world, eroded, profile, x, y);
}

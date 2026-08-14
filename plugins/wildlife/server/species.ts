// Habitat classification and the per-species tuning table.
//
// Everything here is a design decision expressed as a named constant. Two rules
// govern the numbers:
//
//   1. Habitat thresholds are written in BAND_HEIGHT terms, never as raw height
//      units. BAND_HEIGHT is explicitly provisional (shared/src/constants.ts
//      "feel-tune in Phase 2"); "three bands below the sea" survives a retune,
//      "-192" does not.
//   2. Habitats are DISJOINT and EXHAUSTIVE over the height range. Every cell is
//      exactly one of land / shallow / deep. If they overlapped, a creature
//      could stand in two habitats; if they left a gap, a creature could drift
//      into a no-man's-land and be despawned by the habitat-loss rule for having
//      done nothing but swim in a straight line.

import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import type { WildlifeSpecies } from '../protocol.ts';

/** Where a creature can live. Derived from cell height alone (see rule 2). */
export type Habitat = 'land' | 'shallow' | 'deep';

/**
 * Depth, in terrace bands below sea level, at which water stops being coastal
 * shallows and becomes open sea.
 *
 * Three bands. The gradient limit is MAX_STEP = BAND_HEIGHT/2, so terrain can
 * fall at most half a band per cell: a cell this deep is at least six cells from
 * the nearest shoreline. That is what makes the threshold meaningful rather than
 * arbitrary — "deep" is water a whale can be IN, not a puddle it would be
 * beached in the middle of. It is also three world units of water column
 * (HEIGHT_WORLD_SCALE maps one band to one world unit), enough to hold the
 * 5-cell-long whale model clear of both the seabed and the surface.
 */
export const DEEP_WATER_BANDS_BELOW_SEA = 3;

/** Heights at or below this are deep water; above it, up to SEA_LEVEL, shallow. */
export const DEEP_WATER_MAX_HEIGHT = SEA_LEVEL - DEEP_WATER_BANDS_BELOW_SEA * BAND_HEIGHT;

/**
 * Classifies one cell height. Mirrors shared's `isWater` (h <= SEA_LEVEL is
 * water) and then splits the water range once.
 */
export function habitatOf(height: number): Habitat {
  if (height > SEA_LEVEL) return 'land';
  return height <= DEEP_WATER_MAX_HEIGHT ? 'deep' : 'shallow';
}

/** Tuning for one species. All rates are per SECOND of simulated time. */
export interface SpeciesProfile {
  readonly species: WildlifeSpecies;
  readonly habitat: Habitat;

  /** Ordinary wander speed, cells per second. */
  readonly cruiseSpeedCellsPerSecond: number;

  /**
   * Maximum random heading change, radians per second. This is the "how twitchy
   * is it" dial: high values read as darting, low values as gliding.
   */
  readonly turnNoiseRadiansPerSecond: number;

  /**
   * Nose-to-tail length in cells (CELL_WORLD_SIZE is 1, so also world units).
   * Doubles as the minimum look-ahead distance — a creature must never commit to
   * a step that puts its own body outside its habitat.
   */
  readonly bodyLengthCells: number;

  /**
   * Habitat cells required per individual. This is the population dial, and it
   * is expressed as an AREA density rather than a flat count so that a world
   * with one unlocked chunk holds a handful of creatures and a fully revealed
   * 512² world holds a full ecosystem, with no separate small/large-world case.
   *
   * Sized against a nominal half-land / half-water 512² world (262 144 cells;
   * ~131 000 land, and of the water roughly 40% shallow shelf / 60% open sea):
   *
   *   fish     52 000 / 1 500 ≈ 35     grazer   131 000 / 4 000 ≈ 33
   *   deepsea  79 000 / 6 000 ≈ 13     whale     79 000 / 20 000 ≈ 4
   *
   * ≈ 85 creatures at full reveal — comfortably inside WILDLIFE_POPULATION_CAP,
   * so the cap is a safety rail for pathological worlds (an all-shallow ocean
   * map would ask for 175 fish) rather than something the normal case rides.
   */
  readonly habitatCellsPerIndividual: number;

  /**
   * How many spawn at once. Fish shoal; everything else is solitary. A group
   * spawns as a jittered cluster sharing one heading, which — combined with fish
   * having the LOWEST turn noise relative to their speed — reads as a school for
   * the first minute or so before it disperses. Deliberate v1: real flocking
   * (cohesion/separation/alignment steering) is a much bigger sim and buys
   * little for background ambience.
   */
  readonly groupSize: number;
}

/**
 * Speeds are set relative to each other, not measured against anything: the
 * design brief is "whales slow and stately, fish quicker, terrestrial moderate".
 * A fish crosses one chunk (16 cells) in ~5 s; a whale takes ~20 s. At the
 * broadcast cadence (5 Hz) the fastest of them moves 0.6 cells between updates,
 * which is what makes 5 Hz + interpolation indistinguishable from 10 Hz.
 */
export const SPECIES_PROFILES: Readonly<Record<WildlifeSpecies, SpeciesProfile>> = {
  fish: {
    species: 'fish',
    habitat: 'shallow',
    cruiseSpeedCellsPerSecond: 3,
    turnNoiseRadiansPerSecond: 1.4,
    bodyLengthCells: 0.7,
    habitatCellsPerIndividual: 1500,
    groupSize: 5,
  },
  whale: {
    species: 'whale',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: 0.8,
    turnNoiseRadiansPerSecond: 0.25,
    bodyLengthCells: 5,
    habitatCellsPerIndividual: 20000,
    groupSize: 1,
  },
  deepsea: {
    species: 'deepsea',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: 1.2,
    turnNoiseRadiansPerSecond: 0.9,
    bodyLengthCells: 1.2,
    habitatCellsPerIndividual: 6000,
    groupSize: 1,
  },
  grazer: {
    species: 'grazer',
    habitat: 'land',
    cruiseSpeedCellsPerSecond: 1.6,
    turnNoiseRadiansPerSecond: 1.1,
    bodyLengthCells: 1.1,
    habitatCellsPerIndividual: 4000,
    groupSize: 1,
  },
};

/** Deterministic iteration order over species (see WILDLIFE_SPECIES). */
export function profileOf(species: WildlifeSpecies): SpeciesProfile {
  return SPECIES_PROFILES[species];
}

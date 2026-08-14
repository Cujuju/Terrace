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
   * RETUNED 2026-08-14 (owner: "we need more wildlife, I don't see any deep sea
   * creatures"). Two worlds are sized against, and both matter:
   *
   * (a) A FRESH world — since 2026-08-14 an open ocean at
   *     FRESH_SEABED_BANDS_BELOW_SEA under the waterline (server/src/world/
   *     world.ts), so its unlocked starter region is 100% DEEP water and 0%
   *     shallow / 0% land. On the shipped 256² default that region is
   *     INITIAL_UNLOCK_CHUNK_SPAN² chunks = 128×128 = 16 384 cells:
   *
   *       deepsea  16 384 / 1 500 = 10      whale  16 384 / 5 000 = 3
   *       fish 0 and grazer 0 — there is no shallow shelf and no land yet;
   *       both appear the moment a player sculpts one.
   *
   *     This is the case the owner's report was about, and it is why the two
   *     DEEP densities move much further than the other two: they were sized
   *     when deep water was a rare, remote habitat, and it is now the habitat a
   *     brand-new server opens in.
   *
   * (b) A nominal half-land / half-water 512² world at full reveal (262 144
   *     cells; ~131 000 land, of the water roughly 40% shallow / 60% open sea):
   *
   *       fish     52 429 / 1 000 = 52      grazer   131 072 / 2 700 = 48
   *       deepsea  78 643 / 1 500 = 52      whale     78 643 / 5 000 = 15
   *
   *     167 asked for, against the previous table's 82 — the requested "roughly
   *     double". WILDLIFE_POPULATION_CAP (150) then scales every species down
   *     proportionally to 148 (46 fish / 43 grazer / 46 deepsea / 13 whale).
   *
   * HONEST NOTE ON THE CAP'S CHANGED CHARACTER. It used to be documented as a
   * safety rail that the normal case never rode; at these densities a FULLY
   * revealed 512² world does ride it, losing ~10% of the asked-for population.
   * That is accepted rather than worked around: the cap is a bandwidth budget,
   * it scales species proportionally (so what a capped world loses is scale,
   * not shape), and full reveal of a 512² world is the extreme of the range,
   * not the common case. Every partially revealed world — which is every world
   * anyone actually plays for the first hours — is below it and gets exactly
   * the density asked for here.
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
    // 1 500 → 1 000: half again as many schools on a shelf of any given size.
    habitatCellsPerIndividual: 1000,
    groupSize: 5,
  },
  whale: {
    species: 'whale',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: 0.8,
    turnNoiseRadiansPerSecond: 0.25,
    bodyLengthCells: 5,
    // 20 000 → 5 000. The binding requirement: a fresh 256² world's 16 384-cell
    // ocean must hold whales on day one, and 16 384/5 000 = 3 does. The old
    // figure asked for 0 there — the owner's "I don't see any deep sea
    // creatures" was, for whales, arithmetically guaranteed.
    habitatCellsPerIndividual: 5000,
    groupSize: 1,
  },
  deepsea: {
    species: 'deepsea',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: 1.2,
    turnNoiseRadiansPerSecond: 0.9,
    bodyLengthCells: 1.2,
    // 6 000 → 1 500. Deep water carries the ambience of a fresh world entirely
    // on its own, so it needs the density of a populated habitat rather than of
    // a rarity: 10 in a fresh starter ocean, ~46 on a capped full 512².
    habitatCellsPerIndividual: 1500,
    groupSize: 1,
  },
  grazer: {
    species: 'grazer',
    habitat: 'land',
    cruiseSpeedCellsPerSecond: 1.6,
    turnNoiseRadiansPerSecond: 1.1,
    bodyLengthCells: 1.1,
    // 4 000 → 2 700: half again as many grazers per hillside, matching fish.
    habitatCellsPerIndividual: 2700,
    groupSize: 1,
  },
};

/** Deterministic iteration order over species (see WILDLIFE_SPECIES). */
export function profileOf(species: WildlifeSpecies): SpeciesProfile {
  return SPECIES_PROFILES[species];
}

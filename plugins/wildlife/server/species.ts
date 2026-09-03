// The per-species tuning table: the four original rows, and the assembly of
// every row into SPECIES_PROFILES.
//
// The VOCABULARY these rows are written in — habitat classification, the
// gradient and spawn-ground rules, the size and schooling tables, and the
// `SpeciesProfile` shape itself — moved to ./species/profile.ts on 2026-09-02
// and is re-exported below, so every existing importer of this module keeps
// working unchanged. See that file's header for why the split was forced.
//
// Everything here is a design decision expressed as a named constant.

import { cellsAcross, cellsOverArea } from '@terrace/shared';
import { WILDLIFE_HABITAT_SPECIES, type WildlifeHabitatSpecies } from '../protocol.ts';
import {
  AQUATIC_MAX_GRADIENT_PER_CELL,
  FISH_SCHOOLING_PROBABILITY_BY_SIZE,
  FISH_SIZE_WEIGHTS,
  GRAZER_MAX_GRADIENT_PER_CELL,
  GRAZER_SPAWN_OPEN_DIRECTIONS,
  NO_SPAWN_GROUND_RULE,
  SPAWN_AT_ANY_HEIGHT,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  TURN_RADIUS_BODY_LENGTHS,
  WHALE_POD_SIZE,
  WHALE_SCHOOLING_PROBABILITY_BY_SIZE,
  WHALE_SIZE_WEIGHTS,
  type SpeciesProfile,
} from './species/profile.ts';
import { BISON_PROFILE } from './species/bison.ts';
import { IBEX_PROFILE } from './species/ibex.ts';
import { RAY_PROFILE } from './species/ray.ts';
import { SHARK_PROFILE } from './species/shark.ts';
import { EEL_PROFILE } from './species/eel.ts';
import { ANGELFISH_PROFILE } from './species/angelfish.ts';

// The whole vocabulary, re-exported from the one module every row reads it
// from. `export *` rather than a hand-written list: a name added to the
// vocabulary is a name this module should re-export, always, and a list is the
// thing that falls out of step.
export * from './species/profile.ts';

// The four new species (2026-09-02), each in its own file with its own named
// constants and its own argument for its numbers. Re-exported so a caller that
// wants one row directly — a test pinning IBEX_MAX_GRADIENT_PER_CELL, say —
// still imports it from this module like every other species constant.
export * from './species/bison.ts';
export * from './species/ibex.ts';
export * from './species/ray.ts';
export * from './species/shark.ts';
export * from './species/eel.ts';
export * from './species/angelfish.ts';

/**
 * Schools a brand-new world's shelf must be able to hold, and the reason the
 * fish density is 400 rather than 1 000.
 *
 * THE VISIBLE-DENSITY ARGUMENT. A school is a thing you recognise by seeing more
 * than one of them: one blob of fish on an otherwise empty shelf is just "the
 * fish", and at the old density the shelf's whole fish budget was 4 — less than
 * one full group of `groupSize` (5), so a fresh world could not contain a
 * complete school at all.
 *
 * The arithmetic, against the genesis geometry (server/src/world/world.ts): the
 * starter square (shrunk 2026-08-19) is 80×80 = 6 400 square world units of
 * which 2 304 are shallow (36 864 cells — see the units note on
 * habitatCellsPerIndividual), so the 400 density gives floor(2 304 / 400) = 5
 * fish — exactly ONE
 * complete school of `groupSize` (5). One, down from two on the old 128×128
 * square: the density (a world-wide tuning) stayed at 400, and a single whole
 * school still reads as a school; the second returns as soon as territory
 * creeps a little and the shallow census grows.
 *
 * The plugin cannot import the genesis constants (core owns them and must not be
 * imported by a plugin's tuning table), so this relation is PINNED BY TEST in
 * plugins/wildlife/test/wildlife.test.ts against a real World.createFresh census
 * rather than restated here as a magic 4 096.
 */
export const FISH_SCHOOLS_ON_FRESH_SHELF = 1;

/**
 * Speeds are set relative to each other, not measured against anything: the
 * design brief is "whales slow and stately, fish quicker, terrestrial moderate".
 * A fish crosses one chunk (16 world units) in ~5 s; a whale takes ~20 s. At
 * the broadcast cadence (5 Hz) the fastest of them moves 0.6 world units
 * between updates,
 * which is what makes 5 Hz + interpolation indistinguishable from 10 Hz.
 */
export const SPECIES_PROFILES: Readonly<Record<WildlifeHabitatSpecies, SpeciesProfile>> = {
  fish: {
    species: 'fish',
    habitat: 'shallow',
    cruiseSpeedCellsPerSecond: cellsAcross(3),
    turnNoiseRadiansPerSecond: 1.4,
    bodyLengthCells: cellsAcross(0.7),
    // 1 000 → 400. See FISH_SCHOOLS_ON_FRESH_SHELF: a school is only a school if
    // you can see it is one, and at 1 000 the day-one shelf could hold FOUR fish
    // in total — one truncated group, indistinguishable from four singletons.
    habitatCellsPerIndividual: cellsOverArea(400),
    groupSize: 5,
    sizeWeights: FISH_SIZE_WEIGHTS,
    sizeDraw: 'per-group',
    schoolingProbabilityBySize: FISH_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
    turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
    // No idle bouts: a fish that stopped would leave its school behind, and a
    // shoal with holes in it is the bug the cohesion steering exists to fix.
    groupStartle: false,
    spawnGround: NO_SPAWN_GROUND_RULE,
    spawnHeights: SPAWN_AT_ANY_HEIGHT,
  },
  whale: {
    species: 'whale',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: cellsAcross(0.8),
    turnNoiseRadiansPerSecond: 0.25,
    bodyLengthCells: cellsAcross(5),
    // 5 000 → 2 000 (owner, 2026-08-21: "drop the number of unlocked cells
    // required"). The 5 000 figure was chosen against a 128-chunk starter square
    // and outlived it: the square shrank on 2026-08-19 to 4 096 square world
    // units of open sea, so 4 096/5 000 = 0 and a fresh world had no whales at
    // all.
    //
    // A PAIR ON DAY ONE IS NO LONGER PROMISED (owner, 2026-08-26). Genesis
    // guaranteed the starter square held deep water for two whales for one day,
    // and paid for it by reserving 62.5% of that square — which meant rescaling
    // most of it on most seeds, and looked like a rectangle on the map. The
    // guarantee is gone; the density is not. A fresh world whose seed drew an
    // abyss in the starter square still opens with whales, one whose seed drew
    // shallows gets them when territory creep reaches deep water. That is
    // progression, and it is the same answer the kraken has always had.
    //
    // 2 000 rather than the 1 365 that would fit a whole WHALE_POD_SIZE pod on
    // day one, because the same density also decides how many whales a fully
    // revealed world holds, and whales must stay the RAREST species there: at
    // 2 000 a nominal 512² asks for 39 against deepsea's 52, and at 1 365 it
    // would ask for 57 and make the largest animal in the game the second most
    // common one. Day-one completeness lost to late-game shape, deliberately —
    // and it costs one small territory expansion, not a redesign.
    habitatCellsPerIndividual: cellsOverArea(2000),
    groupSize: WHALE_POD_SIZE,
    sizeWeights: WHALE_SIZE_WEIGHTS,
    sizeDraw: 'per-member',
    schoolingProbabilityBySize: WHALE_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
    turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
    // A pod is a school and a startle at its edge could plausibly travel
    // through it — but nothing has asked for that, and the bison is where the
    // behaviour is being tried (./species/bison.ts). Stated as `false` rather
    // than left to a default so this row has made the decision.
    groupStartle: false,
    spawnGround: NO_SPAWN_GROUND_RULE,
    spawnHeights: SPAWN_AT_ANY_HEIGHT,
  },
  deepsea: {
    species: 'deepsea',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: cellsAcross(1.2),
    turnNoiseRadiansPerSecond: 0.9,
    bodyLengthCells: cellsAcross(1.2),
    // 6 000 → 1 500. Deep water is three quarters of a fresh world's starter
    // region, so it needs the density of a populated habitat rather than of a
    // rarity: 8 on day one, ~46 on a capped full 512².
    habitatCellsPerIndividual: cellsOverArea(1500),
    groupSize: 1,
    sizeWeights: SINGLE_SIZE_WEIGHTS,
    sizeDraw: 'per-group',
    schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
    turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
    groupStartle: false,
    spawnGround: NO_SPAWN_GROUND_RULE,
    spawnHeights: SPAWN_AT_ANY_HEIGHT,
  },
  grazer: {
    species: 'grazer',
    habitat: 'land',
    // Owner, 2026-09-02: "Grazers move too fast. I like their speed reduced by
    // half." 1.6 → 0.8 world units per second, exactly halved.
    //
    // IT MOVES ONE OTHER NUMBER WITH IT, and that is by design rather than by
    // accident: FIRE_STARTLE_RADIUS_CELLS (../index.ts) is derived from how far
    // the SLOWEST land animal can run in one panic, so a slower grazer means a
    // shorter fire alarm and the invariant behind it — every animal the alarm
    // reaches can put the whole alarm radius behind it — still holds. Since
    // 2026-09-02 the slowest land animal is the bison (0.6), not the grazer.
    cruiseSpeedCellsPerSecond: cellsAcross(0.8),
    turnNoiseRadiansPerSecond: 1.1,
    bodyLengthCells: cellsAcross(1.1),
    // 4 000 → 2 700: half again as many grazers per hillside, matching fish.
    //
// 2 700 → 100 (owner, 2026-08-23: "reduce that to a 300 square world unit
    // per animal triplet" — 300 units buys a TRIPLET, so 100 buys the animal,
    // and `groupSize` below is the triplet). A 10×10 world-unit patch each: the
    // 2 700 figure was calibrated against a nominal fully-revealed half-land
    // world, and no such world exists — every world on this machine is ocean
    // with an island a player raised, the largest of them 462 square world
    // units of land, on which 2 700 put no grazers at all and 900 still put
    // none by density. At 100 that island carries four, which is the point.
    //
    // WHAT IT COSTS, STATED RATHER THAN DISCOVERED LATER. The ask on a
    // hypothetical fully-revealed half-land 512-unit world goes 48 → 1 310
    // grazers, i.e. 86% of all demand, and WILDLIFE_POPULATION_CAP divides the
    // budget PROPORTIONALLY — so on such a world the sea thins to 12 fish, 5
    // deepsea and 3 whales (one pod exactly). No world in existence is
    // anywhere near that shape, and on the worlds that DO exist the cap does
    // not bind at all, which is why the trade is acceptable rather than merely
    // accepted. It is worth knowing which dial moves it back: the cap is a
    // BANDWIDTH ceiling (census.ts: 150 × 58 B × 5 Hz per client), not an
    // ecology one, and a per-species reservation in `targetsFor` would be the
    // other answer — neither is warranted until a world of that shape exists.
    habitatCellsPerIndividual: cellsOverArea(100),
    // A TRIPLET (owner, 2026-08-23). Grazers arrive three at a time like whales
    // arrive as a pod; unlike whales they keep SOLITARY schooling odds below,
    // so the trio is how they are born rather than how they travel — three
    // animals appear on the hillside together and then graze apart.
    groupSize: 3,
    sizeWeights: SINGLE_SIZE_WEIGHTS,
    sizeDraw: 'per-group',
    schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: GRAZER_MAX_GRADIENT_PER_CELL,
    turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
    // No idle bouts, deliberately, even though "grazer" is the name of an
    // animal that grazes. The bison is the row that stops to graze
    // (./species/bison.ts) and the ibex is the row that perches; giving all
    // three land species the same beat would make the three of them read as one
    // animal in three sizes, which is exactly what the owner asked for two more
    // grazer types to avoid. The grazer keeps the behaviour it shipped with.
    groupStartle: false,
    spawnGround: { kind: 'open', minOpenDirections: GRAZER_SPAWN_OPEN_DIRECTIONS },
    // The generalist: any land, from the beach to the snow. The bison and the
    // ibex (species/bison.ts, species/ibex.ts) are the ones with a place on the
    // ramp.
    spawnHeights: SPAWN_AT_ANY_HEIGHT,
  },
  // The four species added 2026-09-02, each argued in its own file. They are
  // rows in this table like any other: the engine reads fields, and nothing in
  // movement.ts or population.ts knows any of these names.
  ibex: IBEX_PROFILE,
  bison: BISON_PROFILE,
  ray: RAY_PROFILE,
  shark: SHARK_PROFILE,
  // The two shelf fish added 2026-09-03, each argued in its own file.
  eel: EEL_PROFILE,
  angelfish: ANGELFISH_PROFILE,
};

/** Deterministic iteration order over species (see WILDLIFE_HABITAT_SPECIES). */
export function profileOf(species: WildlifeHabitatSpecies): SpeciesProfile {
  return SPECIES_PROFILES[species];
}

/**
 * The body length the school-spacing radii in movement.ts were written against.
 *
 * SCHOOL_COMFORT_RADIUS_CELLS and SCHOOL_FULL_PULL_RADIUS_CELLS are absolute
 * distances, and they were calibrated when the only schooling species was the
 * fish: 2.5 cells is "a few fish lengths", which is a sensible distance to start
 * pulling a shoal together and a nonsense one for an animal seven times longer.
 * Whales schooling (2026-08-21) made that latent: a pod would have been held at
 * fish spacing, which for a five-unit body is closer than its own separation
 * floor lets it get — cohesion pulling in and separation pushing out, for the
 * first time in this plugin's life.
 *
 * Taken FROM the fish profile rather than restated as 0.7, so this is by
 * construction the length those constants were tuned for, and the fish's own
 * spacing multiplier is exactly 1 — the retune cannot move the species it was
 * calibrated against. See schoolLoosenessOf in movement.ts.
 */
export const SCHOOL_SPACING_BASELINE_BODY_LENGTH_CELLS = SPECIES_PROFILES.fish.bodyLengthCells;

/**
 * The cruise speed of the slowest LAND species in the table, in cells/second.
 *
 * WHY IT IS COMPUTED AND NOT NAMED. ../index.ts sizes the fire alarm
 * (FIRE_STARTLE_RADIUS_CELLS) so that every land animal it reaches can outrun
 * it, which makes the alarm a fact about the slowest of them. Until 2026-09-02
 * there was one land species and that file simply read
 * `SPECIES_PROFILES.grazer.cruiseSpeedCellsPerSecond`, with a comment claiming
 * the grazer was "the slowest thing that walks on the ground fire burns". There
 * are three land species now and the bison is slower, so that claim was one
 * table edit away from being false while still compiling — which is the
 * definition of a fact that should be derived rather than cited.
 *
 * Iterates WILDLIFE_HABITAT_SPECIES, the plugin's fixed order, so the answer
 * does not depend on object key order. Computed once at module load; the table
 * is frozen by construction.
 */
export const SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND = (() => {
  let slowest = Number.POSITIVE_INFINITY;
  for (const species of WILDLIFE_HABITAT_SPECIES) {
    const profile = SPECIES_PROFILES[species];
    if (profile.habitat !== 'land') continue;
    slowest = Math.min(slowest, profile.cruiseSpeedCellsPerSecond);
  }
  return slowest;
})();

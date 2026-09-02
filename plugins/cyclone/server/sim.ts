// THIS PLUGIN'S STORM: the profile a cyclone is, how often one arrives, and the
// one rule about where it may be born.
//
// THE SIM ITSELF IS NOT HERE. Movement, veer, the life countdown, the fade, the
// terrain decay, landfall, the damage sampling and the snapshot are core's
// plugin kit (server/src/plugins/kit/rotatingStorms.ts) — one engine, one
// instance per plugin. What is here is everything that makes THIS instance a
// cyclone: nine numbers, a wind field with an eye in it, a roster of names, and
// a birth over open water.

import { SEA_LEVEL, cellsAcross } from '@terrace/shared';
import { interpolateByDifficulty } from '../../../server/src/plugins/kit/difficultyCurve.ts';
import {
  createRotatingStorms,
  waterFractionUnder,
  type RotatingStorm,
  type RotatingStormProfile,
  type RotatingStormWorld,
} from '../../../server/src/plugins/kit/rotatingStorms.ts';
import {
  CYCLONE_EYE_RADIUS_FRACTION,
  cycloneNameFor,
  cycloneRadiusFor,
} from '../protocol.ts';

/**
 * Mean seconds between arrivals at the two ends of WorldApi.difficulty, before
 * the frequency setting scales them.
 *
 * TWO ANCHORS AND A LERP, which is WorldApi.difficulty's own instruction. Forty
 * minutes on the gentlest world and six on the harshest — four times a tornado's
 * anchors at both ends, because a cyclone covers a quarter of the map and lives
 * eight minutes: if one arrived as often as a funnel the world would be under a
 * hurricane most of the time, and a permanent hurricane is weather, not an
 * event.
 */
export const CYCLONE_MEAN_INTERVAL_AT_EASIEST_SECONDS = 2400;
export const CYCLONE_MEAN_INTERVAL_AT_HARDEST_SECONDS = 360;

/** Mean seconds between arrivals on a world of this difficulty. */
export function meanSpawnIntervalSeconds(difficulty: number): number {
  return interpolateByDifficulty(
    CYCLONE_MEAN_INTERVAL_AT_EASIEST_SECONDS,
    CYCLONE_MEAN_INTERVAL_AT_HARDEST_SECONDS,
    difficulty,
  );
}

/**
 * A cyclone: large, slow, and eight minutes long.
 *
 * SPEED — a quarter of a world unit a second, an eighth of the sky's wind
 * ceiling. MEASURED AGAINST THE LIFETIME, not chosen for feel: at half a unit a
 * second a cyclone crosses the whole default world in four minutes, so a storm
 * given eight minutes to live spent most of them off the map — verified in a
 * live world, where a forced cyclone had left the map before its own spin-up
 * curve was interesting. At a quarter it crosses in eight, which is what makes
 * the lifetime the thing that ends a cyclone and the map edge the exception.
 *
 * VEER — 0.008 rad/s, slower than a weather front's. Real tracks curve gently
 * and over hours; a hurricane that turned like a tornado would read as being
 * steered.
 *
 * LAND KILLS IT IN ABOUT A MINUTE at full exposure (decay 0.018/s): long enough
 * that a landfall is an event a settlement lives through, short enough that a
 * cyclone cannot cross a continent. That asymmetry against a tornado's four
 * seconds in water is the whole difference between "land-only" and "weakens over
 * land".
 *
 * THE WIND FIELD HAS AN EYE: nothing inside it, peak at the eyewall, falling to
 * nothing at the rim. Linear up and linear back down — a triangle, deliberately
 * not smoothed, because the eyewall is the one place in a hurricane where the
 * wind really does change over a short distance and rounding it off would hide
 * the only structure this shape has.
 */
const CYCLONE_PROFILE: RotatingStormProfile = {
  speedCellsPerSecond: cellsAcross(0.25),
  veerRadiansPerSecond: 0.008,
  meanLifetimeSeconds: 480,
  spinUpSeconds: 45,
  fadeSeconds: 60,
  hostileTerrainDecayPerSecond: 0.018,
  minPeakIntensity: 0.6,
  maxPeakIntensity: 1,
  maxActive: 1,
  hostileTerrain: 'land',
  eyeRadiusFraction: CYCLONE_EYE_RADIUS_FRACTION,
  windFalloff: (r: number) => {
    const eye = CYCLONE_EYE_RADIUS_FRACTION;
    if (r <= eye) return 0;
    return (1 - r) / (1 - eye);
  },
};

/**
 * How many cyclones may be in the air at once — the number the wire budget in
 * ../protocol.ts's header multiplies by.
 */
export const MAX_ACTIVE_CYCLONES = CYCLONE_PROFILE.maxActive;

/**
 * How much of a cyclone's disc must be water for it to form there.
 *
 * 0.85 — issue #213's "large water bodies" made checkable. Not 1.0: a sample
 * ring at the full radius will clip an island in almost any world worth playing,
 * and demanding a perfectly empty ocean would mean no cyclones at all on an
 * archipelago map. Not lower: at 0.7 a storm can form in a wide bay, which is a
 * storm that is already ashore.
 */
export const CYCLONE_MIN_OPEN_WATER_FRACTION = 0.85;

/**
 * Seed for a world that has never had a cyclone.
 *
 * Fixed rather than drawn from the clock, for relics' and volcanoes' reason: a
 * self-hoster reporting "every cyclone in my world came ashore on the same
 * beach" must be reproducible — and with surge on, this generator also decides
 * which shoreline cells the sea takes. The value itself is arbitrary; only its
 * fixedness is load-bearing. It differs from the tornado plugin's so two
 * independently-seeded populations do not roll their arrivals off the same
 * sequence.
 */
export const CYCLONE_RNG_DEFAULT_SEED = 0x3d_51_57_07;

/** This plugin's one population of rotating storms. */
export const cyclones = createRotatingStorms({
  profile: CYCLONE_PROFILE,
  seed: CYCLONE_RNG_DEFAULT_SEED,
  radiusFor: cycloneRadiusFor,
  nameFor: cycloneNameFor,
  // "The typhoon came ashore" is an instant this plugin publishes as its own
  // event; the kit is what notices it.
  reportsLandfall: true,
});

/** Is this cell under the sea? */
export function isWaterAt(world: RotatingStormWorld, x: number, y: number): boolean {
  return world.heightAt(x, y) <= SEA_LEVEL;
}

/** Is a disc of this radius centred here over open water? */
export function isOpenWater(
  world: RotatingStormWorld,
  x: number,
  y: number,
  radius: number,
): boolean {
  return waterFractionUnder(world, x, y, radius) >= CYCLONE_MIN_OPEN_WATER_FRACTION;
}

/**
 * A CYCLONE, formed over open water and named for the quarter of the world it
 * formed in.
 *
 * The site is drawn anywhere in the world and tested with `waterFractionUnder` —
 * deliberately NOT restricted to the map edge. A world's open water may be an
 * inland sea, and a storm that could only ever be born beyond the coast would
 * mean an archipelago never gets one; the water test is the rule, and where the
 * water is, is the world's business.
 *
 * Returns null when the attempts found nowhere with enough open water — the
 * correct outcome for a world that is all land.
 */
export function trySpawnCyclone(world: RotatingStormWorld): RotatingStorm | null {
  const radius = cycloneRadiusFor(world.worldSize);
  return cyclones.trySpawn(world, (random) => {
    const x = random() * world.worldSize;
    const y = random() * world.worldSize;
    if (!isOpenWater(world, x, y, radius)) return null;
    return { x, y };
  });
}

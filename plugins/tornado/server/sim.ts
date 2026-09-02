// THIS PLUGIN'S STORM: the profile a funnel is, how often one arrives, and the
// one rule about where it may be born.
//
// THE SIM ITSELF IS NOT HERE. Movement, veer, the life countdown, the fade, the
// terrain decay, the damage sampling and the snapshot are core's plugin kit
// (server/src/plugins/kit/rotatingStorms.ts) — one engine, one instance per
// plugin. What is here is everything that makes THIS instance a tornado: nine
// numbers, a wind field, and a spawn site drawn inside a thunderstorm cell.
//
// NOT REPRODUCIBLE FROM SEED ALONE, and it is the one thing in this plugin that
// is not. The spawn site is drawn inside a cell taken from a sibling's live
// system list (./weather-bridge.ts), and those cells are positioned by that
// plugin's own unseeded generator — deliberately, since no client reproduces a
// front either. Seeding this generator reproduces where and when a funnel is
// SITED relative to a cell, not which cells existed to be sited against.

import { SEA_LEVEL, cellsAcross } from '@terrace/shared';
import { interpolateByDifficulty } from '../../../server/src/plugins/kit/difficultyCurve.ts';
import {
  createRotatingStorms,
  type RotatingStorm,
  type RotatingStormProfile,
  type RotatingStormWorld,
} from '../../../server/src/plugins/kit/rotatingStorms.ts';
import { TORNADO_RADIUS_CELLS } from '../protocol.ts';
import { stormCells } from './weather-bridge.ts';

/**
 * Mean seconds between arrivals at the two ends of WorldApi.difficulty, before
 * the frequency setting scales them.
 *
 * TWO ANCHORS AND A LERP, which is WorldApi.difficulty's own instruction and the
 * shape the mana plugin established. Ten minutes on the gentlest world and
 * ninety seconds on the harshest: at difficulty 1 a tornado is something a
 * player might see once a session, and at 100 it is a hazard they have to build
 * around.
 */
export const TORNADO_MEAN_INTERVAL_AT_EASIEST_SECONDS = 600;
export const TORNADO_MEAN_INTERVAL_AT_HARDEST_SECONDS = 90;

/** Mean seconds between arrivals on a world of this difficulty. */
export function meanSpawnIntervalSeconds(difficulty: number): number {
  return interpolateByDifficulty(
    TORNADO_MEAN_INTERVAL_AT_EASIEST_SECONDS,
    TORNADO_MEAN_INTERVAL_AT_HARDEST_SECONDS,
    difficulty,
  );
}

/**
 * A tornado: small, fast, and over in about a minute.
 *
 * SPEED — 2.5 world units a second, so it crosses a default 128-unit world in
 * under a minute if it lives that long. Faster than the sky's own wind ceiling
 * (2 world units/s) on purpose: a funnel outruns the front that made it, which
 * is why it eventually walks out from under the cloud and dies.
 *
 * VEER — 0.05 rad/s, five times a weather front's veer. A tornado's track
 * wanders visibly over its short life; a front's does not over its long one.
 *
 * WATER KILLS IT IN ABOUT FOUR SECONDS at full exposure (decay 0.25/s), which is
 * issue #213's "land-only" made continuous rather than a teleport-to-death: a
 * funnel that crosses a river is shaken, one that walks out to sea is gone.
 *
 * NO EYE, and the wind falls off QUADRATICALLY from the middle: a funnel's
 * damage is famously abrupt at its edge, and `1 - r²` holds near 1 for the inner
 * half of the radius.
 */
const TORNADO_PROFILE: RotatingStormProfile = {
  speedCellsPerSecond: cellsAcross(2.5),
  veerRadiansPerSecond: 0.05,
  meanLifetimeSeconds: 60,
  spinUpSeconds: 4,
  fadeSeconds: 6,
  hostileTerrainDecayPerSecond: 0.25,
  minPeakIntensity: 0.5,
  maxPeakIntensity: 1,
  maxActive: 2,
  hostileTerrain: 'water',
  eyeRadiusFraction: 0,
  windFalloff: (r: number) => 1 - r * r,
};

/**
 * How many funnels may be in the air at once — the number the wire budget in
 * ../protocol.ts's header multiplies by.
 */
export const MAX_ACTIVE_TORNADOES = TORNADO_PROFILE.maxActive;

/**
 * Seed for a world that has never had a tornado.
 *
 * Fixed rather than drawn from the clock, for relics' and volcanoes' reason: a
 * self-hoster reporting "every tornado in my world walked the same way" must be
 * reproducible. The value itself is arbitrary; only its fixedness is
 * load-bearing. It differs from the cyclone plugin's so two independently-seeded
 * populations do not roll their arrivals off the same sequence.
 */
export const TORNADO_RNG_DEFAULT_SEED = 0x57_07_3d_51;

/** This plugin's one population of rotating storms. */
export const tornadoes = createRotatingStorms({
  profile: TORNADO_PROFILE,
  seed: TORNADO_RNG_DEFAULT_SEED,
  // Constant: a funnel is the same size on any world. A cyclone is not, which is
  // why the kit asks rather than assumes.
  radiusFor: () => TORNADO_RADIUS_CELLS,
  // Nobody names a tornado, and no landfall: a funnel that reaches water is not
  // arriving, it is dying.
});

/** Is this cell under the sea? The one terrain question this plugin asks. */
export function isWaterAt(world: RotatingStormWorld, x: number, y: number): boolean {
  return world.heightAt(x, y) <= SEA_LEVEL;
}

/**
 * A TORNADO, dropped out of one of the sky's thunderstorm cells onto land.
 *
 * TWO GATES, and both are issue #213's: it must come from a thunderstorm cell
 * (./weather-bridge.ts — no cell, no funnel, and a world with no sky plugins
 * gets none at all), and it must touch down on LAND. The site is drawn inside
 * the parent cell's own disc, so the funnel is under the cloud that made it at
 * the moment it forms.
 *
 * THE PARENT CELL IS CHOSEN ONCE and every attempt draws inside it, which is
 * what makes a failed roll mean "that cloud had no land under it" rather than
 * "six clouds were unlucky".
 *
 * The heading is drawn by the engine rather than taken from the parent front's
 * drift. The sky publishes one shared wind and this plugin deliberately does not
 * ask for it: a funnel that always ran exactly downwind would make every tornado
 * in a session travel the same way, and the veer would then be the only thing
 * distinguishing them.
 *
 * Returns null when there is no cell, or when the attempts inside one found only
 * water.
 */
export function trySpawnTornado(world: RotatingStormWorld): RotatingStorm | null {
  const cells = stormCells();
  if (cells.length === 0) return null;

  const cell = cells[Math.floor(tornadoes.random() * cells.length)]!;
  return tornadoes.trySpawn(world, (random) => {
    // Uniform over the disc's AREA, not its radius: `sqrt` is what stops every
    // draw bunching at the centre of the cloud.
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * cell.radius;
    const x = cell.x + Math.cos(angle) * distance;
    const y = cell.y + Math.sin(angle) * distance;

    const cx = Math.round(x);
    const cy = Math.round(y);
    if (cx < 0 || cy < 0 || cx >= world.worldSize || cy >= world.worldSize) return null;
    if (isWaterAt(world, cx, cy)) return null;
    return { x, y };
  });
}

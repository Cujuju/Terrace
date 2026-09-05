// WHERE SNOW MAY FORM — the one place this plugin reads terrain, and the
// anti-cheat rule inside it.

import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';

/** The slice of the server's WorldApi this plugin reads. Note how little it is. */
export interface SnowWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

/**
 * How high the ground under a candidate snow system must average, in terrace
 * bands above sea level.
 *
 * SNOW GOES OVER HIGH GROUND, and the server has the heights, so it does this
 * honestly rather than declaring snow "a cold system" and scattering it over the
 * ocean. Two bands is one sculpt above the shoreline flat — the lowest bar that
 * still means "land that someone raised", so a modest island gets snow while the
 * open sea (a fresh world's floor is three bands DOWN, docs/DESIGN.md) never
 * does. Requiring an alpine peak would mean most worlds never see snow at all.
 *
 * REJECTED: "a snow system is just a cold system", i.e. no terrain read. The
 * cost of doing it properly is SNOW_ELEVATION_SAMPLES height lookups per siting
 * attempt, a handful of times a minute — literally nothing — and the payoff is
 * that snow lands on mountains, which is the entire recognisable fact about
 * snow. There is no honest argument for the cheap version at this price.
 *
 * ANTI-CHEAT, AND WHY THE UNLOCK MASK IS CHECKED HERE. Terrain in locked chunks
 * is never sent to clients at all — "anti-cheat by omission" (docs/DESIGN.md).
 * Snow that formed over hidden mountains would be a side channel: a player could
 * read the shape of unrevealed terrain off the sky. So the elevation test counts
 * UNLOCKED samples only, and a candidate with no unlocked sample fails.
 * Consequence, accepted and symmetrical with the wildlife plugin's birds: a
 * system is visible over ground the player has not revealed, and tells them
 * nothing about it.
 */
export const SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA = 2;

/** The height, in height units, that threshold works out to. Derived. */
export const SNOW_MIN_TERRAIN_HEIGHT =
  SEA_LEVEL + SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA * BAND_HEIGHT;

/**
 * Offsets, as fractions of the candidate radius, at which the ground under a
 * candidate is sampled. The centre plus four points at half radius.
 *
 * FIVE SAMPLES, not one and not a full sweep of the disc. One is noise — a
 * single peak in an ocean would qualify a system of up to a 388-cell radius (the
 * band SNOW_FOOTPRINT_AREA_SCALE puts snow in on the shipped world, and it was a
 * 224-cell one before). A full sweep would be thousands
 * of lookups to answer a question whose answer is "is this broadly highland",
 * which five points spread over the inner half of the disc settle. Half radius
 * rather than full, so the test is about the ground the system is CENTRED on and
 * not about its rim, which will have drifted somewhere else within a minute
 * anyway.
 *
 * STILL FIVE AFTER THE 2026-09-04 ENLARGEMENT, deliberately. The offsets are
 * FRACTIONS of the candidate radius, so a three-times-the-area front spreads the
 * same five points over the same shape — what changes is how far apart they are
 * on the ground, which is the point: a bigger front is asked about bigger
 * ground. The consequence, accepted: on a world with one small massif a larger
 * candidate straddles the coast more often and is refused, and that refusal is
 * handed to rain (server/index.ts, SNOW_HAND_OFF_KIND).
 */
export const SNOW_ELEVATION_SAMPLE_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.5, 0],
  [-0.5, 0],
  [0, 0.5],
  [0, -0.5],
];

export const SNOW_ELEVATION_SAMPLES = SNOW_ELEVATION_SAMPLE_OFFSETS.length;

/** Clamps a cell coordinate into the world so a height lookup is always in range. */
function clampCell(value: number, worldSize: number): number {
  const cell = Math.floor(value);
  if (cell < 0) return 0;
  if (cell > worldSize - 1) return worldSize - 1;
  return cell;
}

/**
 * Mean height of the UNLOCKED ground under a candidate system, or null when no
 * sample point falls on unlocked ground.
 *
 * Null is not "sea level" — it is "this plugin is not allowed to know", and the
 * caller must treat it as a failed candidate rather than as flat ground. See the
 * anti-cheat note on SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA.
 */
export function meanUnlockedHeightUnder(
  world: SnowWorld,
  centreX: number,
  centreY: number,
  radius: number,
): number | null {
  let total = 0;
  let counted = 0;
  for (const [offsetX, offsetY] of SNOW_ELEVATION_SAMPLE_OFFSETS) {
    const x = clampCell(centreX + offsetX * radius, world.worldSize);
    const y = clampCell(centreY + offsetY * radius, world.worldSize);
    if (!world.isCellUnlocked(x, y)) continue;
    total += world.heightAt(x, y);
    counted++;
  }
  return counted === 0 ? null : total / counted;
}

/** True when the ground under this candidate is high enough to snow on. */
export function isSnowSite(
  world: SnowWorld,
  centreX: number,
  centreY: number,
  radius: number,
): boolean {
  const mean = meanUnlockedHeightUnder(world, centreX, centreY, radius);
  return mean !== null && mean >= SNOW_MIN_TERRAIN_HEIGHT;
}

// WHICH GROUND WILL HOLD A TEMPLE. Pure functions of the world's current
// state; no mutable state lives here, so the rule can be reasoned about (and
// asserted against a hand-built world) on its own.
//
// AN OWN COPY of the rule structures/server/suitability.ts keeps for its
// settlement buildings — copied, not imported, under the plugin-isolation rule
// every plugin in this repo states beside its own copy of a shared hash: each
// must build and test with every other plugin deleted. What is NOT copied is
// the terrain math itself: `bandOf` and `isWater` come from @terrace/shared,
// the single source of truth, so the two plugins can never disagree about what
// a terrace or the waterline IS — only about how much ground their own
// building needs, which is genuinely each plugin's own business.
//
// "FLAT-ENOUGH DRY LAND", MADE CONCRETE — structures' derivation, at this
// building's own size:
//
//   * DRY — `isWater`, the same static-sea-level test core itself uses. Every
//     surveyed cell, not just the middle one: bandOf floors by BAND_HEIGHT, so
//     band 0 covers dry land AND the waterline at h = 0, and a bare band match
//     would let a temple stand with one corner in the surf.
//   * FLAT — every surveyed cell quantises to the SAME terrace band. The
//     terraced render already carves the world into discrete flats, so "flat
//     enough to build on" needs no slope constant of its own: it is "the whole
//     footprint is on one terrace".
//   * UNLOCKED — the same anti-leak rule every plugin keeps: a temple must
//     never be founded on, or reveal the shape of, land this world has not
//     unlocked.
//
// A cell whose surveyed neighbourhood runs off the map counts as unsuitable:
// a footprint half outside the world is not one a builder can walk around.

import { bandOf, isWater } from '@terrace/shared';
import { TEMPLE_SURVEY_RADIUS_CELLS } from '../protocol.ts';

/** The read-only slice of the server's WorldApi this plugin actually reads. */
export interface TempleWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

/**
 * Every cell of the square the temple stands on, its own cell INCLUDED —
 * unlike structures' equivalent, which excludes the centre because its caller
 * checks that separately. Generated in fixed row-major order so the survey's
 * iteration order is deterministic (the terrain-math contract).
 */
export const TEMPLE_FOOTPRINT_OFFSETS: ReadonlyArray<readonly [number, number]> =
  (() => {
    const offsets: Array<readonly [number, number]> = [];
    for (let dy = -TEMPLE_SURVEY_RADIUS_CELLS; dy <= TEMPLE_SURVEY_RADIUS_CELLS; dy++) {
      for (let dx = -TEMPLE_SURVEY_RADIUS_CELLS; dx <= TEMPLE_SURVEY_RADIUS_CELLS; dx++) {
        offsets.push([dx, dy] as const);
      }
    }
    return offsets;
  })();

/**
 * Is (x, y) somewhere the temple may stand? The one predicate both the
 * placement path and the standing-temple re-validation ask, so neither can
 * hold a different opinion about the same ground.
 */
export function isTempleSite(world: TempleWorld, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;

  const band = bandOf(world.heightAt(x, y));
  for (const [dx, dy] of TEMPLE_FOOTPRINT_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    if (!world.isCellUnlocked(nx, ny)) return false;
    const height = world.heightAt(nx, ny);
    if (isWater(height)) return false;
    if (bandOf(height) !== band) return false;
  }
  return true;
}

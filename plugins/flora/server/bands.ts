// WHICH GROUND IS GREEN — the one predicate every other part of this plugin
// asks before it does anything.
//
// Pure functions of a height and of the world's current state; no mutable state
// lives here, which is what lets the tests assert eligibility directly against a
// hand-built world.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PALETTE COUPLING, STATED RATHER THAN HIDDEN.
//
// The owner's request is "trees in the GREEN layers". Green is not a fact about
// the terrain model — the server has no colours in it — it is a fact about the
// client's ramp, and the server may not import client code. So the two band
// numbers below are a DUPLICATE of a decision recorded in
// client/src/terrain/bandColors.ts, whose land ramp reads:
//
//   band 0  wet beach sand      band 3  bright lowland grass   ← FLORA_MIN_BAND
//   band 1  dry sand            band 4  grass
//   band 2  bare soil           band 5  dark highland grass    ← FLORA_MAX_BAND
//                               band 6+ rock, then snow
//
// RESIDUAL, and it is a real one: if that ramp is re-cut — grass moved up a band
// for contrast, a fourth grass stop added — nothing here fails, and trees will
// simply be growing on sand or on rock until somebody notices by eye. There is
// no cheap fix available today that does not break a hard rule: moving the ramp
// into shared/ would put a rendering decision in the module that is supposed to
// hold only terrain math and protocol types, and importing the client from the
// server is forbidden outright. The honest mitigation is that these two numbers
// are named, are in ONE place, and say what they are coupled to — so the fix is
// a two-line edit by whoever re-cuts the ramp, rather than an archaeology
// exercise.
// ─────────────────────────────────────────────────────────────────────────────

import { bandOf } from '@terrace/shared';

/**
 * Lowest terrace band a tree will grow on: the first GREEN stop of the client's
 * land ramp (bright lowland grass). Bands 0–2 are the sand-and-soil coast, which
 * the owner specifically asked to stay bare.
 */
export const FLORA_MIN_BAND = 3;

/**
 * Highest terrace band a tree will grow on: the last green stop (dark highland
 * grass). Band 6 is exposed rock — the tree line, in effect, which falls out of
 * the palette rather than needing an ecological rule of its own.
 */
export const FLORA_MAX_BAND = 5;

/** The read-only slice of the server's WorldApi this plugin actually reads. */
export interface FloraWorld {
  readonly worldSize: number;
  readonly chunksPerEdge: number;
  heightAt(x: number, y: number): number;
  isChunkUnlocked(cx: number, cy: number): boolean;
  isCellUnlocked(x: number, y: number): boolean;
}

/**
 * Is this height inside the green band range?
 *
 * NO WATER TEST, and its absence is load-bearing rather than forgotten:
 * FLORA_MIN_BAND = 3 means h ≥ 3 × BAND_HEIGHT = 192, and SEA_LEVEL is 0, so
 * every green height is dry land by arithmetic. A redundant `isWater` branch
 * here would be dead code that looks like a safeguard; the property is pinned by
 * test instead (see "no water cell is ever eligible").
 */
export function isGreenBand(height: number): boolean {
  const band = bandOf(height);
  return band >= FLORA_MIN_BAND && band <= FLORA_MAX_BAND;
}

/**
 * Is this cell somewhere a tree may stand? Three conditions, all required:
 * inside the world, inside UNLOCKED territory, and green.
 *
 * The unlock rule is the same anti-leak rule wildlife's habitat check keeps: a
 * tree only ever exists in territory clients can already see, so the un-filtered
 * broadcast (the plugin host offers no per-player filtering) cannot tell anyone
 * anything about locked land. That is a property of the sim, not of the wire
 * format, which is why it holds trivially instead of needing a filter.
 *
 * One predicate, used by planting, by the per-survey validity sweep and by the
 * tests, so those three can never disagree about what "green" means.
 */
export function isPlantableCell(world: FloraWorld, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  return isGreenBand(world.heightAt(x, y));
}

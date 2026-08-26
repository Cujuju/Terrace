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
// The owner's request is "trees in the GREEN layers", and grass "on all of the
// green or green-like bands". Green is not a fact about the terrain model — the
// server has no colours in it — it is a fact about the client's ramp, and the
// server may not import client code. So the heights below are a DUPLICATE of a
// decision recorded in client/src/terrain/bandColors.ts.
//
// THE DUPLICATE IS EXPRESSED IN HEIGHTS, NOT IN BAND INDICES, AND THAT IS THE
// WHOLE POINT (2026-08-25). It used to be two band numbers, FLORA_MIN_BAND = 3
// and FLORA_MAX_BAND = 5, which were correct when BAND_HEIGHT was 64: bands
// 3/4/5 sat at h = 192/256/320, exactly the ramp's three grass anchors. When
// BAND_HEIGHT was re-cut 64 → 16 the ramp did not move — it is anchored to
// HEIGHTS (LAND_RAMP_ANCHORS is evenlySpaced over SEA_LEVEL..SNOW_LINE_HEIGHT)
// — but the band indices did, so bands 3–5 became h = 48..95, which the ramp
// paints as dry sand. Every tree, crop and tuft in the world had been growing
// on the beach ever since, and nothing failed: this is the exact residual the
// previous version of this comment named as "somebody notices by eye", and the
// owner did.
//
// The fix is not a re-guess of two indices, it is a change of unit. A height
// window is invariant under BAND_HEIGHT, so re-terracing the world can never
// slide the flora off its colours again. What remains coupled is WHICH anchors
// of the ramp count as green, and the ramp's own geometry (its snow line and
// its anchor count) — three numbers, named below, that only move if somebody
// re-authors the materials themselves.
//
// The land ramp, for reference (bandColors.ts LAND_RAMP_SHORELINE_UP), ten
// anchors evenly spaced from SEA_LEVEL to SNOW_LINE_HEIGHT = 576, so one every
// 64 units of height:
//
//   anchor 0  h   0  wet beach sand      anchor 5  h 320  dark highland grass
//   anchor 1  h  64  dry sand            anchor 6  h 384  dark exposed rock
//   anchor 2  h 128  bare soil           anchor 7  h 448  rock
//   anchor 3  h 192  bright lowland grass  anchor 8  h 512  pale high rock
//   anchor 4  h 256  grass                 anchor 9  h 576  snow
//
// VERIFIED, not derived and hoped for: calling the client's own bandColorOf on
// every land band's floor, the bands whose colour is green-dominant (g greater
// than both r and b) are exactly bands 10..23 at BAND_HEIGHT = 16 — h = 160 up
// to but not including 384 — which is precisely the window the two constants
// below produce. Re-run that check if the ramp is ever re-authored.
// ─────────────────────────────────────────────────────────────────────────────

import { BAND_HEIGHT, bandOf, isWater, quantizeToBand } from '@terrace/shared';
import type { FringeSpecies } from '../protocol.ts';

/**
 * Height at which the client's land ramp reaches snow — bandColors.ts's
 * SNOW_LINE_HEIGHT, restated here because the server may not import it.
 */
const LAND_RAMP_SNOW_LINE_HEIGHT = 576;

/** How many anchors the land ramp spends between the waterline and the snow line. */
const LAND_RAMP_ANCHOR_COUNT = 10;

/**
 * Height between two neighbouring ramp anchors. Derived rather than written as
 * 64, so it follows the ramp if the ramp gains or loses a material.
 */
const LAND_RAMP_ANCHOR_SPACING = LAND_RAMP_SNOW_LINE_HEIGHT / (LAND_RAMP_ANCHOR_COUNT - 1);

/** Index of the first green anchor (bright lowland grass) in the land ramp. */
const FIRST_GREEN_ANCHOR = 3;

/** Index of the first anchor ABOVE the green ones (dark exposed rock). */
const FIRST_ROCK_ANCHOR = 6;

/**
 * Lowest height that reads as green.
 *
 * HALF AN ANCHOR BELOW the first grass anchor, not at it: the ramp interpolates
 * between anchors, so the bands in the soil → grass gap are part soil and part
 * grass, and the halfway point is where the mix stops being mostly soil. That
 * is the "green-LIKE" the owner asked grass to cover (2026-08-25), and the
 * measurement above confirms those transitional bands do render green-dominant.
 */
export const FLORA_GREEN_MIN_HEIGHT =
  (FIRST_GREEN_ANCHOR - 0.5) * LAND_RAMP_ANCHOR_SPACING;

/**
 * First height that no longer reads as green — EXCLUSIVE.
 *
 * The rock anchor itself, with no half-anchor margin, because the asymmetry is
 * real rather than an oversight: the grass → rock gap interpolates from a
 * saturated dark green, so it stays green-dominant right up to the anchor where
 * rock takes over, where the soil → grass gap starts from a brown and does not.
 * Measured, not assumed — see the module header.
 */
export const FLORA_GREEN_MAX_HEIGHT = FIRST_ROCK_ANCHOR * LAND_RAMP_ANCHOR_SPACING;

/**
 * Lowest terrace band a tree, crop or tuft will grow on. DERIVED from the
 * height window above, so it re-derives itself under a BAND_HEIGHT change
 * instead of silently naming different ground — which is the bug this whole
 * module header is about. Kept as an export because the tests reason in bands.
 */
export const FLORA_MIN_BAND = bandOf(FLORA_GREEN_MIN_HEIGHT);

/** Highest terrace band flora will grow on — the last band below the rock anchor. */
export const FLORA_MAX_BAND = bandOf(FLORA_GREEN_MAX_HEIGHT - BAND_HEIGHT);


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
 * TESTED AGAINST THE BAND FLOOR, not the raw height, because the band floor is
 * what the renderer colours: bandPaletteIndex samples the ramp at
 * quantizeToBand(h), so a cell is green exactly when its band's floor is inside
 * the window. Comparing the raw height would disagree with the picture by up to
 * one band at each end of the range.
 *
 * NO WATER TEST, and its absence is load-bearing rather than forgotten:
 * FLORA_GREEN_MIN_HEIGHT is 160 and SEA_LEVEL is 0, so every green height is
 * dry land by arithmetic. A redundant `isWater` branch here would be dead code
 * that looks like a safeguard; the property is pinned by test instead (see "no
 * water cell is ever eligible").
 */
export function isGreenBand(height: number): boolean {
  const bandFloor = quantizeToBand(height);
  return bandFloor >= FLORA_GREEN_MIN_HEIGHT && bandFloor < FLORA_GREEN_MAX_HEIGHT;
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

// ─────────────────────────────────────────────────────────────────────────────
// THE FRINGE WINDOWS (GH #192, #194) — the two height ranges on either side of
// the green one, and the only other place in this plugin that reads the ramp.
//
// They live HERE, next to the window they are defined against, rather than in
// ../protocol.ts. The client never asks this question: the species rides the
// wire as its own list (../protocol.ts's fringe section says why), so nothing
// outside the server half needs to know where reeds stop and heather starts.
// That is what keeps the palette coupling this module's header documents to a
// single file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * First height that no longer carries heather — EXCLUSIVE, and one ramp anchor
 * above where the green window ends.
 *
 * ONE ANCHOR, not up to the snow line. Heather's job is to stop the ground
 * looking dead the moment the grass gives out; carrying it to the snow line
 * would put scrub on the pale high rock, which reads as the meadow failing to
 * stop rather than as a treeline. One anchor is the transition band itself —
 * dark exposed rock through rock — and above it the world is meant to be bare.
 *
 * DERIVED from the green window's own top rather than written as 448, so it
 * follows the ramp exactly as FLORA_GREEN_MAX_HEIGHT does. Re-deriving the
 * spacing from the window is arithmetic on two constants defined above, not a
 * second copy of the ramp's geometry.
 */
export const FLORA_HEATHER_MAX_HEIGHT =
  FLORA_GREEN_MAX_HEIGHT + LAND_RAMP_ANCHOR_SPACING;

/**
 * Which fringe species — if any — the ground at this height carries.
 *
 * TESTED AGAINST THE BAND FLOOR for isGreenBand's reason (it is what the
 * renderer colours) with ONE exception, and the exception is load-bearing: the
 * wetness test is `isWater` on the RAW height. A cell whose raw height is a
 * unit or two above the sea quantises to a band floor of exactly SEA_LEVEL, and
 * that cell is dry land the ramp paints as wet beach sand — the precise strip
 * reeds exist for. Testing the floor there would call the whole shoreline water
 * and grow nothing at all.
 *
 * Reeds get everything dry below the green window rather than a window of their
 * own: their real bound is the shore test in ./fringe.ts, and a second height
 * bound underneath it would be a constant that never binds.
 */
export function fringeSpeciesForHeight(height: number): FringeSpecies | null {
  if (isWater(height)) return null;
  const bandFloor = quantizeToBand(height);
  if (bandFloor < FLORA_GREEN_MIN_HEIGHT) return 'reed';
  if (bandFloor >= FLORA_GREEN_MAX_HEIGHT && bandFloor < FLORA_HEATHER_MAX_HEIGHT) {
    return 'heather';
  }
  return null;
}

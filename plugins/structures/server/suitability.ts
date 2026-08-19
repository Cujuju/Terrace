// WHICH GROUND WILL HOLD A BUILDING — the one predicate every other part of
// this plugin asks before it founds or surveys anything. Pure functions of a
// world's current state; no mutable state lives here, which is what lets the
// tests assert eligibility directly against a hand-built world (same shape as
// flora's bands.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// "FLAT-ENOUGH LAND ABOVE SEA LEVEL", MADE CONCRETE.
//
// Two conditions, both derived from shared/'s own terrain math rather than a
// second copy of it:
//
//   * DRY — `isWater` (shared/heightmap.ts): the same static-sea-level test
//     every other plugin and core itself uses.
//   * FLAT — a cell and its four orthogonal neighbours must all quantise to
//     the SAME terrace band (`bandOf`, also shared/). A settler does not level
//     a plot by eye against an arbitrary slope tolerance; the terraced render
//     already carves the world into discrete flats, so "flat enough to build
//     on" is exactly "on one terrace, with one terrace either side of it too"
//     — no new slope constant, no re-derivation of MAX_STEP or the gradient
//     relaxation invariant, just the band the terrain renderer already draws.
//
// A cell whose neighbour is off the map counts as NOT flat: a plot that runs
// off the world edge is not a plot a settler can walk around, and it keeps
// this predicate from needing a special case at the border.
// ─────────────────────────────────────────────────────────────────────────────

import { bandOf, isWater } from '@terrace/shared';

/**
 * The four orthogonal neighbours a plot's flatness is checked against.
 * Exported so the reactive demolition path (index.ts) can re-validate a
 * structure's NEIGHBOURS — not just its own cell — after an edit: a
 * structure's eligibility depends on this exact neighbourhood, so an edit
 * next door can silently break it even though the structure's own cell never
 * appears in the diff. One list, so founding and demolition can never
 * disagree about which cells a structure's flatness depends on.
 */
export const FLATNESS_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** The read-only slice of the server's WorldApi this plugin actually reads. */
export interface StructuresWorld {
  readonly worldSize: number;
  readonly chunksPerEdge: number;
  heightAt(x: number, y: number): number;
  isChunkUnlocked(cx: number, cy: number): boolean;
  isCellUnlocked(x: number, y: number): boolean;
}

/**
 * Is (x, y) and each of its four orthogonal neighbours on the same terrace
 * band? Assumes (x, y) itself is already known in-bounds — every caller here
 * reaches this only after that check (see isBuildableCell).
 */
export function isFlatEnough(world: StructuresWorld, x: number, y: number): boolean {
  const band = bandOf(world.heightAt(x, y));
  for (const [dx, dy] of FLATNESS_NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    if (bandOf(world.heightAt(nx, ny)) !== band) return false;
  }
  return true;
}

/**
 * Is this cell somewhere a structure may stand? Four conditions, all
 * required: inside the world, inside UNLOCKED territory (the same anti-leak
 * rule flora's isPlantableCell keeps — an unfiltered broadcast must never
 * mention locked land), dry, and flat.
 *
 * One predicate — the CA's WALL test (life.ts's GenerationSurvey), seed
 * pattern placement (life.ts's attemptSeed), and the reactive demolition
 * path (index.ts) all call this exact function, so none of them can
 * disagree about what "buildable" means.
 */
export function isBuildableCell(world: StructuresWorld, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  if (isWater(world.heightAt(x, y))) return false;
  return isFlatEnough(world, x, y);
}

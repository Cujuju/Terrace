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
 * All eight neighbours a structure's FOOTPRINT is checked against — see
 * hasClearFootprint's own doc comment for why a structure needs the full
 * Moore neighbourhood surveyed, not just the four orthogonal ones
 * FLATNESS_NEIGHBOR_OFFSETS covers for isFlatEnough.
 */
export const FOOTPRINT_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

/**
 * FOOTPRINT-FIT VALIDATION (owner directive 2026-08-20: fishing-village
 * structures were founding on shoreline cells where the model overhangs the
 * terrace edge — houses visibly hanging off the sand into the water). A
 * candidate cell qualifies only if the STANDING GROUND under the whole
 * model — not just the cell's own centre — is usable: same-terrace dry land,
 * never overhanging a band edge or the waterline.
 *
 * THE GAP THIS CLOSES. isFlatEnough (above) only surveys the cell's four
 * ORTHOGONAL neighbours, and only compares their BAND to the centre's —
 * client/models.ts's own STRUCTURE_FOOTPRINT_RADIUS doc comment names both
 * holes explicitly: "It says NOTHING about the diagonals, and nothing at all
 * about ground more than one cell away." That constant is also this
 * function's justification for HOW FAR to look: every tier's model is bound
 * to reach at most STRUCTURE_FOOTPRINT_RADIUS (0.5 / STRUCTURE_SCALE_MAX,
 * unscaled) from its own origin, and the per-building scale roll never
 * exceeds STRUCTURE_SCALE_MAX — so the worst case is exactly half a cell in
 * X or Z, in EVERY direction including the diagonals: a model can touch, but
 * never cross, its own cell's true edge. The true requirement is therefore
 * not "my four orthogonal neighbours match", it is "every cell my model
 * could touch is ground I could stand on" — the full eight-cell Moore
 * neighbourhood, exactly the ring the model's footprint radius can reach.
 *
 * WHY BAND EQUALITY ALONE IS NOT ENOUGH — THE ACTUAL SHORELINE BUG. bandOf
 * floors by BAND_HEIGHT, so band 0 covers raw heights [0, BAND_HEIGHT): both
 * dry land (h = 1..63) AND the waterline itself (h = 0, isWater's own
 * threshold) quantise to band 0. A structure standing on dry band-0 ground
 * one cell from the sea can pass a same-band comparison against a neighbour
 * that is ACTUALLY water at h = 0 — this is precisely the reported defect:
 * sand (band 0, dry) beside surf (band 0, water) reads as "flat" under a bare
 * band match. Every neighbour therefore gets its own explicit isWater check,
 * not just a band comparison.
 *
 * WHY MOORE-8 + DRYNESS IS ENOUGH, WITH NO SEPARATE MARGIN CONSTANT NEEDED.
 * Two dry cells sharing a band render at the identical flat terraced Y, and
 * the terraced renderer only ever draws a step or a shoreline curve where two
 * SAMPLES actually differ in band or wet/dry state (client/src/terrain/
 * contours.ts). A structure whose entire Moore neighbourhood is dry and
 * same-band as its own cell therefore has NO boundary anywhere within its
 * maximum reach to overhang — the model can touch its own cell's true edge
 * and still be standing on continuous, unbroken ground on the other side of
 * it. One ring of Moore neighbours is also provably sufficient: the model's
 * own worst-case reach never exceeds half a cell (see above), so it can never
 * touch a boundary two cells away regardless of what stands there.
 *
 * VALIDATED AT SPAWN ONLY, NOT RE-CHECKED PER TIER GROWTH. Every tier shares
 * the exact same STRUCTURE_FOOTPRINT_RADIUS bound (models.ts: "EVERY TIER
 * BELOW IS BOUND BY STRUCTURE_FOOTPRINT_RADIUS... a building at maximum
 * variation scale is exactly one cell wide" — no tier reaches further than
 * any other). A structure that clears this check at birth therefore never
 * needs re-checking as it upgrades tier (tiers.ts's maybeAdvanceTier): tier
 * only ever changes the SILHOUETTE drawn on an already-validated cell, never
 * the ground it needs. This function is reached exactly where isFlatEnough
 * is, inside isBuildableCell — the CA's own wall test — so a structure that
 * later loses its footprint fit to a terrain edit NEXT DOOR (a neighbour's
 * height moved, not the structure's own cell) is dropped by the ordinary
 * next-generation rescan, the same bounded lag life.ts's header already
 * documents and accepts for isFlatEnough's own neighbour case.
 */
export function hasClearFootprint(world: StructuresWorld, x: number, y: number): boolean {
  const band = bandOf(world.heightAt(x, y));
  for (const [dx, dy] of FOOTPRINT_NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    const neighborHeight = world.heightAt(nx, ny);
    if (isWater(neighborHeight)) return false;
    if (bandOf(neighborHeight) !== band) return false;
  }
  return true;
}

/**
 * Is this cell somewhere a structure may stand? Five conditions, all
 * required: inside the world, inside UNLOCKED territory (the same anti-leak
 * rule flora's isPlantableCell keeps — an unfiltered broadcast must never
 * mention locked land), dry, flat against its four orthogonal neighbours
 * (isFlatEnough), and FOOTPRINT-CLEAR against its full eight-cell Moore
 * neighbourhood (hasClearFootprint) — the model's own maximum reach, so a
 * structure standing here can never render overhanging a terrace edge or the
 * waterline (owner directive 2026-08-20; see hasClearFootprint's own doc
 * comment for the full reasoning). hasClearFootprint's Moore-8 check is a
 * strict superset of isFlatEnough's orthogonal-4 one, so isFlatEnough never
 * changes this function's own answer — it is still called, and stays
 * exported and independently tested, because farmland.ts's "deliberate
 * divergence" contract (see its own header) depends on isFlatEnough meaning
 * exactly what it always has: the narrower, four-neighbour band check, not
 * this stricter one.
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
  return isFlatEnough(world, x, y) && hasClearFootprint(world, x, y);
}

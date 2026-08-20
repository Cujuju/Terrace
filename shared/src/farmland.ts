// FARMLAND — "flat terraces adjacent to water", the terrain half of card 28
// ("Terrace Farming": flat terraces adjacent to water grow visible crops that
// feed settlement growth — the CA's birth rate rises near fed towns).
//
// WHY THIS LIVES IN shared/ AND NOT IN EITHER PLUGIN. Two plugins need this
// exact question answered: structures/server feeds it to the settlement CA's
// birth rule, and flora/server feeds it to the crop renderer. It shipped as
// two character-for-character identical copies, one per plugin, on the
// argument that a plugin may not import another plugin.
//
// That argument is true and does not apply. The rule forbids plugin→PLUGIN
// imports; every plugin already imports @terrace/shared, which is the single
// source of truth for terrain math (CLAUDE.md, design §3.3) and the one
// dependency they are all permitted to share. Both former copies already
// imported isWater and bandOf from here.
//
// The cost of getting this wrong is not hypothetical — it is the bug this
// repo spent 2026-08-19 fixing. Read shared/src/traversal.ts's header:
// wildlife and pilgrims each grew their own copy of "may this thing walk
// here", wildlife's was given a gradient term, pilgrims' was not, and a
// pilgrim walked up a cliff. Duplicated terrain math does not stay
// duplicated; it drifts, silently, in whichever copy nobody edited. Farmland
// had two consumers that will be edited at different times for different
// reasons, which is the same shape.
//
// (Two OTHER predicates, isFlatEnough and isGreenBand, are still independently
// duplicated across structures and flora. They are untouched here — collapsing
// them is a separate change with its own blast radius — but they are the same
// latent hazard and are named so the next person can see the pattern rather
// than rediscover it.)
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT structures' suitability.ts isFlatEnough, EVEN THOUGH BOTH
// TEST "FLAT". This was checked against the actual code, not assumed, and the
// reasoning is preserved verbatim from the original because it is the most
// load-bearing thing in this file:
//
// isFlatEnough requires a cell AND ALL FOUR of its orthogonal neighbours to
// share the SAME terrace band. A water cell's height is <= SEA_LEVEL (0); the
// only water height that can ever land in the SAME band as an adjacent dry
// cell is height exactly 0 (band 0 spans [0, 63], and water is h <= 0, so
// h = 0 is the one value that is both). Any water one band lower (height
// <= -1, which is every real body of water this game generates — shelves at
// -64, slopes at -128, open sea deeper still; see docs/DESIGN.md's fresh-world
// genesis profile) puts the water neighbour on a DIFFERENT band, which
// isFlatEnough treats as "not flat" — i.e. a cell bordering ordinary water can
// never pass isFlatEnough. That is CORRECT for suitability's job (a settler
// cannot level a foundation where the ground drops away next to them) and
// WRONG for this one: a terrace, by definition, is a flat plateau that steps
// DOWN to water at its edge. Reusing isFlatEnough here would make farmland
// vacuous — true on paper, never true on any world this game actually
// generates. (Verified by measurement, not just reasoning: an ad hoc sweep of
// a mixed-terrain board using the reused predicate found zero qualifying
// cells.)
//
// So farmland's flatness test below applies the band-match rule ONLY to a
// cell's DRY orthogonal neighbours, and treats a WATER neighbour as the thing
// that makes the cell a terrace edge rather than as a flatness violation. This
// is the one deliberate divergence from suitability.ts; every other convention
// (four orthogonal neighbours, off-map counts as a failure, unlocked-only for
// the cell itself) matches it rather than reinventing.
// ─────────────────────────────────────────────────────────────────────────────
//
// DETERMINISM CONTRACT (as for every file in shared/): integer-only, no wall
// clock, no RNG, fixed iteration order. Every operation below is an integer
// comparison or a call into heightmap.ts's own integer helpers, so two callers
// running this against the same heights get byte-identical answers.

import { bandOf, isWater } from './heightmap.ts';

/** The read-only slice of a world this predicate needs. */
export interface FarmlandWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

/**
 * The four orthogonal neighbours farmland's flatness is checked against — the
 * same neighbourhood structures' FLATNESS_NEIGHBOR_OFFSETS uses, so
 * "adjacent" means the same thing (shares an edge) in both.
 */
const ADJACENT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Is (x, y) a flat terrace edged by water — "flat terraces adjacent to water"
 * made concrete? Three conditions:
 *
 *   * DRY — the cell itself is not water (isWater, heightmap.ts).
 *   * FLAT AMONG ITS LAND — every orthogonal neighbour that is ALSO dry must
 *     share the cell's terrace band (bandOf). A water neighbour is exempt from
 *     this test entirely — see the file banner for why that is the correct and
 *     deliberate divergence from isFlatEnough.
 *   * ADJACENT TO WATER — at least one orthogonal neighbour must be water.
 *
 * An off-map neighbour fails the whole predicate, mirroring isFlatEnough's
 * identical rule: a terrace that runs off the world edge is not a plot a
 * farmer can walk around either.
 *
 * Gated on `world.isCellUnlocked(x, y)` for the cell itself only — never for
 * its neighbours — again mirroring isBuildableCell/isFlatEnough exactly:
 * checking a neighbour's own lock state would let farmland eligibility change
 * based on unrelated territory a player has not even earned yet. For the
 * caller that BROADCASTS farmland (flora's crops) this is also the anti-leak
 * measure; for the caller that does not (structures' CA) it is kept anyway, so
 * "farmland" cannot exist on ground the game does not yet consider part of
 * anyone's world.
 */
export function isFarmlandCell(world: FarmlandWorld, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;

  const height = world.heightAt(x, y);
  if (isWater(height)) return false;
  const band = bandOf(height);

  let touchesWater = false;
  for (const [dx, dy] of ADJACENT_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;

    const neighborHeight = world.heightAt(nx, ny);
    if (isWater(neighborHeight)) {
      touchesWater = true;
      continue;
    }
    if (bandOf(neighborHeight) !== band) return false;
  }
  return touchesWater;
}

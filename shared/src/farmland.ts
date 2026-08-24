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

/**
 * Does a plot of a given SIZE actually have ground to stand on at (x, y)?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY isFarmlandCell IS NOT ENOUGH, AND WHY THIS IS NOT JUST A WIDER VERSION OF
 * IT (owner, 2026-08-23, from a screenshot of crop plots hanging over a cliff).
 *
 * isFarmlandCell answers a question about a POINT: it promises the cell's
 * CENTRE is dry, unlocked, and on a terrace band. That is also exactly as much
 * as the renderer promises — client/src/terrain/vertexGrid.ts's honesty
 * invariant is stated over cell CENTRES, because terraces are not drawn as
 * per-cell quads. Their outlines are marching-squares contours over the raw
 * heightmap, interpolated along the edges BETWEEN cell centres and then
 * smoothed, so a terrace lip cuts across cells at arbitrary angles and may pass
 * within CONTOUR_CELL_CENTRE_GUARD — an eighth of a cell — of a centre.
 *
 * At a real shoreline it passes at exactly that bound. The crossing fraction is
 * measured from the WATER end of the edge, and deep water against a dry cell
 * only just above the band boundary drives it to its clamp, leaving the drop
 * one eighth of a cell from the dry cell's centre. So a cell that passes
 * isFarmlandCell has, in the common case, an eighth of a cell of tread around
 * its centre and a cliff after that. Any model of visible size standing there
 * overhangs — which is what the screenshot showed.
 *
 * Shrinking the model to an eighth of a cell is not a fix: that is 0.03 world
 * units, invisible at play distance. So this predicate stands the model BACK
 * from the lip instead. It asks for a solid square of same-band dry land around
 * the plot, wide enough that no contour can reach the model, and then asks for
 * water just beyond it so the plot is still farming a water-edged terrace
 * rather than an inland field.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `treadCells` is that solid radius, Chebyshev (a square, because a plot's
 * footprint is a square). The caller derives it from the model's own reach and
 * the contour guard — flora's CROP_PLOT_TREAD_RING_CELLS — so the size of the
 * thing being drawn and the size of the ground it needs can never again be
 * stated independently of one another. At `treadCells` of 0 this degenerates to
 * the centre-cell-only promise that was not enough, which is why flora derives
 * it rather than passing a literal.
 *
 * WHY THE WATER TEST MOVES OUT WITH IT rather than being dropped: card 28 is
 * "flat terraces adjacent to water", and a plot set back one cell from the lip
 * is still on the terrace the water made. Requiring water within `treadCells + 1`
 * keeps that meaning at every plot size — a plot sits as close to the shore as
 * its own footprint allows and no closer.
 *
 * NEIGHBOUR UNLOCK IS DELIBERATELY NOT CHECKED, matching isFarmlandCell's own
 * documented rule: eligibility must not swing on territory the player has not
 * earned. Only the cell the plot stands on is gated on the unlock mask.
 *
 * DETERMINISM: integer comparisons in a fixed iteration order, like everything
 * else here. `treadCells` arrives as an integer count of CELLS precisely so no
 * float ever reaches the terrain math.
 */
export function isFarmlandPlot(
  world: FarmlandWorld,
  x: number,
  y: number,
  treadCells: number,
): boolean {
  if (!Number.isInteger(treadCells) || treadCells < 0) return false;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;

  const height = world.heightAt(x, y);
  if (isWater(height)) return false;
  const band = bandOf(height);

  // THE TREAD, ORTHOGONALS FIRST. Every cell within treadCells must be dry
  // land on this same terrace, or a contour runs through the ground the model
  // stands on. The four orthogonal neighbours are tested BEFORE the rest of
  // the square because they are the cheapest rejection this predicate has and
  // they carry most of its selectivity: they reject every lip cell (a water
  // neighbour) and all broken ground, which between them are nearly every cell
  // of a real board. Ordering matters here in a way it usually does not —
  // crops.ts sweeps the WHOLE board with this predicate on a five-second
  // cadence, so a cell's average cost is the thing being paid, not its worst
  // case.
  for (const [dx, dy] of ADJACENT_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    const neighborHeight = world.heightAt(nx, ny);
    if (isWater(neighborHeight)) {
      // A water neighbour means this cell IS the lip. That disqualifies it
      // once the plot needs tread around it, and is exactly what makes it
      // farmland at treadCells 0 — where this predicate must still be
      // isFarmlandCell, water-neighbour exemption and all.
      if (treadCells >= 1) return false;
      continue;
    }
    if (bandOf(neighborHeight) !== band) return false;
  }
  for (let dy = -treadCells; dy <= treadCells; dy++) {
    for (let dx = -treadCells; dx <= treadCells; dx++) {
      // The four already done above, plus the centre.
      if (Math.abs(dx) + Math.abs(dy) <= 1) continue;
      const nx = x + dx;
      const ny = y + dy;
      // Off-map fails, mirroring isFarmlandCell: ground that is not there is
      // not ground a plot can stand on.
      if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
      const neighborHeight = world.heightAt(nx, ny);
      if (isWater(neighborHeight)) return false;
      if (bandOf(neighborHeight) !== band) return false;
    }
  }

  // THE SHORE. Water in the next ring out — the terrace edge this plot farms,
  // set back by exactly the plot's own footprint. An off-map cell is skipped
  // rather than failing here: the tread loop above has already rejected any
  // plot close enough to the world edge for that to matter, and a world rim is
  // not a shoreline.
  const shore = treadCells + 1;
  for (let dy = -shore; dy <= shore; dy++) {
    for (let dx = -shore; dx <= shore; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== shore) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
      if (isWater(world.heightAt(nx, ny))) return true;
    }
  }
  return false;
}

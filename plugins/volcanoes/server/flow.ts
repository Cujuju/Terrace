// THE LAVA FRONT — how a flow picks its way downhill, and how it cools.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FRONT IS A SCULPT, NOT A DECORATION (issue #214: "advance a lava front as
// a raise along the descent path so relaxation shapes the flow").
//
// Every cell the front enters is RAISED. That single choice is what makes a
// flow behave like lava instead of like a painted stripe:
//
//   * it fills. A raise into a gully is spread by core's gradient relaxation to
//     the gully's shoulders, so the flow visibly pools where the ground is
//     concave and runs thin where it is convex — for free, because relaxation
//     is already the thing that shapes every other edit in this game.
//   * it is permanent, and it is REAL terrain. Delete this plugin and the new
//     ground stays, because it was always just ground (see protocol.ts's
//     "cooled lava is this plugin's overlay, not a new core terrain band").
//   * it cannot loop. The front never re-enters a cell this eruption already
//     visited, so the raise it leaves behind can never turn into a hill it then
//     flows back down. That is the guard, not the raise being small.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE A FRONT STOPS, and all four are ordinary answers rather than errors:
//
//   * FRESH WATER (issue #214: "freshwater contact stops the front (steam)").
//     Core publishes rivers and pools per cell as WorldApi.freshwater, so this
//     is one lookup and no river math of this plugin's own. The front reads a
//     SNAPSHOT of that map taken when the eruption began, not the live getter —
//     see FlowWorld below, and ./vents.ts's `beginEruption`.
//   * THE SEA. Below sea level the flow is under water, which is the same
//     steam by a different route.
//   * NOWHERE LEFT TO GO. No unvisited neighbour lower than the front means the
//     lava has found a basin and is pooling in it — the flow is done.
//   * THE LENGTH CAP. See MAX_FLOW_CELLS.

import { BAND_HEIGHT, SEA_LEVEL, cellsAcross, type FreshwaterMap } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { FLOW_RADIUS_WORLD_UNITS, lavaKey } from '../protocol.ts';

/**
 * The slice of the world a flow reads.
 *
 * FRESH WATER IS NOT IN IT, deliberately: `WorldApi.freshwater` is a getter
 * that rebuilds the whole world's river network on demand, and a front asks the
 * water question once per cell it enters while ALSO invalidating that network
 * with every raise it makes. Reading it through the world therefore forced a
 * full-world recompute at its throttle cap for the whole eruption. The map is
 * passed in beside this instead — see ./vents.ts's `beginEruption`, which
 * snapshots it once.
 */
export type FlowWorld = Pick<WorldApi, 'worldSize' | 'heightAt'>;

/**
 * How fast a front travels, in CELLS per second.
 *
 * Stated in world units and converted, per the re-sample rule: a flow's speed
 * is a fact about the ground it crosses, not about how finely the ground is
 * sampled. Half a world unit a second is a walking pace's fraction — slow
 * enough that a player watching one sees it CHOOSE its way down a slope (which
 * is the whole appeal of a steepest-descent front) and fast enough that an
 * eruption is over inside the minute it is budgeted for.
 */
export const FLOW_SPEED_WORLD_UNITS_PER_SECOND = 0.5;
export const FLOW_SPEED_CELLS_PER_SECOND = cellsAcross(FLOW_SPEED_WORLD_UNITS_PER_SECOND);

/**
 * The longest a single eruption's flow may get, in cells.
 *
 * DERIVED FROM THE ERUPTION'S OWN DURATION, not chosen beside it: at
 * FLOW_SPEED_CELLS_PER_SECOND a front can only reach so far in the time it is
 * given, so a cap below that is a real limit and a cap above it is a comment.
 * ./vents.ts's ERUPTION_SECONDS is the input; this is stated there and imported
 * here would be circular, so the cap lives here and the duration is checked
 * against it in that file's own note.
 *
 * 64 cells is 16 world units — a flow that runs the length of a hillside and
 * stops, rather than one that crosses the map. It is also the FUNCTIONAL cap on
 * how much terrain one eruption can rewrite, which is the number an operator
 * turning `active` on is really consenting to.
 */
export const MAX_FLOW_CELLS = 64;

/**
 * How much the flow raises each cell it enters, in height units.
 *
 * ONE HALF OF A TERRACE BAND. A full band would make every flow cell a visible
 * step in its own right — the flow would terrace itself as it went, which is
 * the one thing a liquid does not do. Half a band leaves the flow BELOW the
 * threshold that draws a new contour on flat ground, so on a slope it thickens
 * the ground it crosses without inventing a staircase, and where several cells
 * of flow overlap in a hollow the halves add up and the pool does step. That is
 * exactly the right way round.
 *
 * RE-MEASURED AND DELIBERATELY NOT RETUNED after the conserving relaxation
 * (issue #108, 2026-08-29). The claim above is about a single flow cell, and it
 * is exactly as true as it was: one cell melted on genesis ground settles at
 * 8.00 height units under BOTH rules (.sim-108/plugins.mjs, `=== VOLCANOES:
 * lava settled thickness ===`, "one cell" column) — the relaxation has nothing
 * to spread half a band of rise into that it did not have before.
 *
 * WHAT DID CHANGE IS THE POOL, and it is the change that was WANTED. Over a
 * 32-cell flow the mean settled rise fell from 41.9 units to 20.4, and the
 * height the world actually gained fell from 12,642 to 4,608 — the 4,608 being
 * exactly what the brush displaced. The missing 8,034 was never lava: it was
 * relaxation manufacturing height out of the odd remainder of every pair it
 * touched (#108), so an old flow deposited nearly three times the material it
 * was asked for. Doubling this constant to "restore" that would be restoring an
 * accounting error, and it would break the sentence above outright — measured,
 * FLOW_THICKNESS = BAND_HEIGHT lands a full band on every cell the flow enters
 * (16.00 in the same table), which is the self-terracing flow this value exists
 * to prevent. The pool still steps: 20.4 units is more than one band.
 */
export const FLOW_THICKNESS = BAND_HEIGHT / 2;

/**
 * Brush radius for a flow cell's raise, in cells — the sculpt that IS the flow.
 *
 * DERIVED FROM protocol.ts's FLOW_RADIUS_WORLD_UNITS, which is the same number
 * the client's decal is sized from, so the glow and the ground it raised are
 * the same width by construction rather than by two people agreeing.
 *
 * One world unit is also the finest brush that still writes a feature the
 * terrain can draw: MAX_STEP is one band per world unit of run, so a narrower
 * brush's edit sits entirely inside one terrace tread and relaxation flattens
 * it straight back out.
 */
export const FLOW_BRUSH_RADIUS = cellsAcross(FLOW_RADIUS_WORLD_UNITS);

/**
 * How many flow cells the world remembers, across every eruption there has ever
 * been.
 *
 * A HARD CEILING ON THIS PLUGIN'S UNBOUNDED AXIS, and it is the only place that
 * axis exists: vents are capped by MAX_VENTS_PER_WORLD and an eruption by
 * MAX_FLOW_CELLS, but a world that runs for a year erupts an unbounded number
 * of times, and a set that only ever grows is a snapshot that only ever grows
 * and a keepalive payload that only ever grows with it.
 *
 * 192 is three maximum-length flows. So the most recent few eruptions keep
 * their crust and older ones fade back into being ordinary ground — which they
 * ALREADY ARE, in the only sense core cares about: the sculpt happened and the
 * height stays. What is evicted is the memory that it was once lava, and that
 * memory is exactly the thing whose value decays.
 */
export const MAX_TRACKED_FLOW_CELLS = 192;

/**
 * Why a front stopped. `length` is the caller's — ./vents.ts counts the cells —
 * and the other three are this module's; they are one type because the caller
 * reports them through one field and a split would make it choose twice.
 */
export type FlowStop = 'water' | 'sea' | 'basin' | 'length';

/** The eight neighbours, in a FIXED order — reproducibility, and tests. */
const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/**
 * The cell a front at (x, y) flows into next, or a reason it stops.
 *
 * STEEPEST DESCENT over the eight neighbours, ties broken by the fixed offset
 * order above. Eight and not four because a four-neighbour front can only run
 * along the axes, and a flow that goes down a diagonal slope in a staircase of
 * norths and easts looks like a pathfinder, not like a liquid.
 *
 * `visited` is THIS ERUPTION's cells, not the world's tracked crust: an old
 * flow's cooled ground is ordinary terrain and a new flow may perfectly well
 * run down it (that is how a volcano builds a fan), but a flow crossing its own
 * live path could circle forever.
 */
export function nextFlowCell(
  world: FlowWorld,
  freshwater: FreshwaterMap,
  x: number,
  y: number,
  visited: ReadonlySet<number>,
): { readonly x: number; readonly y: number } | FlowStop {
  const size = world.worldSize;
  const here = world.heightAt(x, y);

  let bestX = -1;
  let bestY = -1;
  let bestHeight = here;

  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    if (visited.has(lavaKey(nx, ny))) continue;

    const height = world.heightAt(nx, ny);
    if (height >= bestHeight) continue;
    bestHeight = height;
    bestX = nx;
    bestY = ny;
  }

  // Nothing lower and unvisited around it: the lava has found a basin.
  if (bestX < 0) return 'basin';

  // The stop tests are on the cell the front is ABOUT to enter, not the one it
  // is in, so a flow reaching a river stops AT the bank rather than in the
  // water — which is where the steam is, and where the player can see it.
  if (freshwater.at(bestX, bestY) !== 'none') return 'water';
  if (bestHeight < SEA_LEVEL) return 'sea';

  return { x: bestX, y: bestY };
}

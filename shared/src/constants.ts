// Terrain constants — the feel-critical numbers, all named, all justified.
//
// DETERMINISM CONTRACT: everything in shared/ must produce identical results on
// server and client from identical inputs (client-side prediction reconciles
// against the server's authoritative diff — any divergence shows up as visible
// snapping). All terrain math is integer-only, or uses exactly-specified IEEE
// operations (Math.sqrt) immediately floored to an integer.

/**
 * Cells per WORLD UNIT — the horizontal sampling quantum, and the exact
 * counterpart of BAND_HEIGHT below.
 *
 * A cell is how finely the world is SAMPLED across the ground; it is not a
 * size anything in the world HAS. The world unit is the physical horizontal
 * fact: a hill's footprint, a boat's speed, how far a village patrols. Before
 * 2026-08-21 the two were the same number (one cell = one world unit) and the
 * distinction cost nothing, so every world-space distance in the codebase was
 * written in cells — which is exactly the conflation the 2026-08-20 re-terrace
 * found between height units and bands, one axis over.
 *
 * FOUR (owner, 2026-08-21: "I want the cell size to be one quarter of the size
 * that it is now"). The re-terrace made the world step four times as finely in
 * the vertical; this does the same across the ground, so a terrace tread is
 * sampled at four points where it used to be sampled at one and a contour
 * follows the land rather than the grid. Nothing about the world's SIZE moves
 * with it: every physical distance is stated in world units and multiplied by
 * this constant to reach cells, so re-sampling the world can never resize it.
 *
 * COST, and it is not small: sixteen times the cells. See DEFAULT_WORLD_SIZE
 * for the storage, CHUNK_SIZE for the per-chunk mesh, MAX_STEP for the
 * geometry, and SMOOTH_PASS_LIMIT for the relaxation worst case.
 */
export const WORLD_UNIT_CELLS = 4;

/**
 * The same ratio the other way: world units per cell edge, i.e. the factor
 * that turns a cell coordinate into a render-space X/Z.
 *
 * IN SHARED RATHER THAN IN THE CLIENT'S CONFIG, where it lived until
 * 2026-08-21, because the client is not the only thing that renders the world
 * in world units: every plugin that draws an entity at a cell position needs
 * this exact number, and plugins cannot import client/src/config.ts without
 * dragging `import.meta.env` into their node test runs (see plugins/mana/
 * client/env.d.ts). They restated "CELL_WORLD_SIZE is 1" instead — a dozen
 * copies of an assumption that the re-sample broke all at once, each of which
 * would have silently placed its entity four times too far out. One exported
 * ratio is the fix; client/src/config.ts re-exports this very constant so the
 * client keeps its single import site.
 */
export const CELL_WORLD_SIZE = 1 / WORLD_UNIT_CELLS;

/**
 * Default world edge in WORLD UNITS — how big the land IS. Unchanged since
 * 2026-08-13 and deliberately untouched by the 2026-08-21 re-sample: that
 * change was about how finely the world is sampled, never about how much of it
 * there is. 128 world units is the Populous-proven playable minimum for small
 * self-hosted boxes.
 */
export const DEFAULT_WORLD_SPAN = 512;

/**
 * Default cells per world edge — DERIVED, never stated. 2048² Int16 = 8 MB,
 * allocated up front, never resized (512 KB before the re-sample). Server
 * config (`WORLD_SIZE`) may override, and that override is in CELLS because
 * cells are what the heightmap is indexed by.
 */
export const DEFAULT_WORLD_SIZE = DEFAULT_WORLD_SPAN * WORLD_UNIT_CELLS;

/**
 * Chunk edge in WORLD UNITS — how much land one chunk covers.
 *
 * FOUR, DOWN FROM SIXTEEN (2026-08-21), and this is the one place the
 * re-sample was allowed to change a physical size. A chunk is three things at
 * once — the sync payload, the reveal quantum, and the MESH quantum — and the
 * third one has a hard cost curve the other two do not: the mesher ear-clips
 * each band contour inside a chunk, which is O(V²) in that contour's vertices,
 * so a chunk's build cost grows as the SQUARE of the sampling density. Held at
 * 16 world units through the re-sample, the worst legitimate chunk (three
 * floor-depth craters, measured — see client/src/terrain/capEmission.ts) went
 * from 3.3 M units of triangulation work to 55.7 M: a 90–180 ms freeze in a
 * single build, on ordinary deep digging, where it used to be ~9 ms.
 *
 * Keeping 16 CELLS per chunk instead holds that cost exactly where it was
 * calibrated, because a chunk then samples a sixteenth of the ground it used
 * to. What it costs is chunk COUNT: sixteen times as many, so a default world
 * is 16 384 chunks rather than 1 024, and a fully revealed one is that many
 * draw calls. That is the tradeoff taken, and it is taken in this direction
 * because the draw-call bill is paid only by a world explored end to end and
 * has a known fix already named in render/terrainMeshes.ts (merge chunks into
 * super-meshes, keeping the same patch path), while the meshing bill is paid
 * by every player who digs a hole and has no fix short of suspending a build
 * mid-walk.
 *
 * WHAT THIS BREAKS, and where it went instead: "one chunk" was the game's
 * neighbourhood unit — the size half the world's distances rhyme with (a
 * settler district, a route search margin, the outer-terrain lattice, a
 * monster's minimum lair). Those are facts about the GROUND and none of them
 * moved; they now rhyme with NEIGHBOURHOOD_CELLS below, which is the 16 world
 * units they always meant, rather than with a chunk that no longer is one.
 */
export const CHUNK_SPAN = 4;

/**
 * Cells per chunk edge (chunks are square) — DERIVED from the span above, and
 * SIXTEEN either side of the 2026-08-21 re-sample, which is the point: the
 * mesher's per-chunk budgets (client/src/terrain/capEmission.ts) and the 512 B
 * Int16 payload are both facts about this number, and neither had to move.
 * WORLD_SIZE must be a multiple of it.
 */
export const CHUNK_SIZE = CHUNK_SPAN * WORLD_UNIT_CELLS;

/**
 * THE NEIGHBOURHOOD, in cells: sixteen world units of ground.
 *
 * This is what "one chunk" meant everywhere it was used as a DISTANCE rather
 * than as a unit of storage — a settler district, the route search margin, the
 * outer-terrain noise lattice, the smallest lair a monster will take, the
 * margin a flock is born outside. Every one of those is a fact about the
 * ground, and they all read `CHUNK_SIZE` because a chunk happened to be that
 * much ground until 2026-08-21, when the chunk shrank to keep the mesher's
 * costs where they were calibrated (see CHUNK_SPAN).
 *
 * Naming it separately is the fix rather than a patch: the two ideas were
 * always distinct and only ever coincided, and a codebase that says
 * NEIGHBOURHOOD_CELLS where it means "about a village across" cannot be
 * re-tuned into nonsense by a later change to how the world is stored.
 */
export const NEIGHBOURHOOD_CELLS = 16 * WORLD_UNIT_CELLS;

/**
 * World units → cells: THE conversion, and the one every physical distance in
 * this codebase should be written through.
 *
 * `cellsAcross(4)` says "four world units of ground" and reads as such;
 * `4 * WORLD_UNIT_CELLS` says the same thing and reads as arithmetic. The
 * difference matters because of its sibling below.
 */
export function cellsAcross(worldUnits: number): number {
  return worldUnits * WORLD_UNIT_CELLS;
}

/**
 * Square world units → cells, for anything that is an AREA: a population
 * density, a minimum lair, how much water makes a settlement coastal.
 *
 * IT EXISTS BECAUSE THE WRONG POWER IS SILENT. An area scales as the SQUARE of
 * the sampling density, and a density scaled as a length is not a crash, a
 * type error or a failed test in any obvious place — it is four times the
 * whales, or a settlement that calls a puddle the sea. The 2026-08-21
 * re-sample had to find every one of these by hand; naming the operation is
 * what stops the next change having to.
 */
export function cellsOverArea(squareWorldUnits: number): number {
  return squareWorldUnits * WORLD_UNIT_CELLS * WORLD_UNIT_CELLS;
}

/**
 * Cells → world units, the inverse of cellsAcross — for turning a cell
 * coordinate or a cell count into a size in the world (an entity's position,
 * a camera distance).
 */
export function worldUnitsAcross(cells: number): number {
  return cells * CELL_WORLD_SIZE;
}

/**
 * Height units per terrace band — how thick one terrace is.
 *
 * Decided 2026-08-13 (open question 1) at 64, flagged PROVISIONAL for Phase 2
 * feel-tuning. THIS IS THAT TUNING (owner, 2026-08-20: "the world is too
 * blocky and it's causing a lot of problems"): 64 → 16, four times the terrace
 * resolution, 64 bands of relief above sea level instead of 16.
 *
 * WHAT "TOO BLOCKY" WAS. A band was drawn one full cell tall (client
 * config.ts's BAND_WORLD_HEIGHT = CELL_WORLD_SIZE), so every riser in the
 * world was a cube-sized step and the land read as stacked blocks rather than
 * as terraces. The client now draws a band at a QUARTER of a cell, and this
 * constant puts four times as many of them in the same height range, so the
 * world keeps exactly its relief (HEIGHT_WORLD_SCALE is unchanged — see
 * config.ts) while every step in it is four times finer.
 *
 * WHAT MOVED WITH IT, and why nothing else had to: MAX_STEP below is now tied
 * to this constant rather than stated against it, and every physical depth in
 * the world (the strata stack, deep water, the snow line, genesis's floors) is
 * stated in HEIGHT UNITS with its band count derived. That is the contract
 * this change bought: a band is a RENDER quantum, and re-terracing the world
 * must not move anything the world is actually made of.
 *
 * COST, measured 2026-08-20 on a realistic island world (dome + two octaves of
 * relief, relaxed by smooth(), five dug craters), every chunk meshed: a fully
 * explored 512² world goes from 1.69 M triangles to 4.09 M, and the terrain's
 * vertex buffers from 279 MB to 673 MB. Both are consequences of MAX_STEP's
 * value, not this one — see the measured table there.
 */
export const BAND_HEIGHT = 16;

/**
 * Heights at or below this are water (static sea — decided 2026-08-13, open
 * question 3: water is a derived fact of the heightmap, never simulated
 * state; waves/shimmer are client-side visuals only).
 */
export const SEA_LEVEL = 0;

/**
 * Sculptable height range, in HEIGHT UNITS. Int16 storage allows ±32767; we
 * deliberately cap far below that: 1024 units of relief above sea keeps
 * mountains readable and bounds the smoothing cascade (see SMOOTH_PASS_LIMIT).
 * Brush edits clamp to this range.
 *
 * DELIBERATELY NOT A BAND COUNT. It was described as "16 bands" while
 * BAND_HEIGHT was 64; that was the same conflation the strata stack below
 * suffered from, and re-terracing the world (2026-08-20) would have changed
 * the height of the sky. The ceiling is a physical fact of the world and the
 * number of terraces under it is derived: MAX_HEIGHT / BAND_HEIGHT, 64 bands
 * at today's resolution.
 *
 * The range is ASYMMETRIC since Deep Strata (2026-08-19, mechanics card 41):
 * the world goes deeper than it goes high. MIN_HEIGHT is derived from the
 * strata stack below — never restated as a literal — so the floor and the
 * strata that define it cannot drift apart.
 */
export const MAX_HEIGHT = 1024;

/**
 * DEEP STRATA (decided 2026-08-19, mechanics card 41: "new bands below the
 * current floor: basalt, obsidian, a lava glow at the very bottom").
 *
 * The world's depth is a stack of named strata, shallowest first:
 *
 *   * the SEA COLUMN — the ordinary seabed: the blue water column the
 *     2026-08-19 depth ramp colours, ending in very dark blue. It is exactly
 *     as deep as the sky is high, which is the PRE-deep-strata floor (the old
 *     MIN_HEIGHT = −MAX_HEIGHT), kept exactly so every world saved before the
 *     strata landed is unchanged, and so everything anchored to "the sea"
 *     (monster depth thresholds, the seabed palette) keeps meaning the sea
 *     rather than the crust.
 *   * DEEP BASALT — volcanic rock, half the crust. Deep enough that breaking
 *     through the seabed is an act, not an accident.
 *   * DEEP OBSIDIAN — glass-black rock, the darkest material in the game.
 *   * DEEP LAVA — the absolute floor: molten glow, and the thinnest stratum
 *     of the three, because it is a boundary rather than a place — the world
 *     ends in light.
 *
 * STATED IN HEIGHT UNITS, COUNTED IN BANDS (2026-08-20). These depths were
 * originally written as band counts (16 / 4 / 3 / 1), which silently made the
 * world four times shallower the moment BAND_HEIGHT was re-tuned: a band is a
 * render quantum, and the seabed is not. The DEPTH of each stratum is
 * therefore the primary fact and its band count is derived, so re-terracing
 * the world can never move its floor. The 4 : 3 : 1 proportion between the
 * crust strata is preserved exactly from the original band counts, and the
 * crust is half as deep as the sky is high — 1024 of sea over 512 of rock,
 * the same −1536 floor as before.
 *
 * These are WORLD-MODEL facts, not render trivia: the client palette derives
 * its stops from them and the monsters plugin derives "deep for this world"
 * from the sea column, so they live here in shared. Hazards (heat, eruption)
 * are deliberately NOT core — nothing gamey in core; a future plugin reads
 * these same boundaries.
 */
export const SEA_COLUMN_DEPTH = MAX_HEIGHT;
export const DEEP_STRATA_DEPTH = MAX_HEIGHT / 2;
export const DEEP_BASALT_DEPTH = DEEP_STRATA_DEPTH / 2;
export const DEEP_OBSIDIAN_DEPTH = (DEEP_STRATA_DEPTH * 3) / 8;
export const DEEP_LAVA_DEPTH = DEEP_STRATA_DEPTH / 8;

/**
 * The same stack counted in terrace bands — DERIVED, so a BAND_HEIGHT change
 * re-terraces the strata instead of moving them. Every one of these divisions
 * is exact today; a future BAND_HEIGHT that does not divide the stack evenly
 * would leave a stratum boundary off a band edge, which the strata test in
 * test/constants.test.ts is what catches.
 */
export const SEA_COLUMN_BANDS = SEA_COLUMN_DEPTH / BAND_HEIGHT;
export const DEEP_BASALT_BANDS = DEEP_BASALT_DEPTH / BAND_HEIGHT;
export const DEEP_OBSIDIAN_BANDS = DEEP_OBSIDIAN_DEPTH / BAND_HEIGHT;
export const DEEP_LAVA_BANDS = DEEP_LAVA_DEPTH / BAND_HEIGHT;

/** Total crust bands below the sea column. */
export const DEEP_STRATA_BANDS =
  DEEP_BASALT_BANDS + DEEP_OBSIDIAN_BANDS + DEEP_LAVA_BANDS;

/** The floor of the world: the bottom of the lava stratum (−1536). */
export const MIN_HEIGHT = -(SEA_COLUMN_DEPTH + DEEP_STRATA_DEPTH);

/**
 * The DEEPEST floor this game has ever had — the −1536 that Deep Strata
 * (2026-08-19) set and the 2026-08-24 shallowing lifted.
 *
 * WHY THIS EXISTS RATHER THAN BEING DELETED WITH THE OLD STACK. MIN_HEIGHT is
 * a world-model fact that the owner can retune, but a saved world is bytes
 * written against whatever MIN_HEIGHT was true the day it was saved, and a
 * snapshot records no floor of its own. Without a stated historical floor the
 * two failures below are indistinguishable, and the loader must treat both as
 * the fatal one:
 *
 *   * a cell at −1152 because a player dug to the old lava floor — legitimate
 *     terrain that the world model has since made unreachable, and which must
 *     be migrated (raised to today's floor), not refused;
 *   * a cell at −20000 because the blob is corrupt or foreign — which must
 *     still stop the boot rather than be silently repaired.
 *
 * So this is the migration window's far edge: [LEGACY_MIN_HEIGHT, MIN_HEIGHT)
 * is old-but-honest and gets clamped on load, anything below it is corruption.
 * It is a floor, so it must only ever go DOWN: if a future stack goes deeper
 * than −1536, this becomes that number and the window keeps covering every
 * world ever saved.
 */
export const LEGACY_MIN_HEIGHT = -1536;

/**
 * Gradient limit: maximum allowed height difference between 4-neighbors.
 * THE feel-critical number — this is what makes edits "flow" outward
 * (Populous's signature).
 *
 * DERIVED FROM BAND_HEIGHT, NOT STATED AGAINST IT (2026-08-20). It was the
 * literal 32 next to a BAND_HEIGHT of 64, with the ratio explained only in
 * this comment; the ratio is the whole meaning of the number, so it is now
 * the code. One BAND_HEIGHT per WORLD UNIT of run means a terrace tread is one
 * world unit wide at the steepest the world may be, which is the finest
 * terrace that can still be seen as a terrace: at a narrower tread the
 * contours of neighbouring bands crowd together and the staircase dissolves
 * into a ramp.
 *
 * PER WORLD UNIT, NOT PER CELL (2026-08-21). The steepest slope the world may
 * hold is a physical fact — rise over RUN, both measured in the world — and
 * the cell grid is only what samples it. Left as one band per CELL through the
 * re-sample it would have quadrupled every gradient in the game: a full-height
 * mountain's foot would have come in from 64 world units to 16, which is a
 * different world, not a more finely sampled one. Stated per world unit, the
 * tread stays exactly one world unit wide and is now sampled by four cells
 * instead of one — the whole visible point of the re-sample, and the reason
 * the mush described above cannot happen at any sampling density.
 *
 * WHY ONE CELL AND NOT TWO (the old ratio), measured on the island fixture,
 * fully explored 512² world, at BAND_HEIGHT 16:
 *
 *   MAX_STEP  tread    max mountain    world triangles   vertex buffers
 *   ────────────────────────────────────────────────────────────────────
 *      8      2 cells  128-cell radius     1.81 M           297 MB
 *     16      1 cell    64-cell radius     4.09 M           673 MB
 *     32      ½ cell    32-cell radius     8.50 M         1,431 MB
 *
 * Two cells per band (MAX_STEP 8) is the cheapest and keeps the old tread
 * width, but it halves the slope again: every hill would sprawl four times
 * wider than today's for the same height, which is a different world, not a
 * finer one. Half a cell (32) keeps today's hills exactly but puts two band
 * contours inside every cell of a steep face — the mush described above, at
 * double the geometry. One cell is the middle the owner chose (2026-08-20):
 * hills spread twice as wide as they used to, and a full MAX_HEIGHT mountain's
 * foot moves from 32 to 64 cells out, still comfortable in a 512² world and
 * reachable in a 128² one.
 *
 * READING THAT TABLE AFTER THE 2026-08-21 RE-SAMPLE: its rows were measured
 * when a cell WAS a world unit, so read every "cell" in it as a world unit and
 * the choice it records is unchanged — one band per world unit, a 64-world-
 * unit mountain foot. The triangle and memory columns are the ones the
 * re-sample moves (a band contour is four times as long in cells), and they
 * are re-measured where they are enforced rather than restated here: see
 * client/src/terrain/capEmission.ts's CHUNK_TRIANGLE_BUDGET table.
 */
export const MAX_STEP = BAND_HEIGHT / WORLD_UNIT_CELLS;

/**
 * The odd height unit relaxation is allowed to LEAVE STANDING in a pair, in
 * height units. A neighbour pair is relaxed only when it exceeds
 * `MAX_STEP + RELAX_SLACK`, so a pair sitting one unit over the gradient limit
 * is at rest and the world's true steepest legal slope is MAX_STEP + 1 per
 * cell rather than MAX_STEP. Every reader of the gradient invariant must
 * allow it (shared/test/heightmap.test.ts's expectGradientLimitHolds).
 *
 * WHY IT EXISTS — issue #108, and it is the price of conservation, not a
 * tolerance for sloppiness. Relaxation splits a pair's excess `e` EXACTLY in
 * half (`drop = rise = e >> 1`): the high cell loses precisely what the low
 * cell gains, so the map's total height is unchanged by a pass. The previous
 * rule gave the low cell `e - (e >> 1)`, one unit more than the high cell lost
 * whenever `e` was odd, and since relaxation is closed over the map that unit
 * came from NOWHERE — measured at 1,666,592 units manufactured by one bare
 * smooth of a 401-unit cliff on a 128² map, 50.7% of the map's total.
 *
 * WHY IT IS EXACTLY 1, and why the trigger and not just the arithmetic had to
 * move: an even split of an excess of 1 gives both sides zero, and a pair that
 * cannot move must not be treated as movable or the sweep never reports a
 * clean pass and spins to SMOOTH_PASS_LIMIT (measured: it does). Excluding
 * `e === 1` from the trigger makes `e >= 2` for every pair the sweep touches,
 * so both sides always move at least 1 — every counted move is real progress
 * and termination is provable rather than hoped for. 1 is the smallest slack
 * with that property, and the largest that is invisible: it is a quarter of
 * MAX_STEP and 1/16 of a terrace band, well inside one band contour.
 *
 * REJECTED ALTERNATIVES: give the odd unit to the HIGH side instead
 * (`drop = e - (e >> 1)`) — that makes the map a height SINK, destroying
 * ground on every odd pair, which is the same defect with the sign flipped;
 * alternate the parity by pass or by cell index — conserves only on average,
 * which is not conservation, and makes the result depend on sweep bookkeeping
 * the determinism contract would then have to pin; carry the remainder in a
 * ledger cell — exact, but it makes the map's height depend on invisible
 * state and is unreadable.
 */
export const RELAX_SLACK = 1;

/**
 * Height units applied at the brush center by one sculpt intent: exactly one
 * terrace band per click, so each sculpt visibly pops a terrace — the core
 * interaction. Server config may override; plugins may modify per-intent.
 *
 * A CLICK GOT FOUR TIMES FINER on 2026-08-20, for free, because it is stated
 * against BAND_HEIGHT rather than in units: one click moves 16 units where it
 * used to move 64. That is the owner's ask ("the click would go by layer, so
 * we would want a finer click as well") and it is the same rule as before —
 * one click, one terrace — but it does mean reaching a given height takes four
 * times the clicks. Digging from sea level to the world floor is now ~96 held
 * clicks (≈12 s on the hold-repeat ramp) against ~24 before. The knob if that
 * proves tedious is this constant or client config.ts's ramp, NOT the strata
 * depths: making the world shallower to shorten the dig would trade a fact of
 * the world for a fact about the input device.
 */
export const DEFAULT_SCULPT_AMOUNT = BAND_HEIGHT;

/**
 * Brush radius bounds, in cells. Decided 2026-08-13 (open question 2): radius
 * brush with linear falloff, from the point brush up to a widest brush that
 * caps the blast area so a single intent's diff stays small on the wire.
 *
 * THE TWO BOUNDS ANSWER DIFFERENT QUESTIONS (2026-08-21), which is why only
 * one of them moved with the re-sample:
 *
 *   * the FLOOR is a fact about the GRID — one cell is the smallest footprint
 *   that can be expressed at all, whatever a cell is worth — so it stays a
 *   literal 1 and simply got four times finer. It is no longer the "Populous
 *   point brush" of the original decision, though: that brush is a WORLD-space
 *   idea (one unit of ground) and now lives in the player-facing ladder, at
 *   client/src/state/hudState.ts's BRUSH_RADII. Everything from this floor up
 *   to that ladder's first rung is a legal, finer tool that no shipped UI
 *   offers, and a sub-world-unit one behaves accordingly: a click is
 *   DEFAULT_SCULPT_AMOUNT = one band, the world may not fall faster than one
 *   band per world unit (MAX_STEP), so relaxation immediately spreads a
 *   one-cell peak's excess and the cell settles inside band 0 — a polish, not
 *   a terrace. That is the world being consistent, not the brush being broken.
 *   * the CEILING is a fact about the GROUND — "this much land per stroke" —
 *   so it is stated in world units and converted. Left at 4 CELLS the widest
 *   brush would have shrunk to a single world unit and quietly become the old
 *   medium one.
 *
 * WHAT THE CEILING COSTS ON THE WIRE, stated because it was originally chosen
 * for exactly this reason: the same disc of ground is now sampled by ~720
 * cells rather than ~45. At the intent floor of one per server tick that is a
 * few KB per tick for a player holding the widest brush — still bounded and
 * still per-player, but sixteen times what open question 2 sized. The knob if
 * it bites is this ceiling, not the sampling density.
 */
export const MIN_BRUSH_RADIUS = 1;
export const MAX_BRUSH_RADIUS = 4 * WORLD_UNIT_CELLS;


/**
 * How far excess can travel from one edit: relaxation stops where the slope
 * everywhere respects MAX_STEP, so the full height range laid out at maximum
 * slope spans (MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP = 160 cells (80 before the
 * 2026-08-20 re-terrace halved MAX_STEP, 64 before Deep Strata widened the
 * range; the budget scales with both). Math.floor guards the value against a
 * future range/step change that stops dividing exactly (today's division is
 * exact).
 *
 * WHAT THE DOUBLING DOES AND DOES NOT COST. This is the worst case — a single
 * stroke laid against the full 2560-unit range — not the common one. A PLAYER
 * click got cheaper, not dearer: DEFAULT_SCULPT_AMOUNT is BAND_HEIGHT and
 * MAX_STEP is BAND_HEIGHT per WORLD UNIT, so one click's excess spills exactly
 * one WORLD UNIT, where the old 64-against-32 pair spilled two.
 *
 * CORRECTED 2026-08-29 (#108): this paragraph used to say the two constants
 * "are both BAND_HEIGHT now", which stopped being true at the 2026-08-21
 * re-sample — DEFAULT_SCULPT_AMOUNT is 16 and MAX_STEP is 4. The DISTANCE the
 * claim was making a point about is unchanged, which is why the error was
 * invisible: a click spills one world unit either way, and that world unit is
 * four cells now. The ratio DEFAULT_SCULPT_AMOUNT = MAX_STEP * WORLD_UNIT_CELLS
 * is its own settled decision (see MAX_STEP above); only the wording moved.
 *
 * FOUR TIMES THE CELLS, THE SAME DISTANCE (2026-08-21). MAX_STEP is a slope
 * per world unit, so spread went 160 to 640 CELLS while staying 160 world
 * units: excess travels exactly as far across the ground as it did, and it is
 * only counted more finely. One click still spills one world unit — four cells
 * now — because DEFAULT_SCULPT_AMOUNT is a band and a band is MAX_STEP per
 * world unit.
 *
 * THE WORST CASE IS THE ONE TO WATCH. smooth() expands its window one ring per
 * pass and the pass budget below scales with this number, so the ceiling on a
 * single pathological stroke goes as the cube of the sampling density: ~64×
 * the old bound. It is a BOUND, not a cost — the loop exits the pass it stops
 * changing anything, and every ordinary stroke exits in a handful of passes —
 * but a server that ever reaches it now spends far longer there.
 */
export const SMOOTH_SPREAD_CELLS = Math.floor((MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP);

/**
 * Relaxation passes budgeted per cell of spread. One pass per cell is NOT
 * enough (#12): each relaxation moves only half the excess, and the row-major
 * sweep propagates against the sweep direction (-x/-y) at one cell per pass,
 * so real cascades need a small multiple of the travel distance.
 *
 * RE-MEASURED 2026-08-29 FOR THE CONSERVING SPLIT (issue #108), and it stays 4.
 * The whole per-cell figure moved, so the derivation is restated rather than
 * patched. Passes actually taken, over the spread the fixture's own relief pays
 * for (relief / MAX_STEP), old rule vs new (.sim-108/passes.mjs):
 *
 *   fixture                                   old    new
 *   15-band stamp plateau, one smooth stroke  0.54   0.43   ← player-constructible
 *   MAX plateau, brush fully clamped          0.53   0.42   ← player-constructible
 *   MAX plateau beside a MIN moat             0.37   0.37   ← player-constructible
 *   bare 100-unit cliff (synthetic)           2.12   3.04
 *   bare 401-unit cliff (synthetic)           3.00  11.87
 *   bare 1000-unit cliff (synthetic)          3.36  10.24  ← truncated at the cap
 *
 * THE OLD "~2.2 PASSES PER CELL" WAS THE SYNTHETIC ROW, NOT THE PLAYER ONE.
 * Every stroke a player can actually make still converges in under half a pass
 * per cell of spread — FEWER passes than under the old rule, because the
 * manufactured unit the old rule handed the low cell of every odd pair was
 * itself a fresh excess for the next pass to push further out. What got dearer
 * is the synthetic case: a bare sheer cliff has to walk every unit of its ramp
 * down off the plateau now instead of having the fill invented under it, and at
 * 401 units that is 11.9 passes per cell.
 *
 * SO 4 IS NO LONGER "double the measured worst case" — it is roughly nine times
 * the worst PLAYER-CONSTRUCTIBLE case and about a third of what a 401-unit
 * synthetic cliff wants. That is deliberate and is the owner's call (2026-08-29,
 * recorded on SMOOTH_PASS_LIMIT below): this factor is the SERVER'S CPU BOUND
 * per intent, not a promise that every conceivable fixture converges. Keeping
 * it at 4 keeps SMOOTH_PASS_LIMIT at 2560, i.e. keeps the worst-case cost of a
 * single intent exactly where it has been; raising it to cover a legacy sheer
 * cliff would raise that cost for every world. The stress tests in
 * shared/test/heightmap.test.ts pin both halves: the player cascades converge
 * far under the cap, and the 1000-unit cliff truncates AT it.
 */
export const SMOOTH_PASSES_PER_SPREAD_CELL = 4;

/**
 * Safety bound on smoothing passes. The relaxation loop exits as soon as a
 * pass changes nothing; this cap bounds the authoritative server's CPU per
 * intent. It is sized so every single-stroke cascade a player can construct
 * converges first (see SMOOTH_PASSES_PER_SPREAD_CELL); if it is ever hit the
 * gradient invariant may be locally violated until a later edit resumes
 * relaxation — deterministic on both sides, and `smooth` reports its pass
 * count so callers can observe a truncated cascade.
 *
 * BANDED SPILL NOTE (issue #26, measured 2026-08-19): the per-spread-cell
 * budget above was measured on the FREE relaxation path. Banded containment
 * shifts the worst cases without breaking the budget: on legal (invariant-
 * satisfying) maps the banded worst case observed runs ~2.3× the free path's
 * passes (83 vs 36) — still well under the cap — while the worst
 * PLAYER-CONSTRUCTIBLE cascades converge far faster banded than free (9 vs 67
 * passes), because the band caps stop the excess from travelling. The #12
 * stress tests pin both modes.
 *
 * IT STAYS 2560 UNDER THE CONSERVING SPLIT — OWNER DECISION, 2026-08-29 (issue
 * #108), with the residual named rather than fixed. Conservation costs passes
 * on SHEER ground: the fill on the low side of a cliff is no longer invented,
 * so every unit of the ramp has to be walked down off the plateau. Measured by
 * bisection on a bare cliff over 128² (.sim-108/passes.mjs's truncation-
 * threshold section, output in .sim-108/passes.txt), the smallest wall
 * that no longer converges inside this cap is 593 height units — a 592-unit
 * cliff finishes in 2,524 passes and a 593-unit one is truncated at 2,560. A
 * 1000-unit cliff wants ~7,205 (.sim-108/results.txt).
 *
 * WHAT A TRUNCATED SWEEP LEAVES: the gradient invariant locally violated, with
 * a measured worst local gradient of 6 at the 593-unit threshold and 7 at 1000
 * units, against the MAX_STEP + RELAX_SLACK of 5 it guarantees elsewhere. It is
 * deterministic on both sides (client and server truncate identically), it is
 * visible — `smooth` returns its pass count, and a count equal to this cap
 * means exactly this — and it is repaired incrementally: the next smooth stroke
 * over that ground resumes the cascade where the last one stopped.
 *
 * WHY THE CAP DID NOT MOVE ANYWAY. Nothing a PLAYER can construct reaches it:
 * the worst player-constructible strokes converge in 108-118 passes, 4% of the
 * cap (see the table on SMOOTH_PASSES_PER_SPREAD_CELL). A 600-unit sheer wall
 * is roughly 37 stamped bands with no tread between them — a legacy or
 * synthetic world, not a stroke. Raising the cap would raise the worst-case
 * cost of EVERY intent on EVERY world to buy convergence on those; the cost of
 * leaving it is that a legacy over-steep world re-grades over several strokes
 * instead of one. The other price is time on such a world: a relic cast landing
 * on genesis-steep ground was measured at 888 ms before the split and 1,271 ms
 * after (issue #108's review, 2026-08-30 — roughly 2× the genesis-cast cost,
 * not re-measured here).
 */
export const SMOOTH_PASS_LIMIT = SMOOTH_SPREAD_CELLS * SMOOTH_PASSES_PER_SPREAD_CELL;

/**
 * How close, in CELL units, a contour may come to a cell centre.
 *
 * This is the honesty guard, enforced in the CLIENT (terrain/contours.ts's
 * crossingFraction and terrain/contourSmoothing.ts) and re-exported from there
 * for its original readers. It lives HERE because it is also read on the
 * SERVER: it bounds how far a terrace lip can cut into a cell, and therefore
 * how much flat tread a model standing at a cell centre can rely on — the
 * question shared/src/farmland.ts's isFarmlandPlot exists to answer.
 *
 * A cell centre is the fixed point of picking.ts's Math.round(). A cell centre is the fixed point of picking.ts's
 * Math.round(), so whichever caps cover it decide what the player sees AND
 * clicks at that cell. Marching squares can already only cross the edges
 * BETWEEN samples, but a raw crossing can land arbitrarily close to one end of
 * an edge, and two Chaikin passes could then round the outline across it. Every
 * crossing is therefore clamped into the middle [1/8, 7/8] of its edge, and
 * every smoothed vertex is pushed back out of the disc of this radius around
 * its nearest cell centre.
 *
 * 1/8 of a cell: large enough that the guarantee survives the smoothing passes
 * with room to spare (a Chaikin vertex is a convex combination of two vertices
 * of the polyline it smooths, so it can only ever move ALONG the outline, never
 * outward past it), small enough that it never becomes the thing that decides
 * where an outline goes — a 1/8-cell clamp only fires on samples within a few
 * height units of a band boundary, which is where the outline's exact position
 * is meaningless anyway. It is a negative power of two, so it is exact in
 * binary and identical on every platform.
 */
export const CONTOUR_CELL_CENTRE_GUARD = 1 / 8;

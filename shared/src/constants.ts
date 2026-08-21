// Terrain constants — the feel-critical numbers, all named, all justified.
//
// DETERMINISM CONTRACT: everything in shared/ must produce identical results on
// server and client from identical inputs (client-side prediction reconciles
// against the server's authoritative diff — any divergence shows up as visible
// snapping). All terrain math is integer-only, or uses exactly-specified IEEE
// operations (Math.sqrt) immediately floored to an integer.

/**
 * Default cells per world edge. 512² Int16 = 512 KB, allocated up front, never
 * resized. Server config (`WORLD_SIZE`) may override; 128 is the
 * Populous-proven playable minimum for small self-hosted boxes.
 */
export const DEFAULT_WORLD_SIZE = 512;

/**
 * Cells per chunk edge (chunks are square). Decided 2026-08-13 (design doc
 * open question 5): 16×16 = 512 B of Int16 per chunk — fine-grained reveal at
 * both 128² (64 chunks) and 512² (1024 chunks) world sizes. WORLD_SIZE must be
 * a multiple of this.
 */
export const CHUNK_SIZE = 16;

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
 * Gradient limit: maximum allowed height difference between 4-neighbors.
 * THE feel-critical number — this is what makes edits "flow" outward
 * (Populous's signature).
 *
 * DERIVED FROM BAND_HEIGHT, NOT STATED AGAINST IT (2026-08-20). It was the
 * literal 32 next to a BAND_HEIGHT of 64, with the ratio explained only in
 * this comment; the ratio is the whole meaning of the number, so it is now
 * the code. One BAND_HEIGHT per cell of run means a terrace tread is one cell
 * wide at the steepest the world may be, which is the finest terrace that can
 * still be seen as a terrace: at a tread narrower than the cell grid the
 * contours of neighbouring bands crowd inside a single cell and the staircase
 * dissolves into a ramp.
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
 */
export const MAX_STEP = BAND_HEIGHT;

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
 * Brush radius bounds (cells). Decided 2026-08-13 (open question 2): radius
 * brush with linear falloff; radius 1 is the Populous point brush. 4 caps the
 * blast area (~45 cells) so a single intent's diff stays small on the wire.
 */
export const MIN_BRUSH_RADIUS = 1;
export const MAX_BRUSH_RADIUS = 4;

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
 * click got cheaper, not dearer: DEFAULT_SCULPT_AMOUNT and MAX_STEP are both
 * BAND_HEIGHT now, so one click's excess spills exactly one cell, where the
 * old 64-against-32 pair spilled two.
 */
export const SMOOTH_SPREAD_CELLS = Math.floor((MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP);

/**
 * Relaxation passes budgeted per cell of spread. One pass per cell is NOT
 * enough (#12): each relaxation moves only half the excess, and the row-major
 * sweep propagates against the sweep direction (-x/-y) at one cell per pass,
 * so real cascades need a small multiple of the travel distance. Measured on
 * the worst player-constructible single strokes (a MAX_HEIGHT stamp plateau
 * smoothed in one stroke; the same plateau beside a MIN_HEIGHT moat): ~2.2
 * passes per cell of spread. 4 doubles the measured worst case; the stress
 * tests in shared/test/heightmap.test.ts pin that the budget converges there.
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
 */
export const SMOOTH_PASS_LIMIT = SMOOTH_SPREAD_CELLS * SMOOTH_PASSES_PER_SPREAD_CELL;

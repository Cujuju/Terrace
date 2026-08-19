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
 * Height units per terrace band. Decided 2026-08-13 (open question 1),
 * PROVISIONAL feel-tuning value: with the ±1024 sculpt range this gives 16
 * bands above sea level — chunky enough to read as Godus-style terraces.
 * Tune in Phase 2 with real rendering; nothing structural depends on it.
 */
export const BAND_HEIGHT = 64;

/**
 * Heights at or below this are water (static sea — decided 2026-08-13, open
 * question 3: water is a derived fact of the heightmap, never simulated
 * state; waves/shimmer are client-side visuals only).
 */
export const SEA_LEVEL = 0;

/**
 * Sculptable height range. Int16 storage allows ±32767; we deliberately cap
 * far below that: 1024 = 16 bands of relief above sea (and the same depth
 * below), which keeps mountains readable and bounds the smoothing cascade
 * (see SMOOTH_PASS_LIMIT). Brush edits clamp to this range.
 */
export const MAX_HEIGHT = 1024;
export const MIN_HEIGHT = -1024;

/**
 * Gradient limit: maximum allowed height difference between 4-neighbors.
 * THE feel-critical number — this is what makes edits "flow" outward
 * (Populous's signature). BAND_HEIGHT/2 means one terrace band spans at least
 * two cells of slope, so cliffs are never single-cell walls, and a full
 * MAX_HEIGHT mountain has a footprint radius of 1024/32 = 32 cells — fits
 * comfortably even in a 128² world. PROVISIONAL: feel-tune in Phase 2.
 */
export const MAX_STEP = 32;

/**
 * Height units applied at the brush center by one sculpt intent: exactly one
 * terrace band per click, so each sculpt visibly pops a terrace — the core
 * interaction. Server config may override; plugins may modify per-intent.
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
 * slope spans (MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP = 64 cells. Math.floor
 * guards the value against a future range/step change that stops dividing
 * exactly (today's division is exact).
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

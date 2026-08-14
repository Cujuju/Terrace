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
 * Safety bound on smoothing passes. The relaxation loop exits as soon as a
 * pass changes nothing; this cap only guards against a pathological cascade.
 * Worst realistic spread of one edit is the full height range at maximum
 * slope: (MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP = 64 cells — one pass per cell
 * of travel. If a pass ever hits this cap the invariant "no step exceeds
 * MAX_STEP" may be locally violated until the next edit resumes relaxation.
 */
export const SMOOTH_PASS_LIMIT = (MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP;

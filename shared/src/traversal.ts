// TRAVERSAL — the one predicate for "may a walker stand here / cross here",
// shared by every plugin that moves something across the heightmap on foot or
// through water (wildlife's grazers/fish/whales, pilgrims' pilgrims and
// wanderers, and whatever walks next).
//
// ROOT CAUSE THIS FIXES (2026-08-19, owner report on pilgrims + wildlife
// parity): two plugins each grew their own answer to "can this thing be here
// / go there" — wildlife's canTraverse (species.ts + census.ts) got a
// gradient-aware fix earlier the same day; pilgrims' isWalkableCell still
// tested only `heightAt > SEA_LEVEL`, the exact rule wildlife shipped with
// BEFORE its fix, because pilgrims' own doc comment says so. Two independent
// copies of terrain math is exactly how one drifted behind the other, and a
// third caller would drift the same way. This file is the contract layer:
// the predicate lives here ONCE, and every walker plugin adapts a
// WalkerProfile onto it instead of re-deriving the maths.
//
// DETERMINISM CONTRACT (same as every other file in shared/): integer-only
// except heightAt itself (already Int16 in the authoritative heightmap), no
// wall clock, no RNG, fixed iteration order. Two callers running this against
// the same heights get byte-identical answers.

import { BAND_HEIGHT, SEA_LEVEL } from './constants.ts';

// ─────────────────────────────────────────────────────────────────────────────
// The world, as this file needs to read it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimal shape a caller must expose. Deliberately NOT the concrete
 * `Heightmap` from heightmap.ts: every plugin already reads terrain through
 * its own narrow view of the server's WorldApi (wildlife's `HabitatWorld`,
 * pilgrims' `PilgrimWorld`), and both already declare `worldSize` and
 * `heightAt(x, y)` with this exact shape — so those interfaces satisfy
 * `TerrainSampler` structurally, with no adapter object to construct.
 */
export interface TerrainSampler {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ground classification — moved from wildlife/server/species.ts's `habitatOf`
// (2026-08-14), which read purely from height and owed nothing to wildlife
// specifically. `dry`/`shallow`/`deep` name the same three bands that plugin
// called `land`/`shallow`/`deep`; the renamed `dry` is this file's own word so
// it never reads as a re-statement of wildlife's `Habitat` union, which stays
// a plugin-local type mapped onto this one (species.ts's `habitatOf` is now a
// one-line wrapper).
// ─────────────────────────────────────────────────────────────────────────────

export type TerrainGround = 'dry' | 'shallow' | 'deep';

/**
 * Depth, in terrace bands below sea level, at which water stops being coastal
 * shallows and becomes open sea.
 *
 * Three bands. The gradient limit is MAX_STEP = BAND_HEIGHT/2, so terrain can
 * fall at most half a band per cell: a cell this deep is at least six cells
 * from the nearest shoreline. That is what makes the threshold meaningful
 * rather than arbitrary — "deep" is water something can be IN, not a puddle
 * it would be beached in the middle of.
 */
export const DEEP_WATER_BANDS_BELOW_SEA = 3;

/** Heights at or below this are deep water; above it, up to SEA_LEVEL, shallow. */
export const DEEP_WATER_MAX_HEIGHT = SEA_LEVEL - DEEP_WATER_BANDS_BELOW_SEA * BAND_HEIGHT;

/** Classifies one cell height into dry land / shallow water / deep water. */
export function groundOf(height: number): TerrainGround {
  if (height > SEA_LEVEL) return 'dry';
  return height <= DEEP_WATER_MAX_HEIGHT ? 'deep' : 'shallow';
}

// ─────────────────────────────────────────────────────────────────────────────
// Gradient limits — moved from wildlife/server/species.ts (2026-08-19 gradient
// fix). The reasoning is unchanged; only the names generalise past "grazer"
// and "aquatic" since a land walker that isn't a grazer (pilgrims, wanderers)
// needs the exact same number for the exact same reason.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "No limit at all" for a walker whose ground has no risers — deep or
 * shallow water, where the seabed's steepness never blocks anything that
 * swims. `Number.isFinite` short-circuits every gradient check below to
 * `true` without sampling a height, so a water-ground profile answers the
 * same `maxGradientPerCell` question as a land one and nothing downstream
 * needs a "does this walker care about slope" flag.
 */
export const UNCONSTRAINED_GRADIENT_PER_CELL = Infinity;

/**
 * The standard land-walker gradient limit: the most height a walker on dry
 * ground will climb or descend in ONE CELL of travel before it must turn
 * along the level instead of crossing.
 *
 * Sized against the terrain's OWN gradient cap, not picked independently:
 * MAX_STEP (constants.ts) bounds every 4-neighbor height difference at
 * BAND_HEIGHT/2, so BAND_HEIGHT/2 is the STEEPEST slope that can exist
 * anywhere in the world — anything steeper is not legal terrain. Half of
 * that, BAND_HEIGHT/4 (= MAX_STEP/2), means the steepest HALF of
 * legally-possible slopes are impassable to a walker — a terrace riser reads
 * as a riser — while an ordinary rolling ramp (shallower than a quarter-band
 * per cell) still crosses freely.
 *
 * ONE NUMBER FOR EVERY LAND WALKER, on purpose: wildlife's grazer and
 * pilgrims'/wanderers' human(-ish) walk are both "a legged thing walking on
 * dry ground", and nothing about that judgement is species-specific. Before
 * this file existed each plugin re-derived (or, for pilgrims, forgot to
 * derive) the same number; a future land species reuses this constant rather
 * than re-deriving BAND_HEIGHT/4 a third time.
 */
export const LAND_WALKER_MAX_GRADIENT_PER_CELL = BAND_HEIGHT / 4;

// ─────────────────────────────────────────────────────────────────────────────
// The walker profile and the two predicates every caller adapts onto.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What kind of thing is walking, expressed as the two facts terrain math
 * needs to know about it: what ground it may stand on, and how steep a step
 * it will accept. Everything else about a species (speed, size, habitat
 * population targets, ...) is plugin business and stays out of `shared/`.
 */
export interface WalkerProfile {
  /** Which ground classification this walker may occupy. */
  readonly ground: TerrainGround;
  /**
   * Max |height difference| accepted crossing ONE CELL of travel.
   * UNCONSTRAINED_GRADIENT_PER_CELL (Infinity) for a walker whose ground has
   * no risers (water); LAND_WALKER_MAX_GRADIENT_PER_CELL for one that walks
   * dry ground.
   */
  readonly maxGradientPerCell: number;
}

/**
 * Is this single cell somewhere `profile` may stand? Bounds and ground class
 * only — no "from" cell, so no gradient term (see `canTraverseSegment` for
 * the predicate that has one). Used for standalone cell queries: a goal cell,
 * a spawn candidate, a viewpoint candidate.
 */
export function isWalkableCell(
  world: TerrainSampler,
  profile: WalkerProfile,
  x: number,
  y: number,
): boolean {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= world.worldSize || cy >= world.worldSize) return false;
  return groundOf(world.heightAt(cx, cy)) === profile.ground;
}

/**
 * Can `profile` walk in a straight line from (fromX, fromY) to (toX, toY)
 * without crossing a slope steeper than its own `maxGradientPerCell`?
 *
 * SAMPLES ALONG THE WHOLE SEGMENT, not just the two endpoints. An
 * endpoint-only check could step from one terrace level, over a riser, to a
 * DIFFERENT terrace level that happens to sit within limit of the far side —
 * invisible to it, since the two endpoints can be similarly high while the
 * ground between them drops away in a cliff. Steps are spaced ~1 cell apart
 * (`Math.ceil` of the segment length), matching `heightAt`'s own
 * grain, so no riser narrower than a full cell can hide between two
 * consecutive samples.
 *
 * Ground legality of the endpoints is NOT this function's job — callers that
 * need it call `isWalkableCell` too (see `isWalkableCell`'s own doc). This
 * function answers exactly one question: is the SLOPE crossable.
 */
export function canTraverseSegment(
  world: TerrainSampler,
  profile: WalkerProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const limit = profile.maxGradientPerCell;
  if (!Number.isFinite(limit)) return true; // water-ground: no risers to cross.

  const dx = toX - fromX;
  const dy = toY - fromY;
  // Math.sqrt, NOT Math.hypot, and the result is consumed by Math.ceil on the
  // very next line. This is the determinism rule in CLAUDE.md being obeyed to
  // the letter, and it is load-bearing now that this predicate lives in
  // shared/ and BOTH sides run it: ECMA-262 specifies Math.sqrt as IEEE-754
  // correctly-rounded, but leaves Math.hypot implementation-approximated — it
  // is explicitly allowed to differ between engines and versions. One ULP of
  // disagreement either side of an integer flips `steps`, which moves every
  // sample position, which can flip this function's verdict; server and client
  // would then disagree about whether a walker may cross a slope. Harmless
  // while this code was server-only (it came from plugins/wildlife); a real
  // divergence risk the moment it moved here.
  const distance = Math.sqrt(dx * dx + dy * dy);
  // At least one step even for a same-cell probe; otherwise ~1 sample per
  // cell of travel, per the "no riser can hide between samples" argument above.
  const steps = Math.max(1, Math.ceil(distance));

  let previousHeight = world.heightAt(Math.floor(fromX), Math.floor(fromY));
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const sampleX = Math.floor(fromX + dx * t);
    const sampleY = Math.floor(fromY + dy * t);
    const height = world.heightAt(sampleX, sampleY);
    if (Math.abs(height - previousHeight) > limit) return false;
    previousHeight = height;
  }
  return true;
}

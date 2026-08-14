// The active skills' terrain effects, as data.
//
// WHAT THE REAL PIPELINE ACCEPTS (verified against shared/src/heightmap.ts and
// server/src/plugins/world-api.ts, not assumed):
//
//   * WorldApi.sculpt does NOT clamp anything. It goes straight to the shared
//     applySculpt → applyBrush, which THROWS a RangeError on a radius outside
//     [MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS], on a non-integer radius or amount,
//     and on an out-of-bounds centre. A plugin that passes radius 12 to make a
//     big crater does not get a big crater; it gets a stack trace, swallowed by
//     the host's `safely` wrapper, and a skill that silently never works.
//   * So a cast bigger than one brush is COMPOSED: several MAX_BRUSH_RADIUS
//     sculpts at offset centres. That is the only way to exceed the brush cap,
//     and it is also more controllable — the rim of a crater can be shallower
//     than its core, which a single wider brush could not express.
//   * `amount` is not capped, only required to be an integer; the resulting
//     heights clamp to [MIN_HEIGHT, MAX_HEIGHT] inside the brush. Amounts here
//     are whole multiples of BAND_HEIGHT so a cast moves a countable number of
//     terrace bands, exactly like a hand sculpt moves one.
//   * Gradient relaxation runs after every one of these sculpts and spreads the
//     result far past the brush footprint (MAX_STEP is 32, so a 6-band = 384
//     unit centre reaches roughly 12 further cells). The footprints below are
//     therefore the *edit*, not the *result* — the visible crater is much wider
//     than the offsets suggest, which is the Populous flow-outward feel and the
//     reason these numbers look small.

import { BAND_HEIGHT, MAX_BRUSH_RADIUS } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import type { SkillId } from '../protocol.ts';

/** One brush application, positioned relative to the cast's target cell. */
export interface TerraformStep {
  readonly dx: number;
  readonly dy: number;
  readonly radius: number;
  /** Height units, signed. Always a whole number of terrace bands. */
  readonly amount: number;
}

/**
 * Distance from the target at which the rim/shore brushes sit.
 *
 * Equal to MAX_BRUSH_RADIUS so the rim brushes begin exactly where the centre
 * brush's influence ends: the centre brush at radius R touches cells out to
 * R-1, so a rim centred at R leaves no untouched ring between the two and no
 * wasteful overlap at the centre either. Derived from the shared constant so
 * the shapes stay correct if the brush cap is ever retuned.
 */
export const TERRAFORM_RING_OFFSET = MAX_BRUSH_RADIUS;

/** The four cardinal rim positions, in fixed order (determinism, and tests). */
const RING_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-TERRAFORM_RING_OFFSET, 0],
  [TERRAFORM_RING_OFFSET, 0],
  [0, -TERRAFORM_RING_OFFSET],
  [0, TERRAFORM_RING_OFFSET],
];

/**
 * Terrace bands a Quake drops at its centre. Six is deliberately deeper than
 * the ±16 band relief a hand sculpt can practically build in one session, so a
 * Quake reads as an event rather than as a fast brush — it will punch a fresh
 * (band 0) shoreline well below sea level and flood it.
 */
export const QUAKE_CORE_DEPTH_BANDS = 6;

/**
 * Bands the Quake's rim drops — half the core, so the hole is a bowl rather
 * than a shaft. Halving is what makes the relaxation cascade outward smoothly
 * instead of leaving a ring of maximum-gradient cliff for the smoother to chew
 * through over the following passes.
 */
export const QUAKE_RIM_DEPTH_BANDS = QUAKE_CORE_DEPTH_BANDS / 2;

/**
 * Bands Genesis raises at its centre. Matched to the Quake's depth on purpose:
 * the two active skills are inverses, and a player who has both should be able
 * to undo one with the other rather than finding that creation is weaker than
 * destruction.
 */
export const GENESIS_PEAK_BANDS = QUAKE_CORE_DEPTH_BANDS;

/**
 * Bands Genesis raises at its shore ring. Lower than the Quake's rim ratio (2
 * of 6 rather than 3 of 6) because an island wants a beach: a shallow ring
 * lands the shoreline near sea level, which is the band that renders as
 * buildable flat land (MVP criterion 4), instead of dropping straight from
 * peak to water.
 */
export const GENESIS_SHORE_BANDS = 2;

function ring(bands: number): TerraformStep[] {
  return RING_OFFSETS.map(([dx, dy]) => ({
    dx,
    dy,
    radius: MAX_BRUSH_RADIUS,
    amount: bands * BAND_HEIGHT,
  }));
}

/** Quake: a deep bowl. Core first, then the rim — fixed order. */
export const QUAKE_STEPS: readonly TerraformStep[] = [
  { dx: 0, dy: 0, radius: MAX_BRUSH_RADIUS, amount: -QUAKE_CORE_DEPTH_BANDS * BAND_HEIGHT },
  ...ring(-QUAKE_RIM_DEPTH_BANDS),
];

/** Genesis: a peak with a beach around it. */
export const GENESIS_STEPS: readonly TerraformStep[] = [
  { dx: 0, dy: 0, radius: MAX_BRUSH_RADIUS, amount: GENESIS_PEAK_BANDS * BAND_HEIGHT },
  ...ring(GENESIS_SHORE_BANDS),
];

/** The shape each active skill casts. Skills absent here are not castable. */
export const TERRAFORM_BY_SKILL: ReadonlyMap<SkillId, readonly TerraformStep[]> = new Map<
  SkillId,
  readonly TerraformStep[]
>([
  ['quake', QUAKE_STEPS],
  ['genesis', GENESIS_STEPS],
]);

/**
 * Applies a composed terraform at a target cell. Returns the number of cells
 * changed across all of its steps (0 means the cast landed somewhere already at
 * the height clamp and did nothing).
 *
 * VALIDATION — CRITICAL. The target has already been checked by the caller
 * (in bounds, unlocked). What is checked HERE is each offset step's own centre,
 * because an offset can push a perfectly legal target off the edge of the map,
 * and applyBrush throws on that rather than clamping. Such a step is SKIPPED,
 * not clamped inward: sliding it back would silently deepen the crater on the
 * map-edge side, and a cast near the border being slightly lopsided is a better
 * answer than one that is secretly stronger.
 *
 * Offsets are NOT mask-checked. That matches the core intent pipeline exactly
 * (server/src/intent/pipeline.ts step 2: only the brush CENTRE is checked, and
 * the relaxation spill into locked chunks is real but is filtered off the wire
 * by sculpt-service). Plugin sculpts run through that same service, so nothing
 * about locked terrain leaks here either.
 */
export function applyTerraform(
  world: WorldApi,
  x: number,
  y: number,
  steps: readonly TerraformStep[],
): number {
  const size = world.worldSize;
  let changed = 0;

  for (const step of steps) {
    const cx = x + step.dx;
    const cy = y + step.dy;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
    changed += world.sculpt(cx, cy, step.radius, step.amount).length;
  }

  return changed;
}

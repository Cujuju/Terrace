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
 * buildable flat land, instead of dropping straight from
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

/**
 * A cast, as the plugin's own contract: what it will cost, and how it chooses
 * its steps.
 *
 * WHY A PLAN AND NOT A LIST (2026-09-05). Quake and Genesis are fixed shapes
 * — the same bowl wherever you put it — so a `readonly TerraformStep[]` said
 * everything about them. Landslide is not: it has to find the cliff face at
 * the target before it knows which way to topple it, and a shape that reads
 * the ground cannot be a constant. Making every cast a plan (a constant one
 * for the fixed shapes, via `fixedTerraform`) keeps ONE contract for the caller
 * instead of two code paths, one per kind of skill.
 */
export interface TerraformSpec {
  /**
   * Terrace bands the strongest step of this cast can move.
   *
   * PRICES THE COOLDOWN (server/index.ts), so it must be knowable BEFORE a
   * target is chosen: the HUD shows a skill's cooldown while it is still
   * cooling down, with no cell in mind. A shape that plans itself therefore
   * declares its CEILING here rather than what one cast happened to use — a
   * cooldown that changed with the cursor would be unreadable, and a cast that
   * priced itself after the fact could be made free by aiming at flat ground.
   */
  readonly peakBands: number;

  /**
   * The steps for a cast at (x, y).
   *
   * READ-ONLY on the world. It runs before the first sculpt of the cast, so
   * everything it reads still describes the ground the steps were chosen for;
   * a plan that sculpted as it planned would be reading its own edits.
   *
   * NO STEPS MEANS "NOT HERE" — the ground is legal but is not what this skill
   * needs. The caller refuses the cast on CAST_DENIED_UNSUITABLE and charges no
   * cooldown, rather than running an empty cast that looks like a bug.
   */
  plan(world: WorldApi, x: number, y: number): readonly TerraformStep[];
}

/**
 * The bands a step list moves at its strongest step.
 *
 * THE STRONGEST STEP, NOT THE CENTRE ONE (2026-09-05). Cooldowns used to be
 * priced from the step at offset (0,0), which was the deepest one in both
 * shapes that existed. Bulwark has no centre step at all — that hole is the
 * whole point of it — so the old rule priced it at zero bands, i.e. free and
 * instantly repeatable. The peak is the same number for Quake and Genesis
 * (their centres ARE their strongest steps) and is defined for every shape,
 * including one that does not touch its own target cell.
 */
function peakBandsOf(steps: readonly TerraformStep[]): number {
  return Math.max(...steps.map((step) => Math.abs(step.amount))) / BAND_HEIGHT;
}

/** A cast whose shape is the same wherever it lands. */
export function fixedTerraform(steps: readonly TerraformStep[]): TerraformSpec {
  return { peakBands: peakBandsOf(steps), plan: () => steps };
}

// ────────────────────────────────────────────────────────────────────────────
// Bulwark — a ring wall with nothing in the middle
// ────────────────────────────────────────────────────────────────────────────

/**
 * Bands the wall stands proud of the ground it is raised from.
 *
 * Half of Quake's depth: high enough that the ring reads as a wall and cannot
 * be walked over, low enough that it is a fortification rather than a mountain
 * range, and — being half — it prices at half a Quake's cooldown, which is the
 * relationship the two events should have.
 */
export const BULWARK_WALL_BANDS = QUAKE_CORE_DEPTH_BANDS / 2;

/**
 * Distance from the target to the wall.
 *
 * TWICE the ring offset the bowls use, because those rings exist to blend into
 * a centre brush and this one exists to enclose empty ground: at radius 2R with
 * brushes of radius R, the interior clear of every footprint is a disc of about
 * R cells — a courtyard you can put something in, which is the entire
 * difference between this cast and a crater rim.
 */
export const BULWARK_RING_RADIUS = 2 * TERRAFORM_RING_OFFSET;

/**
 * Brushes around the wall.
 *
 * EIGHT, and the number is load-bearing rather than aesthetic: adjacent centres
 * on a ring of radius 2R sit 2·2R·sin(π/8) ≈ 1.53R apart, and two brushes of
 * radius R stop overlapping at 2R apart — so eight is the smallest count whose
 * footprints still meet, and the wall is therefore CLOSED. Four (the cardinals
 * the bowls use) would sit 2.83R apart and leave four diagonal gates in it.
 */
export const BULWARK_SEGMENTS = 8;

const FULL_TURN = Math.PI * 2;

/**
 * The ring, as whole-cell offsets.
 *
 * Rounded to integers because a brush centre must be one (applyBrush throws
 * otherwise). Rounding moves a centre by at most half a cell, far inside the
 * 0.47R of overlap the eight-segment spacing leaves, so the wall stays closed.
 */
export const BULWARK_STEPS: readonly TerraformStep[] = Array.from(
  { length: BULWARK_SEGMENTS },
  (_unused, index) => {
    const bearing = (index / BULWARK_SEGMENTS) * FULL_TURN;
    return {
      dx: Math.round(Math.cos(bearing) * BULWARK_RING_RADIUS),
      dy: Math.round(Math.sin(bearing) * BULWARK_RING_RADIUS),
      radius: MAX_BRUSH_RADIUS,
      amount: BULWARK_WALL_BANDS * BAND_HEIGHT,
    };
  },
);

// ────────────────────────────────────────────────────────────────────────────
// Landslide — the first cast that reads the ground before it writes
// ────────────────────────────────────────────────────────────────────────────

/**
 * The share of a cliff face one Landslide takes: a half.
 *
 * A half rather than the whole face because the cast should turn a wall into a
 * slope, not into flat ground — and because a player who wants the rest can
 * cast again, which is a better answer than one cast that deletes the cliff.
 * The same halving then governs the ramp: each step out lays down half of what
 * the step before it did, which is what makes the pile read as talus.
 */
export const LANDSLIDE_HALVING = 2;

/**
 * The smallest face worth toppling, in bands.
 *
 * DERIVED, not picked: the cast takes half the face, and the ramp lays down
 * half of that, so a face of fewer than four bands cannot produce a single
 * ramp step and would lower the lip while building nothing. Below this the
 * cast refuses instead, and the player keeps their cooldown.
 */
export const LANDSLIDE_MIN_FACE_BANDS = LANDSLIDE_HALVING * LANDSLIDE_HALVING;

/**
 * The most one cast takes off a lip, in bands.
 *
 * Under Quake's six: a landslide is a local event that opens a way up a cliff,
 * not a crater. It is also what the cooldown is priced from, so a cast against
 * a 40-band mountain costs exactly what a cast against a 8-band scarp does.
 */
export const LANDSLIDE_MAX_TOPPLE_BANDS = 4;

/**
 * Plans a Landslide: find the steepest cardinal drop from the target, take
 * half of it off the lip, and lay it down the slope in halving steps.
 *
 * MASS IS NOT CONSERVED and is not meant to be — the lip is lowered over a
 * whole brush while the ramp is built from smaller ones, and gradient
 * relaxation moves more ground than either. What the numbers guarantee is the
 * SHAPE: less comes off than the face is deep, and each step out is lower than
 * the one before it, so the result descends.
 *
 * THE PROBE AND THE RAMP USE THE SAME OFFSETS — RING_OFFSETS, one stride of
 * TERRAFORM_RING_OFFSET in each cardinal direction. The cell whose height is
 * read is exactly the cell the first ramp step raises, so the drop the cast
 * measures is the drop the cast fills; probing at one distance and building at
 * another would let it find a cliff and then ramp somewhere else.
 *
 * Ties between two equally steep directions go to the first in RING_OFFSETS'
 * fixed order, which is why that order is fixed.
 */
export function planLandslide(
  world: WorldApi,
  x: number,
  y: number,
): readonly TerraformStep[] {
  const size = world.worldSize;
  const top = world.heightAt(x, y);

  let face: { readonly dx: number; readonly dy: number; readonly drop: number } | null = null;
  for (const [dx, dy] of RING_OFFSETS) {
    const px = x + dx;
    const py = y + dy;
    if (px < 0 || py < 0 || px >= size || py >= size) continue;
    const drop = top - world.heightAt(px, py);
    if (face === null || drop > face.drop) face = { dx, dy, drop };
  }
  if (face === null) return [];

  const faceBands = Math.floor(face.drop / BAND_HEIGHT);
  if (faceBands < LANDSLIDE_MIN_FACE_BANDS) return [];

  const toppleBands = Math.min(
    Math.floor(faceBands / LANDSLIDE_HALVING),
    LANDSLIDE_MAX_TOPPLE_BANDS,
  );

  const steps: TerraformStep[] = [
    { dx: 0, dy: 0, radius: MAX_BRUSH_RADIUS, amount: -toppleBands * BAND_HEIGHT },
  ];
  let bands = Math.floor(toppleBands / LANDSLIDE_HALVING);
  for (let stride = 1; bands >= 1; stride++) {
    steps.push({
      dx: face.dx * stride,
      dy: face.dy * stride,
      radius: MAX_BRUSH_RADIUS,
      amount: bands * BAND_HEIGHT,
    });
    bands = Math.floor(bands / LANDSLIDE_HALVING);
  }
  return steps;
}

/** The cast each active skill runs. Skills absent here are not castable. */
export const TERRAFORM_BY_SKILL: ReadonlyMap<SkillId, TerraformSpec> = new Map<
  SkillId,
  TerraformSpec
>([
  ['quake', fixedTerraform(QUAKE_STEPS)],
  ['genesis', fixedTerraform(GENESIS_STEPS)],
  ['bulwark', fixedTerraform(BULWARK_STEPS)],
  ['landslide', { peakBands: LANDSLIDE_MAX_TOPPLE_BANDS, plan: planLandslide }],
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

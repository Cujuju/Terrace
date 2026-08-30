// STORM SURGE — the one thing in this plugin that touches the ground, and the
// only reason it has a setting of its own.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS BEHIND A SETTING THAT SHIPS OFF.
//
// Everything else a storm does is transient: a funnel passes and the world is
// exactly as it was. A surge is a `sculpt`, and a sculpt is PERMANENT terrain
// the player did not ask for — it goes through the same authoritative path, the
// same relaxation, the same snapshot as a player's own click, and there is no
// undo. Issue #213 already calls surge optional; ../protocol.ts's
// DEFAULT_STORM_SURGE_MODE says why the default is `off`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT DOES: SHALLOW SCOUR, AT THE WATERLINE, UNDER A LANDFALLING CYCLONE.
//
// A cell qualifies only if it is LAND WITH SEA NEXT TO IT — the shoreline, not
// the beach behind it and not the seabed in front of it. The scour is half a
// terrace band, which the relaxation then spreads into the cells around it, so
// one surge lowers the shore by less than a visible step and a storm that sits
// on a coast for its whole landfall takes it down a band or two. That is the
// difference between "the sea took some of the shore" and "a hurricane
// re-terraformed the island", and it is the reason the depth is stated as a
// FRACTION of a band rather than as a height.
//
// TORNADOES DO NOT SURGE. A surge is water driven ashore by a storm that has
// been standing over the sea for hours; a funnel that came out of a cloud over
// a wheat field has no sea to drive. Only cyclones reach here.

import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import type { Storm, StormWorld } from './storms.ts';

/**
 * How deep one surge scours, in HEIGHT UNITS — half a terrace band.
 *
 * Stated as a fraction of BAND_HEIGHT rather than as `8`, because the number
 * that matters is "less than one visible step of terracing": a full band would
 * drop the shoreline a whole terrace at once, which reads as an edit rather
 * than as erosion. If BAND_HEIGHT ever changes, this follows it.
 */
export const SURGE_SCOUR_HEIGHT_UNITS = BAND_HEIGHT / 2;

/**
 * The brush radius one surge is applied with, in cells.
 *
 * FOUR — one world unit (WORLD_UNIT_CELLS), so a surge scours about as much
 * shore as a small player stroke would. Wider and a single storm re-cuts a
 * whole bay in one call; narrower and the relaxation swallows the whole edit
 * and nothing happens at all.
 *
 * RE-MEASURED AND DELIBERATELY NOT RETUNED after the conserving relaxation
 * (issue #108, 2026-08-29). One surge on a genesis shoreline now takes 152
 * height units away where the old rule took 139 — 1.09× — and on a uniform
 * shoreline slope 144 against 109, 1.32× (.sim-108/plugins.mjs, `=== STORMS:
 * ground one surge removes ===`). The surge got slightly BIGGER because the old
 * rule partly refilled its own hole with manufactured height; nothing about the
 * brush changed.
 *
 * THE INTENT SENTENCE ABOVE STILL HOLDS AND IS THE REASON THIS STAYS 4: one
 * surge drops the shore at the centre by 8 units on a slope and 11 on genesis,
 * both under the 16 that would draw a new contour, so "less than a visible
 * step" is still measured true. The only integer alternative is 3, which
 * undershoots harder than 4 overshoots (0.61× and 0.56× of the old figures in
 * the same table) AND stops being one world unit — it would be a tuning
 * literal where this is a derivation.
 *
 * RESIDUAL, NAMED: many surges landing on the SAME cell take the shore down far
 * more than the file header's "a band or two" — 48 of them (a full landfall at
 * SURGE_INTERVAL_SECONDS) cut 12.8 bands on genesis. That is not new and not
 * this fix's doing: the same fixture under the old rule cut 9.6 bands. It is
 * bounded in practice by the siting loop, which draws a fresh random point over
 * the storm's whole disc for every surge, so a landfall spreads its cuts along
 * the coast rather than stacking them.
 */
export const SURGE_BRUSH_RADIUS_CELLS = 4;

/**
 * Seconds between surges from one storm.
 *
 * TEN, so a cyclone that spends its whole landfall on a coast surges a few
 * dozen times over eight minutes rather than every tick. The cadence is what
 * makes the total effect bounded and legible: a landfall costs the shore a
 * predictable amount, not a function of the server's tick rate.
 */
export const SURGE_INTERVAL_SECONDS = 10;

/**
 * How strong a cyclone has to be, in [0, 1], before it drives any water ashore.
 *
 * 0.5 — half strength. A storm that has already been beaten down by the land it
 * crossed does not get to keep eating coastline on its way out, and a storm
 * still spinning up out at sea does not scour a shore it has not reached.
 */
export const SURGE_MIN_INTENSITY = 0.5;

/**
 * How many cells are tried before a surge gives up for this interval.
 *
 * TWELVE draws inside the storm's disc. A cyclone's disc is mostly not
 * shoreline, so most draws miss; twelve is enough to find the coast reliably
 * when the eye is near one and to find nothing at all when it is not, which is
 * the outcome a storm out at sea should have.
 */
export const SURGE_SITING_ATTEMPTS = 12;

/** The four neighbours a shoreline test looks at. Cardinal only: a cell whose
 * only water is diagonal is a corner, not a coast. */
const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Is (x, y) land with sea in one of the four cells beside it? */
function isShoreline(world: StormWorld, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (world.heightAt(x, y) <= SEA_LEVEL) return false;
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
    if (world.heightAt(nx, ny) <= SEA_LEVEL) return true;
  }
  return false;
}

// The surge timer lives on the Storm record (`surgeDebtSeconds`) rather than in
// a side table here: it is state of the storm, it must persist with it, and a
// side table needed its own reset and prune to stay in step with the roster
// (review 2026-08-28).

/**
 * Runs one tick of surge for one storm. Returns the cell it scoured, or null.
 *
 * `random` is the SIM'S OWN generator, passed in rather than created here, so a
 * surge is part of the one seeded sequence that explains a world (./rng.ts's
 * whole argument). A second generator here would be a second thing to persist.
 *
 * Callers gate on the setting; this function does not, because a module that
 * silently did nothing depending on a global would be the harder thing to read.
 */
export function tickSurge(
  world: WorldApi & StormWorld,
  storm: Storm,
  intensity: number,
  dt: number,
  random: () => number,
): { x: number; y: number } | null {
  if (storm.kind !== 'cyclone') return null;

  storm.surgeDebtSeconds += dt;
  if (storm.surgeDebtSeconds < SURGE_INTERVAL_SECONDS) return null;
  // The debt is cleared whether or not a site is found, so a storm at sea does
  // not bank up ten minutes of surge and spend it all on the first rock it
  // passes.
  storm.surgeDebtSeconds = 0;
  if (intensity < SURGE_MIN_INTENSITY) return null;

  for (let attempt = 0; attempt < SURGE_SITING_ATTEMPTS; attempt++) {
    const angle = random() * Math.PI * 2;
    // Uniform over the disc's area — see the same sqrt in ./storms.ts.
    const distance = Math.sqrt(random()) * storm.radius;
    const x = Math.round(storm.x + Math.cos(angle) * distance);
    const y = Math.round(storm.y + Math.sin(angle) * distance);
    if (!isShoreline(world, x, y)) continue;

    // NEGATIVE: the sea takes ground away. Scaled by how hard the storm is
    // blowing, so a weakening cyclone scours less than one at full strength —
    // the same intensity that drives the damage events drives this.
    world.sculpt(x, y, SURGE_BRUSH_RADIUS_CELLS, -SURGE_SCOUR_HEIGHT_UNITS * intensity);
    return { x, y };
  }
  return null;
}


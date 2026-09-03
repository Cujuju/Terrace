// WIND SCOUR — the second thing in this plugin that touches the ground, and
// the reason the ground-changing setting is no longer only about the sea.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT IS. A cyclone that flattens a wood and takes the roofs off a village
// has not touched the LAND it did that on, and the owner's ruling (2026-09-03)
// asks for a storm that "disrupt[s] the land itself". This is that: cells the
// wind struck hard, above the waterline, lose a fraction of a band.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT USES THE DAMAGE EVENT'S SAMPLE, AND THAT IS THE ONE RIGHT SOURCE HERE.
//
// Every other consumer of `cyclone:damage` in this repo owns a spatial index
// (a forest, a board of buildings, a fleet) and is expected to read the disc
// and answer exactly — the engine's own note where it declares
// ROTATING_STORM_DAMAGE_SAMPLE_CELLS says as much. This consumer owns nothing
// of the kind. Its subject is the GROUND, of which there are tens of thousands
// of cells under one cyclone, and scouring them exactly would be a re-terraform
// rather than a storm. So the twelve sampled cells are read as what they are:
// twelve places the wind is known to have hit hard, redrawn every second over
// the storm's whole life, which spreads the scour along the track instead of
// stacking it — the same argument ./surge.ts's siting loop makes for itself.
//
// AND IT DOES NOT ROUND-TRIP ITS OWN EVENT. The cyclone plugin drives its own
// storms and holds the damage in hand at the moment it emits it (./index.ts's
// `simulate`); subscribing to itself through `onWorldEvent` would be a fan-out
// through every installed plugin, a structural re-parse of a payload this
// module just built, and a hook whose own doc comment warns the emitter must
// filter itself back out. The by-name subscription rule is about reaching a
// NEIGHBOUR.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT IS BUDGETED, HARD. A storm may scour at most
// WIND_SCOUR_MAX_CELLS_PER_EVENT cells per event, i.e. per second per storm.
// A `sculpt` is not free — it re-runs the relaxation, walks a diff and
// notifies every plugin — and the sample is redrawn every second for eight
// minutes, so an unbudgeted version would put a few thousand sculpts through
// the queue over one cyclone's life. The budget is what makes the cost of a
// hurricane a number this file can state.

import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import { footprintUnlocked } from '../../../server/src/plugins/footprint.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import type {
  RotatingStormDamage,
  RotatingStormWorld,
} from '../../../server/src/plugins/kit/rotatingStorms.ts';

/**
 * How deep one scour cuts at full severity, in HEIGHT UNITS — a QUARTER of a
 * terrace band.
 *
 * Half of ./surge.ts's SURGE_SCOUR_HEIGHT_UNITS, and stated as a fraction of
 * BAND_HEIGHT for that constant's own reason: the number that matters is "less
 * than one visible step of terracing", so a cut reads as erosion rather than as
 * an edit, and it follows BAND_HEIGHT if BAND_HEIGHT ever moves.
 *
 * SHALLOWER THAN A SURGE because it is a different force doing less work. A
 * surge is the sea itself driven onto a shore over ten seconds; this is wind
 * stripping the ground it is crossing, once a second, in as many as
 * WIND_SCOUR_MAX_CELLS_PER_EVENT places at a time. At the same depth as a surge
 * a cyclone would cut the land faster than it cuts the coast, which is backwards.
 */
export const WIND_SCOUR_HEIGHT_UNITS = BAND_HEIGHT / 4;

/**
 * The brush radius one scour is applied with, in cells.
 *
 * TWO — half ./surge.ts's SURGE_BRUSH_RADIUS_CELLS, and the smallest radius at
 * which the conserving relaxation does not simply swallow the edit (that file's
 * note on why 3 undershoots the old rule by nearly half is the measurement this
 * leans on). Wind strips a patch of hillside; the sea re-cuts a bay. Making
 * them the same width would make this a second surge that happened to be
 * inland.
 */
export const WIND_SCOUR_BRUSH_RADIUS_CELLS = 2;

/**
 * How hard the wind must be blowing at a cell before it moves any ground.
 *
 * 0.5 — the same bar ./surge.ts's SURGE_MIN_INTENSITY sets for the sea, and
 * deliberately the same number: both answer one question, "is this storm strong
 * enough to rewrite terrain", and giving them two answers would mean a cyclone
 * that had stopped eating its coastline was still scouring the hills behind it.
 * It is applied to per-cell SEVERITY here where the surge applies it to the
 * whole storm's intensity, because severity is what a cell actually feels; the
 * effect is that only the inner half of a full-strength disc cuts at all, and a
 * storm below half strength cuts nowhere.
 *
 * IT ALSO KEEPS THE SCULPT AMOUNT OFF ZERO, which is not a happy accident but
 * the failure mode ./surge.ts documents at length: a brush amount is an integer
 * by contract, and a scour rounded to nothing is a sculpt that costs a
 * relaxation and moves no ground. At this bar the shallowest cut is
 * round(WIND_SCOUR_HEIGHT_UNITS × 0.5) = 2 units.
 */
export const WIND_SCOUR_MIN_SEVERITY = 0.5;

/**
 * The most cells one storm may scour in one damage event — i.e. per second.
 *
 * THREE of the twelve sampled cells. A cyclone lives about eight minutes
 * (../server/sim.ts's meanLifetimeSeconds), so this caps a whole storm at
 * roughly 1 400 sculpts spread along its entire track, against the ~5 700 an
 * unbudgeted version would queue — and in practice far fewer, because most of a
 * disc is sea, locked, or under the severity bar. Three is enough that a
 * landfall visibly works the ground over and few enough that the sculpt queue
 * never sees a storm as a burst.
 */
export const WIND_SCOUR_MAX_CELLS_PER_EVENT = 3;

/**
 * Scours the ground under one damage event, and returns the cells it cut.
 *
 * Callers gate on the setting; this function does not, for ./surge.ts's reason
 * — a module that silently did nothing depending on a global would be the
 * harder thing to read.
 */
export function scourStruckGround(
  world: WorldApi & RotatingStormWorld,
  damage: RotatingStormDamage,
): Array<{ x: number; y: number }> {
  const cut: Array<{ x: number; y: number }> = [];

  for (const cell of damage.cells) {
    if (cut.length >= WIND_SCOUR_MAX_CELLS_PER_EVENT) break;
    if (cell.severity < WIND_SCOUR_MIN_SEVERITY) continue;
    // ABOVE THE WATERLINE ONLY. Wind does not strip a seabed, and the sea's own
    // share of a cyclone is the surge, which deals in the shoreline.
    if (world.heightAt(cell.x, cell.y) <= SEA_LEVEL) continue;
    // REVEALED GROUND ONLY — the whole brush, not just the centre cell, the
    // same guard and the same reason as ./surge.ts: terrain nobody has
    // unlocked is never rewritten behind the fog, and the skirt of the sculpt
    // must not bleed into a locked chunk either.
    if (!footprintUnlocked(world, cell.x, cell.y, WIND_SCOUR_BRUSH_RADIUS_CELLS)) continue;

    // NEGATIVE: the wind takes ground away. Scaled by the severity at that
    // cell, and ROUNDED TO A WHOLE HEIGHT UNIT because a brush amount is an
    // integer by contract (shared/src/heightmap.ts, `assertBrushArgs`) — a
    // fractional amount throws a RangeError inside onTick, which is exactly how
    // the surge silently moved no ground for as long as it shipped.
    const amount = Math.round(WIND_SCOUR_HEIGHT_UNITS * cell.severity);
    // Belt and suspenders against that same failure: WIND_SCOUR_MIN_SEVERITY
    // already puts the shallowest cut at 2 units, so this cannot fire today —
    // but a retune of either constant that made it round to zero would
    // otherwise cost a relaxation per cell and move nothing, which is a bug
    // that reads exactly like "the feature does not work".
    if (amount <= 0) continue;

    world.sculpt(cell.x, cell.y, WIND_SCOUR_BRUSH_RADIUS_CELLS, -amount);
    cut.push({ x: cell.x, y: cell.y });
  }

  return cut;
}

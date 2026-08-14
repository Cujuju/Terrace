// Vertical placement: turning "the rendered seabed under it is at world Y = s"
// into "this monster's origin belongs at world Y = y".
//
// Pure arithmetic, no three, no DOM — which is what lets it be tested in the
// same node environment as the rest of the suite (the project ships no headless
// GL rig; see design §8).
//
// HORIZONTAL placement needs no code: CELL_WORLD_SIZE is 1 (client/src/
// config.ts), so a monster's cell position is its world X/Z. RESIDUAL, stated
// rather than papered over: if CELL_WORLD_SIZE ever stops being 1, every size
// and position in this plugin's client half needs a multiply, and nothing here
// will fail loudly to tell you so.

import { SEA_LEVEL } from '@terrace/shared';
import { CTHULHU_LURK_DEPTH } from './anatomy.ts';

/**
 * World-space Y of the sea surface.
 *
 * The renderer draws the sea at `SEA_LEVEL * HEIGHT_WORLD_SCALE +
 * WATER_SURFACE_LIFT` (client/src/render/water.ts). SEA_LEVEL is 0 by definition
 * in @terrace/shared — "water is every height at or below zero" — so the first
 * term is exactly 0 whatever the height scale is, and the second is a
 * thirty-second of a cell, sixty times smaller than the waterline bite this
 * plugin cares about.
 *
 * The `: 0` annotation is the guard: this stops compiling the day SEA_LEVEL
 * becomes anything else, which is exactly when this reasoning stops holding.
 */
export const SEA_SURFACE_WORLD_Y: 0 = SEA_LEVEL;

/**
 * World Y of the model's origin, given the rendered seabed height under it (or
 * null when that chunk has not arrived).
 *
 * THE RULE: it sinks to its preferred lurking depth, but never through the
 * floor — `max(seabed, surface - lurkDepth)`.
 *
 * A NULL seabed (the chunk has not arrived yet) means no clamp, NOT band 0.
 * Band 0 is what the terrain mesh draws for unknown cells, and band 0 is the sea
 * SURFACE plane — clamping against it would beach the thing at full height for
 * the frames between its first broadcast and its chunk arriving. The server only
 * ever summons into deep unlocked water, so "unknown" honestly means "deep
 * enough". (The wildlife plugin's swimmers do fall back to band 0; they are a
 * fraction of a cell tall, so for them the two answers are the same picture.)
 *
 * Two consequences, both deliberate:
 *
 *   * in a true abyss it rides at exactly CTHULHU_LURK_DEPTH: head and shoulder
 *     crowns out, torso gone. That is the intended silhouette;
 *   * in a basin only just past the deep threshold (3 bands = 3 world units), it
 *     STANDS ON THE BOTTOM and correspondingly more of it towers out of the
 *     water. Barely-deep water shows you the whole monster; a real trench leaves
 *     you a head. That inversion is a feature — digging deeper is rewarded with
 *     the more menacing, less legible silhouette.
 *
 * REJECTED ALTERNATIVE: pin the origin at the lurk depth unconditionally and let
 * the submerged body intersect the seabed. It keeps the silhouette constant, and
 * it costs a body visibly clipping through terrain in every shallow lair, which
 * the water — being translucent — would show plainly. A creature standing on the
 * floor is a thing that can happen; a creature inside the floor is a bug.
 * REJECTED ALTERNATIVE 2: a deeper habitat threshold, so the shallow case cannot
 * arise. That would fork this plugin's idea of "deep water" away from the
 * wildlife plugin's for a rendering convenience, which is the wrong layer to
 * settle a rendering question in.
 */
export function monsterOriginWorldY(seabedY: number | null): number {
  const preferred = SEA_SURFACE_WORLD_Y - CTHULHU_LURK_DEPTH;
  if (seabedY === null) return preferred;
  return Math.max(seabedY, preferred);
}

/**
 * How much of the model is under water at a given origin Y — a fraction of its
 * total height, clamped to [0, 1]. Not used by the renderer; it is the property
 * the placement rule exists to produce, so it is what the tests assert against.
 */
export function submergedFraction(originY: number, totalHeight: number): number {
  if (totalHeight <= 0) return 0;
  const submerged = SEA_SURFACE_WORLD_Y - originY;
  return Math.min(1, Math.max(0, submerged / totalHeight));
}

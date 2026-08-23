// Vertical placement: turning "the terrain under it is at world Y = s" into
// "this monster's origin belongs at world Y = y".
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
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO RULES, AND THEY ARE A NAMED KIND (2026-08-14, for the yeti)
//
// A swimmer hangs from the SEA SURFACE and is clamped by the seabed; a walker
// stands ON the ground. Those are different questions, not one question with a
// parameter, and the table below answers with a discriminated union so a kind
// added without a placement rule fails to compile rather than floating at
// Cthulhu's depth.
//
// This is the wildlife plugin's PlacementKind lesson (plugins/wildlife/client/
// placement.ts), which learned it the hard way: "is this a walker" used to be
// read off the nullness of the swim table, and adding a third kind to a
// two-valued test on a table with nothing to say about it would silently have
// made birds walk. Restated rather than imported — plugins are independently
// installable.
// ─────────────────────────────────────────────────────────────────────────────

import { SEA_LEVEL, cellsAcross } from '@terrace/shared';
import type { MonsterKind } from '../protocol.ts';
import { CTHULHU_LURK_DEPTH } from './anatomy.ts';
import { KRAKEN_LURK_DEPTH } from './kraken-anatomy.ts';
import { YETI_FOOT_GROUND_HALF_EXTENT } from './yeti-anatomy.ts';

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
 * Terrain Y a WALKER is placed against when the client has never been sent the
 * chunk it is standing in. Band 0 is what the terrain mesh draws for unknown
 * cells (see ClientPluginCtx.terrainHeightAt), and band 0 is world Y 0, so this
 * is exactly what the player sees there.
 *
 * IT IS THE OPPOSITE ANSWER FROM THE SWIMMERS' (see monsterOriginWorldY, where
 * unknown means "no clamp"), and the two are both right: a walker standing on
 * the ground that is drawn is correct even when the drawn ground is a
 * placeholder, whereas band 0 is ALSO the sea surface, so clamping a swimmer
 * against it would beach a ten-cell horror at full height. In practice a monster
 * only ever exists in unlocked territory (the server refuses to summon or steer
 * one anywhere else), so this covers the one frame between its first broadcast
 * and its chunk arriving.
 */
export const UNKNOWN_TERRAIN_WORLD_Y = 0;

/**
 * How a kind is placed vertically.
 *
 * `swimmer` carries the depth its origin rides below the sea surface in water
 * deep enough to allow it; both of today's are DERIVED in their anatomy files
 * from the part of the creature that has to stay clear of the water — Cthulhu's
 * head, the kraken's eyes — so retuning a silhouette moves its waterline with
 * it.
 *
 * `walker` carries the half-extent of the ground its FEET cover, which is what
 * the terrain sample is taken over.
 */
export type MonsterPlacementRule =
  | { readonly placement: 'swimmer'; readonly lurkDepth: number }
  | { readonly placement: 'walker'; readonly footGroundHalfExtentCells: number };

/**
 * A TABLE rather than a parameter with a default: a kind added without a
 * placement rule should fail to compile, not float at Cthulhu's depth.
 */
const PLACEMENT_BY_KIND: Readonly<Record<MonsterKind, MonsterPlacementRule>> = {
  cthulhu: { placement: 'swimmer', lurkDepth: CTHULHU_LURK_DEPTH },
  kraken: { placement: 'swimmer', lurkDepth: KRAKEN_LURK_DEPTH },
  // CONVERTED HERE, and this is the only place it may be: the anatomy states the
  // body in world units and walkerGroundWorldY steps in CELLS.
  yeti: {
    placement: 'walker',
    footGroundHalfExtentCells: cellsAcross(YETI_FOOT_GROUND_HALF_EXTENT),
  },
};

export function placementRuleOf(kind: MonsterKind): MonsterPlacementRule {
  return PLACEMENT_BY_KIND[kind];
}

/**
 * How far a kind's origin rides below the sea surface. Swimmers only — a walker
 * has no such number, which is why this throws rather than returning zero: a
 * caller asking a mountain animal how deep it lurks has a bug, and a plausible
 * answer would hide it.
 */
export function lurkDepthOf(kind: MonsterKind): number {
  const rule = placementRuleOf(kind);
  if (rule.placement !== 'swimmer') {
    throw new Error(`${kind} is not placed in the water`);
  }
  return rule.lurkDepth;
}

/**
 * World Y of a SWIMMER's origin, given the rendered seabed height under it (or
 * null when that chunk has not arrived) and this kind's lurking depth.
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
 *   * in a true abyss it rides at exactly its lurk depth: for Cthulhu, head and
 *     shoulder crowns out and torso gone; for the kraken, eyes at the waterline
 *     and the mantle clear. Those are the intended silhouettes;
 *   * in a basin only just past the deep threshold (3 bands = 3 world units), a
 *     kind whose lurk depth is DEEPER than that threshold STANDS ON THE BOTTOM
 *     and correspondingly more of it towers out of the water. Barely-deep water
 *     shows you the whole monster; a real trench leaves you a head. That
 *     inversion is a feature — digging deeper is rewarded with the more
 *     menacing, less legible silhouette.
 *
 *     WHICH KINDS, EXACTLY — stated because this read as a rule about swimmers
 *     until a correctness pass (2026-08-19) checked it against both of them:
 *     it is CTHULHU'S behaviour and only his. His lurk depth is 6.6 world
 *     units, past the 3-unit deep-water line, so the clamp fires in every
 *     basin shallower than that. The KRAKEN lurks at 0.85 — its eyes ride a
 *     waterline bite under the surface by construction (kraken-anatomy.ts) —
 *     and no cell it may legally occupy is shallower than 3, so `max` picks
 *     the preferred depth every time and the seabed argument NEVER binds. Its
 *     silhouette is therefore depth-invariant: identical in a three-band
 *     puddle and on the lava floor twenty-four units down. That is the
 *     anatomy's intent and not an oversight — the kraken is the sea kind you
 *     are meant to SEE — so it must not be "fixed" by making it sink. The
 *     inertness is pinned by a test, so a lurk-depth retune that pushed it
 *     past the deep-water line (and started dropping it onto the floor) fails
 *     loudly instead of quietly changing what the animal looks like.
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
export function monsterOriginWorldY(seabedY: number | null, lurkDepth: number): number {
  const preferred = SEA_SURFACE_WORLD_Y - lurkDepth;
  if (seabedY === null) return preferred;
  return Math.max(seabedY, preferred);
}

/**
 * World Y of a WALKER's origin: the HIGHEST rendered cell under its feet, not
 * the single cell under its centre.
 *
 * The single-cell version is a clipping bug the wildlife plugin already
 * reported and fixed (plugins/wildlife/client/placement.ts, walkerGroundY): a
 * walker whose centre is on a low band but whose body overhangs a neighbouring
 * higher band stands at the low height and its body intersects the riser face.
 * Sampling the four corners of the footprint plus the centre and standing on the
 * max means the model clears every band it overlaps; while crossing a riser it
 * pops up a band the moment its leading edge reaches it — a step, which is how a
 * terraced world walks.
 *
 * THE FOOTPRINT SAMPLED IS THE FEET, not the body (see
 * YETI_FOOT_GROUND_HALF_EXTENT): a walker stands on what it steps on, and
 * sampling the shoulders would have him ride up onto every band his elbow
 * overhangs.
 *
 * Returns null only when the client has been sent none of those cells; the
 * caller substitutes UNKNOWN_TERRAIN_WORLD_Y.
 */
export function walkerGroundWorldY(
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
  halfExtentCells: number,
): number | null {
  let ground: number | null = null;
  for (const [dx, dy] of [
    [0, 0],
    [-halfExtentCells, -halfExtentCells],
    [-halfExtentCells, halfExtentCells],
    [halfExtentCells, -halfExtentCells],
    [halfExtentCells, halfExtentCells],
  ]) {
    const sampled = sampleRenderedY(Math.floor(x + dx!), Math.floor(y + dy!));
    if (sampled !== null && (ground === null || sampled > ground)) ground = sampled;
  }
  return ground;
}

/**
 * World Y of one monster's origin, whichever rule its kind is placed by.
 *
 * ONE entry point, so the render path cannot forget a case: it hands over the
 * terrain sampler and the position, and the table decides what to do with them.
 * The swimmers take one sample under their centre — they float in the water
 * column rather than standing on a footprint, and the seabed is only ever used
 * as a floor.
 */
export function monsterOriginY(
  kind: MonsterKind,
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
): number {
  const rule = placementRuleOf(kind);
  if (rule.placement === 'walker') {
    const ground = walkerGroundWorldY(sampleRenderedY, x, y, rule.footGroundHalfExtentCells);
    return ground ?? UNKNOWN_TERRAIN_WORLD_Y;
  }
  return monsterOriginWorldY(sampleRenderedY(Math.floor(x), Math.floor(y)), rule.lurkDepth);
}

/**
 * How much of the model is under water at a given origin Y — a fraction of its
 * total height, clamped to [0, 1]. Not used by the renderer; it is the property
 * the swimmers' placement rule exists to produce, so it is what the tests assert
 * against.
 */
export function submergedFraction(originY: number, totalHeight: number): number {
  if (totalHeight <= 0) return 0;
  const submerged = SEA_SURFACE_WORLD_Y - originY;
  return Math.min(1, Math.max(0, submerged / totalHeight));
}

// Vertical placement: turning "the rendered terrain surface is at world Y = s"
// into "this creature's origin belongs at world Y = y".
//
// Pure arithmetic, no three, no DOM — which is what lets it be tested in the
// same node environment as the rest of the suite (the project ships no headless
// GL rig; see client/vite.config.ts).
//
// HORIZONTAL placement needs no code: CELL_WORLD_SIZE is 1 (client/src/config.ts
// — "world-space X/Z coordinates ARE cell coordinates"), so a creature's cell
// position is its world X/Z and its body length in cells is its length in world
// units. RESIDUAL, stated rather than papered over: if CELL_WORLD_SIZE ever
// stops being 1, every size and position in this plugin's client half needs a
// multiply, and nothing here will fail loudly to tell you so.

import { BAND_HEIGHT, MAX_HEIGHT, SEA_LEVEL, cellsAcross } from '@terrace/shared';
import {
  WILDLIFE_SIZE_MODEL_SCALE,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from '../protocol.ts';

/**
 * World-space Y of the sea surface.
 *
 * The renderer draws the sea at `SEA_LEVEL * HEIGHT_WORLD_SCALE +
 * WATER_SURFACE_LIFT` (client/src/render/water.ts). SEA_LEVEL is 0 by definition
 * in @terrace/shared — "water is every height at or below zero" — so the first
 * term is exactly 0 whatever the height scale is, and the second is a
 * thirty-second of a cell, two hundred times smaller than the tightest clearance
 * below. Swimmers are therefore placed against Y = 0.
 *
 * The `: 0` annotation is the guard: this stops compiling the day SEA_LEVEL
 * becomes anything else, which is exactly when this reasoning stops holding.
 */
export const SEA_SURFACE_WORLD_Y: 0 = SEA_LEVEL;

/**
 * Where in the water column a species swims, and how much room it insists on.
 *
 * BOTH CLEARANCES ARE STATED AT SIZE CLASS `medium`, the class whose model scale
 * is 1 by definition (WILDLIFE_SIZE_MODEL_SCALE). They are half-extents of the
 * MODEL, and the model is uniformly scaled by its class, so they are scaled by
 * it too — see swimmerWorldY. `depthFraction` is a fraction of the water column
 * and means the same thing at every size.
 */
export interface SwimProfile {
  /** 0 = at the surface, 1 = on the seabed. */
  readonly depthFraction: number;
  /** Never closer than this to the seabed, in world units, at model scale 1. */
  readonly minClearance: number;
  /** Never closer than this to the surface, in world units, at model scale 1. */
  readonly minSubmergence: number;
}

/**
 * Fish sit just under the surface where the light is, whales cruise mid-water,
 * and the deep-sea creature hugs the bottom — that vertical separation is what
 * makes three species sharing one body of water read as three species rather
 * than as a soup. The clearances are sized off each model's own half-height so a
 * creature never intersects the seabed or breaches the surface.
 */
export const SWIM_PROFILES: Readonly<Record<WildlifeSpecies, SwimProfile | null>> = {
  fish: { depthFraction: 0.2, minClearance: 0.25, minSubmergence: 0.3 },
  whale: { depthFraction: 0.5, minClearance: 0.7, minSubmergence: 0.7 },
  // minClearance 0.8, NOT the 0.35 it shipped with (owner report 2026-08-14:
  // the angler "keeps clipping into the terrain"). The model's body ellipsoid
  // reaches 0.7 below the placement point (models.ts, ellipsoid(1, 0.7, 0.55))
  // and 0.35 honoured only half of that, so at depthFraction 0.88 the belly
  // sat inside the seabed — the one species that HUGS the bottom had the one
  // clearance smaller than its own lower half-height. 0.7 + 0.1 of visible
  // water under the belly restores the contract stated above the table.
  deepsea: { depthFraction: 0.88, minClearance: 0.8, minSubmergence: 0.5 },
  // Land species stand on the ground; they have no water column to sit in.
  grazer: null,
  // Flyers have no water column either — see FLIGHT_ALTITUDES.
  bird: null,
};

// ── Flight ───────────────────────────────────────────────────────────────────

/**
 * World units of height the full above-sea range stands — the client's
 * MAX_RELIEF_WORLD_UNITS (client/src/config.ts), restated here for the same
 * import reason as everything else in this block. THE relief fact: it alone
 * decides how mountainous the world looks, and since 2026-08-20 it is what the
 * client's whole vertical scale derives from.
 */
const MAX_RELIEF_WORLD_UNITS = 16;

/**
 * World-space Y of the highest terrain this game can contain.
 *
 * MAX_HEIGHT (@terrace/shared) is the sculpt ceiling in HEIGHT UNITS; the
 * renderer draws one terrace band as one world unit (BAND_WORLD_HEIGHT =
 * CELL_WORLD_SIZE = 1 in client/src/config.ts, so HEIGHT_WORLD_SCALE is
 * 1/BAND_HEIGHT). Deriving the world-space figure from those two shared
 * constants rather than writing 16 is what keeps this correct if either moves —
 * and BAND_HEIGHT is explicitly provisional.
 *
 * This plugin cannot import client/src/config.ts's HEIGHT_WORLD_SCALE without
 * dragging `import.meta.env` into a node test run (see plugins/mana/client/
 * env.d.ts for the same trap), so the ratio is restated from its two shared
 * inputs. RESIDUAL, named: if BAND_WORLD_HEIGHT ever stops equalling
 * CELL_WORLD_SIZE, this figure is wrong by that ratio and nothing fails loudly —
 * exactly the CELL_WORLD_SIZE residual already recorded at the top of this file,
 * on the vertical axis. *
 * THE NAMED RESIDUAL CAME TRUE (2026-08-20). BAND_WORLD_HEIGHT stopped
 * equalling CELL_WORLD_SIZE: the client now derives it from the world's RELIEF
 * (config.ts's MAX_RELIEF_WORLD_UNITS) rather than the reverse, so a band is a
 * quarter of a cell at BAND_HEIGHT 16 and MAX_HEIGHT / BAND_HEIGHT is no longer
 * the ceiling in world units — it is 64 where the ceiling is still 16. The
 * quotient was only ever accidentally right.
 *
 * So the relief is restated directly, the same way this file already restates
 * everything else it cannot import. It is the ONE number the client's vertical
 * scale is built from now, which makes it a better thing to restate than a
 * ratio that happened to equal it.
 */
export const MAX_TERRAIN_WORLD_Y = MAX_RELIEF_WORLD_UNITS;

/**
 * Clearance between the highest possible mountain and the birds, in world units.
 *
 * Eight — half of MAX_TERRAIN_WORLD_Y (16). The requirement is that birds read
 * as flying OVER the world rather than skimming it, and that has to hold at the
 * worst case, not the typical one: a player who builds a maximum-height peak and
 * then watches a flock pass must still see clear sky between the two. Half the
 * tallest possible mountain again is a gap you cannot mistake for a near miss,
 * and it is still tiny against the camera's 20-cell minimum orbit distance, so
 * birds never crowd the near plane.
 *
 * Everything real is far below it: a fresh world's seabed is 3 bands DOWN, and a
 * mountain a player actually builds is a handful of bands up.
 */
export const BIRD_ALTITUDE_HEADROOM_WORLD_UNITS = MAX_TERRAIN_WORLD_Y / 2;

/**
 * The single world-space Y every bird flies at.
 *
 * ONE ALTITUDE FOR ALL BIRDS, and that is what keeps altitude off the wire: the
 * server sends a bird's cell position and heading like any other creature, and
 * the client already knows the third coordinate. A per-flock altitude would be a
 * float per bird per broadcast (or a per-flock message this plugin does not
 * have) to buy vertical variety at a distance where the eye reads a flock's
 * height off its position against the ground, not off its parallax.
 */
export const BIRD_FLIGHT_WORLD_Y = MAX_TERRAIN_WORLD_Y + BIRD_ALTITUDE_HEADROOM_WORLD_UNITS;

/**
 * Fixed cruising altitude of each FLYING species, in world units; null for
 * anything that is not a flyer.
 *
 * A flyer's Y is a constant, not a function of the ground: it is the one
 * placement rule in this file that does not read the terrain at all, which is
 * also why a bird over a chunk this client has never been sent is drawn in
 * exactly the right place rather than sagging to UNKNOWN_TERRAIN_WORLD_Y.
 */
export const FLIGHT_ALTITUDES: Readonly<Record<WildlifeSpecies, number | null>> = {
  fish: null,
  whale: null,
  deepsea: null,
  grazer: null,
  bird: BIRD_FLIGHT_WORLD_Y,
};

/**
 * How a species is placed vertically. Three genuinely different rules, so this
 * is three cases and not two.
 *
 * IT IS A NAMED KIND, not the nullness of some other table. Before birds, "is
 * this a walker" was read off `SWIM_PROFILES[species] === null` at the render
 * call site — a two-valued test on a table that had nothing to say about a third
 * kind, and adding a bird to it would silently have made birds walk. The kind is
 * now the thing the caller asks for, and both tables answer to it.
 */
export type PlacementKind = 'flyer' | 'swimmer' | 'walker';

export function placementKindOf(species: WildlifeSpecies): PlacementKind {
  if (FLIGHT_ALTITUDES[species] !== null) return 'flyer';
  return SWIM_PROFILES[species] === null ? 'walker' : 'swimmer';
}

/**
 * Terrain Y a creature is placed against when the client has never been sent the
 * chunk it is standing in. Band 0 is what the terrain mesh draws for unknown
 * cells (see ClientPluginCtx.terrainHeightAt), and band 0 is world Y 0 — the
 * same plane as the sea surface — so this matches what the player sees.
 *
 * In practice creatures only ever exist in UNLOCKED territory (the server refuses
 * to spawn or steer them anywhere else), so this is a belt-and-suspenders default
 * for the one frame between a creature's first broadcast and its chunk arriving.
 */
export const UNKNOWN_TERRAIN_WORLD_Y = 0;

/**
 * Where a swimmer's origin sits between the seabed and the surface.
 *
 * The fraction is applied first, then both clearances clamp it. In water too
 * shallow to honour both (a fish that has drifted over a sandbar), the clamps
 * would cross; splitting the remaining column is the only answer that keeps the
 * creature inside the water at all, and it degrades smoothly as the water
 * shallows rather than snapping when the two limits meet.
 *
 * `modelScale` IS NOT OPTIONAL, and it is the fix for a bug the table above was
 * always one size class away from (found 2026-08-21, when whales gained size
 * classes). A clearance is the creature's own half-height plus a little water;
 * the class scales the model but was scaling nothing here. An earlier version
 * of this note blamed the FISH, computing its half-height from ellipsoid()'s
 * full height argument — 1.4 x 0.26 = 0.36 against a 0.3 minSubmergence, which
 * it noted protocol.ts called "comfortably inside". That was wrong about the
 * fish: ellipsoid() takes FULL extents, so a fish's half-height is 0.13, and at
 * 1.4x that is 0.182 — comfortably inside, as it always was. The whale is the
 * genuine case: WHALE_ENVELOPE (whaleSpecies.ts) IS a half-extent envelope,
 * measured from the model's bounding box, so at `large` its crown reaches
 * 1.4 x 0.670 = 0.938 and its belly sits 1.4 x 0.575 = 0.805 below the origin,
 * against this table's whale minSubmergence 0.7 and minClearance 0.7.
 * Unscaled, a large whale would have put its belly 0.1 units into the seabed
 * and its dorsal 0.24 above the waterline.
 */
export function swimmerWorldY(
  seabedY: number,
  profile: SwimProfile,
  modelScale: number,
): number {
  const column = SEA_SURFACE_WORLD_Y - seabedY;
  const preferred = SEA_SURFACE_WORLD_Y - profile.depthFraction * column;

  const lowest = seabedY + profile.minClearance * modelScale;
  const highest = SEA_SURFACE_WORLD_Y - profile.minSubmergence * modelScale;
  if (highest < lowest) return seabedY + column / 2;

  return Math.min(Math.max(preferred, lowest), highest);
}

/**
 * World Y for one creature. `terrainY` is the ground/seabed height under it —
 * for a walker, use walkerGroundY, not a single-cell sample — or null before the
 * first snapshot arrives (and always, for a flyer, which ignores it).
 *
 * `sizeClass` is required rather than defaulted: every creature has one, the
 * caller always knows it (it arrives on the wire with the entity), and a default
 * would silently place a large whale as if it were an adult — the exact class of
 * mistake swimmerWorldY's note describes.
 */
export function creatureWorldY(
  species: WildlifeSpecies,
  terrainY: number | null,
  sizeClass: WildlifeSizeClass,
): number {
  const altitude = FLIGHT_ALTITUDES[species];
  // A flyer's altitude is absolute: the ground beneath it is irrelevant, and so
  // is whether this client has even been sent that ground.
  if (altitude !== null) return altitude;

  const surfaceY = terrainY ?? UNKNOWN_TERRAIN_WORLD_Y;
  const profile = SWIM_PROFILES[species];
  // Land species' models are built with the origin at their feet, so the ground
  // height is the answer with no offset — and a walker's size scales its body
  // upward from that origin, which moves nothing about where its feet go.
  return profile === null
    ? surfaceY
    : swimmerWorldY(surfaceY, profile, WILDLIFE_SIZE_MODEL_SCALE[sizeClass]);
}

/**
 * Half-extent of a walker's ground footprint, in WORLD UNITS.
 *
 * A grazer's body is ~1.1 world units long (client/models.ts: an 0.85 box with
 * a head reaching 0.67 ahead of centre), so its geometry overhangs its centre
 * by roughly half a unit in every facing. Slightly under that (0.45) keeps the
 * sample inside the body's true extent, so the creature never rides up on a
 * band it does not actually overlap.
 *
 * IT WAS NAMED `..._CELLS` AND IT WAS NOT CELLS, which is the whole bug (found
 * 2026-08-22, alongside the identical one in the monsters plugin). A model
 * dimension has been world units since the 2026-08-21 re-sample cut a cell to a
 * quarter of one, and walkerGroundY adds this straight to a CELL coordinate —
 * so every land creature probed 0.45 CELLS, a quarter of the ground it covers,
 * and a grazer could stand a band below a riser its body overhung. That is the
 * exact clipping bug walkerGroundY exists to prevent, reintroduced underneath
 * it by a units change three months later.
 *
 * The conversion now happens at the one boundary (`cellsAcross`, the conversion
 * every physical distance in this codebase is supposed to go through) and the
 * name says which side of it this number is on — which is the part that let it
 * hide, because 0.45 is a perfectly plausible number of cells.
 */
export const WALKER_FOOTPRINT_HALF_EXTENT = 0.45;

/** The same half-extent in the CELLS walkerGroundY steps in. Converted once. */
export const WALKER_FOOTPRINT_HALF_EXTENT_CELLS = cellsAcross(WALKER_FOOTPRINT_HALF_EXTENT);

/**
 * Ground height for a land creature: the HIGHEST rendered cell under its
 * footprint, not the single cell under its centre.
 *
 * The single-cell version is exactly the reported clipping bug: a walker whose
 * centre is on a low band but whose body overhangs a neighbouring higher band
 * stands at the low height and its body intersects the riser face. Sampling
 * the four footprint corners plus the centre and standing on the max means the
 * body clears every band it overlaps; while crossing a riser the creature pops
 * up a band the moment its leading edge reaches it — a step, which is how a
 * terraced world walks.
 */
export function walkerGroundY(
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
): number | null {
  const h = WALKER_FOOTPRINT_HALF_EXTENT_CELLS;
  let ground: number | null = null;
  for (const [dx, dy] of [
    [0, 0],
    [-h, -h],
    [-h, h],
    [h, -h],
    [h, h],
  ]) {
    const sampled = sampleRenderedY(Math.floor(x + dx), Math.floor(y + dy));
    if (sampled !== null && (ground === null || sampled > ground)) ground = sampled;
  }
  return ground;
}

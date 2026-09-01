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
  /**
   * Half the model's length and half its width, in world units at model scale
   * 1 — the footprint `swimmerSeabedY` samples the seabed over.
   *
   * A MODEL DIMENSION, exactly like WALKER_FOOTPRINT_HALF_EXTENT further down,
   * and read off the same place (./models.ts, ./whaleSpecies.ts) for the same
   * reason: this is a question about the hull the client draws, not about the
   * body the simulation steers. The server's own bodyLengthCells answers a
   * different question — how far ahead to probe for habitat — and the two are
   * deliberately not one number.
   */
  readonly halfLength: number;
  readonly halfWidth: number;
}

/**
 * Fish sit just under the surface where the light is, whales cruise mid-water,
 * and the deep-sea creature hugs the bottom — that vertical separation is what
 * makes three species sharing one body of water read as three species rather
 * than as a soup. The clearances are sized off each model's own half-height so a
 * creature never intersects the seabed or breaches the surface.
 */
export const SWIM_PROFILES: Readonly<Record<WildlifeSpecies, SwimProfile | null>> = {
  // Body ellipsoid(0.55, 0.26, 0.18) with a tail sweeping back to ~0.7 overall.
  fish: {
    depthFraction: 0.2,
    minClearance: 0.25,
    minSubmergence: 0.3,
    halfLength: 0.35,
    halfWidth: 0.09,
  },
  // WHALE_ENVELOPE.length 5.05 (./whaleSpecies.ts); the widest hull of the
  // three is roughly a fifth of its length across.
  whale: {
    depthFraction: 0.5,
    minClearance: 0.7,
    minSubmergence: 0.7,
    halfLength: 2.53,
    halfWidth: 0.5,
  },
  // minClearance 0.8, NOT the 0.35 it shipped with (owner report 2026-08-14:
  // the angler "keeps clipping into the terrain"). The model's body ellipsoid
  // reaches 0.7 below the placement point (models.ts, ellipsoid(1, 0.7, 0.55))
  // and 0.35 honoured only half of that, so at depthFraction 0.88 the belly
  // sat inside the seabed — the one species that HUGS the bottom had the one
  // clearance smaller than its own lower half-height. 0.7 + 0.1 of visible
  // water under the belly restores the contract stated above the table.
  // Body ellipsoid(1, 0.7, 0.55) — see the clearance note above.
  deepsea: {
    depthFraction: 0.88,
    minClearance: 0.8,
    minSubmergence: 0.5,
    halfLength: 0.5,
    halfWidth: 0.28,
  },
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
 * Where a swimmer's origin PREFERS to sit between the seabed and the surface:
 * the depth fraction, clamped into the legal band (swimmerColumnBounds).
 *
 * This is the instantaneous answer — the depth for a seabed, with no history.
 * The render path does not call it directly; it calls `swimmerFrameY`, which
 * eases toward this and re-clamps, because a seabed quantised to terrace bands
 * makes this function's output step by a whole band as a creature crosses a
 * boundary. See SWIM_VERTICAL_WORLD_UNITS_PER_SECOND.
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
  const bounds = swimmerColumnBounds(seabedY, profile, modelScale);
  const column = SEA_SURFACE_WORLD_Y - seabedY;
  const preferred = SEA_SURFACE_WORLD_Y - profile.depthFraction * column;
  return Math.min(Math.max(preferred, bounds.lowest), bounds.highest);
}

/**
 * The band of world Y a swimmer's origin may occupy over a seabed at
 * `seabedY`: floor is the seabed plus its belly clearance, ceiling is the
 * surface less its dorsal submergence.
 *
 * SEPARATE FROM `swimmerWorldY` BECAUSE THE TWO ARE DIFFERENT KINDS OF RULE,
 * and keeping them apart is what lets the smoothing below exist. The preferred
 * depth is a PREFERENCE — a fish likes the light, a whale likes mid-water —
 * and something that can be eased toward over a second without anyone being
 * harmed. These two are HARD INVARIANTS: below the floor the body is inside
 * the seabed, above the ceiling it is out of the water. So the render path
 * eases toward the preference and then clamps to this band, and the clamp
 * always wins.
 *
 * When the water is too shallow to honour both (a whale over a sandbar) the
 * limits cross, and splitting the remaining column is the only answer that
 * keeps the creature inside the water at all; it degrades smoothly as the
 * water shallows rather than snapping when the two limits meet. Both halves of
 * the returned pair are that midpoint in that case, so a caller that clamps to
 * it lands exactly there without a special case of its own.
 */
export function swimmerColumnBounds(
  seabedY: number,
  profile: SwimProfile,
  modelScale: number,
): { readonly lowest: number; readonly highest: number } {
  const lowest = seabedY + profile.minClearance * modelScale;
  const highest = SEA_SURFACE_WORLD_Y - profile.minSubmergence * modelScale;
  if (highest < lowest) {
    const midpoint = seabedY + (SEA_SURFACE_WORLD_Y - seabedY) / 2;
    return { lowest: midpoint, highest: midpoint };
  }
  return { lowest, highest };
}

/**
 * How fast a swimmer's origin may rise or sink, in world units per second.
 *
 * ROOT CAUSE THIS FIXES (owner, 2026-08-24: sea creatures should "float
 * smoothly somewhere in between there without glitching up and down a level").
 * A swimmer's Y was a pure function of the seabed directly beneath it, and the
 * rendered seabed is QUANTISED TO TERRACE BANDS — so the instant a creature's
 * centre crossed a band boundary its whole depth recomputed against a seabed
 * that had just moved by a full band. Not a drift: a jump, every boundary, on
 * one frame. The owner's own framing is the fix — a creature "doesn't need to
 * follow the contour of the ground", it only may not clip into it or breach
 * the surface — so the preferred depth becomes something eased toward at this
 * rate, and the two things that genuinely must hold stay hard clamps
 * (swimmerColumnBounds).
 *
 * HALF A WORLD UNIT PER SECOND, which is two terrace bands a second (a band is
 * a quarter of a world unit at the client's current relief — see
 * MAX_TERRAIN_WORLD_Y). Sized against the animal that has the problem: a whale
 * cruises at 0.8 world units/s, so this is a gentle glide relative to its own
 * travel — visibly a fish rising, never a step — while still crossing the band
 * it just stepped over in half a second, long before the eye reads the depth
 * as wrong. It is a fixed rate rather than one scaled by species speed because
 * what it has to beat is a property of the TERRAIN (how often a band boundary
 * passes underneath), not of the swimmer.
 */
export const SWIM_VERTICAL_WORLD_UNITS_PER_SECOND = 0.5;

/**
 * World Y for a swimmer this frame: ease toward the depth it prefers, then
 * clamp to the depth it is allowed.
 *
 * `previousY` is the Y this creature was drawn at last frame, or null for one
 * that has just appeared — which starts at its preferred depth, because there
 * is no history to ease from and easing up from nowhere would read as the
 * creature surfacing.
 *
 * ORDER MATTERS: ease first, clamp second. Clamping the eased value means a
 * seabed that rises faster than SWIM_VERTICAL_WORLD_UNITS_PER_SECOND still
 * pushes the creature up immediately — the body never enters the ground, which
 * is the invariant — and the easing only ever governs the slack between the
 * clamps. Doing it the other way round would let a creature lag inside a bank.
 */
export function swimmerFrameY(
  previousY: number | null,
  seabedY: number,
  profile: SwimProfile,
  modelScale: number,
  dt: number,
): number {
  const preferred = swimmerWorldY(seabedY, profile, modelScale);
  const bounds = swimmerColumnBounds(seabedY, profile, modelScale);
  if (previousY === null) return preferred;

  const budget = SWIM_VERTICAL_WORLD_UNITS_PER_SECOND * Math.max(0, dt);
  const remaining = preferred - previousY;
  const eased = previousY + Math.max(-budget, Math.min(budget, remaining));
  return Math.min(Math.max(eased, bounds.lowest), bounds.highest);
}

/**
 * Seabed a swimmer is placed against: the HIGHEST rendered cell anywhere under
 * its BODY, not the single cell under its centre.
 *
 * The same argument `walkerGroundY` makes, and the same bug (owner, 2026-08-24:
 * whales "have a tendency to glitch into the seabed"). A whale is five world
 * units long; sampling one cell under its origin says nothing about the bank
 * its nose is already over, so its head entered the seabed a full body length
 * before its centre noticed. Sampling the nose, the tail and both flanks and
 * taking the shallowest reading means the whole hull clears every band it
 * overlaps.
 *
 * IT SAMPLES ALONG THE CREATURE'S FACING, which is why `heading` is required:
 * the footprint of a five-by-one body is a completely different set of cells
 * depending on which way it points, and a heading-agnostic disc would have to
 * use the LENGTH as its radius in every direction — making a whale rise for
 * banks a body length off its beam that it will never touch.
 *
 * The nose sample is also what buys the easing above its time: a whale meets a
 * rising bank two and a half units before its centre does, which at cruise
 * speed is roughly three seconds of warning — far more than the fraction of a
 * second SWIM_VERTICAL_WORLD_UNITS_PER_SECOND needs to lift it clear.
 */
/**
 * Where a swimmer's hull is sampled, as multipliers of its half-length (along
 * the heading) and half-width (across it): centre, nose, tail, both flanks.
 * Module-level so the per-frame call allocates nothing — an inline
 * `[[0, 0], …] as const` is type-only and rebuilt on every call.
 */
const HULL_SAMPLE_ALONG: readonly number[] = [0, 1, -1, 0, 0];
const HULL_SAMPLE_ACROSS: readonly number[] = [0, 0, 0, 1, -1];
const HULL_SAMPLE_COUNT = HULL_SAMPLE_ALONG.length;

export function swimmerSeabedY(
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
  heading: number,
  profile: SwimProfile,
  modelScale: number,
): number | null {
  // Model dimensions are WORLD UNITS; this steps in CELLS. One conversion, at
  // the boundary — the same trap WALKER_FOOTPRINT_HALF_EXTENT_CELLS names.
  const along = cellsAcross(profile.halfLength * modelScale);
  const across = cellsAcross(profile.halfWidth * modelScale);
  const forwardX = Math.cos(heading);
  const forwardY = Math.sin(heading);
  // Right-hand normal of the heading, so the two flank samples straddle the hull.
  const rightX = -forwardY;
  const rightY = forwardX;

  let seabed: number | null = null;
  for (let i = 0; i < HULL_SAMPLE_COUNT; i++) {
    const alongOffset = HULL_SAMPLE_ALONG[i]! * along;
    const acrossOffset = HULL_SAMPLE_ACROSS[i]! * across;
    const sampled = sampleRenderedY(
      Math.floor(x + forwardX * alongOffset + rightX * acrossOffset),
      Math.floor(y + forwardY * alongOffset + rightY * acrossOffset),
    );
    if (sampled !== null && (seabed === null || sampled > seabed)) seabed = sampled;
  }
  return seabed;
}

/**
 * World Y for one creature — the single entry point every placement kind is
 * answered through.
 *
 * `terrainY` is the ground/seabed height under it, and a SINGLE CELL SAMPLE IS
 * WRONG FOR EVERY KIND THAT READS IT: a walker uses `walkerGroundY`, a swimmer
 * uses `swimmerSeabedY`, both of which sample the body's whole footprint. Null
 * before the first snapshot arrives, and always for a flyer, which ignores it.
 *
 * `sizeClass` is required rather than defaulted: every creature has one, the
 * caller always knows it (it arrives on the wire with the entity), and a default
 * would silently place a large whale as if it were an adult — the exact class of
 * mistake swimmerWorldY's note describes.
 *
 * `previousY` and `dt` are the SWIMMER's frame history, and only a swimmer
 * reads them: a walker's feet and a flyer's altitude are functions of where it
 * is now, with nothing to ease. They default to "no history", which is the
 * honest answer for a caller asking what depth a seabed implies rather than
 * where to draw a creature this frame.
 */
export function creatureWorldY(
  species: WildlifeSpecies,
  terrainY: number | null,
  sizeClass: WildlifeSizeClass,
  previousY: number | null = null,
  dt = 0,
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
    : swimmerFrameY(previousY, surfaceY, profile, WILDLIFE_SIZE_MODEL_SCALE[sizeClass], dt);
}

/**
 * Half-extent of a walker's ground footprint, in WORLD UNITS.
 *
 * A grazer's body is ~0.44 world units long (client/models.ts: an 0.85 box with
 * a head reaching 0.67 ahead of centre, all of it at GRAZER_SCALE 0.4), so its
 * geometry overhangs its centre by ~0.27 units ahead and ~0.17 behind. Slightly
 * under the smaller of those (0.18) keeps the sample inside the body's true
 * extent, so the creature never rides up on a band it does not actually
 * overlap.
 *
 * IT MOVES WITH THE MODEL. It was 0.45 while the grazer was authored at 1.0
 * (owner shrank grazers to settler scale, 2026-08-24); left at 0.45 it would
 * have probed 2.5x the ground the animal covers, which is the same class of
 * error as the units bug below, only in the other direction.
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
export const WALKER_FOOTPRINT_HALF_EXTENT = 0.18;

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
/**
 * Where a walker's footprint is sampled, in cell offsets from its centre: the
 * centre and the four corners. Module-level for the same reason as
 * HULL_SAMPLE_ALONG — this runs once per walker per frame.
 */
const FOOTPRINT_SAMPLE_DX: readonly number[] = (() => {
  const h = WALKER_FOOTPRINT_HALF_EXTENT_CELLS;
  return [0, -h, -h, h, h];
})();
const FOOTPRINT_SAMPLE_DY: readonly number[] = (() => {
  const h = WALKER_FOOTPRINT_HALF_EXTENT_CELLS;
  return [0, -h, h, -h, h];
})();
const FOOTPRINT_SAMPLE_COUNT = FOOTPRINT_SAMPLE_DX.length;

export function walkerGroundY(
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
): number | null {
  let ground: number | null = null;
  for (let i = 0; i < FOOTPRINT_SAMPLE_COUNT; i++) {
    const sampled = sampleRenderedY(
      Math.floor(x + FOOTPRINT_SAMPLE_DX[i]!),
      Math.floor(y + FOOTPRINT_SAMPLE_DY[i]!),
    );
    if (sampled !== null && (ground === null || sampled > ground)) ground = sampled;
  }
  return ground;
}

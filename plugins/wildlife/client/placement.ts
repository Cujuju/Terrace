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

import {
  BAND_HEIGHT,
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  SEA_LEVEL,
  cellsAcross,
} from '@terrace/shared';
import {
  WILDLIFE_SIZE_MODEL_SCALE,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from '../protocol.ts';
// The models' own measurements. Every figure below that describes a BODY is
// read from here rather than restated: a model file that changes its anatomy
// changes the water column it is fitted into, in the same commit, or the two
// drift and nothing says so. See species/speciesModel.ts.
import { FISH_ENVELOPE } from './species/fish.ts';
import { RAY_ENVELOPE } from './species/ray.ts';
import { SHARK_ENVELOPE } from './species/shark.ts';
import { GRAZER_ENVELOPE } from './species/grazer.ts';
import { IBEX_ENVELOPE } from './species/ibex.ts';
import { BISON_ENVELOPE } from './species/bison.ts';

/**
 * Water a swimmer keeps between its own skin and the surface (or the seabed),
 * in world units, on top of the half-extent the clearance is derived from.
 *
 * READ OFF THE ROW IT REPLACES. The fish shipped with minSubmergence 0.3
 * against a body whose half-height was 0.13 at model scale 1 and 0.182 at the
 * large class (the arithmetic swimmerWorldY's note walks through) — 0.118 of
 * water above the crown. Rounded to 0.12, and used for the seabed side too:
 * the old fish row's 0.25 minClearance left only 0.068 there, which is less
 * visible water under a fish than above it for no reason anyone recorded.
 */
const WATER_MARGIN_WORLD_UNITS = 0.12;

/**
 * The size class every envelope-derived clearance below is measured at.
 *
 * THE BRIEF'S RULE, and it is deliberately conservative: a clearance is stated
 * at model scale 1 (see SwimProfile) and then multiplied by the class scale
 * again at use, so a figure taken at `large` submerges a large creature by
 * WILDLIFE_SIZE_MODEL_SCALE.large² of its crown rather than once.
 *
 * RESIDUAL, NAMED RATHER THAN HIDDEN (2026-09-02): the fish, ray and shark
 * rows therefore ask for more water than their bodies strictly need — a large
 * shark insists on 0.68 x 1.4 = 0.95 of water above its 0.56 crown. The effect
 * is never a body out of the water; it is that in a column shallower than
 * `minClearance + minSubmergence` the two limits cross and
 * swimmerColumnBounds' midpoint split takes over, which happens sooner for
 * these three than the geometry alone requires. The whale and deep-sea rows
 * are hand-set at scale 1 and are NOT changed here, so this constant is also
 * the one place the two conventions can be reconciled.
 */
const CLEARANCE_SIZE_CLASS: WildlifeSizeClass = 'large';
const CLEARANCE_MODEL_SCALE = WILDLIFE_SIZE_MODEL_SCALE[CLEARANCE_SIZE_CLASS];

/** A body half-extent turned into the water it insists on keeping past it. */
function clearanceFor(halfExtentAtScaleOne: number): number {
  return halfExtentAtScaleOne * CLEARANCE_MODEL_SCALE + WATER_MARGIN_WORLD_UNITS;
}

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
 * BOTH CLEARANCES ARE READ AT MODEL SCALE 1 — the `medium` class's scale by
 * definition (WILDLIFE_SIZE_MODEL_SCALE) — and multiplied by the drawn
 * creature's class scale at use (see swimmerWorldY). `depthFraction` is a
 * fraction of the water column and means the same thing at every size.
 *
 * WHAT GOES IN THE FIELD is not the same for every row. The whale and the
 * deep-sea creature are hand-set half-extents at scale 1; the fish, ray and
 * shark are derived from their model files' envelopes at CLEARANCE_SIZE_CLASS,
 * which is a class scale larger. See that constant for the named residual — it
 * is why those three rows read high against their own crowns.
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
   * A MODEL DIMENSION, exactly like WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES
   * further down,
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
  // Every figure but the depth fraction is FISH_ENVELOPE (species/fish.ts).
  fish: {
    // Unchanged: a fish sits just under the surface where the light is.
    depthFraction: 0.2,
    minClearance: clearanceFor(-FISH_ENVELOPE.bellyY), // anal fin, envelope bellyY
    minSubmergence: clearanceFor(FISH_ENVELOPE.crownY), // dorsal tip, envelope crownY
    halfLength: FISH_ENVELOPE.halfLength, // nose to caudal tip, envelope halfLength
    halfWidth: FISH_ENVELOPE.halfWidth, // widest station, envelope halfWidth
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
  ibex: null,
  bison: null,
  // The ray sits deepest of the shelf species because it rests on the seabed
  // (server/species/ray.ts's idle bouts); the shark cruises the middle of the
  // column. Both bodies are now MEASURED — the interim figures these rows
  // carried while the models were being authored in parallel are gone.
  ray: {
    depthFraction: 0.85,
    // A wing tip at the bottom of its beat, envelope bellyY.
    minClearance: clearanceFor(-RAY_ENVELOPE.bellyY),
    // A wing tip at the top of its beat plus the eyes, envelope crownY.
    minSubmergence: clearanceFor(RAY_ENVELOPE.crownY),
    halfLength: RAY_ENVELOPE.halfLength, // lobes to tail tip, envelope halfLength
    halfWidth: RAY_ENVELOPE.halfWidth, // half the wingspan, envelope halfWidth
  },
  shark: {
    depthFraction: 0.4,
    minClearance: clearanceFor(-SHARK_ENVELOPE.bellyY), // pectoral tip, envelope bellyY
    minSubmergence: clearanceFor(SHARK_ENVELOPE.crownY), // first dorsal, envelope crownY
    halfLength: SHARK_ENVELOPE.halfLength, // snout to caudal tip, envelope halfLength
    halfWidth: SHARK_ENVELOPE.halfWidth, // pectoral tips, envelope halfWidth
  },
  // Flyers have no water column either — see FLIGHT_ALTITUDES.
  bird: null,
};

// ── Flight ───────────────────────────────────────────────────────────────────

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
 * So the relief itself is what this is. It is IMPORTED rather than restated
 * since the constant moved into @terrace/shared (which a plugin can import from
 * either half, where client/src/config.ts cannot be reached from a server file),
 * so the named residual above is closed rather than merely recorded.
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
  ibex: null,
  bison: null,
  ray: null,
  shark: null,
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
 * Half-extent of each walker's ground footprint, in WORLD UNITS: half the
 * BODY's length (not the nose-to-tail length — a muzzle and a tail hang past
 * the feet and do not bear weight), read from the model file's envelope.
 *
 * ONE NUMBER PER SPECIES, not one for every walker. Until 2026-09-02 there was
 * a single WALKER_FOOTPRINT_HALF_EXTENT of 0.18, derived from the only walker
 * there was; a bison is nearly twice a grazer's body and an ibex a little under
 * it, so one constant would have had a bison probing a third of the ground it
 * covers — the same class of error as the units bug below, in the same
 * direction.
 *
 * IT MOVES WITH THE MODEL, and now it cannot fail to: `bodyHalfLength` is
 * measured in the file that draws the animal (species/grazer.ts and friends),
 * scale included, so a body that is re-proportioned re-proportions its probe in
 * the same commit.
 *
 * Null for anything that is not a walker. `walkerGroundY` is only ever reached
 * for a `PlacementKind` of 'walker', and it throws rather than guessing if that
 * ever stops being true.
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
 * The conversion still happens at the one boundary (`cellsAcross`, the
 * conversion every physical distance in this codebase is supposed to go
 * through) and the name still says which side of it a number is on.
 */
export const WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES: Readonly<
  Record<WildlifeSpecies, number | null>
> = {
  fish: null,
  whale: null,
  deepsea: null,
  grazer: GRAZER_ENVELOPE.bodyHalfLength, // envelope bodyHalfLength
  ibex: IBEX_ENVELOPE.bodyHalfLength, // envelope bodyHalfLength
  bison: BISON_ENVELOPE.bodyHalfLength, // envelope bodyHalfLength
  ray: null,
  shark: null,
  bird: null,
};

/** The same half-extents in the CELLS walkerGroundY steps in. Converted once. */
export const WALKER_FOOTPRINT_HALF_EXTENT_CELLS_BY_SPECIES: Readonly<
  Record<WildlifeSpecies, number | null>
> = Object.fromEntries(
  Object.entries(WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES).map(([species, halfExtent]) => [
    species,
    halfExtent === null ? null : cellsAcross(halfExtent),
  ]),
) as Readonly<Record<WildlifeSpecies, number | null>>;

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
 * Where a walker's footprint is sampled, as multipliers of its half-extent: the
 * centre and the four corners. Module-level for the same reason as
 * HULL_SAMPLE_ALONG — this runs once per walker per frame, and the half-extent
 * is now per species, so the offsets are unit and the scale is applied inside.
 */
const FOOTPRINT_SAMPLE_DX: readonly number[] = [0, -1, -1, 1, 1];
const FOOTPRINT_SAMPLE_DY: readonly number[] = [0, -1, 1, -1, 1];
const FOOTPRINT_SAMPLE_COUNT = FOOTPRINT_SAMPLE_DX.length;

export function walkerGroundY(
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
  species: WildlifeSpecies,
): number | null {
  const halfExtent = WALKER_FOOTPRINT_HALF_EXTENT_CELLS_BY_SPECIES[species];
  // Belt and suspenders: the render path only reaches here for a 'walker', and
  // every walker has a footprint. A species that gains legs without gaining a
  // row would otherwise silently probe a single cell — the clipping bug this
  // whole function exists to prevent.
  if (halfExtent === null) {
    throw new Error(`walkerGroundY: "${species}" is not a walker and has no ground footprint`);
  }
  let ground: number | null = null;
  for (let i = 0; i < FOOTPRINT_SAMPLE_COUNT; i++) {
    const sampled = sampleRenderedY(
      Math.floor(x + FOOTPRINT_SAMPLE_DX[i]! * halfExtent),
      Math.floor(y + FOOTPRINT_SAMPLE_DY[i]! * halfExtent),
    );
    if (sampled !== null && (ground === null || sampled > ground)) ground = sampled;
  }
  return ground;
}

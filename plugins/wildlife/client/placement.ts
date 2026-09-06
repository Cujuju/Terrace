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
import { EEL_ENVELOPE } from './species/eel.ts';
import { ANGELFISH_ENVELOPE } from './species/angelfish.ts';
import { GRAZER_ENVELOPE, GRAZER_STRIDE_WORLD_UNITS } from './species/grazer.ts';
// The per-species draw scale, in its own module so this file and ./models.ts
// can both read it: ./models.ts cannot import THIS file (placement already
// imports models for BIRD_ENVELOPE, and the cycle would leave one of the two
// reading a half-initialised module).
import { modelScaleFor, speciesModelScale } from './modelScale.ts';
import { followGroundY } from '../../../client/src/plugins/kit/groundFollow.ts';
import { WOLF_ENVELOPE, WOLF_STRIDE_WORLD_UNITS } from './species/wolf.ts';
import { IBEX_ENVELOPE, IBEX_STRIDE_WORLD_UNITS } from './species/ibex.ts';
import { BISON_ENVELOPE, BISON_STRIDE_WORLD_UNITS } from './species/bison.ts';
import { TWO_PI } from './species/speciesModel.ts';
import { DEEPSEA_ENVELOPE } from './species/deepsea.ts';
import { WHALE_ENVELOPE } from './whaleSpecies.ts';
import { BIRD_ENVELOPE } from './models.ts';

/** Visible water a swimmer keeps past its crown and belly, in world units. */
const WATER_MARGIN_WORLD_UNITS = 0.12;

/** 'medium' IS scale 1; swimmerColumnBounds applies the class scale itself, so deriving here at 'large' double-scaled. */
const CLEARANCE_SIZE_CLASS: WildlifeSizeClass = 'medium';
const CLEARANCE_MODEL_SCALE = WILDLIFE_SIZE_MODEL_SCALE[CLEARANCE_SIZE_CLASS];

/** A body half-extent turned into the water it insists on keeping past it. */
function clearanceFor(halfExtentAtScaleOne: number): number {
  return halfExtentAtScaleOne * CLEARANCE_MODEL_SCALE + WATER_MARGIN_WORLD_UNITS;
}

/** SEA_LEVEL is 0 by definition, so the sea surface is world Y 0. The `: 0` fails to compile if that changes. */
export const SEA_SURFACE_WORLD_Y: 0 = SEA_LEVEL;

/** World units at model scale 1, multiplied by class scale at use. Whale and deepsea rows are hand-set. */
export interface SwimProfile {
  /** 0 = at the surface, 1 = on the seabed. */
  readonly depthFraction: number;
  readonly minClearance: number;
  readonly minSubmergence: number;
  /** The hull footprint `swimmerSeabedY` samples over; not the server's bodyLengthCells. */
  readonly halfLength: number;
  readonly halfWidth: number;
}

export const SWIM_PROFILES: Readonly<Record<WildlifeSpecies, SwimProfile | null>> = {
  fish: {
    depthFraction: 0.2,
    minClearance: clearanceFor(-FISH_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(FISH_ENVELOPE.crownY),
    halfLength: FISH_ENVELOPE.halfLength,
    halfWidth: FISH_ENVELOPE.halfWidth,
  },
  // Hand-set against WHALE_ENVELOPE (crown 0.670, belly -0.575, length 5.05).
  whale: {
    depthFraction: 0.5,
    minClearance: 0.7,
    minSubmergence: 0.7,
    halfLength: 2.53,
    halfWidth: 0.5,
  },
  // Hand-set; minClearance covers the 0.35 belly plus visible water (owner report 2026-08-14).
  deepsea: {
    depthFraction: 0.88,
    minClearance: 0.8,
    minSubmergence: 0.5,
    halfLength: 0.5,
    halfWidth: 0.28,
  },
  // Land species stand on the ground; they have no water column to sit in.
  grazer: null,
  wolf: null,
  ibex: null,
  bison: null,
  // Ray and eel rest on the seabed (server idle bouts); shark and angelfish cruise mid-column.
  ray: {
    depthFraction: 0.85,
    minClearance: clearanceFor(-RAY_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(RAY_ENVELOPE.crownY),
    halfLength: RAY_ENVELOPE.halfLength,
    halfWidth: RAY_ENVELOPE.halfWidth,
  },
  shark: {
    depthFraction: 0.4,
    minClearance: clearanceFor(-SHARK_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(SHARK_ENVELOPE.crownY),
    halfLength: SHARK_ENVELOPE.halfLength,
    halfWidth: SHARK_ENVELOPE.halfWidth,
  },
  eel: {
    depthFraction: 0.8,
    minClearance: clearanceFor(-EEL_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(EEL_ENVELOPE.crownY),
    halfLength: EEL_ENVELOPE.halfLength,
    halfWidth: EEL_ENVELOPE.halfWidth,
  },
  angelfish: {
    depthFraction: 0.3,
    minClearance: clearanceFor(-ANGELFISH_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(ANGELFISH_ENVELOPE.crownY),
    halfLength: ANGELFISH_ENVELOPE.halfLength,
    halfWidth: ANGELFISH_ENVELOPE.halfWidth,
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
  wolf: null,
  ibex: null,
  bison: null,
  ray: null,
  shark: null,
  eel: null,
  angelfish: null,
  bird: BIRD_FLIGHT_WORLD_Y,
};

/**
 * The vertical span of a species' BODY about its model origin, in WORLD units
 * at model scale 1 — what anything drawn ON the creature (a flame, today:
 * MoverPose.bodyBottomY / bodyHeight) should cover.
 *
 * Two origin conventions, one table. Land species are authored with the origin
 * at their feet (creatureWorldY), so their belly line IS the origin and the
 * crown is the envelope height; swimmers and the bird are centre-origin, so
 * their envelopes already state both sides. Read from the model files, never
 * restated here, for the reason the SWIM_PROFILES header gives.
 */
export interface BodyColumn {
  readonly bellyY: number;
  readonly crownY: number;
}

export const BODY_COLUMNS: Readonly<Record<WildlifeSpecies, BodyColumn>> = {
  fish: { bellyY: FISH_ENVELOPE.bellyY, crownY: FISH_ENVELOPE.crownY },
  whale: { bellyY: WHALE_ENVELOPE.bellyY, crownY: WHALE_ENVELOPE.crownY },
  deepsea: { bellyY: DEEPSEA_ENVELOPE.bellyY, crownY: DEEPSEA_ENVELOPE.crownY },
  grazer: { bellyY: 0, crownY: GRAZER_ENVELOPE.height },
  wolf: { bellyY: 0, crownY: WOLF_ENVELOPE.height },
  ibex: { bellyY: 0, crownY: IBEX_ENVELOPE.height },
  bison: { bellyY: 0, crownY: BISON_ENVELOPE.height },
  ray: { bellyY: RAY_ENVELOPE.bellyY, crownY: RAY_ENVELOPE.crownY },
  shark: { bellyY: SHARK_ENVELOPE.bellyY, crownY: SHARK_ENVELOPE.crownY },
  eel: { bellyY: EEL_ENVELOPE.bellyY, crownY: EEL_ENVELOPE.crownY },
  angelfish: { bellyY: ANGELFISH_ENVELOPE.bellyY, crownY: ANGELFISH_ENVELOPE.crownY },
  bird: { bellyY: BIRD_ENVELOPE.bellyY, crownY: BIRD_ENVELOPE.crownY },
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
 * Preferred origin Y, no history: depth fraction clamped into swimmerColumnBounds.
 * `modelScale` is required: unscaled, a large whale's belly sat inside the seabed.
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

/** Hard invariants: seabed plus clearance, surface less submergence. Crossed limits return the column midpoint twice. */
export function swimmerColumnBounds(
  seabedY: number,
  profile: SwimProfile,
  modelScale: number,
): { readonly lowest: number; readonly highest: number } {
  // A "seabed" above the surface would put the crossed-limits midpoint in mid-air.
  seabedY = Math.min(seabedY, SEA_SURFACE_WORLD_Y);
  const lowest = seabedY + profile.minClearance * modelScale;
  const highest = SEA_SURFACE_WORLD_Y - profile.minSubmergence * modelScale;
  if (highest < lowest) {
    const midpoint = seabedY + (SEA_SURFACE_WORLD_Y - seabedY) / 2;
    return { lowest: midpoint, highest: midpoint };
  }
  return { lowest, highest };
}

/** The seabed is band-quantised, so un-eased depth jumps at every boundary. Two bands a second, fixed: terrain sets it. */
export const SWIM_VERTICAL_WORLD_UNITS_PER_SECOND = 0.5;

/**
 * Ease toward the preferred depth, THEN clamp: a bank rising faster than the
 * easing still pushes the body up at once. `previousY` null starts at preferred.
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

  // The ease is the kit's (client/src/plugins/kit/groundFollow.ts) at this
  // family's own rate; what stays here is the water column it is clamped into,
  // which is the only part that is about swimming. No snap: a swimmer's target
  // is a smooth function of the seabed, so a big gap is a big REAL change and
  // easing through it is the point.
  const eased = followGroundY(previousY, preferred, dt, SWIM_VERTICAL_WORLD_UNITS_PER_SECOND, Infinity);
  return Math.min(Math.max(eased, bounds.lowest), bounds.highest);
}

/** Hull sample offsets (centre, nose, tail, flanks) as half-extent multipliers. Module-level: no per-frame allocation. */
const HULL_SAMPLE_ALONG: readonly number[] = [0, 1, -1, 0, 0];
const HULL_SAMPLE_ACROSS: readonly number[] = [0, 0, 0, 1, -1];
const HULL_SAMPLE_COUNT = HULL_SAMPLE_ALONG.length;

/**
 * The highest rendered cell at or below the surface under the whole hull, sampled
 * along the heading. One cell under the centre let a whale's nose enter a bank first.
 */
export function swimmerSeabedY(
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
  heading: number,
  profile: SwimProfile,
  modelScale: number,
): number | null {
  // World units in, cells out: one conversion at the boundary.
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
    if (sampled === null) continue;
    // Land is not seabed: a flank sample on a cliff drew a ray halfway up the mountain.
    if (sampled > SEA_SURFACE_WORLD_Y) continue;
    if (seabed === null || sampled > seabed) seabed = sampled;
  }
  // All samples on land reads as "no seabed known"; the render path skips the frame.
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
  //
  // CHASED, NOT ASSIGNED (2026-09-05). `surfaceY` is band-quantised, so a
  // walker crossing a band boundary used to jump a whole BAND_WORLD_HEIGHT
  // between two frames. The kit's follower turns that step into a quarter
  // second of visible motion and leaves a spawn or a sculpt snapping, which is
  // what those should do.
  return profile === null
    ? followGroundY(previousY, surfaceY, dt)
    : swimmerFrameY(previousY, surfaceY, profile, modelScaleFor(species, sizeClass), dt);
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
  wolf: WOLF_ENVELOPE.bodyHalfLength, // envelope bodyHalfLength: the PAWS, not the tail
  ibex: IBEX_ENVELOPE.bodyHalfLength, // envelope bodyHalfLength
  bison: BISON_ENVELOPE.bodyHalfLength, // envelope bodyHalfLength
  ray: null,
  shark: null,
  eel: null,
  angelfish: null,
  bird: null,
};

/**
 * The ground one full leg cycle covers, in WORLD units, per walker — null for
 * anything without legs.
 *
 * THE GAIT IS PACED OFF GROUND COVERED, NOT THE CLOCK (owner, 2026-09-05: "we
 * seem to speed up the pace of the models as they move, but not the legs").
 * Every walk cycle used to be `sin(seconds * STRIDE_HZ * TWO_PI + phase)`, a
 * rate fixed per species whatever the body was doing — so a fleeing deer slid
 * across the ground at three times cruise on cruise-speed legs, and a bison in
 * an idle bout marched on the spot. index.ts now advances a walker's phase by
 * `walkerStrideRadians` each frame, from the distance it was actually drawn
 * moving, and a walker's `animate` reads its beat from that phase ALONE
 * (species/speciesModel.ts): three times the speed is three times the steps,
 * and no movement is no steps. Swimmers and flyers keep the clock — a fin beats
 * whether or not the fish is getting anywhere.
 *
 * Each value lives in the file that draws the animal, beside its swing and bob,
 * and is imported here the way the envelopes are: a re-proportioned model
 * re-paces its own gait in the same commit.
 */
export const WALKER_STRIDE_WORLD_UNITS_BY_SPECIES: Readonly<Record<WildlifeSpecies, number | null>> =
  {
    fish: null,
    whale: null,
    deepsea: null,
    grazer: GRAZER_STRIDE_WORLD_UNITS,
    wolf: WOLF_STRIDE_WORLD_UNITS,
    ibex: IBEX_STRIDE_WORLD_UNITS,
    bison: BISON_STRIDE_WORLD_UNITS,
    ray: null,
    shark: null,
    eel: null,
    angelfish: null,
    bird: null,
  };

/**
 * How far a walker's animation phase advances for `distanceWorldUnits` of
 * ground covered: one full turn per stride.
 *
 * THE DISTANCE IS THREE-DIMENSIONAL (2026-09-05). It was the horizontal hypot,
 * which reads the same as the 3D one on any ground a walker walks — and zero on
 * a CLIMB, where the mover's x/y are pinned at the foot of the wall and all of
 * the motion is vertical (shared/src/climb.ts). A climbing ibex therefore rose
 * up the cliff on frozen legs. See index.ts's stride call.
 *
 * Throws for a non-walker on the same belt-and-suspenders argument as
 * `walkerGroundY`: the render path only reaches here for a 'walker', and a
 * species that gained legs without gaining a row would otherwise walk on
 * frozen legs with nothing saying so.
 */
export function walkerStrideRadians(species: WildlifeSpecies, distanceWorldUnits: number): number {
  const stride = WALKER_STRIDE_WORLD_UNITS_BY_SPECIES[species];
  if (stride === null) {
    throw new Error(`walkerStrideRadians: "${species}" is not a walker and has no stride`);
  }
  // Legs drawn at `speciesModelScale` cover that much less ground per cycle, so
  // a re-sized animal takes proportionally more steps rather than gliding.
  return (distanceWorldUnits / (stride * speciesModelScale(species))) * TWO_PI;
}

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
  // The footprint is the DRAWN body's, not the authored one's: an animal drawn
  // smaller stands within less ground, and probing the authored extent would
  // pop it onto a riser its feet are nowhere near.
  const drawnHalfExtent = halfExtent * speciesModelScale(species);
  let ground: number | null = null;
  for (let i = 0; i < FOOTPRINT_SAMPLE_COUNT; i++) {
    const sampled = sampleRenderedY(
      Math.floor(x + FOOTPRINT_SAMPLE_DX[i]! * drawnHalfExtent),
      Math.floor(y + FOOTPRINT_SAMPLE_DY[i]! * drawnHalfExtent),
    );
    if (sampled !== null && (ground === null || sampled > ground)) ground = sampled;
  }
  return ground;
}

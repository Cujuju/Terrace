// Low-poly procedural buildings, drawn as INSTANCES — one InstancedMesh per
// (tier, part), exactly flora's "a tree is not an object" argument extended
// to six silhouettes instead of two.
//
// A building is a small fixed list of PARTS (a wall, a roof panel, a
// chimney...), each part pre-built as ONE geometry with one or more LOCAL
// transforms relative to the building's own origin (a mirrored roof panel is
// the same geometry placed twice, at +pitch and -pitch). Placing a whole
// building is: compose its own position/yaw/scale into a matrix once, then
// for every part, for every local transform, multiply the two together and
// write one instance. No per-part bookkeeping beyond that multiply — the
// shape of "a building" IS the list of (geometry, material, local transforms)
// triples, and nothing here cares what tier it belongs to beyond reading it
// off that list.
//
// SIX TIERS, EACH A DIFFERENT SILHOUETTE AND A DIFFERENT MATERIAL — the
// design brief's own bar, restated as a design table where every dimension
// and colour lives:
//
//   0 camp           canvas tent + campfire        lowest, roundest, warmest colour
//   1 hut             round wall + conical thatch   first solid drum
//   2 timber-house    box wall + gable roof         first hard edges (ridge roof)
//   3 longhouse       longer/lower box + chimney    widest footprint, low profile
//   4 stone-cottage   STONE wall + tile roof         first grey/stone material
//   5 watchtower      tall narrow tower + parapet    tallest, narrowest, first vertical silhouette
//
// Silhouette and material both move at every step — never scale alone — so
// the tiers stay legible from the game's orbit-camera distance the way
// flora's two tree kinds and monsters' three creatures do.
//
// The rules those plugins' models.ts files keep, kept here too: no per-object
// lights, and flat shading so a low-segment primitive reads as a deliberate
// faceted style rather than as low detail.
//
// TEXTURES AND EXTERNAL ASSETS ARE ALLOWED (owner, 2026-09-04, superseding
// this file's original "no textures, no external assets, everything generated
// in this file"). A tier may be an authored model loaded from a .glb instead
// of a list of primitives — tier 2 is the first, see IMPORTED_STRUCTURE_TIER
// below — and such a model brings its own textured material. Nothing else
// about the file changes: an imported tier arrives as the SAME
// (geometry, material, local transforms) list every procedural tier is, goes
// through the same merge and the same InstancedMesh allocation, and is bound
// by the same footprint contract. The procedural builder of a replaced tier
// stays in this file, marked superseded, because it is also the fallback when
// no asset is installed (a failed preload must not empty a tier).
//
// FIDELITY PASS (owner feedback: "these structures need more detail"): every
// tier below picked up a fixed set of PRIMITIVE detail beyond its original
// wall+roof — a door, and from timber-house up a pair of glowing windows, are
// now consistent across every house tier; camp gets a firepit ring and
// woodpile; the hut gets an eave ring and a smoke vent standing in for a
// chimney it is too primitive to have; timber-house gets corner posts and a
// ridge cap; longhouse and stone-cottage both get a chimney pot on top of
// their existing chimney, stone-cottage adds quoins at all four corners; the
// watchtower gets a ring of arrow slits, crenellations on its parapet, and a
// base plinth. Every one of these is still just another (geometry, material,
// local transforms) entry on the same tier list this file already builds —
// see "Fidelity-pass helpers" below for the shared ring/window plumbing.
//
// FIDELITY PASS 2026-08-20 (owner: from the game's orbit camera "a house
// reads as a brown tile with four spikes"): a second, heavier detail pass on
// all six tiers — same silhouettes, same material story, substantially more
// geometry. Gable roofs gain course strips through the gableRoof contract
// itself (GableRoof.courseMatrices, so no tier can forget its rows); every
// door gains a framed surround (doorFrameMatrices); and per tier: the camp a
// cooking spit and hide-pinning stones, the hut wattle bands, a second
// thatch-bundle course and a daub footing, the timber-house shutters and a
// lit loft gable, the longhouse exposed post-and-beam framing, eave posts,
// rear windows and loft lights, the stone-cottage window sills/lintels, a
// stone door surround, a chimney collar and rear windows, the watchtower
// corbels under its parapet, a door surround with threshold, an eave ring
// and a banner. All still fixed literal transforms on the same part lists.
//
// TRIANGLE BUDGET (this pass, per building — instanced, so per-tier totals
// multiply by however many standing structures roll that tier, bounded by
// STRUCTURES_CAP = 512):
//
//   tier            before   after
//   0 camp             260     404
//   1 hut              452     568
//   2 timber-house     736     928
//   3 longhouse        144     504
//   4 stone-cottage   1140    1428
//   5 watchtower       988    1196
//
// Worst legal case (512 structures, all the heaviest tier) is ~731k
// triangles, up from ~584k — the same order the terrain mesh itself costs,
// and segment counts stay at the file's 3–8 range throughout: the detail is
// bought with more PARTS, not rounder primitives.

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type InstancedBufferAttribute,
  type Material,
} from 'three';
// The render kit, reached by path exactly as plugins/boats reaches it — see
// that plugin's models.ts header. rigAsset.ts loads and validates the file;
// staticAsset.ts turns it into the part list this plugin already draws.
import {
  assertAssetFits,
  loadRigAsset,
  type RigAsset,
} from '../../../client/src/render/rigAsset.ts';
import { flattenAssetParts } from '../../../client/src/render/staticAsset.ts';
import { CELL_WORLD_SIZE, cellsAcross } from '@terrace/shared';
import {
  MAX_STRUCTURE_TIER,
  STRUCTURES_CAP,
  STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS,
  STRUCTURE_SURVEYED_GROUND_RADIUS,
  STRUCTURE_SCALE_MAX,
  STRUCTURE_TIER_COUNT,
  type SettlerRace,
  type StructureTier,
} from '../protocol.ts';
import { isDurandsCell } from './durands.ts';
import { FISHING_HUT_BUILDERS, fishingHutVariantIndex } from './fishingHuts.ts';
import {
  fitToRadius,
  mergeParts,
  mergeSharedSurface,
  partsStandingHeight,
  type StructurePart,
} from './parts.ts';
import type { SiteKind } from './site.ts';

// ── Shared build helpers ─────────────────────────────────────────────────────

const Z_AXIS = new Vector3(0, 0, 1);
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

/**
 * THE FOOTPRINT CONTRACT — how far, in X/Z, a tier's model may reach from its
 * own origin, measured on the UNSCALED model.
 *
 * WHY IT EXISTS. The server only ever promises one thing about the ground a
 * structure stands on: `suitability.ts`'s isBuildableCell says the cell AND
 * its four orthogonal neighbours quantise to the same terrace band. It says
 * NOTHING about the diagonals, and nothing at all about ground more than one
 * cell away. A model wider than its own cell is therefore standing on ground
 * nobody checked — and the terraced renderer draws a one-band step's outline
 * a quarter of a cell INSIDE the higher cell (client/src/terrain/vertexGrid.ts,
 * CONTOUR_SAMPLE_CLEARANCE), so an over-wide building hangs off the cliff it
 * was never told about. That is the "buildings straddle terrace edges" defect,
 * and it is a property of the model list, not of any one tier: the fix is a
 * bound every tier is measured against (test/models.test.ts asserts it), not a
 * hand-shrunk longhouse.
 *
 * WHY THIS VALUE — DERIVED, NOT STATED (2026-08-21). The ground a building
 * may need is STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS wide (protocol.ts): one
 * world unit, one terrace tread at the steepest legal slope — the tuned look.
 * Half of that is the largest reach that keeps a model strictly over its own
 * tread. Each building is then drawn at a per-cell variation scale of up to
 * STRUCTURE_SCALE_MAX (protocol.ts), which multiplies that reach, so the
 * bound on the UNSCALED model has to be divided by it:
 * 0.5 / 1.1 ≈ 0.4545 world units. The biggest building the game can roll is
 * then exactly one world unit wide. The server's suitability check derives
 * ITS neighbourhood from this same span via cellsAcross(), so the two sides
 * cannot drift apart however finely the world is sampled — before the
 * 2026-08-21 re-sample they agreed only because a cell happened to be one
 * world unit, which is what let the server end up checking less ground than
 * the widest model covers.
 */
export const STRUCTURE_FOOTPRINT_RADIUS =
  STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS / 2 / STRUCTURE_SCALE_MAX;

function lambert(color: number, options: { emissive?: number } = {}): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true, emissive: options.emissive ?? 0x000000 });
}

// ── The imported tier: an authored .glb where a tier used to be primitives ───
//
// Owner decision 2026-09-04: a plugin may ship external model assets. Tier 2
// is the first one taken up on it — see IMPORTED_STRUCTURE_TIER for why that
// tier, and the file banner for what does and does not change.

/**
 * Which tier is drawn from the .glb rather than built from primitives.
 *
 * TIER 2, THE TIMBER-HOUSE. The asset is a timber-framed cottage with a gable
 * roof and a chimney (see assets/LICENSES.md), which is tier 2's own design
 * line — "box wall + gable roof, first hard edges" — rather than an
 * approximation of one. It is not tier 4: the stone-cottage's identity in the
 * progression is its MATERIAL BREAK to stone (see the tier table above), and
 * an imported timber house standing in for it would erase the one step in the
 * six that changes material rather than shape.
 */
const IMPORTED_STRUCTURE_TIER = 2;

/**
 * The scale from an asset's own units to this plugin's model space.
 *
 * ASSETS ARE AUTHORED IN CELLS (docs/model-assets.md: "units are cells, 1 unit
 * = 1 cell") and every local matrix in this file is in WORLD UNITS — the frame
 * a building matrix is composed in, which is why STRUCTURE_FOOTPRINT_RADIUS
 * above is stated in world units. One cell is CELL_WORLD_SIZE world units, so
 * this is the whole of the conversion. Get it wrong and the error is a factor
 * of WORLD_UNIT_CELLS (four today): a cottage four times too big, or a doll's
 * house. Derived from shared rather than written as 0.25 because the world's
 * sampling density has already changed once (2026-08-21).
 */
const ASSET_UNITS_TO_MODEL_UNITS = CELL_WORLD_SIZE;

/**
 * How tall, in WORLD UNITS, the tallest procedural tier stands: the
 * watchtower's spire apex — tower 1.3 + parapet 0.14 + roof 0.4 (tier 5's own
 * constants, below).
 *
 * It is the CEILING an imported model is measured against, so no downloaded
 * building can tower over the game's own tallest silhouette. Stated here and
 * VERIFIED against the built models on every attach (see createStructureModels)
 * rather than merely stated, because a number copied out of another block goes
 * stale the moment that block is edited — and stale HIGH is a licence for an
 * asset to dwarf every building in the game.
 */
const TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS = 1.84;

/**
 * The budget an imported building must fit, in CELLS — the unit
 * assertAssetFits measures in (rigAsset.ts).
 *
 * x and z are the footprint contract restated for an asset: a tier may reach
 * STRUCTURE_FOOTPRINT_RADIUS from its origin in either direction, so the whole
 * model spans twice that, converted from world units to cells by cellsAcross()
 * — the same conversion the server's own suitability check uses, so the two
 * sides of the footprint contract still cannot drift apart. y is the height
 * ceiling above.
 */
const IMPORTED_STRUCTURE_FOOTPRINT_CELLS = {
  x: cellsAcross(STRUCTURE_FOOTPRINT_RADIUS * 2),
  z: cellsAcross(STRUCTURE_FOOTPRINT_RADIUS * 2),
  y: cellsAcross(TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS),
};

/**
 * The loaded building asset, or null until preloadStructureModels installs one.
 *
 * MODULE-SCOPED AND NEVER DISPOSED BY THIS PLUGIN'S dispose(), which is the
 * whole of the ownership design (D3). The asset owns its geometries, materials
 * and textures; createStructureModels takes CLONES of them (see
 * importedStructureParts) so that everything it pushes into its own dispose
 * lists is its own, and mergeParts — which disposes what it is handed — never
 * sees an asset-owned object. The alternative, tracking asset parts separately
 * so dispose() could free the asset after the meshes, buys nothing: the file is
 * ~180 KB and one settlement's worth of buildings re-mounts the plugin many
 * times a session, so re-loading it per attach would be strictly worse.
 */
let importedBuildingAsset: RigAsset | null = null;

/**
 * Loads the tier-2 building asset before attach — the plugin's preload().
 *
 * A rejected load leaves the previous asset (or none) installed and is a
 * logged breach for this plugin alone: buildTierParts falls back to the
 * procedural timber-house, so the settlement still stands.
 */
export async function preloadStructureModels(url: string): Promise<void> {
  installStructureAsset(await loadRigAsset(url));
}

/**
 * Installs an already-parsed asset: the node path (bytes off disk plus
 * parseRigAsset), used by the verification scripts and the tests.
 *
 * The fit check lives HERE rather than in preloadStructureModels for boats'
 * reason (installBoatKit): a file that passes offline must be the same file
 * that passes in the browser, and it would not be if the two paths checked
 * different things.
 */
export function installStructureAsset(asset: RigAsset): void {
  // Measured BEFORE anything is assigned, so a model that overruns its plot
  // cannot replace a good one. The shared error already names the axis and
  // the number; what it cannot say is why this budget is the budget.
  try {
    assertAssetFits(asset, IMPORTED_STRUCTURE_FOOTPRINT_CELLS);
  } catch (cause) {
    throw new Error(
      `structure asset: the model breaks the footprint contract — a building must stand ` +
        `strictly over the ground the server surveys for it (see STRUCTURE_FOOTPRINT_RADIUS)`,
      { cause },
    );
  }
  importedBuildingAsset = asset;
}

/**
 * The imported tier as parts in this file's own model space, or null when no
 * asset is installed (the caller falls back to the procedural builder).
 *
 * THREE STEPS, IN THIS ORDER, AND EACH IS LOAD-BEARING:
 *
 *   1. flattenAssetParts turns the file's meshes into (geometry, material,
 *      local matrices) — ASSET-OWNED objects (staticAsset.ts's ownership rule);
 *   2. every part is copied, geometry and material both, because the merge this
 *      list is about to go through disposes what it is handed, and the asset's
 *      own buffers must outlive it. Material.clone() shares the TEXTURE objects
 *      rather than duplicating them, and three's Material.dispose() does not
 *      free a texture, so the texels stay owned by the asset exactly as
 *      staticAsset.ts requires;
 *   3. the asset's cell units become world units, and the result is passed
 *      through the same radial fit Durand's uses — a model may fit its
 *      axis-aligned footprint and still swing a corner over unsurveyed ground
 *      once the placement yaw turns it (parts.ts's partsRadialReach). A no-op
 *      for a model that already fits, which this one does.
 */
function importedStructureParts(): StructurePart[] | null {
  if (importedBuildingAsset === null) return null;
  const scale = new Matrix4().makeScale(
    ASSET_UNITS_TO_MODEL_UNITS,
    ASSET_UNITS_TO_MODEL_UNITS,
    ASSET_UNITS_TO_MODEL_UNITS,
  );
  const owned = flattenAssetParts(importedBuildingAsset).map((part) => ({
    geometry: part.geometry.clone(),
    material: part.material.clone(),
    localMatrices: part.localMatrices.map((local) =>
      new Matrix4().multiplyMatrices(scale, local),
    ),
  }));
  return fitToRadius(owned, STRUCTURE_SURVEYED_GROUND_RADIUS / STRUCTURE_SCALE_MAX);
}

// ── Fidelity-pass helpers ────────────────────────────────────────────────────
//
// Everything below this line was added for the "more detail per tier" pass:
// doors, windows, chimney pots, framing, quoins, crenellations. All of it
// keeps the file's two hard rules — every added element is one more LOCAL
// transform (or one more part) on the same fixed list every tier already is
// (see the file banner), and every local transform below is a FIXED literal,
// never derived from a per-cell hash: the only source of per-building
// variation anywhere in this plugin stays structureVariation's yaw/scale roll
// (protocol.ts) plus durands.ts's skin roll, both already spent before this
// file ever runs. A ring of firepit stones or crenellations is the same shape
// on every camp or every watchtower, exactly as every hut's cone roof already
// was.

/** One full turn. A second copy of DURANDS_TWO_PI (below) scoped to this
 * section deliberately: that constant is Durand's own flash-timing constant,
 * and reusing it here for ring geometry would make an unrelated future edit
 * to the sign's timing silently reach into the tower's crenellation layout. */
const FULL_TURN_RADIANS = Math.PI * 2;

/**
 * `count` local transforms evenly spaced around a circle of `radius` at
 * height `y`, centred on the building's own origin — the shared building
 * block behind every "ring of small repeated details" this pass adds
 * (firepit stones, arrow slits, crenellations). `faceOutward` yaws each
 * instance so its local +Z axis points away from the circle's centre, for
 * parts (like the tower's arrow slits) whose geometry has a front face that
 * needs to face out through the wall rather than whatever way the building
 * yaws.
 */
function circleRingMatrices(
  count: number,
  radius: number,
  y: number,
  faceOutward: boolean,
  startAngleRadians = 0,
): Matrix4[] {
  const matrices: Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const angle = startAngleRadians + (FULL_TURN_RADIANS * i) / count;
    const position = new Vector3(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
    const rotation = faceOutward ? new Quaternion().setFromAxisAngle(Y_AXIS, angle) : new Quaternion();
    matrices.push(new Matrix4().compose(position, rotation, new Vector3(1, 1, 1)));
  }
  return matrices;
}

/**
 * Every box-walled house tier (timber-house, longhouse, stone-cottage) and
 * Durand's put their door and windows on the +Z face. Picking that once,
 * here, means every tier's "front" reads the same way rather than each
 * tier's block choosing an axis on its own — the same reasoning the file
 * banner gives for moving silhouette AND material together at every tier:
 * consistency is a property of the whole set, not of one entry in it.
 */

/**
 * Warm interior lamplight glow shared by every house tier's windows from
 * timber-house up (round tiers — camp and hut — read as lived-in through
 * their fire/smoke-vent instead; a lit window on a canvas tent would not
 * read as glass). One colour at every tier keeps the "habitation" cue
 * legible as the same cue everywhere it appears, exactly like the file
 * banner's silhouette-and-material rule. Static — only Durand's sign and
 * marquee pulse via animate(); a window is simply lit or not.
 */
const WINDOW_GLOW_COLOR = 0xffcf7a;
const WINDOW_FRAME_COLOR = 0x2a1c10;
/**
 * Restrained on purpose: bright enough to read as "lit" without competing
 * with Durand's own sign, the one emissive element in this plugin meant to
 * be the eye's focal point (see DURANDS_SIGN_EMISSIVE_MAX's own comment).
 */
const WINDOW_EMISSIVE_INTENSITY = 0.5;

/** A fresh window material — every tier gets its own instance (see dispose(), which walks the flat `materials` array once per part) rather than sharing one object across tiers. */
function windowMaterial(): MeshLambertMaterial {
  return new MeshLambertMaterial({
    color: WINDOW_FRAME_COLOR,
    flatShading: true,
    emissive: WINDOW_GLOW_COLOR,
    emissiveIntensity: WINDOW_EMISSIVE_INTENSITY,
  });
}

/** A matrix that only translates — the common case for a single-instance part. */
function at(x: number, y: number, z: number): Matrix4 {
  return new Matrix4().makeTranslation(x, y, z);
}

// ── The gable-roof contract ──────────────────────────────────────────────────
//
// A GABLE ROOF IS FOUR THINGS, NOT ONE. Two sloped panels, the two TYMPANUM
// triangles that close the wall between the wall-top and the ridge at either
// end, and a ridge cap over the seam where the panels meet. Until this pass
// only the panels existed, and every gable tier (timber-house, longhouse,
// stone-cottage) shipped with two open triangles you could see straight
// through — the owner's "missing sections", reproduced in-world at game camera
// distance on all three tiers.
//
// The root cause is not that three tiers each forgot the same detail; it is
// that the helper handed out one quarter of a roof and left the rest as
// something each tier had to remember. So `gableRoof` below returns the WHOLE
// roof — panels, ends and ridge cap — as one value. A tier cannot build half a
// gable any more, because there is no longer a call that returns half of one.

/** Half-base of the unit triangular prism `TRIANGLE_PRISM_UNIT` builds, at radius 1: sin(120°). */
const TRIANGLE_PRISM_HALF_BASE = Math.sqrt(3) / 2;
/** Apex-to-base height of that same unit triangle: 1 (apex) + 0.5 (base) = 1.5. */
const TRIANGLE_PRISM_HEIGHT = 1.5;
/** How far the unit triangle's base sits below the geometry's own origin, as a fraction of its height. */
const TRIANGLE_PRISM_BASE_FRACTION = 0.5 / TRIANGLE_PRISM_HEIGHT;

/**
 * Lays the unit prism's triangular cross-section flat in the XY plane, apex
 * up, with the prism's length running along Z. A CylinderGeometry with three
 * radial segments IS a triangular prism — its "circle" is a triangle with
 * vertices at 0°, 120° and 240° — the same primitive-reuse trick the teepee's
 * door already leans on, one axis-swap further.
 */
const TRIANGLE_PRISM_LIE_FLAT = new Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2);

/**
 * One isoceles triangle standing in the XZ-normal plane at `z`: `halfBase`
 * wide, `rise` tall, `thickness` deep, its BASE resting on `baseY`. Every
 * dimension comes from a scale on the shared unit prism, so a gable end costs
 * one more local transform on one more part rather than a bespoke geometry per
 * tier (the file banner's own rule).
 *
 * Scale axes are in the prism's ORIGINAL (pre-rotation) frame, because
 * Matrix4.compose applies scale before rotation: the cylinder's X is the
 * triangle's width, its Z is the triangle's height, and its Y — the extrusion
 * axis — is the thickness.
 */
function trianglePrismMatrix(
  halfBase: number,
  rise: number,
  thickness: number,
  baseY: number,
  z: number,
): Matrix4 {
  return new Matrix4().compose(
    new Vector3(0, baseY + rise * TRIANGLE_PRISM_BASE_FRACTION, z),
    TRIANGLE_PRISM_LIE_FLAT,
    new Vector3(halfBase / TRIANGLE_PRISM_HALF_BASE, thickness, rise / TRIANGLE_PRISM_HEIGHT),
  );
}

/** Everything a gable roof is made of, in the frame the tier asked for. */
interface GableRoof {
  /** Local-X length of the panel box geometry — its slope, eave to ridge. */
  readonly slopeLength: number;
  /** Local-Z length of the panel box geometry — the roof's run along the ridge. */
  readonly panelLength: number;
  /** Two panels, mirrored about the ridge. */
  readonly panelMatrices: Matrix4[];
  /** Two tympanum triangles, one at each end of the ridge. */
  readonly endMatrices: Matrix4[];
  /** One cap over the ridge seam. */
  readonly ridgeCapMatrices: Matrix4[];
  /** World Y of the ridge line. */
  readonly ridgeY: number;
  /**
   * FIDELITY PASS 2026-08-20 (owner: from the orbit camera "a house reads as
   * a brown tile with four spikes"): course strips laid ON the panels —
   * ROOF_COURSES_PER_PANEL strips per panel, eave to ridge, each standing a
   * hair proud of the panel face with a joint gap between rows, so a roof
   * reads as SHINGLE/PLANK/TILE COURSES rather than as one flat slab. Same
   * "the helper returns the WHOLE roof" contract as the endMatrices above: a
   * tier that draws its roof from gableRoof gets course lines by adding ONE
   * part, and cannot get the strip arithmetic wrong per tier.
   */
  readonly courseMatrices: Matrix4[];
  /** Local-X length of one course strip's box geometry (its run down the slope). */
  readonly courseSlopeLength: number;
}

/** How thick the tympanum slab is. Thin enough to read as a gable wall, thick enough for flat shading to catch it. */
const GABLE_END_THICKNESS = 0.04;
/**
 * FIDELITY PASS 2026-08-20: rows of course strips per roof panel. Four is the
 * fewest that still reads as "rows of shingles" rather than "a stripe" at the
 * orbit camera's distance; more would multiply instances across every gable
 * tier for detail the camera cannot resolve.
 */
const ROOF_COURSES_PER_PANEL = 4;
/**
 * Fraction of each course's slot left open between rows, exactly
 * STONE_JOINT_FRACTION's trick recoloured: the panel underneath shows through
 * the gap as a shadow line, which is what draws the course boundaries under
 * flat shading. Larger than the stone joints (0.06) because a roof is seen at
 * a shallower angle than a wall — a thinner gap forecloses to nothing.
 */
const ROOF_COURSE_JOINT_FRACTION = 0.14;
/** How far a course strip stands proud of the panel face beneath it — enough to cast a flat-shaded step, never enough to read as a second roof. */
const ROOF_COURSE_PROUD = 0.012;
/** Thickness of one course strip. Thinner than the panel so the eave edge reads as layered courses, not a doubled slab. */
const ROOF_COURSE_THICKNESS = 0.02;
/** How thick a roof panel is. One value for every gable tier, so their roofs read as the same construction. */
const GABLE_PANEL_THICKNESS = 0.05;
/** Half-width of the ridge cap tile, across the ridge line. */
const GABLE_RIDGE_CAP_HALF_WIDTH = 0.035;
/** Height of the ridge cap tile. */
const GABLE_RIDGE_CAP_HEIGHT = 0.045;

/**
 * The whole roof. `halfSpan` is centre-to-eave in the SLOPE direction (wall
 * half-width plus the eave overhang); `halfLength` is centre-to-eave along the
 * RIDGE; `wallHalfLength` is the wall's own half-extent along the ridge, which
 * is where the tympanum triangles stand.
 *
 * `ridgeAlongX` yaws the finished roof a quarter turn so the ridge runs along
 * the building's X axis instead of its Z. The longhouse needs it: a hall's
 * ridge runs down its LENGTH, and before this pass the longhouse's ridge ran
 * across its short axis, which is why its roof read as a shallow slab draped
 * over the wrong axis rather than as a hall.
 *
 * The tympanum's half-base is `halfSpan`, not the wall's own half-width, so
 * its two sloping edges lie exactly ON the panels' centre planes: the triangle
 * is then half-embedded in the panels at every point along both edges, which
 * is a seam that cannot open however the numbers are re-tuned. Sizing it to
 * the wall instead would make its edges STEEPER than the roof and poke them
 * out through the panels' top faces.
 */
function gableRoof(
  halfSpan: number,
  ridgeRise: number,
  wallTopY: number,
  halfLength: number,
  wallHalfLength: number,
  ridgeAlongX: boolean,
): GableRoof {
  const slopeLength = Math.hypot(halfSpan, ridgeRise);
  const panelMatrices: Matrix4[] = [];
  const courseMatrices: Matrix4[] = [];
  for (const sign of [1, -1] as const) {
    // Each side is computed independently from its own (dx, dy) direction
    // rather than mirrored off the other: half the arithmetic, and a bug in
    // one side cannot silently be "the same bug, mirrored" in the other.
    const angle = Math.atan2(-ridgeRise, sign * halfSpan);
    const rotation = new Quaternion().setFromAxisAngle(Z_AXIS, angle);
    const center = new Vector3((sign * halfSpan) / 2, wallTopY + ridgeRise / 2, 0);
    panelMatrices.push(new Matrix4().compose(center, rotation, new Vector3(1, 1, 1)));

    // FIDELITY PASS 2026-08-20: course strips down this panel's slope (see
    // GableRoof.courseMatrices). The strip plane's axes are the panel's own,
    // recovered from the same angle: local +X runs down the slope, local +Y
    // is the panel's normal — which for the sign = -1 panel comes out of the
    // raw rotation POINTING DOWN (its angle lands in the second quadrant, so
    // cos(angle) < 0), and offsetting along it as-is buried that panel's
    // whole course set inside the roof void (seen in preview 2026-08-20: the
    // longhouse's camera-facing slope, which IS the -1 panel after the
    // quarter turn, rendered as the bare slab this pass exists to fix).
    // Negating the down case pins the offset to the SKYWARD normal on both
    // panels.
    const slopeDirection = new Vector3(Math.cos(angle), Math.sin(angle), 0);
    const panelNormal = new Vector3(-Math.sin(angle), Math.cos(angle), 0);
    if (panelNormal.y < 0) panelNormal.negate();
    const courseCenterOffset = GABLE_PANEL_THICKNESS / 2 + ROOF_COURSE_PROUD;
    for (let course = 0; course < ROOF_COURSES_PER_PANEL; course++) {
      const alongSlope = -slopeLength / 2 + (slopeLength * (course + 0.5)) / ROOF_COURSES_PER_PANEL;
      const position = center
        .clone()
        .addScaledVector(slopeDirection, alongSlope)
        .addScaledVector(panelNormal, courseCenterOffset);
      courseMatrices.push(new Matrix4().compose(position, rotation.clone(), new Vector3(1, 1, 1)));
    }
  }

  const endMatrices = [wallHalfLength, -wallHalfLength].map((z) =>
    trianglePrismMatrix(halfSpan, ridgeRise, GABLE_END_THICKNESS, wallTopY, z),
  );

  const ridgeCapMatrices = [at(0, wallTopY + ridgeRise - GABLE_RIDGE_CAP_HEIGHT / 2, 0)];

  if (ridgeAlongX) {
    const quarterTurn = new Matrix4().makeRotationY(Math.PI / 2);
    for (const list of [panelMatrices, endMatrices, ridgeCapMatrices, courseMatrices]) {
      for (const matrix of list) matrix.premultiply(quarterTurn);
    }
  }

  return {
    slopeLength,
    panelLength: halfLength * 2,
    panelMatrices,
    endMatrices,
    ridgeCapMatrices,
    ridgeY: wallTopY + ridgeRise,
    courseMatrices,
    courseSlopeLength: (slopeLength / ROOF_COURSES_PER_PANEL) * (1 - ROOF_COURSE_JOINT_FRACTION),
  };
}

// ── Remodel-pass helpers ─────────────────────────────────────────────────────
//
// Added for the owner's per-tier remodel notes (teepee camp, thatched hut,
// log-course timber walls, a longer longhouse, coursed-stone cottage and
// tower, a recentred sign). Same discipline as the fidelity pass above: every
// addition is still just another (geometry, material, local transforms) entry
// on a tier's fixed list, and every transform below is a FIXED literal, never
// a per-cell hash roll.

/**
 * A tube segment BETWEEN two arbitrary 3D points: midpoint, length and
 * orientation are all derived from the endpoints, so a building is authored
 * as a joint skeleton rather than as hand-placed matrices — the same
 * "endpoints, not eyeballed transforms" trick dancerSegment (below, in the
 * Durand's section) already uses, generalised from dancerSegment's fixed-Z
 * 2D plane to full 3D: the teepee's lodge-poles and the timber-house's log
 * courses both need segments that leave that one plane, which is exactly
 * what dancerSegment was written not to need. `unitLength` is the shared
 * segment geometry's own built length; the returned matrix's Y-scale
 * stretches it to the endpoints' actual distance.
 */
function segmentMatrix(from: Vector3, to: Vector3, unitLength: number): Matrix4 {
  const direction = new Vector3().subVectors(to, from);
  const length = direction.length();
  const midpoint = new Vector3().addVectors(from, to).multiplyScalar(0.5);
  const rotation = new Quaternion().setFromUnitVectors(Y_AXIS, direction.normalize());
  return new Matrix4().compose(midpoint, rotation, new Vector3(1, length / unitLength, 1));
}

/**
 * The coursed-stone impression shared by the stone-cottage's flat walls and
 * the watchtower's round one (owner: "consistent shades, so cottage and
 * tower read as the same masonry era"): three grey-tan shades, cycling by a
 * FIXED (course + position) pattern so the mix of shades is the same on
 * every building of either tier — the same "one fixed layout, shared by
 * every building" rule every ring above already keeps, just for colour
 * instead of position. Both tiers build their own fresh MeshLambertMaterial
 * per shade (see stoneMaterial below) rather than sharing one material
 * object across tiers, matching windowMaterial's own "every tier gets its
 * own instance" convention — dispose() only has to walk one flat list either
 * way, and nothing here risks a double-dispose of a shared object.
 */
const STONE_SHADE_COLORS: readonly [number, number, number] = [0x9c968c, 0x8b8b86, 0x76736c];

/**
 * What shows through the joints between the blocks: the wall box UNDER the
 * veneer is painted this, not a stone shade. Darker than every shade above so
 * a joint reads as a shadow line — the cheapest way to make a field of blocks
 * read as one wall rather than as loose tiles, and the reason the veneer can
 * now cover the whole face without the joints disappearing.
 */
const STONE_MORTAR_COLOR = 0x55524c;

/** A fresh material for one of the three shared stone shades — see STONE_SHADE_COLORS. */
function stoneMaterial(shadeIndex: number): MeshLambertMaterial {
  return lambert(STONE_SHADE_COLORS[shadeIndex]);
}

/** One instance of a coursed-stone block: its local matrix plus which of the three shared shades it belongs to. */
interface StoneBlock {
  readonly matrix: Matrix4;
  readonly shadeIndex: number;
}

/**
 * How much of a block's own slot the mortar joint takes, as a fraction of the
 * slot's width and of the course's height. Small on purpose: a wall is mostly
 * STONE with thin dark lines between the blocks, and the previous 0.14 read at
 * game distance as scattered tiles glued to a bare wall rather than as a
 * coursed face (owner: "missing sections"). The wall box behind the veneer is
 * painted STONE_MORTAR_COLOR, so what shows through the joint is a shadow line,
 * not the wall's own colour.
 */
const STONE_JOINT_FRACTION = 0.06;

/**
 * A grid of small, slightly proud stone blocks tiling one FLAT rectangular
 * wall face — the stone-cottage's four walls. `faceHalfWidth` is the face's
 * own half-span along whichever axis it runs; `fixedAxis`/`fixedValue` place
 * the face's plane (the wall's `x = ±wallHalfWidth` faces use fixedAxis 'x',
 * its `z = ±wallDepth/2` faces use 'z'). Column count is the closest whole
 * divisor of the face's width to `STONE_BLOCK_TARGET_WIDTH` — the same
 * "target spacing, actual count is the nearest divisor" trick
 * DURANDS_MARQUEE_BULB_TARGET_SPACING already uses for the marquee bulb
 * ring — so blocks tile edge-to-edge with no fractional remainder, whatever
 * the face's own width happens to be.
 *
 * EVERY COURSE SPANS THE WHOLE FACE, edge to edge. Alternate courses are
 * staggered by half a slot (the running bond real coursed masonry has), and a
 * staggered course closes both its ends with a HALF block rather than simply
 * dropping one column: dropping it left a half-slot hole at both ends of every
 * other course, which is what made the cottage's corners read as bites taken
 * out of the wall. Each block's own width is baked into its matrix here, which
 * is what makes the half-width end blocks possible at all — one shared scale
 * applied by the caller could only ever describe one block size per face.
 */
function stoneBlocksForFace(
  faceHalfWidth: number,
  wallHeight: number,
  courseCount: number,
  fixedAxis: 'x' | 'z',
  fixedValue: number,
  targetBlockWidth: number,
): StoneBlock[] {
  const faceWidth = faceHalfWidth * 2;
  const columnCount = Math.max(2, Math.round(faceWidth / targetBlockWidth));
  const slotWidth = faceWidth / columnCount;
  const rowHeight = wallHeight / courseCount;
  const blockHeight = rowHeight * (1 - STONE_JOINT_FRACTION);
  // Rotate the block geometry (authored flat against a 'z'-normal face, its
  // own local X spanning the face's width) a quarter turn for an 'x'-normal
  // face, so its width axis becomes Z instead of X.
  const rotation = new Quaternion().setFromAxisAngle(Y_AXIS, fixedAxis === 'x' ? Math.PI / 2 : 0);

  const blocks: StoneBlock[] = [];
  for (let course = 0; course < courseCount; course++) {
    const staggered = course % 2 === 1;
    const y = rowHeight * (course + 0.5);
    // (centre-along-the-face, slot width) per block of this course.
    const slots: Array<[number, number]> = [];
    if (staggered) {
      slots.push([-faceHalfWidth + slotWidth / 4, slotWidth / 2]); // half block closing the near end
      for (let column = 0; column < columnCount - 1; column++) {
        slots.push([-faceHalfWidth + slotWidth * (column + 1), slotWidth]);
      }
      slots.push([faceHalfWidth - slotWidth / 4, slotWidth / 2]); // half block closing the far end
    } else {
      for (let column = 0; column < columnCount; column++) {
        slots.push([-faceHalfWidth + slotWidth * (column + 0.5), slotWidth]);
      }
    }
    slots.forEach(([across, width], column) => {
      const position =
        fixedAxis === 'z' ? new Vector3(across, y, fixedValue) : new Vector3(fixedValue, y, across);
      blocks.push({
        matrix: new Matrix4().compose(
          position,
          rotation,
          new Vector3(width * (1 - STONE_JOINT_FRACTION), blockHeight, 1),
        ),
        shadeIndex: (course + column) % STONE_SHADE_COLORS.length,
      });
    });
  }
  return blocks;
}

/** Smallest angle between two directions, both in radians — wraparound-aware (the gap between 350° and 10° is 20°, not 340°). */
function angularDistance(a: number, b: number): number {
  const wrapped = ((a - b + Math.PI) % FULL_TURN_RADIANS + FULL_TURN_RADIANS) % FULL_TURN_RADIANS;
  return Math.abs(wrapped - Math.PI);
}

/**
 * Splits a flat list of StoneBlocks into one StructurePart per shared shade
 * (see STONE_SHADE_COLORS) — the instancing rule every ring in this file
 * keeps: one geometry, one material, many local transforms PER PART, so a
 * multi-shade field is exactly `STONE_SHADE_COLORS.length` parts, never one
 * part per block.
 */
function stonePartsByShade(blocks: readonly StoneBlock[], geometry: BufferGeometry): StructurePart[] {
  return STONE_SHADE_COLORS.map((_, shadeIndex) => ({
    geometry,
    material: stoneMaterial(shadeIndex),
    localMatrices: blocks.filter((block) => block.shadeIndex === shadeIndex).map((block) => block.matrix),
  }));
}

// ── Fidelity-pass 2026-08-20 helpers ────────────────────────────────────────
//
// Owner feedback, 2026-08-20: from the game's orbit camera "a house reads as
// a brown tile with four spikes". This pass raises every tier's geometric
// detail — roofs gain course strips (see GableRoof.courseMatrices), doors
// gain frames, walls gain their material's own framing/trim — while keeping
// every rule the file already has: parts on the same fixed lists, fixed
// literal transforms, flat shading, modest segment counts, and the
// STRUCTURE_FOOTPRINT_RADIUS bound. The two helpers below exist because the
// same two details (roof courses, door frames) appear on several tiers, and
// per-tier copies of their arithmetic is exactly the drift the gable-roof
// contract above was written to end.

/**
 * One StructurePart of roof course strips for `gable`, in `color` — the
 * GableRoof.courseMatrices field made concrete. The strip geometry is built
 * here from the gable's own measured slope so a tier cannot pair one roof's
 * matrices with another roof's strip length.
 */
function roofCoursesPart(gable: GableRoof, color: number): StructurePart {
  return {
    geometry: new BoxGeometry(gable.courseSlopeLength, ROOF_COURSE_THICKNESS, gable.panelLength),
    material: lambert(color),
    localMatrices: gable.courseMatrices,
  };
}

/** Cross-section (width and depth) of a door-frame bar. One value everywhere a frame appears, so every tier's joinery reads as the same construction. */
const DOOR_FRAME_BAR = 0.028;
/** How far past the door's own top the lintel's ends reach, per side — the overhanging lintel every plank doorway shows. */
const DOOR_FRAME_LINTEL_OVERHANG = 0.012;

/**
 * A doorway frame: two jambs and a lintel hugging a `width` × `height` door
 * whose face sits at `z` on the building's +Z front (the shared front-face
 * convention above), centred on `x`, standing on `baseY`. Returns the three
 * local matrices for a UNIT cube geometry — each bar's dimensions are baked
 * into its own matrix, the same "the matrix carries the size" trick
 * stoneBlocksForFace uses, so one geometry serves every frame in the file.
 */
function doorFrameMatrices(width: number, height: number, x: number, baseY: number, z: number): Matrix4[] {
  const jambX = width / 2 + DOOR_FRAME_BAR / 2;
  const jambScale = new Vector3(DOOR_FRAME_BAR, height, DOOR_FRAME_BAR);
  const lintelScale = new Vector3(width + 2 * (DOOR_FRAME_BAR + DOOR_FRAME_LINTEL_OVERHANG), DOOR_FRAME_BAR, DOOR_FRAME_BAR);
  const identity = new Quaternion();
  return [
    new Matrix4().compose(new Vector3(x - jambX, baseY + height / 2, z), identity, jambScale),
    new Matrix4().compose(new Vector3(x + jambX, baseY + height / 2, z), identity, jambScale),
    new Matrix4().compose(
      new Vector3(x, baseY + height + DOOR_FRAME_BAR / 2, z),
      identity,
      lintelScale,
    ),
  ];
}

/** The unit cube every door frame (and other matrix-scaled trim) instances — see doorFrameMatrices. Each caller builds its own BoxGeometry(1, 1, 1) so dispose() keeps its one-flat-list walk. */
function unitBoxGeometry(): BoxGeometry {
  return new BoxGeometry(1, 1, 1);
}

// ── One building tier: a fixed list of (geometry, material, local transforms) ─


function buildTierParts(): StructurePart[][] {
  const tiers: StructurePart[][] = [];

  // EVERY TIER BELOW IS BOUND BY STRUCTURE_FOOTPRINT_RADIUS (see its own doc
  // comment): no part of a tier's model may reach further than that from the
  // building's origin in X or Z, so a building at maximum variation scale is
  // exactly one cell wide and can never hang over the terrace step next door.
  // test/models.test.ts measures every tier against it — the bound is a test,
  // not a convention, because "keep it small" is exactly the kind of rule six
  // separate blocks of hand-authored numbers drift out of.

  // ── Tier 0: camp — a teepee: a conical hide tent beside a campfire's ember
  // glow. The shortest, roundest-toned silhouette in the progression: nothing
  // here stands taller than half a cell.
  //
  // COMPOSITION PASS. The lodge-poles used to start in mid-air part-way up the
  // tent's flank and cross above the apex, which reads as two sticks thrown at
  // a cone rather than as a frame the tent is built ON. They now run from the
  // GROUND, outside the hide, up through the smoke hole — the whole point of a
  // lodge-pole is that it is the thing standing the tent up, so both of its
  // ends have to be somewhere believable. The door grew from a barely-visible
  // 0.11-radius chip to a real opening, and the woodpile shrank so the hearth
  // cluster reads as three logs rather than one slab.
  {
    const TENT_RADIUS = 0.24;
    const tentHeight = 0.5;
    const tentX = -0.13; // off-centre so the hearth cluster below has room on the tent's +X side
    const tent: StructurePart = {
      geometry: new ConeGeometry(TENT_RADIUS, tentHeight, 8),
      material: lambert(0xcbb994),
      localMatrices: [at(tentX, tentHeight / 2, 0)],
    };

    // Dark triangular door opening, set into the tent's own +Z meridian at its
    // base — the same unit triangular prism the gable ends use (see
    // trianglePrismMatrix), so the camp's one opening and the house tiers'
    // gables are the same primitive rather than two ways of drawing a triangle.
    const TEEPEE_DOOR_HALF_BASE = 0.085;
    const TEEPEE_DOOR_RISE = 0.24;
    const TEEPEE_DOOR_DEPTH = 0.02; // just enough extrusion for flat shading to read this as a face, not a zero-thickness plane
    const TEEPEE_DOOR_PROUD_MARGIN = 0.012; // clears the tent's own sloped surface — see doorZ below
    // The tent is a CONE, not a cylinder: its radius shrinks with height, so a
    // flat door needs its z-offset sized to the SMALLEST radius it spans (its
    // own top) or its upper half would clip inside the sloped hide. The safe
    // direction to be wrong in is "floating slightly proud", never "buried in
    // the wall" — the same trade every opening in this file makes.
    const teepeeDoorTopRadius = TENT_RADIUS * (1 - TEEPEE_DOOR_RISE / tentHeight);
    const doorZ = teepeeDoorTopRadius + TEEPEE_DOOR_PROUD_MARGIN;
    const teepeeDoor: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 3),
      material: lambert(0x241708),
      localMatrices: [
        trianglePrismMatrix(TEEPEE_DOOR_HALF_BASE, TEEPEE_DOOR_RISE, TEEPEE_DOOR_DEPTH, 0, doorZ).premultiply(
          at(tentX, 0, 0),
        ),
      ],
    };

    // Lodge-poles: three poles standing the tent up, each running from a point
    // on the ground OUTSIDE the hide, through the smoke hole, to a common
    // crossing point above the apex. Each pole's two endpoints are computed
    // independently (see segmentMatrix) rather than one mirrored off another,
    // the same reasoning gableRoof gives for its two independently-placed
    // panels: a bug in one is not silently the same bug, mirrored, in the next.
    const TEEPEE_POLE_RADIUS = 0.011;
    const TEEPEE_POLE_UNIT_LENGTH = 0.1;
    const TEEPEE_POLE_FOOT_RADIUS = TENT_RADIUS + 0.05; // stands clear of the hide at ground level
    const TEEPEE_POLE_CROSS_HEIGHT = tentHeight + 0.14; // where the three poles meet, above the smoke hole
    const TEEPEE_POLE_CROSS_SPREAD = 0.05; // how far the crossing point of each pole is offset from the apex, so they cross rather than converge to a single point
    const TEEPEE_POLE_COUNT = 3;
    const lodgepoleMatrices: Matrix4[] = [];
    for (let i = 0; i < TEEPEE_POLE_COUNT; i++) {
      const footAngle = (FULL_TURN_RADIANS * i) / TEEPEE_POLE_COUNT + Math.PI / 6;
      // The pole leans across the tent: its top is on the OPPOSITE side of the
      // apex from its foot, which is what makes three poles cross.
      const topAngle = footAngle + Math.PI;
      lodgepoleMatrices.push(
        segmentMatrix(
          new Vector3(
            tentX + Math.sin(footAngle) * TEEPEE_POLE_FOOT_RADIUS,
            0,
            Math.cos(footAngle) * TEEPEE_POLE_FOOT_RADIUS,
          ),
          new Vector3(
            tentX + Math.sin(topAngle) * TEEPEE_POLE_CROSS_SPREAD,
            TEEPEE_POLE_CROSS_HEIGHT,
            Math.cos(topAngle) * TEEPEE_POLE_CROSS_SPREAD,
          ),
          TEEPEE_POLE_UNIT_LENGTH,
        ),
      );
    }
    const lodgepoles: StructurePart = {
      geometry: new CylinderGeometry(TEEPEE_POLE_RADIUS, TEEPEE_POLE_RADIUS, TEEPEE_POLE_UNIT_LENGTH, 5),
      material: lambert(0x4a3420),
      localMatrices: lodgepoleMatrices,
    };

    const HEARTH_X = 0.24;
    const HEARTH_Z = 0.06;
    const fireHeight = 0.14;
    const fire: StructurePart = {
      geometry: new ConeGeometry(0.06, fireHeight, 6),
      material: lambert(0x3a2010, { emissive: 0xd9540f }),
      localMatrices: [at(HEARTH_X, fireHeight / 2, HEARTH_Z)],
    };

    // Firepit ring: small stones circling the fire — the same fixed-ring trick
    // the watchtower's crenellations use below, at camp scale. Centred on the
    // fire's own (x, z) offset, not the building origin, since the fire itself
    // is off-centre from the tent.
    const FIREPIT_STONE_COUNT = 5;
    const FIREPIT_STONE_RADIUS = 0.1;
    const stoneHeight = 0.045;
    const firepitStones: StructurePart = {
      geometry: new CylinderGeometry(0.03, 0.035, stoneHeight, 5),
      material: lambert(0x8a8478),
      localMatrices: circleRingMatrices(FIREPIT_STONE_COUNT, FIREPIT_STONE_RADIUS, stoneHeight / 2, false).map(
        (ring) => ring.premultiply(at(HEARTH_X, 0, HEARTH_Z)),
      ),
    };

    // A small woodpile beside the hearth — three split logs, laid on their
    // sides, stacked two-and-one. Reads as "primitive camp" the way a firepit
    // alone does not: there is fuel here, not just a fire. Clustered on the
    // SAME side as the fire and its stone ring, clear of the tent's own
    // silhouette from every angle that matters.
    const logRadius = 0.024;
    const logLength = 0.15;
    const logRotation = new Quaternion().setFromAxisAngle(Z_AXIS, Math.PI / 2);
    const woodpile: StructurePart = {
      geometry: new CylinderGeometry(logRadius, logRadius, logLength, 5),
      material: lambert(0x5a3d22),
      localMatrices: [
        new Matrix4().compose(new Vector3(0.36, logRadius, -0.11), logRotation, new Vector3(1, 1, 1)),
        new Matrix4().compose(new Vector3(0.36, logRadius * 3, -0.11), logRotation, new Vector3(1, 1, 1)),
        new Matrix4().compose(new Vector3(0.35, logRadius * 5, -0.07), logRotation, new Vector3(1, 1, 1)),
      ],
    };

    // FIDELITY PASS 2026-08-20 (owner: structures too low-resolution from the
    // orbit camera). Two camp additions, both things a working camp visibly
    // HAS rather than decoration: a cooking spit over the fire, and the ring
    // of stones real teepees pin their hide's skirt down with.
    //
    // Spit: two uprights leaning over the fire from opposite sides, one
    // crossbar between their tops — three segments via segmentMatrix, the
    // same joint-skeleton authoring the lodgepoles use, so the spit connects
    // by construction.
    const SPIT_STICK_RADIUS = 0.009; // thinner than a lodgepole (0.011): a cooking stick, not a structural pole
    const SPIT_UNIT_LENGTH = 0.1;
    const SPIT_TOP_HEIGHT = 0.19; // clears the fire cone (0.14 tall) with headroom for the crossbar's own sag-free read
    const SPIT_FOOT_SPREAD = 0.09; // uprights planted just outside the firepit stone ring (radius 0.1) so they straddle the fire
    const SPIT_TOP_SPREAD = 0.055; // tops lean inward over the fire; the crossbar spans this
    const spitFootA = new Vector3(HEARTH_X - SPIT_FOOT_SPREAD, 0, HEARTH_Z);
    const spitFootB = new Vector3(HEARTH_X + SPIT_FOOT_SPREAD, 0, HEARTH_Z);
    const spitTopA = new Vector3(HEARTH_X - SPIT_TOP_SPREAD, SPIT_TOP_HEIGHT, HEARTH_Z);
    const spitTopB = new Vector3(HEARTH_X + SPIT_TOP_SPREAD, SPIT_TOP_HEIGHT, HEARTH_Z);
    const spit: StructurePart = {
      geometry: new CylinderGeometry(SPIT_STICK_RADIUS, SPIT_STICK_RADIUS, SPIT_UNIT_LENGTH, 5),
      material: lambert(0x4a3420), // the lodgepoles' own wood — one timber palette per camp
      localMatrices: [
        segmentMatrix(spitFootA, spitTopA, SPIT_UNIT_LENGTH),
        segmentMatrix(spitFootB, spitTopB, SPIT_UNIT_LENGTH),
        segmentMatrix(spitTopA, spitTopB, SPIT_UNIT_LENGTH),
      ],
    };

    // Hide-pinning stones: a ring of small blocks around the tent's own base,
    // pinning the hide's skirt — circleRingMatrices again, centred on the
    // tent's own off-centre x exactly like the firepit ring is centred on the
    // hearth's. Fewer, smaller and squarer than the firepit stones so the two
    // rings read as different jobs, not one ring drawn twice.
    const HIDE_PIN_STONE_COUNT = 7;
    const HIDE_PIN_STONE_SIZE = 0.032; // cube edge — a hand-sized rock, half a firepit stone's bulk
    const HIDE_PIN_RING_RADIUS = TENT_RADIUS + 0.02; // just outside the hide's ground edge
    /** Skips the ring position nearest the door (+Z meridian): a stone in the doorway would read as blocking it. */
    const HIDE_PIN_START_ANGLE = FULL_TURN_RADIANS / HIDE_PIN_STONE_COUNT / 2;
    const hidePinStones: StructurePart = {
      geometry: new BoxGeometry(HIDE_PIN_STONE_SIZE, HIDE_PIN_STONE_SIZE, HIDE_PIN_STONE_SIZE),
      material: lambert(0x8a8478), // the firepit stones' own grey — one stone palette per camp
      localMatrices: circleRingMatrices(
        HIDE_PIN_STONE_COUNT,
        HIDE_PIN_RING_RADIUS,
        HIDE_PIN_STONE_SIZE / 2,
        false,
        HIDE_PIN_START_ANGLE,
      ).map((ring) => ring.premultiply(at(tentX, 0, 0))),
    };

    tiers.push([tent, fire, firepitStones, woodpile, teepeeDoor, lodgepoles, spit, hidePinStones]);
  }

  // ── Tier 1: hut (the settler hut) — a round wattle-and-daub wall under a
  // conical THATCH roof. First solid drum shape; still no hard edges anywhere
  // on it.
  //
  // COMPOSITION PASS. The two thatch layers used to be two independently-sized
  // CONES: the lower one tapered to a point at the exact height where the
  // upper one's full-width base began, so the cap's rim overhung thin air and
  // the roof read as two stacked discs — a wedding cake, not thatch. They are
  // now FRUSTA that share a radius at their seam (skirt top radius === cap
  // bottom radius), which is the only construction where the join cannot open:
  // the two surfaces meet edge to edge by definition rather than by two numbers
  // happening to agree.
  {
    const wallRadiusTop = 0.26;
    const wallRadiusBottom = 0.275;
    const wallHeight = 0.42;
    const wall: StructurePart = {
      geometry: new CylinderGeometry(wallRadiusTop, wallRadiusBottom, wallHeight, 8),
      material: lambert(0x9c7a52),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };

    // Straw palette: the skirt (lower, wider layer) a shade darker than the cap
    // (upper, narrower layer) so the seam between them reads as a texture break
    // even under flat shading, not just a silhouette step.
    const THATCH_CAP_COLOR = 0xdcb95a;
    const THATCH_SKIRT_COLOR = 0xc3a047;

    // Skirt: the wider, shorter lower roof layer — oversized relative to the
    // wall it sits on, per the brief, and its own EAVE radius is what the
    // fringe ring below hangs from.
    const skirtEaveRadius = 0.38;
    const skirtTopRadius = 0.3;
    const skirtHeight = 0.13;
    const roofSkirt: StructurePart = {
      geometry: new CylinderGeometry(skirtTopRadius, skirtEaveRadius, skirtHeight, 8),
      material: lambert(THATCH_SKIRT_COLOR),
      localMatrices: [at(0, wallHeight + skirtHeight / 2, 0)],
    };

    // Cap: the taller upper layer, standing on the skirt's own TOP radius so
    // the two meet edge to edge (see this tier's banner).
    const capHeight = 0.3;
    const roofCap: StructurePart = {
      geometry: new ConeGeometry(skirtTopRadius, capHeight, 8),
      material: lambert(THATCH_CAP_COLOR),
      localMatrices: [at(0, wallHeight + skirtHeight + capHeight / 2, 0)],
    };

    // Door: a dark plank set into the drum's +Z face, low and narrow — a
    // wattle-and-daub hut's doorway, not a house's. z is a hair proud of the
    // drum's own radius at every height the door spans, so the plank reads as
    // mounted on the wall rather than half-swallowed by it.
    const doorHeight = 0.27;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.13, doorHeight, 0.03),
      material: lambert(0x3a2416),
      localMatrices: [at(0, doorHeight / 2, wallRadiusBottom + 0.015)],
    };

    // Thatch fringe: a ring of small boxes standing in for straw bundles
    // hanging past the skirt's own eave, so the eave's silhouette is ragged
    // rather than a lathe-turned rim. Count is the closest whole divisor of the
    // eave's circumference to the target spacing below — the same "target
    // spacing, nearest divisor" trick DURANDS_MARQUEE_BULB_TARGET_SPACING uses,
    // reused here for the same reason: an even ring with no leftover gap.
    const FRINGE_TARGET_SPACING = 0.085;
    const fringeCount = Math.round((FULL_TURN_RADIANS * skirtEaveRadius) / FRINGE_TARGET_SPACING);
    const fringeTiltRadians = Math.PI / 7; // hangs the bundle's outer end down past the eave line rather than standing it straight out
    const fringe: StructurePart = {
      geometry: new BoxGeometry(0.045, 0.09, 0.02),
      material: lambert(0xb8944a),
      localMatrices: circleRingMatrices(fringeCount, skirtEaveRadius - 0.02, wallHeight + 0.01, true).map((ring) =>
        ring.multiply(new Matrix4().makeRotationX(fringeTiltRadians)),
      ),
    };

    // Smoke vent: a dark cap at the roof's own apex, standing in for a chimney
    // a hut this primitive would not have — a hole in the thatch, not a
    // masonry stack.
    const smokeVentHeight = 0.05;
    const smokeVent: StructurePart = {
      geometry: new CylinderGeometry(0.045, 0.045, smokeVentHeight, 6),
      material: lambert(0x2a1c10),
      localMatrices: [at(0, wallHeight + skirtHeight + capHeight - smokeVentHeight / 2, 0)],
    };

    // FIDELITY PASS 2026-08-20 (owner: structures too low-resolution from the
    // orbit camera). Four hut additions, each a visible fact of wattle-and-
    // daub construction rather than decoration.
    //
    // Wattle bands: the horizontal withy courses a wattle wall is woven
    // around, as two thin dark rings riding just proud of the drum. What
    // makes the wall read as WOVEN rather than as a plain plastered tube.
    const WATTLE_BAND_RADIAL_PROUD = 0.008; // stands the band clear of the drum's own surface
    const WATTLE_BAND_HEIGHT = 0.022;
    const WATTLE_BAND_YS = [wallHeight * 0.33, wallHeight * 0.66]; // thirds of the wall — two visible courses, neither kissing the eave nor the ground
    const wattleBands: StructurePart = {
      // openEnded: only the band's outer surface can ever be seen (the drum
      // fills its inside), so the cap fans would be 16 invisible triangles.
      geometry: new CylinderGeometry(
        wallRadiusTop + WATTLE_BAND_RADIAL_PROUD,
        wallRadiusBottom + WATTLE_BAND_RADIAL_PROUD,
        WATTLE_BAND_HEIGHT,
        8,
        1,
        true,
      ),
      material: lambert(0x7a5c3a), // withy-brown, darker than the daub so the course reads as a line
      localMatrices: WATTLE_BAND_YS.map((y) => at(0, y, 0)),
    };

    // Door frame: two jambs and a lintel around the plank door — the shared
    // doorFrameMatrices contract (see the fidelity-pass helpers), in rough
    // pole timber to match a hut's own joinery.
    const HUT_DOOR_WIDTH = 0.13; // the door part's own width, restated for the frame
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(0x54381f),
      localMatrices: doorFrameMatrices(HUT_DOOR_WIDTH, doorHeight, 0, 0, wallRadiusBottom + 0.015),
    };

    // Upper thatch courses: two conical bands wrapping the CAP part-way up,
    // each a shade darker than the straw beneath and a hair proud of the
    // surface, so the thatch reads as LAYERED COURSES rather than as one
    // smooth cone — the wattle bands' trick, moved onto the roof. Each
    // band's radii follow the cone's own taper at its top and bottom (the
    // teepee door's "a cone's surface moves inward with height" reasoning),
    // so a band hugs the slope instead of standing off it.
    //
    // (First attempt was a ring of tilted straw BUNDLES like the eave
    // fringe's — reviewed in preview 2026-08-20 it read as a crown of merlons
    // standing out of the roof, not as thatch; a band that follows the
    // surface cannot mis-read that way.)
    const CAP_COURSE_HEIGHT = 0.045;
    const CAP_COURSE_RADIAL_PROUD = 0.008;
    const CAP_COURSE_BOTTOM_FRACTIONS = [0.22, 0.52]; // two courses up the cap, neither kissing the seam below nor the vent above
    /** The cap cone's surface radius at `fraction` of its own height. */
    const capRadiusAtFraction = (fraction: number): number => skirtTopRadius * (1 - fraction);
    const capCourses: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 8, 1, true), // unit open band; each course's taper rides its own matrix scale
      material: lambert(0xcfa94e), // between the cap's and skirt's straw shades — its own course, same palette
      localMatrices: CAP_COURSE_BOTTOM_FRACTIONS.map((fraction) => {
        const fractionSpan = CAP_COURSE_HEIGHT / capHeight;
        const bottomRadius = capRadiusAtFraction(fraction) + CAP_COURSE_RADIAL_PROUD;
        const topRadius = capRadiusAtFraction(fraction + fractionSpan) + CAP_COURSE_RADIAL_PROUD;
        const y = wallHeight + skirtHeight + capHeight * fraction + CAP_COURSE_HEIGHT / 2;
        // A unit cylinder cannot scale into a frustum, so approximate each
        // course band as a cylinder at the band's MEAN radius: over 0.045 of
        // height the cone narrows by 0.0225 — half of it hidden inside the
        // proud margin, invisible at any distance this tier is seen from.
        const meanRadius = (bottomRadius + topRadius) / 2;
        return new Matrix4().compose(
          new Vector3(0, y, 0),
          new Quaternion(),
          new Vector3(meanRadius, CAP_COURSE_HEIGHT, meanRadius),
        );
      }),
    };

    // Daub footing: a low, slightly wider ring at the drum's base — the mud
    // sill a wattle wall stands on, and what keeps the drum from reading as
    // planted straight into the terrain (the watchtower's plinth reasoning,
    // at hut scale).
    const FOOTING_HEIGHT = 0.05;
    const FOOTING_RADIAL_PROUD = 0.02;
    const footing: StructurePart = {
      geometry: new CylinderGeometry(
        wallRadiusBottom + FOOTING_RADIAL_PROUD / 2,
        wallRadiusBottom + FOOTING_RADIAL_PROUD,
        FOOTING_HEIGHT,
        8,
        1,
        true, // openEnded for the wattle bands' own reason: only the outer face can show
      ),
      material: lambert(0x87683f), // the wall's daub, one shade darker — weathered splash line
      localMatrices: [at(0, FOOTING_HEIGHT / 2, 0)],
    };

    tiers.push([wall, roofSkirt, roofCap, door, fringe, smokeVent, wattleBands, doorFrame, capCourses, footing]);
  }

  // ── Tier 2: timber-house — walls built of stacked LOG COURSES under a peaked
  // (gable) roof: the first tier with hard edges anywhere on it.
  //
  // All four walls are one `logCourses` part: one unit-length cylinder
  // geometry, stretched and placed per course via segmentMatrix — the same
  // instancing shape every other multi-instance part in this file has. Every
  // course on every wall OVERHANGS its own corner by LOG_END_OVERHANG, so the
  // cylinder's own flat end cap is what shows as the log-end caps a log
  // cabin's corners are made of; no separate cap part is needed, because the
  // overhanging log ends already have caps by construction.
  //
  // COMPOSITION PASS: the roof is now a whole gable (panels, closed ends and a
  // ridge cap — see gableRoof), where before it was two panels over an open
  // triangle you could see straight through.
  //
  // SUPERSEDED BY THE IMPORTED ASSET (2026-09-04, IMPORTED_STRUCTURE_TIER).
  // The builder below is no longer what a tier-2 house normally looks like:
  // when assets/timber-house.glb is installed, this tier is that model. It is
  // kept, whole, for two reasons — it is the FALLBACK whenever no asset is
  // installed (a rejected preload, a node test that never preloads), so the
  // tier can never come out empty; and it is the record of how the tier's
  // silhouette was arrived at, which the asset was then chosen to match.
  // Nothing below runs when the asset is installed: it is built lazily, inside
  // this function, precisely so the unused primitives are never allocated.
  const buildTimberHouseTier = (): StructurePart[] => {
    const wallHeight = 0.5;
    const wallHalfWidth = 0.28;
    const wallHalfDepth = 0.23;

    const LOG_COURSE_COUNT = 5; // within the brief's "4-6 courses"
    const logDiameter = wallHeight / LOG_COURSE_COUNT;
    const logRadius = logDiameter / 2;
    const LOG_END_OVERHANG = 0.04; // how far each course pokes out past the corner it meets
    const LOG_UNIT_LENGTH = 0.1;

    const logMatrices: Matrix4[] = [];
    for (let course = 0; course < LOG_COURSE_COUNT; course++) {
      const y = logRadius + course * logDiameter;
      // Front and back walls run along X; left and right walls run along Z.
      // Every course overhangs both its own ends, which is what makes the
      // perpendicular wall's log ends poke past this wall's face at every
      // corner (and vice versa) — the interlocking joint a log cabin shows.
      for (const z of [wallHalfDepth, -wallHalfDepth]) {
        logMatrices.push(
          segmentMatrix(
            new Vector3(-wallHalfWidth - LOG_END_OVERHANG, y, z),
            new Vector3(wallHalfWidth + LOG_END_OVERHANG, y, z),
            LOG_UNIT_LENGTH,
          ),
        );
      }
      for (const x of [wallHalfWidth, -wallHalfWidth]) {
        logMatrices.push(
          segmentMatrix(
            new Vector3(x, y, -wallHalfDepth - LOG_END_OVERHANG),
            new Vector3(x, y, wallHalfDepth + LOG_END_OVERHANG),
            LOG_UNIT_LENGTH,
          ),
        );
      }
    }
    const logCourses: StructurePart = {
      geometry: new CylinderGeometry(logRadius, logRadius, LOG_UNIT_LENGTH, 8),
      material: lambert(0x7a5232),
      localMatrices: logMatrices,
    };

    const ridgeRise = 0.3;
    const eave = 0.055;
    const gable = gableRoof(wallHalfWidth + eave, ridgeRise, wallHeight, wallHalfDepth + eave, wallHalfDepth, false);
    const ROOF_COLOR = 0x8a3a2e;
    const roof: StructurePart = {
      geometry: new BoxGeometry(gable.slopeLength, GABLE_PANEL_THICKNESS, gable.panelLength),
      material: lambert(ROOF_COLOR),
      localMatrices: gable.panelMatrices,
    };
    // The tympanum triangles take the WALL's own timber colour, not the roof's:
    // a gable end is the wall carrying on upward, and colouring it as roof
    // would make the closed gable read as a second roof panel facing the camera.
    const gableEnds: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 3),
      material: lambert(0x6b4629),
      localMatrices: gable.endMatrices,
    };
    const ridgeCap: StructurePart = {
      geometry: new BoxGeometry(GABLE_RIDGE_CAP_HALF_WIDTH * 2, GABLE_RIDGE_CAP_HEIGHT, gable.panelLength),
      material: lambert(0x5a2820),
      localMatrices: gable.ridgeCapMatrices,
    };

    // Door and windows, centred on the +Z wall face (see the shared "+Z is the
    // front" convention every box-walled tier follows). z clears the logs' own
    // overhanging radius, not a flat box face.
    const openingZ = wallHalfDepth + logRadius + 0.015;
    const doorHeight = 0.3;
    const TIMBER_DOOR_WIDTH = 0.13;
    const door: StructurePart = {
      geometry: new BoxGeometry(TIMBER_DOOR_WIDTH, doorHeight, 0.03),
      material: lambert(0x2e1c10),
      localMatrices: [at(0, doorHeight / 2, openingZ)],
    };
    const WINDOW_WIDTH = 0.085;
    const WINDOW_HEIGHT = 0.1;
    const WINDOW_X = 0.16;
    const WINDOW_Y = 0.3;
    const windows: StructurePart = {
      geometry: new BoxGeometry(WINDOW_WIDTH, WINDOW_HEIGHT, 0.02),
      material: windowMaterial(),
      localMatrices: [at(WINDOW_X, WINDOW_Y, openingZ), at(-WINDOW_X, WINDOW_Y, openingZ)],
    };

    // FIDELITY PASS 2026-08-20 (owner: structures too low-resolution from the
    // orbit camera). Shingle courses on the roof (the shared gable contract's
    // new courseMatrices — see GableRoof), a framed door, plank shutters on
    // both windows, and a lit loft window in the front gable. Every one is a
    // log-built house's own vocabulary; nothing here borrows a later tier's
    // masonry.
    const roofCourses = roofCoursesPart(gable, 0x7c332a); // one shade under the panels' red — courses in the panel's own material
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(0x54331c), // hewn-timber frame, lighter than the dark doorway it outlines
      localMatrices: doorFrameMatrices(TIMBER_DOOR_WIDTH, doorHeight, 0, 0, openingZ),
    };

    // Shutters: one plank per side of each window, proud of the same opening
    // plane, in the gable ends' darker timber so they read as joinery against
    // the log courses behind them.
    const SHUTTER_WIDTH = 0.032;
    const SHUTTER_GAP = 0.006; // daylight between shutter and glass edge
    const shutterX = WINDOW_WIDTH / 2 + SHUTTER_GAP + SHUTTER_WIDTH / 2;
    const shutterMatrices: Matrix4[] = [];
    for (const windowX of [WINDOW_X, -WINDOW_X]) {
      for (const side of [1, -1] as const) {
        shutterMatrices.push(at(windowX + side * shutterX, WINDOW_Y, openingZ));
      }
    }
    const shutters: StructurePart = {
      geometry: new BoxGeometry(SHUTTER_WIDTH, WINDOW_HEIGHT + 0.012, 0.018), // a whisker taller than the glass, like a hung shutter
      material: lambert(0x6b4629),
      localMatrices: shutterMatrices,
    };

    // Loft window: one small glow up in the +Z tympanum — the storey the
    // gable's own closed triangle implies. z clears the tympanum slab's own
    // half-thickness at the wall face.
    const LOFT_WINDOW_RISE_FRACTION = 0.35; // low in the triangle, where it is still wide enough to hold a window
    const loftWindow: StructurePart = {
      geometry: new BoxGeometry(0.06, 0.07, 0.02),
      material: windowMaterial(),
      localMatrices: [at(0, wallHeight + ridgeRise * LOFT_WINDOW_RISE_FRACTION, wallHalfDepth + GABLE_END_THICKNESS / 2 + 0.012)],
    };

    return [logCourses, roof, gableEnds, ridgeCap, door, windows, roofCourses, doorFrame, shutters, loftWindow];
  };

  // The imported model when one is installed, the primitives above when it is
  // not — see IMPORTED_STRUCTURE_TIER and importedStructureParts.
  tiers.push(importedStructureParts() ?? buildTimberHouseTier());

  // ── Tier 3: longhouse — longer and lower than the timber house (a workshop's
  // footprint, not its height), with a smoking chimney: the widest silhouette
  // in the whole progression.
  //
  // COMPOSITION PASS, two changes that go together. (1) The ridge now runs
  // along the building's LONG axis (gableRoof's `ridgeAlongX`). It used to run
  // across the short one, so the two roof planes fell down the hall's entire
  // length and the result read as a shallow slab draped the wrong way rather
  // than as a hall. (2) The length itself is now bounded by
  // STRUCTURE_FOOTPRINT_RADIUS like every other tier: at half-width 1.05 this
  // building was 2.3 cells across at maximum variation scale, which is why it
  // overlapped its neighbours' cells in-world and hung off terrace steps its
  // own cell's flatness check never covered.
  {
    const wallHeight = 0.4;
    const wallHalfLength = 0.4; // the long axis, X — the tier's defining measure
    const wallHalfDepth = 0.19; // the short axis, Z
    const wall: StructurePart = {
      geometry: new BoxGeometry(wallHalfLength * 2, wallHeight, wallHalfDepth * 2),
      material: lambert(0x5a4028),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };

    const ridgeRise = 0.24;
    const eave = 0.045;
    const gable = gableRoof(
      wallHalfDepth + eave,
      ridgeRise,
      wallHeight,
      wallHalfLength + eave,
      wallHalfLength,
      true,
    );
    const roof: StructurePart = {
      geometry: new BoxGeometry(gable.slopeLength, GABLE_PANEL_THICKNESS, gable.panelLength),
      material: lambert(0x746558),
      localMatrices: gable.panelMatrices,
    };
    const gableEnds: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 3),
      material: lambert(0x4a3320),
      localMatrices: gable.endMatrices,
    };
    const ridgeCap: StructurePart = {
      geometry: new BoxGeometry(GABLE_RIDGE_CAP_HALF_WIDTH * 2, GABLE_RIDGE_CAP_HEIGHT, gable.panelLength),
      material: lambert(0x5c5045),
      localMatrices: gable.ridgeCapMatrices,
    };

    // Chimney: rooted BELOW the ridge line and rising through the roof plane,
    // rather than balanced on top of it. A stack that starts at the surface it
    // pierces has no way to hide the seam where the two meet; one that starts
    // inside the roof has nothing to hide.
    const chimneyHeight = 0.3;
    const chimneyX = wallHalfLength * 0.55;
    const chimneyBaseY = wallHeight; // inside the roof void, under the panels
    const chimneyY = chimneyBaseY + chimneyHeight / 2;
    // Stack and pot both re-proportioned in the composition pass: at 0.08
    // square in pale grey the stack read as a factory smokestack next to a
    // 0.38-tall hall, and its pot was wider than the stack it capped.
    const chimney: StructurePart = {
      geometry: new BoxGeometry(0.065, chimneyHeight, 0.065),
      material: lambert(STONE_SHADE_COLORS[2]),
      localMatrices: [at(chimneyX, chimneyY, 0)],
    };
    const potHeight = 0.05;
    const chimneyPot: StructurePart = {
      geometry: new CylinderGeometry(0.032, 0.042, potHeight, 6),
      material: lambert(0x3a332c),
      localMatrices: [at(chimneyX, chimneyBaseY + chimneyHeight + potHeight / 2, 0)],
    };

    // Door and windows on the +Z long face — the eave side, under the roof's
    // own overhang, which is where a hall this shape is entered.
    const openingZ = wallHalfDepth + 0.012;
    const doorHeight = 0.28;
    const LONGHOUSE_DOOR_WIDTH = 0.13;
    const door: StructurePart = {
      geometry: new BoxGeometry(LONGHOUSE_DOOR_WIDTH, doorHeight, 0.03),
      material: lambert(0x2a1a10),
      localMatrices: [at(0, doorHeight / 2, openingZ)],
    };
    const WINDOW_X = 0.22;
    const WINDOW_Y = 0.24;
    const windows: StructurePart = {
      geometry: new BoxGeometry(0.09, 0.1, 0.02),
      material: windowMaterial(),
      localMatrices: [
        at(WINDOW_X, WINDOW_Y, openingZ),
        at(-WINDOW_X, WINDOW_Y, openingZ),
        // FIDELITY PASS 2026-08-20: the rear long face gets the same pair —
        // a hall is orbited in-game, and a blank back wall is exactly the
        // "unfinished model" read Durand's own rear-openings note fixed.
        at(WINDOW_X, WINDOW_Y, -openingZ),
        at(-WINDOW_X, WINDOW_Y, -openingZ),
      ],
    };

    // FIDELITY PASS 2026-08-20 (owner: from the orbit camera "a house reads
    // as a brown tile with four spikes" — this tier, a long plain box under a
    // long plain roof, was the worst offender). The hall becomes a TIMBER-
    // FRAMED hall: visible post-and-beam framing on the walls, plank courses
    // on the roof, eave posts holding the front overhang, a framed door, and
    // lit loft triangles at both gable ends.
    // Course shade: two visible steps darker than the panels' 0x746558 —
    // the first draft's one-step 0x655749 vanished into the panel at the
    // orbit camera's angle (reviewed in preview 2026-08-20); a roof course
    // that cannot be seen is the "brown tile" complaint intact.
    const roofCourses = roofCoursesPart(gable, 0x574a3e); // weathered plank courses, legibly darker than the panels
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(0x3f2c1a),
      localMatrices: doorFrameMatrices(LONGHOUSE_DOOR_WIDTH, doorHeight, 0, 0, openingZ),
    };

    // Wall framing: corner posts at all four arrises, one stud between each
    // opening on both long faces, and a horizontal mid-rail the studs meet —
    // the exposed frame that makes a hall's long wall read as BUILT rather
    // than extruded. All one unit-cube part; each bar's size rides its own
    // matrix (doorFrameMatrices' trick, applied wall-wide).
    const FRAME_BAR = 0.032; // heavier than a door jamb (0.028): structural timber, not trim
    const FRAME_PROUD = 0.008; // how far the framing stands proud of the wall face
    const FRAME_COLOR = 0x3f2c1a; // one dark oak for every framing member and the door frame alike
    const framePostScale = new Vector3(FRAME_BAR, wallHeight, FRAME_BAR);
    const frameIdentity = new Quaternion();
    const framingMatrices: Matrix4[] = [];
    // Corner posts: proud of BOTH faces they meet, so the arris reads framed
    // from every orbit angle.
    for (const x of [wallHalfLength, -wallHalfLength]) {
      for (const z of [wallHalfDepth, -wallHalfDepth]) {
        framingMatrices.push(
          new Matrix4().compose(
            new Vector3(Math.sign(x) * (Math.abs(x) - FRAME_BAR / 2 + FRAME_PROUD), wallHeight / 2, Math.sign(z) * (Math.abs(z) - FRAME_BAR / 2 + FRAME_PROUD)),
            frameIdentity,
            framePostScale,
          ),
        );
      }
    }
    // Studs: midway between the windows and the gable ends on both long
    // faces — where a real frame's bay divisions fall on this elevation.
    const STUD_X = 0.32;
    for (const z of [wallHalfDepth, -wallHalfDepth]) {
      for (const x of [STUD_X, -STUD_X]) {
        framingMatrices.push(
          new Matrix4().compose(
            new Vector3(x, wallHeight / 2, Math.sign(z) * (Math.abs(z) + FRAME_PROUD - FRAME_BAR / 2)),
            frameIdentity,
            framePostScale,
          ),
        );
      }
    }
    // Mid-rail: one horizontal member across each long face at the windows'
    // sill line, tying the studs together.
    const RAIL_Y = 0.17; // just under the windows (bottom edge 0.19) — a sill rail, not a belt through the glass
    for (const z of [wallHalfDepth, -wallHalfDepth]) {
      framingMatrices.push(
        new Matrix4().compose(
          new Vector3(0, RAIL_Y, Math.sign(z) * (Math.abs(z) + FRAME_PROUD - FRAME_BAR / 2)),
          frameIdentity,
          new Vector3(wallHalfLength * 2, FRAME_BAR, FRAME_BAR),
        ),
      );
    }
    const framing: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(FRAME_COLOR),
      localMatrices: framingMatrices,
    };

    // Eave posts: three poles under the front eave's overhang — the covered
    // walk a working hall's entrance side has, and the one addition that
    // changes this tier's near-ground silhouette the way the design table's
    // "widest footprint, low profile" wants seeing.
    const EAVE_POST_RADIUS = 0.016;
    const EAVE_POST_XS = [0.3, 0, -0.3]; // door bay centred, one post per flanking bay
    const eavePostZ = wallHalfDepth + eave - EAVE_POST_RADIUS; // under the eave's own outer edge
    const eavePostHeight = wallHeight; // ground to wall-top, where the roof plane begins
    const eavePosts: StructurePart = {
      geometry: new CylinderGeometry(EAVE_POST_RADIUS, EAVE_POST_RADIUS, eavePostHeight, 5),
      material: lambert(FRAME_COLOR),
      localMatrices: EAVE_POST_XS.map((x) => at(x, eavePostHeight / 2, eavePostZ)),
    };

    // Loft lights: one small glow high in each gable triangle (the ridge runs
    // along X, so the tympana face ±X — each window is the thin box yawed a
    // quarter turn, Durand's own side-window trick).
    const LOFT_WINDOW_RISE_FRACTION = 0.35;
    const loftQuarterTurn = new Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 2);
    const loftWindowX = wallHalfLength + GABLE_END_THICKNESS / 2 + 0.012;
    const loftWindows: StructurePart = {
      geometry: new BoxGeometry(0.055, 0.065, 0.02),
      material: windowMaterial(),
      localMatrices: [loftWindowX, -loftWindowX].map((x) =>
        new Matrix4().compose(new Vector3(x, wallHeight + ridgeRise * LOFT_WINDOW_RISE_FRACTION, 0), loftQuarterTurn, new Vector3(1, 1, 1)),
      ),
    };

    tiers.push([
      wall,
      roof,
      gableEnds,
      ridgeCap,
      chimney,
      chimneyPot,
      door,
      windows,
      roofCourses,
      doorFrame,
      framing,
      eavePosts,
      loftWindows,
    ]);
  }

  // ── Tier 4: stone-cottage — a STONE wall (first material break in the
  // progression) under a clay-tile roof, with a round chimney: semi-advanced
  // masonry, still a house.
  //
  // COMPOSITION PASS: closed gable ends (see gableRoof), and the stone veneer
  // re-proportioned. Its blocks used to be taller than they were wide and stood
  // 0.025 proud of a 1-cell wall, which read as sugar cubes glued to a box;
  // real coursing is LANDSCAPE and barely proud, so the blocks are now wider
  // than they are tall and half as deep.
  {
    const wallHeight = 0.55;
    const wallHalfWidth = 0.29;
    const wallHalfDepth = 0.21;
    // How far the stone-block veneer stands proud of the flat wall beneath it.
    // Declared up here, ahead of the veneer itself, because the door and
    // windows need it too: they must clear the veneer's own outer face, not
    // just the bare wall, or they interpenetrate the blocks over their opening.
    const STONE_BLOCK_DEPTH = 0.015;
    // Painted as MORTAR, not as stone: with the veneer now covering the whole
    // face (see stoneBlocksForFace), everything still visible of this box is
    // the joint lines between the blocks.
    const wall: StructurePart = {
      geometry: new BoxGeometry(wallHalfWidth * 2, wallHeight, wallHalfDepth * 2),
      material: lambert(STONE_MORTAR_COLOR),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };

    const ridgeRise = 0.3;
    const eave = 0.055;
    const gable = gableRoof(wallHalfWidth + eave, ridgeRise, wallHeight, wallHalfDepth + eave, wallHalfDepth, false);
    const roof: StructurePart = {
      geometry: new BoxGeometry(gable.slopeLength, GABLE_PANEL_THICKNESS, gable.panelLength),
      material: lambert(0xb5502e),
      localMatrices: gable.panelMatrices,
    };
    // The gable ends take the wall's own stone grey, one shade darker so the
    // triangle reads as masonry in shadow under the eave rather than as a third
    // roof plane.
    const gableEnds: StructurePart = {
      geometry: new CylinderGeometry(1, 1, 1, 3),
      material: lambert(0x7d7a74),
      localMatrices: gable.endMatrices,
    };
    const ridgeCap: StructurePart = {
      geometry: new BoxGeometry(GABLE_RIDGE_CAP_HALF_WIDTH * 2, GABLE_RIDGE_CAP_HEIGHT, gable.panelLength),
      material: lambert(0x8a3a22),
      localMatrices: gable.ridgeCapMatrices,
    };

    // Chimney, rooted below the roof plane for the same reason the longhouse's
    // is (see there).
    const chimneyHeight = 0.36;
    const chimneyX = wallHalfWidth * 0.5;
    const chimneyBaseY = wallHeight;
    // Same re-proportioning as the longhouse's stack, and the same darker
    // shade off the shared stone palette, so the two tiers' chimneys read as
    // the same masonry the walls beneath them do.
    const chimney: StructurePart = {
      geometry: new CylinderGeometry(0.045, 0.056, chimneyHeight, 6),
      material: lambert(STONE_SHADE_COLORS[2]),
      localMatrices: [at(chimneyX, chimneyBaseY + chimneyHeight / 2, 0)],
    };
    const potHeight = 0.05;
    const chimneyPot: StructurePart = {
      geometry: new CylinderGeometry(0.03, 0.04, potHeight, 6),
      material: lambert(0x3a332c),
      localMatrices: [at(chimneyX, chimneyBaseY + chimneyHeight + potHeight / 2, 0)],
    };

    // Door and windows on the +Z face. z clears the stone veneer's own outer
    // face (STONE_BLOCK_DEPTH, declared above) plus the usual small proud gap,
    // not just the bare wall beneath it.
    const cottageOpeningZ = wallHalfDepth + STONE_BLOCK_DEPTH + 0.01;
    const doorHeight = 0.32;
    const COTTAGE_DOOR_WIDTH = 0.13;
    const door: StructurePart = {
      geometry: new BoxGeometry(COTTAGE_DOOR_WIDTH, doorHeight, 0.03),
      material: lambert(0x3a2416),
      localMatrices: [at(0, doorHeight / 2, cottageOpeningZ)],
    };
    const WINDOW_WIDTH = 0.085;
    const WINDOW_HEIGHT = 0.1;
    const WINDOW_X = 0.17;
    const WINDOW_Y = 0.34;
    const windows: StructurePart = {
      geometry: new BoxGeometry(WINDOW_WIDTH, WINDOW_HEIGHT, 0.02),
      material: windowMaterial(),
      localMatrices: [
        at(WINDOW_X, WINDOW_Y, cottageOpeningZ),
        at(-WINDOW_X, WINDOW_Y, cottageOpeningZ),
        // FIDELITY PASS 2026-08-20: the rear face gets the same pair — the
        // longhouse's own "a blank back wall reads as an unfinished model"
        // reasoning, applied to the tier above it.
        at(WINDOW_X, WINDOW_Y, -cottageOpeningZ),
        at(-WINDOW_X, WINDOW_Y, -cottageOpeningZ),
      ],
    };

    // FIDELITY PASS 2026-08-20 (owner: structures too low-resolution from the
    // orbit camera). The cottage's additions are all DRESSED-STONE details —
    // the same masonry story the quoins began: tile courses on the roof, cut
    // sills and lintels on every window, a stone door surround, and a collar
    // where the chimney pierces the roof plane.
    const roofCourses = roofCoursesPart(gable, 0xa2452a); // one shade under the panels' clay red — fired-tile courses
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(STONE_SHADE_COLORS[0]), // the quoins' own pale dressed stone
      localMatrices: doorFrameMatrices(COTTAGE_DOOR_WIDTH, doorHeight, 0, 0, cottageOpeningZ),
    };

    // Sills and lintels: one cut stone under and one over each of the four
    // windows, slightly wider than the glass — the header-and-sill pair every
    // coursed wall shows around an opening. One unit-cube part; sizes ride
    // the matrices (doorFrameMatrices' trick).
    const SILL_WIDTH = WINDOW_WIDTH + 0.03; // overhangs the glass by a block-joint's worth per side
    const SILL_HEIGHT = 0.024;
    const SILL_DEPTH = 0.026;
    const sillIdentity = new Quaternion();
    const sillScale = new Vector3(SILL_WIDTH, SILL_HEIGHT, SILL_DEPTH);
    const sillMatrices: Matrix4[] = [];
    for (const z of [cottageOpeningZ, -cottageOpeningZ]) {
      for (const x of [WINDOW_X, -WINDOW_X]) {
        sillMatrices.push(
          new Matrix4().compose(new Vector3(x, WINDOW_Y - WINDOW_HEIGHT / 2 - SILL_HEIGHT / 2, z), sillIdentity, sillScale),
          new Matrix4().compose(new Vector3(x, WINDOW_Y + WINDOW_HEIGHT / 2 + SILL_HEIGHT / 2, z), sillIdentity, sillScale),
        );
      }
    }
    const sillsAndLintels: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(STONE_SHADE_COLORS[0]),
      localMatrices: sillMatrices,
    };

    // Chimney collar: a battered (wider-at-the-base) course where the stack
    // pierces the roof — the flashing that hides the pierce seam, made
    // visible as masonry. A VERTICAL frustum over a SLOPED plane floats off
    // the downslope side and buries on the upslope side unless it is sized
    // from both: its base seats a hair below the roof surface at its own
    // DOWNSLOPE rim, and its top clears the surface at its UPSLOPE rim, so
    // no sliver of daylight can open under it from any orbit angle. The
    // panel plane drops ridgeRise over halfSpan of run; the ridge runs along
    // Z on this tier, so distance from it is measured in X.
    const COLLAR_RADIUS_TOP = 0.062; // wider than the stack's base (0.056) so it reads as a course around it
    const COLLAR_RADIUS_BOTTOM = 0.075;
    const COLLAR_EMBED = 0.01; // seated this far under the downslope surface — seam-proof, not load-bearing
    const COLLAR_REVEAL = 0.03; // stands this far above the upslope surface, so the course shows all round
    /** Roof-panel surface height at distance `x` from the ridge line. */
    const roofSurfaceYAt = (x: number): number => wallHeight + ridgeRise * (1 - x / (wallHalfWidth + eave));
    const collarBaseY = roofSurfaceYAt(chimneyX + COLLAR_RADIUS_BOTTOM) - COLLAR_EMBED;
    const collarTopY = roofSurfaceYAt(chimneyX - COLLAR_RADIUS_BOTTOM) + COLLAR_REVEAL;
    const collarHeight = collarTopY - collarBaseY;
    const chimneyCollar: StructurePart = {
      geometry: new CylinderGeometry(COLLAR_RADIUS_TOP, COLLAR_RADIUS_BOTTOM, collarHeight, 6),
      material: lambert(STONE_SHADE_COLORS[1]), // mid shade — between the stack's dark and the sills' pale
      localMatrices: [at(chimneyX, collarBaseY + collarHeight / 2, 0)],
    };

    // Loft light in the +Z gable — the timber-house's own loft-window cue,
    // carried up the ladder so the habitation glow stays a constant across
    // every gable tier.
    const LOFT_WINDOW_RISE_FRACTION = 0.35;
    const loftWindow: StructurePart = {
      geometry: new BoxGeometry(0.06, 0.07, 0.02),
      material: windowMaterial(),
      localMatrices: [at(0, wallHeight + ridgeRise * LOFT_WINDOW_RISE_FRACTION, wallHalfDepth + GABLE_END_THICKNESS / 2 + 0.012)],
    };

    // Stone quoins: the tier's own doc comment calls out "the first material
    // break" — quoins are the classic masonry tell that goes with it, dressed
    // corner stone standing proud of the rubble coursing between them. One
    // full-height pilaster per corner, four in all.
    //
    // COMPOSITION PASS: this was three loose CUBES per corner, each centred
    // beyond the wall's own arris, which read as sugar cubes balanced on the
    // corners rather than as masonry — and left the veneer's own corner seam
    // showing between them. A quoin's actual job in a wall is to dress that
    // corner along its whole height, so that is what it now does: seated so it
    // stands a hair proud of the veneer's outer face (never floating clear of
    // it), which also hides the seam where two faces of coursing meet.
    const quoinWidth = 0.06;
    const quoinProud = 0.006; // how far the dressed corner stands out past the coursing beside it
    const quoinOffset = (size: number, half: number): number =>
      half + STONE_BLOCK_DEPTH + quoinProud - size / 2;
    const quoinX = quoinOffset(quoinWidth, wallHalfWidth);
    const quoinZ = quoinOffset(quoinWidth, wallHalfDepth);
    const quoinMatrices: Matrix4[] = [];
    for (const x of [quoinX, -quoinX]) {
      for (const z of [quoinZ, -quoinZ]) quoinMatrices.push(at(x, wallHeight / 2, z));
    }
    const quoins: StructurePart = {
      geometry: new BoxGeometry(quoinWidth, wallHeight, quoinWidth),
      material: lambert(STONE_SHADE_COLORS[0]),
      localMatrices: quoinMatrices,
    };

    // The veneer itself: one shared block geometry tiled across all four wall
    // faces via stoneBlocksForFace, split into STONE_SHADE_COLORS.length
    // StructureParts by stonePartsByShade — the wall box stays as the solid
    // substrate underneath, so this is a veneer layer, not a wall replacement
    // (unlike the timber-house's log courses, which fully REPLACE their wall: a
    // stone wall's coursing sits ON a solid wall, a log wall's courses ARE it).
    const STONE_BLOCK_TARGET_WIDTH = 0.135;
    const STONE_COURSE_COUNT = 5;
    const stoneBlockGeometry = new BoxGeometry(1, 1, STONE_BLOCK_DEPTH); // unit width/height; every block's matrix carries its own
    const stoneBlocks: StoneBlock[] = [];
    for (const face of [
      { half: wallHalfWidth, axis: 'z' as const, value: wallHalfDepth + STONE_BLOCK_DEPTH / 2 },
      { half: wallHalfWidth, axis: 'z' as const, value: -(wallHalfDepth + STONE_BLOCK_DEPTH / 2) },
      { half: wallHalfDepth, axis: 'x' as const, value: wallHalfWidth + STONE_BLOCK_DEPTH / 2 },
      { half: wallHalfDepth, axis: 'x' as const, value: -(wallHalfWidth + STONE_BLOCK_DEPTH / 2) },
    ]) {
      stoneBlocks.push(
        ...stoneBlocksForFace(
          face.half,
          wallHeight,
          STONE_COURSE_COUNT,
          face.axis,
          face.value,
          STONE_BLOCK_TARGET_WIDTH,
        ),
      );
    }
    const stoneWalls = stonePartsByShade(stoneBlocks, stoneBlockGeometry);

    tiers.push([
      wall,
      roof,
      gableEnds,
      ridgeCap,
      chimney,
      chimneyPot,
      door,
      windows,
      quoins,
      roofCourses,
      doorFrame,
      sillsAndLintels,
      chimneyCollar,
      loftWindow,
      ...stoneWalls,
    ]);
  }

  // ── Tier 5: watchtower — a tall narrow stone tower with a parapet ring and a
  // slate roof. The one VERTICAL silhouette in the set: taller than every other
  // tier is wide, where every house tier is wider than it is tall.
  //
  // COMPOSITION PASS. The crenellations used to ride the parapet's CIRCUM-
  // radius while the parapet itself was a ten-sided prism, so every merlon
  // balanced on a corner of a wall it was supposed to stand on, with daylight
  // between it and the flat beneath. They now share the parapet's segment
  // count and sit on its INRADIUS, so each merlon stands squarely on one facet.
  // The stone veneer had the same portrait-block problem as the cottage's and
  // gets the same landscape re-proportioning.
  {
    const towerHeight = 1.3;
    const towerRadiusTop = 0.22;
    const towerRadiusBottom = 0.24;
    /** Sides on every round part of this tier, so tower, parapet and plinth are facet-aligned rather than three different polygons stacked. */
    const TOWER_SIDES = 8;
    // How far the stone-block ring stands proud of the tower's own tapered
    // surface, declared up here because the door has to clear its outer face
    // too — see towerDoorZ below.
    const STONE_TOWER_BLOCK_DEPTH = 0.018;
    const tower: StructurePart = {
      geometry: new CylinderGeometry(towerRadiusTop, towerRadiusBottom, towerHeight, TOWER_SIDES),
      // Mortar, not stone — the coursing below covers this shaft; what stays
      // visible of it is the joint lines (see STONE_MORTAR_COLOR).
      material: lambert(STONE_MORTAR_COLOR),
      localMatrices: [at(0, towerHeight / 2, 0)],
    };

    const parapetHeight = 0.14;
    const parapetRadius = towerRadiusTop + 0.08;
    const parapet: StructurePart = {
      geometry: new CylinderGeometry(parapetRadius, parapetRadius, parapetHeight, TOWER_SIDES),
      material: lambert(0x6f6a63),
      localMatrices: [at(0, towerHeight + parapetHeight / 2, 0)],
    };
    const roofHeight = 0.4;
    const roof: StructurePart = {
      geometry: new ConeGeometry(towerRadiusTop + 0.04, roofHeight, TOWER_SIDES),
      material: lambert(0x3a4a52),
      localMatrices: [at(0, towerHeight + parapetHeight + roofHeight / 2, 0)],
    };

    // Door at the tower's base, on the +Z face of the drum — the one tier whose
    // wall is round rather than boxed, so the door sits directly on the tower's
    // own radius instead of a flat wall face. z clears the stone ring's outer
    // face, not just the bare tapered wall beneath it.
    const doorHeight = 0.28;
    const towerDoorZ = towerRadiusBottom + STONE_TOWER_BLOCK_DEPTH + 0.01;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.12, doorHeight, 0.04),
      material: lambert(0x2a2018),
      localMatrices: [at(0, doorHeight / 2, towerDoorZ)],
    };

    // Arrow slits: tall thin glows up the shaft, evenly ringed rather than all
    // facing one way — a watchtower is meant to see (and be seen watching) in
    // every direction. Reuses the window glow so "there is a light behind this
    // opening" reads as the same cue at every tier tall enough to have upper
    // floors. Two bands of them, because one band up a 1.3-unit shaft reads as
    // a single lit floor rather than as a tower that is manned.
    const ARROW_SLIT_COUNT = 4;
    const ARROW_SLIT_BAND_YS = [towerHeight * 0.45, towerHeight * 0.72];
    const arrowSlitMatrices: Matrix4[] = [];
    for (const y of ARROW_SLIT_BAND_YS) {
      arrowSlitMatrices.push(
        ...circleRingMatrices(ARROW_SLIT_COUNT, towerRadiusTop + STONE_TOWER_BLOCK_DEPTH, y, true),
      );
    }
    const arrowSlits: StructurePart = {
      geometry: new BoxGeometry(0.035, 0.16, 0.02),
      material: windowMaterial(),
      localMatrices: arrowSlitMatrices,
    };

    // Crenellations: merlon blocks standing proud of the parapet ring — the
    // tier doc's own "parapet ring" made concrete, since a plain ring reads as
    // a collar, not a fortification. One merlon per parapet FACET, centred on
    // that facet's own inradius, so each stands squarely on flat stone.
    const merlonHeight = 0.12;
    const merlonDepth = 0.055;
    const parapetInradius = parapetRadius * Math.cos(Math.PI / TOWER_SIDES);
    const merlons: StructurePart = {
      geometry: new BoxGeometry(0.075, merlonHeight, merlonDepth),
      material: lambert(0x6f6a63),
      localMatrices: circleRingMatrices(
        TOWER_SIDES,
        parapetInradius - merlonDepth / 2,
        towerHeight + parapetHeight + merlonHeight / 2 - 0.015,
        true,
        Math.PI / TOWER_SIDES, // half a facet's turn: centres each merlon on a facet, not on the edge between two
      ),
    };

    // Base plinth: a wider stone footing ring at the tower's foot — the
    // parapet's counterpart at ground level, so the tower reads as founded on
    // masonry rather than planted straight into the terrain.
    const plinthHeight = 0.11;
    const plinth: StructurePart = {
      geometry: new CylinderGeometry(towerRadiusBottom + 0.05, towerRadiusBottom + 0.09, plinthHeight, TOWER_SIDES),
      material: lambert(0x6f6a63),
      localMatrices: [at(0, plinthHeight / 2, 0)],
    };

    // The tower's wall is a CYLINDER, not a box, so stoneBlocksForFace's
    // flat-face grid does not apply directly; this builds the equivalent for a
    // round wall — courses of small boxes ringed around the shaft via
    // circleRingMatrices (faceOutward, exactly like the arrow slits and merlons
    // above), reading the SAME STONE_SHADE_COLORS in the SAME fixed
    // (course + position) cycle stoneBlocksForFace uses, so the cottage and the
    // tower are drawn from one shared palette rather than two similar-but-
    // different ones.
    //
    // COMPOSITION PASS, two changes. (1) Each course now rides the shaft's OWN
    // radius at that course's height, not the widest radius shared by all of
    // them: the tower tapers, so one fixed radius meant the top courses stood a
    // whole block-depth clear of the wall behind them and read as a loose collar
    // of tiles. (2) The blocks fill their slots (STONE_JOINT_FRACTION, shared
    // with the cottage) instead of leaving a seventh of every slot empty, which
    // is what made the shaft read as scattered patches rather than as coursing.
    const STONE_TOWER_COURSE_COUNT = 7;
    const STONE_TOWER_TARGET_SPACING = 0.15;
    const towerStoneBandBottom = plinthHeight;
    const towerStoneBandTop = towerHeight - 0.05;
    const towerStoneBand = towerStoneBandTop - towerStoneBandBottom;
    const towerCourseHeight = towerStoneBand / STONE_TOWER_COURSE_COUNT;
    /** The shaft's own radius at height `y` — the cylinder tapers linearly from bottom to top. */
    const towerRadiusAt = (y: number): number =>
      towerRadiusBottom + (towerRadiusTop - towerRadiusBottom) * (y / towerHeight);
    // Nearest whole divisor of the ring's own circumference, same "target
    // spacing" trick stoneBlocksForFace and the marquee bulbs both use — fixed
    // across courses (so the stagger below stays a half-slot everywhere) and
    // measured at the band's midpoint, the average of the radii it spans.
    const towerStoneMidRadius = towerRadiusAt((towerStoneBandBottom + towerStoneBandTop) / 2);
    const towerStoneRingCount = Math.round(
      (FULL_TURN_RADIANS * towerStoneMidRadius) / STONE_TOWER_TARGET_SPACING,
    );
    const towerStoneHalfSlotAngle = Math.PI / towerStoneRingCount; // half of one slot's own angular width
    // A stone block landing in front of an arrow slit would defeat the slit.
    // Rather than reasoning about which courses vertically overlap the slit
    // bands, this carves a full-height angular seam at each slit's own angle —
    // no stone block within ARROW_SLIT_ANGLE_CLEARANCE of a slit's angle, at
    // ANY course — the masonry equivalent of a real tower's slits being built
    // INTO the coursing rather than one course happening to leave a gap there.
    const ARROW_SLIT_ANGLES = Array.from(
      { length: ARROW_SLIT_COUNT },
      (_, i) => (FULL_TURN_RADIANS * i) / ARROW_SLIT_COUNT,
    );
    const ARROW_SLIT_ANGLE_CLEARANCE = towerStoneHalfSlotAngle; // half a slot either side of the slit
    const towerStoneBlocks: StoneBlock[] = [];
    for (let course = 0; course < STONE_TOWER_COURSE_COUNT; course++) {
      const y = towerStoneBandBottom + towerCourseHeight * (course + 0.5);
      const courseRadius = towerRadiusAt(y) + STONE_TOWER_BLOCK_DEPTH / 2;
      const startAngle = course % 2 === 1 ? towerStoneHalfSlotAngle : 0; // running-bond stagger, ring case
      const ring = circleRingMatrices(towerStoneRingCount, courseRadius, y, true, startAngle);
      // Block width follows the course's own circumference, so a course near
      // the narrower top is made of slightly narrower stones rather than of the
      // same stones overlapping each other.
      const courseBlockScale = new Matrix4().makeScale(
        ((FULL_TURN_RADIANS * courseRadius) / towerStoneRingCount) * (1 - STONE_JOINT_FRACTION),
        towerCourseHeight * (1 - STONE_JOINT_FRACTION),
        1,
      );
      for (let i = 0; i < ring.length; i++) {
        // Same angle formula circleRingMatrices used internally to place
        // ring[i] — recomputed here (cheaply) only to test it against the slit
        // seam, not to rebuild the matrix itself.
        const angle = startAngle + (FULL_TURN_RADIANS * i) / towerStoneRingCount;
        const nearSlit = ARROW_SLIT_ANGLES.some(
          (slitAngle) => angularDistance(angle, slitAngle) < ARROW_SLIT_ANGLE_CLEARANCE,
        );
        if (nearSlit) continue;
        towerStoneBlocks.push({
          matrix: ring[i].multiply(courseBlockScale),
          shadeIndex: (course + i) % STONE_SHADE_COLORS.length,
        });
      }
    }
    const towerStoneGeometry = new BoxGeometry(1, 1, STONE_TOWER_BLOCK_DEPTH);
    const towerStoneWalls = stonePartsByShade(towerStoneBlocks, towerStoneGeometry);

    // FIDELITY PASS 2026-08-20 (owner: structures too low-resolution from the
    // orbit camera). Four tower additions, each a fortification's own
    // vocabulary: corbels carrying the parapet's overhang, a stone door
    // surround with a threshold step, an eave ring where the slate cone meets
    // the parapet, and a banner at the spire — the one silhouette flourish,
    // on the one tier whose job is to be seen from far away.
    //
    // Corbels: the parapet overhangs the shaft (parapetRadius = shaft top
    // + 0.08) with nothing visibly holding the overhang; one bracket per
    // facet under its rim is what makes the ring read as BUILT onto the
    // tower rather than dropped over it. Same facet count and inradius
    // discipline as the merlons above, one facet's half-turn offset so each
    // corbel sits under a merlon rather than under a gap.
    const CORBEL_WIDTH = 0.05;
    const CORBEL_HEIGHT = 0.06;
    const CORBEL_DEPTH = 0.06; // spans from the shaft's surface out under the parapet rim
    const corbelRingRadius = towerRadiusAt(towerHeight - CORBEL_HEIGHT / 2) + CORBEL_DEPTH / 2;
    const corbels: StructurePart = {
      geometry: new BoxGeometry(CORBEL_WIDTH, CORBEL_HEIGHT, CORBEL_DEPTH),
      material: lambert(0x6f6a63), // the parapet's own stone — corbels belong to the ring they carry
      localMatrices: circleRingMatrices(
        TOWER_SIDES,
        corbelRingRadius,
        towerHeight - CORBEL_HEIGHT / 2,
        true,
        Math.PI / TOWER_SIDES, // under the merlons (their own facet-centring offset)
      ),
    };

    // Door surround and threshold: the cottage's dressed-stone story at the
    // tower's own base — a frame in the shared doorFrameMatrices shape plus
    // one wide step, so the entrance reads as an entrance from orbit height
    // instead of as a dark chip on the drum.
    const TOWER_DOOR_WIDTH = 0.12; // the door part's own width, restated for the frame
    const towerDoorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(STONE_SHADE_COLORS[0]),
      localMatrices: doorFrameMatrices(TOWER_DOOR_WIDTH, doorHeight, 0, 0, towerDoorZ),
    };
    const THRESHOLD_WIDTH = 0.2; // wider than the framed opening — a landing, not a shelf
    const THRESHOLD_HEIGHT = 0.035;
    const THRESHOLD_DEPTH = 0.08;
    const threshold: StructurePart = {
      geometry: new BoxGeometry(THRESHOLD_WIDTH, THRESHOLD_HEIGHT, THRESHOLD_DEPTH),
      material: lambert(STONE_SHADE_COLORS[1]),
      localMatrices: [at(0, THRESHOLD_HEIGHT / 2, towerDoorZ + THRESHOLD_DEPTH / 2)],
    };

    // Eave ring: a slim collar under the slate cone's own rim, closing the
    // step where roof meets parapet — the hut's footing reasoning, at the
    // top of the build instead of the bottom.
    const EAVE_RING_HEIGHT = 0.035;
    const EAVE_RING_RADIUS = towerRadiusTop + 0.055; // a hair past the cone's base (towerRadiusTop + 0.04)
    const eaveRing: StructurePart = {
      geometry: new CylinderGeometry(EAVE_RING_RADIUS, EAVE_RING_RADIUS, EAVE_RING_HEIGHT, TOWER_SIDES),
      material: lambert(0x2e3b42), // the slate's own family, darker — an under-eave shadow course
      localMatrices: [at(0, towerHeight + parapetHeight + EAVE_RING_HEIGHT / 2, 0)],
    };

    // Banner: a short staff out of the spire with a small pennant — pure
    // silhouette, no emissive (the arrow slits keep the "manned" glow role).
    // Height is the one axis the footprint bound deliberately leaves free
    // (see buildDurandsParts' own height note).
    const BANNER_STAFF_RADIUS = 0.008;
    const BANNER_STAFF_HEIGHT = 0.16;
    const bannerStaffBaseY = towerHeight + parapetHeight + roofHeight; // the spire's own apex
    const BANNER_FLAG_WIDTH = 0.09; // flies in +X from the staff
    const BANNER_FLAG_HEIGHT = 0.055;
    const BANNER_FLAG_THICKNESS = 0.012; // boxy on purpose — cloth at this art scale is a slab, like every other surface here
    const bannerStaff: StructurePart = {
      geometry: new CylinderGeometry(BANNER_STAFF_RADIUS, BANNER_STAFF_RADIUS, BANNER_STAFF_HEIGHT, 5),
      material: lambert(0x3a2a1a),
      localMatrices: [at(0, bannerStaffBaseY + BANNER_STAFF_HEIGHT / 2, 0)],
    };
    const bannerFlag: StructurePart = {
      geometry: new BoxGeometry(BANNER_FLAG_WIDTH, BANNER_FLAG_HEIGHT, BANNER_FLAG_THICKNESS),
      material: lambert(0x8a2f2f), // heraldic red — the one saturated accent on an all-stone tier
      localMatrices: [
        at(
          BANNER_STAFF_RADIUS + BANNER_FLAG_WIDTH / 2,
          bannerStaffBaseY + BANNER_STAFF_HEIGHT - BANNER_FLAG_HEIGHT / 2,
          0,
        ),
      ],
    };

    tiers.push([
      tower,
      parapet,
      roof,
      door,
      arrowSlits,
      merlons,
      plinth,
      corbels,
      towerDoorFrame,
      threshold,
      eaveRing,
      bannerStaff,
      bannerFlag,
      ...towerStoneWalls,
    ]);
  }

  return tiers;
}

// ── Fishing villages: the top-tier VARIANT set for COASTAL sites (card 33,
// redesigned 2026-08-22) ────────────────────────────────────────────────────
//
// At MAX_STRUCTURE_TIER, a coastal site renders as one of TEN grass huts
// (fishingHuts.ts) instead of the stone watchtower — little reed and daub
// huts with a couple of fish on the sand in front, one rolled per cell from
// the cell's own coordinates.
//
// WHAT CHANGED, AND WHAT DID NOT. This replaces the single raised dock
// lookout ("buildHarborParts") that shipped with card 33; the DISPATCH
// around it is unchanged in shape and unchanged in priority. A site variant
// is still a categorical fact about this settlement's ground, not a rarity,
// so it still wins over Durand's ~1-in-6 roll (see apply() below) rather
// than competing with it. What is new is that a site now offers a SET of
// models rather than one, and picks between them with its own per-cell roll
// — the reason SiteVariantSet below carries a `pick` beside its builders
// instead of the registry mapping straight to a part list.
//
// EXTENDING IT. A second site kind with its own look is one more entry in
// SITE_TOP_TIER_VARIANTS: a list of builders and a pick function (or a
// single builder and `() => 0`). Nothing in the dispatch, the allocation or
// the disposal below needs to know how many kinds or variants exist. If a
// future card wants coastal sites to diverge BELOW the top tier too, the
// seam is still the registry key: make it `${tier}:${site}` and this
// dispatch needs no further change — it already treats the variant set as
// an opaque, optional override of one tier.

/**
 * One site's model set: the models it can render as, and which of them a
 * given CELL gets. `pick` must be a pure function of the cell — every client
 * has to draw the same village on the same shore, with nothing on the wire
 * to reconcile them.
 */
interface SiteVariantSet {
  readonly builders: ReadonlyArray<() => StructurePart[]>;
  pick(cellX: number, cellY: number): number;
}

/**
 * TOP-TIER model variants keyed by site. A site kind with an entry here
 * REPLACES MAX_STRUCTURE_TIER's normal model (and takes priority over the
 * Durand's roll); a kind absent from this record falls through to whatever
 * apply() would have done anyway.
 */
const SITE_TOP_TIER_VARIANTS: Readonly<Partial<Record<SiteKind, SiteVariantSet>>> = {
  coastal: { builders: FISHING_HUT_BUILDERS, pick: fishingHutVariantIndex },
};

// ── Durand's: a cosmetic top-tier VARIANT ───────────────────────────────────
//
// At MAX_STRUCTURE_TIER, a deterministic ~1-in-6 slice of cells (see
// ./durands.ts) render as "Durand's" instead of the watchtower above: a
// two-storey saloon in the same low-poly, flat-shaded, no-external-asset
// style as every tier above, plus one deliberate exception — a small sign
// carrying real text. Everything else in this file draws text-free
// primitives by design (see the file banner); the sign is the one place
// that rule is bent, and only because the brief asks for a NAMED building,
// which no combination of boxes and cones can spell out on its own.
//
// The text is a CanvasTexture drawn ONCE at module init (below), not per
// building: every Durand's sign shows the identical string, so one canvas
// and one texture are shared by every instance the same way one geometry
// already is. That is also what keeps the sign INSTANCED rather than
// forcing a non-instanced mesh per building — the usual reason a texture
// breaks instancing (a different image per instance) does not apply here,
// because there is only ever one image.

/** Canvas the sign text is rasterised into. Proportioned for a short word. */
const DURANDS_SIGN_CANVAS_WIDTH = 512;
const DURANDS_SIGN_CANVAS_HEIGHT = 128;

/** The sign's text. Drawn once; never assembled from a per-instance string. */
const DURANDS_SIGN_TEXT = "Durand's";

/**
 * `bold <px> sans-serif` — the canvas default generic family, deliberately:
 * the brief calls for no external font assets, and `sans-serif` resolves to
 * whatever the platform ships rather than a font this bundle would have to
 * carry. `bold` is load-bearing at this resolution — the regular weight's
 * thin strokes alias badly once minified onto a low-poly board this small.
 */
const DURANDS_SIGN_FONT = 'bold 84px sans-serif';

/** Dark red-brown board and warm gold-leaf lettering — a saloon sign's usual palette. */
const DURANDS_SIGN_BOARD_COLOR = '#3a1610';
const DURANDS_SIGN_TEXT_COLOR = '#f2c85b';

/**
 * Draws the sign once and returns its texture. Called exactly once, at
 * module init (the module-scope `const` just below), per the brief.
 */
function buildDurandsSignTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = DURANDS_SIGN_CANVAS_WIDTH;
  canvas.height = DURANDS_SIGN_CANVAS_HEIGHT;

  const context = canvas.getContext('2d');
  if (context !== null) {
    context.fillStyle = DURANDS_SIGN_BOARD_COLOR;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = DURANDS_SIGN_TEXT_COLOR;
    context.font = DURANDS_SIGN_FONT;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(DURANDS_SIGN_TEXT, canvas.width / 2, canvas.height / 2);
  }
  // A null 2D context (no canvas support at all) leaves the canvas blank
  // rather than throwing at module init, which would take the whole plugin
  // down with it — a blank sign board is a cosmetic miss, not a crash.

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Built once, at module init — every Durand's sign instance shares this texture. */
const DURANDS_SIGN_TEXTURE = buildDurandsSignTexture();

/**
 * Seconds for one full flash cycle (dim → bright → dim). ~0.625 Hz.
 *
 * Bounded well under 3 Hz deliberately: weather/client/sky.ts's own lightning
 * flash and monsters/client/dread.ts's own strike both cite the same ceiling
 * — the photosensitive-seizure threshold most style guides (WCAG among them)
 * draw the line at. This sign is a continuous, LOW-frequency pulse rather
 * than a rare strobe, so unlike those two effects it does not need its own
 * prefers-reduced-motion gate: at this period there is nothing to reduce.
 */
export const DURANDS_SIGN_FLASH_PERIOD_SECONDS = 1.6;

/** Warm gold — the same hue as the sign's painted lettering, so the glow reads as the letters lighting up rather than a stage light hitting the board. */
const DURANDS_SIGN_EMISSIVE_COLOR = 0xf2c85b;

/**
 * Emissive intensity bounds the flash pulses between. The minimum is not
 * zero: at 0 the board still reads as painted wood under the scene's own
 * lights (see MeshLambertMaterial below), so "dark" is "unlit sign", not
 * "invisible sign". The maximum (matches relics/client/index.ts's own
 * GEM_EMISSIVE_INTENSITY reasoning) is high enough to read as lit against
 * shaded terrain without ACES tone-mapping blowing the lettering to white.
 */
const DURANDS_SIGN_EMISSIVE_MIN = 0.05;
const DURANDS_SIGN_EMISSIVE_MAX = 1.4;

/** One full turn, for turning a period in seconds into an angular rate. */
const DURANDS_TWO_PI = Math.PI * 2;

// ── Marquee bulbs: little blinking lights around the sign header ───────────
//
// Owner feedback: "the whorehouse needs to have little blinking lights
// around the header." A ring/border of small emissive bulbs framing the sign
// board on all four edges (top, both sides, AND bottom — more than the "top
// edge + sides at minimum" the brief asks for, for a proper closed marquee
// frame), split into two PHASE GROUPS so alternating bulbs light in a chase
// rather than all together — each phase group is its own InstancedMesh
// sharing one material, the same "one InstancedMesh per part" rule every
// other part in this file keeps.
//
// FREQUENCY CEILING: this plugin already cites the project's 3 Hz
// photosensitivity ceiling for DURANDS_SIGN_FLASH_PERIOD_SECONDS above (the
// same ceiling weather/client/sky.ts's lightning flash and monsters/client/
// dread.ts's strike cite). The bulb chase does not invent a second flash
// mechanism: it reuses the sign's own smooth CONTINUOUS SINE shape (never a
// hard on/off cut, which is the more seizure-relevant pattern under WCAG),
// phase-locked to the sign's own period so the two read as one marquee
// rather than as two effects competing for attention. Phase A and phase B
// are the same sine 180° apart — when A is brightest, B is dimmest — at
// HALF the sign's own period:
//
//   sign  period 1.6 s  → 1 / 1.6  = 0.625 Hz
//   bulbs period 0.8 s  → 1 / 0.8  = 1.25  Hz
//   combined            = 0.625 + 1.25 = 1.875 Hz
//
// 1.875 Hz sits 37.5% below the 3 Hz ceiling even added together (the
// conservative reading — sign and bulbs share the same small header area, so
// this treats them as one combined stimulus rather than crediting the
// ceiling separately to each). Each is also individually far under 3 Hz on
// its own, and — like the sign — a continuous sine has nothing a
// prefers-reduced-motion gate would meaningfully reduce.
export const DURANDS_MARQUEE_BULB_PERIOD_SECONDS = DURANDS_SIGN_FLASH_PERIOD_SECONDS / 2;

/** Warm incandescent bulb glass — a shade whiter than the sign's own gold-leaf lettering, so the bulbs read as their own light source next to it rather than as more sign. Only ever the EMISSIVE colour, never the base colour (see DURANDS_MARQUEE_BULB_SOCKET_COLOR immediately below) — a bright base colour would keep a "dim" bulb looking lit under the scene's own directional/hemisphere lights regardless of emissiveIntensity, which is exactly the failure mode that would make the chase invisible. */
const DURANDS_MARQUEE_BULB_COLOR = 0xffe9a8;
/**
 * Dark bulb-socket base colour — the same "dark frame, bright emissive
 * glow" split windowMaterial() already keeps for lit windows, applied here
 * for the same reason: with the base colour bright, an unlit bulb would
 * still catch the scene's own lights and read as lit regardless of
 * emissiveIntensity, silencing the chase. Dark base + swinging emissive is
 * what makes "off" actually read as off.
 */
const DURANDS_MARQUEE_BULB_SOCKET_COLOR = 0x3a3226;
/** Same floor-is-not-zero reasoning as DURANDS_SIGN_EMISSIVE_MIN: a "dim" bulb still reads as an unlit bulb, not a missing one. */
const DURANDS_MARQUEE_BULB_EMISSIVE_MIN = 0.05;
/** Below DURANDS_SIGN_EMISSIVE_MAX on purpose — the sign is the marquee's focal point; the bulbs frame it rather than out-shining it. */
const DURANDS_MARQUEE_BULB_EMISSIVE_MAX = 1.1;
/** Bulb radius, world units — small enough to read as individual bulbs rather than a solid strip. */
const DURANDS_MARQUEE_BULB_RADIUS = 0.014;
/** How far outward the bulb ring sits from the sign board's own edge, before the border is walked. */
const DURANDS_MARQUEE_BULB_MARGIN = 0.025;
/** Target arc-length between adjacent bulbs; the actual count is the closest whole divisor of the frame's perimeter (see buildDurandsParts). */
const DURANDS_MARQUEE_BULB_TARGET_SPACING = 0.09;
/** How far the bulbs stand proud of the sign board's own face — clears the board the same way the sign itself clears the false front (see signGap below). */
const DURANDS_MARQUEE_BULB_GAP = 0.015;

/**
 * `count` points evenly spaced around a rectangle's border (half-width `hw`,
 * half-height `hh`), starting at the top-left corner and walking clockwise.
 * The rectangle case of circleRingMatrices above — the sign board is a
 * rectangle, not a circle, so it earns its own small helper rather than
 * forcing that one to handle a shape it was not written for.
 */
function rectangleBorderPoints(count: number, hw: number, hh: number): Array<{ x: number; y: number }> {
  const top = 2 * hw;
  const right = 2 * hh;
  const bottom = 2 * hw;
  const perimeter = top + right + bottom + right; // top + right + bottom + left (left === right in length)
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    let t = (perimeter * i) / count;
    if (t < top) {
      points.push({ x: -hw + t, y: hh });
      continue;
    }
    t -= top;
    if (t < right) {
      points.push({ x: hw, y: hh - t });
      continue;
    }
    t -= right;
    if (t < bottom) {
      points.push({ x: hw - t, y: -hh });
      continue;
    }
    t -= bottom;
    points.push({ x: -hw, y: -hh + t }); // left edge
  }
  return points;
}

// ── Neon dancer: the rooftop sign figure ────────────────────────────────────
//
// Owner request, twice: a dancer on the saloon's pole, and then — after the
// first attempt — "your pole dancers look terrible, and they don't have any
// boobs". Both notes are about the same root cause, so both are answered by
// the same change rather than by nudging numbers: the figure was a 0.42-unit
// stick skeleton tucked BEHIND a porch post, at a scale where nothing about
// it could read from the game's own camera (OrbitControls clamps the player no
// closer than CAMERA_MIN_DISTANCE, and 0.42 units at that range is a smudge
// tens of pixels tall). A sign figure has to be sign-SIZED and unobstructed,
// so the dancer is now the building's ROOFTOP SIGN: a 0.78-unit figure on its
// own board above the false front, roughly twice the height of the whole
// silhouette it used to hide inside, with nothing in front of it.
//
// STILL A SIGN, NOT A BODY. It is drawn exactly the way a neon sign is drawn:
// glowing TUBE OUTLINE and nothing else — a profile silhouette traced as
// polylines (back line, front line, limbs, hair) plus circles for the head and
// the bust curve. There is no surface, no anatomy, no detail of any kind
// inside the outline, and the bust is what makes the silhouette female in the
// same way the hip and waist curves do: one curve of tube, read at sign scale.
//
// Two fixed poses alternate on the marquee's own phase clock (pose A lit with
// bulb phase A, pose B with phase B) — the classic two-pose animated-sign
// trick: apparent motion with zero per-frame matrix work, and no new flash
// frequency beyond the 1.25 Hz bulb sine already counted in the marquee's
// 3 Hz-ceiling arithmetic above.

/** Neon-pink tube glow; deliberately not the marquee's gold so the figure reads as its own sign element. */
const DURANDS_DANCER_NEON_COLOR = 0xff4f96;
/**
 * Dark tube base. REDESIGN 2026-08-19: matched to the board's own colour
 * (rather than the old maroon 0x33202b) so an OFF tube disappears into the
 * board instead of standing behind the lit pose as a dark scribble — the
 * "ghost figure" that made the old two-pose sign read as a muddle.
 */
const DURANDS_DANCER_TUBE_COLOR = 0x241016;
/**
 * Fully dark, not the bulbs' visible-when-off floor: a bulb that vanishes
 * looks broken, but an OFF neon LIMB must vanish — the whole two-frame trick
 * is that only one limb set exists at a time.
 */
const DURANDS_DANCER_EMISSIVE_MIN = 0.0;
/** Slightly under the bulbs' own max: the figure is set dressing, the name sign stays the focal point. */
const DURANDS_DANCER_EMISSIVE_MAX = 1.0;
/**
 * The BODY outline never blinks (see DURANDS_DANCER_BODY_STROKES): held a
 * shade under the limbs' peak so the moving limbs carry the eye.
 */
const DURANDS_DANCER_BODY_EMISSIVE_INTENSITY = 0.85;
/**
 * Neon-tube radius. Raised again from 0.018 in the 2026-08-19 redesign: the
 * line's weight is what carries the silhouette at game distance, and the
 * smooth-arc strokes below can afford a heavier line without tangling because
 * consecutive segments now bend a few degrees at a time instead of cornering.
 */
const DURANDS_DANCER_TUBE_RADIUS = 0.021;
/** Unit length the shared segment cylinder is built at; per-segment matrices scale Y to the real length. */
const DURANDS_DANCER_SEGMENT_UNIT = 0.1;
/** The head circle. Every other circle on the figure is this one geometry, scaled per instance. */
const DURANDS_DANCER_HEAD_RADIUS = 0.055;
/** The bust circle, nested inside the outline's own bust arc — the emphasis that keeps the silhouette female at any distance. */
const DURANDS_DANCER_BUST_RADIUS = 0.048;
/** Circle closing each bend between two tube segments, so a corner never opens a notch. Matches the tube it joins. */
const DURANDS_DANCER_JOINT_RADIUS = DURANDS_DANCER_TUBE_RADIUS;
/** The pole itself: a neon tube, lit steadily (it is the stage, not the performer, so it never blinks). */
const DURANDS_DANCER_POLE_RADIUS = 0.016;
const DURANDS_DANCER_POLE_COLOR = 0xffd9ec;
const DURANDS_DANCER_POLE_EMISSIVE_INTENSITY = 0.9;
/**
 * The board's own neon border: a steady warm-gold rectangle of tube just
 * inside the board edge, the marquee's colour family — what turns the black
 * slab into a lit sign CABINET. Steady on purpose: it is framing, not
 * animation, so it adds no flash frequency to the 3 Hz arithmetic.
 */
const DURANDS_DANCER_FRAME_COLOR = 0xffd98a;
const DURANDS_DANCER_FRAME_EMISSIVE_INTENSITY = 0.55;
/** How far the border tube sits in from the board's edge. */
const DURANDS_DANCER_FRAME_INSET = 0.035;
/** Border tube: slimmer than the figure's line, so the frame stays quieter than the dancer. */
const DURANDS_DANCER_FRAME_TUBE_RADIUS = 0.012;

/** A point in the sign board's own 2D frame: `u` across it, `v` up from the figure's feet. */
type SignPoint = readonly [u: number, v: number];

/**
 * One neon tube segment BETWEEN two joints in the building's front (x, y)
 * plane: midpoint, length and Z-tilt are all derived from the endpoints, so the
 * figure is authored as a joint skeleton and every limb connects by
 * construction — hand-placed midpoints proved unreviewable (the first draft
 * rendered as a disconnected jumble; this helper is the fix).
 */
function dancerSegment(x1: number, y1: number, x2: number, y2: number, z: number): Matrix4 {
  const dx = x2 - x1;
  const dy = y2 - y1;
  // rotZ(θ) maps the cylinder's +Y axis onto (-sin θ, cos θ), so this angle
  // points the tube from joint 1 to joint 2.
  const tiltZ = Math.atan2(-dx, dy);
  const length = Math.hypot(dx, dy);
  return new Matrix4().compose(
    new Vector3((x1 + x2) / 2, (y1 + y2) / 2, z),
    new Quaternion().setFromAxisAngle(Z_AXIS, tiltZ),
    new Vector3(1, length / DURANDS_DANCER_SEGMENT_UNIT, 1),
  );
}

/** One circle of the figure, as a scale on the shared head-sized sphere geometry. */
function dancerCircle(x: number, y: number, z: number, radius: number): Matrix4 {
  const scale = radius / DURANDS_DANCER_HEAD_RADIUS;
  // Depth is NOT the drawn radius. A neon "circle" is a flat loop of tube, and
  // a full sphere at head/bust radius reaches deeper than the figure's
  // tube-radius stand-off from the board — the head and bust spheres poked out
  // of the board's BACK face (seen in-world as pink dots on the sign's rear).
  // Squashing every circle to the tube's own half-depth puts its back face
  // exactly on the board face, whatever its drawn radius.
  const depthScale = DURANDS_DANCER_TUBE_RADIUS / DURANDS_DANCER_HEAD_RADIUS;
  return new Matrix4().compose(new Vector3(x, y, z), new Quaternion(), new Vector3(scale, scale, depthScale));
}

// ── The drawing (redesigned from scratch, owner request 2026-08-19:
// "completely reconsidered") ────────────────────────────────────────────────
//
// THREE DECISIONS replace the old two-full-figure design:
//
//   1. SMOOTH ARCS, NOT CORNERED POLYLINES. Every stroke is authored as
//      quadratic arcs and sampled into short runs (neonArc/neonStroke), so a
//      line bends a few degrees per segment — the "one confident continuous
//      outline" of a real bent-glass tube. The old hand-placed polylines
//      cornered hard at every joint, which is what read as scribble.
//   2. THE BODY NEVER BLINKS; ONLY THE LIMBS SWAP. The torso outline, head,
//      bust, standing leg — everything that would be IDENTICAL in both frames
//      — is drawn ONCE on its own steady material, and only the kicking leg,
//      the two arms and the ponytail alternate with the marquee phases. This
//      is how real two-frame neon figures are built (shared tubes + two limb
//      sets), it halves the tube count, and it removes the old design's
//      biggest legibility fault: a dark ghost of the OTHER pose standing
//      behind the lit one.
//   3. A CAN-CAN KICK. The two limb sets are one high kick and one low kick
//      of the SAME leg, with the free arm counter-swinging and the ponytail
//      tossing — a single, instantly legible motion, rather than two
//      unrelated acrobatic poses the eye had to reconcile.

/**
 * Arc samples per quadratic. Four runs per arc keeps consecutive tube
 * headings within ~15° of each other on every curve below — visually a smooth
 * bend at the tube radius used — without flooding the instancer.
 */
const DANCER_ARC_SAMPLES = 4;

/** One quadratic arc, sampled from `from` to `to` toward `control`. */
function neonArc(from: SignPoint, control: SignPoint, to: SignPoint): SignPoint[] {
  const points: SignPoint[] = [];
  for (let i = 0; i <= DANCER_ARC_SAMPLES; i++) {
    const t = i / DANCER_ARC_SAMPLES;
    const s = 1 - t;
    points.push([
      s * s * from[0] + 2 * s * t * control[0] + t * t * to[0],
      s * s * from[1] + 2 * s * t * control[1] + t * t * to[1],
    ]);
  }
  return points;
}

/** Chains arcs into ONE continuous stroke (each arc must start where the previous ended; the duplicate point is dropped). */
function neonStroke(...arcs: SignPoint[][]): SignPoint[] {
  const stroke: SignPoint[] = [...arcs[0]];
  for (let i = 1; i < arcs.length; i++) stroke.push(...arcs[i].slice(1));
  return stroke;
}

/** The u the pole stands at — the mark every pole-side hand and toe reaches for. */
const DURANDS_DANCER_POLE_U = 0.2;

/**
 * THE BODY — everything both frames share, drawn once and lit steadily.
 * Profile facing the pole (+u): chin high, bust arc out front, waist pinched,
 * seat arc out back, weight on one straight leg with a pointed foot.
 */
const DURANDS_DANCER_BODY_STROKES: ReadonlyArray<readonly SignPoint[]> = [
  // Front outline: chin → throat → bust (the apex arc) → under-bust → pinched
  // waist → belly → front of the hip.
  neonStroke(
    neonArc([0.05, 0.675], [0.075, 0.63], [0.075, 0.585]),
    neonArc([0.075, 0.585], [0.125, 0.55], [0.055, 0.505]),
    neonArc([0.055, 0.505], [0.03, 0.455], [0.075, 0.385]),
  ),
  // Back outline: nape → shoulder → arched small of the back → seat → under-seat.
  neonStroke(
    neonArc([-0.02, 0.66], [-0.06, 0.6], [-0.055, 0.52]),
    neonArc([-0.055, 0.52], [-0.125, 0.45], [-0.06, 0.355]),
  ),
  // Pelvis + standing leg, one line: front hip across to the under-seat, down
  // the thigh, a soft knee, the calf, and out through a pointed foot.
  neonStroke(
    neonArc([0.075, 0.385], [0.01, 0.345], [-0.06, 0.355]),
    neonArc([-0.06, 0.355], [-0.005, 0.24], [0.005, 0.19]),
    neonArc([0.005, 0.19], [0.015, 0.09], [-0.005, 0.025]),
    neonArc([-0.005, 0.025], [0.02, 0.0], [0.065, 0.005]),
  ),
];

/** Centre of the steady head circle. */
const DURANDS_DANCER_BODY_HEAD: SignPoint = [0.015, 0.725];
/** Centre of the steady bust circle, nested at the front outline's apex. */
const DURANDS_DANCER_BODY_BUST: SignPoint = [0.09, 0.552];

/**
 * FRAME A limbs — the HIGH kick: kicking leg swept up toward the pole, pole
 * hand gripping high, free arm trailing low behind, ponytail streaming back.
 */
const DURANDS_DANCER_LIMBS_A: ReadonlyArray<readonly SignPoint[]> = [
  // Kicking leg: hip → raised knee → toe pointed at the pole's upper reach.
  neonStroke(
    neonArc([0.045, 0.375], [0.15, 0.42], [0.21, 0.47]),
    neonArc([0.21, 0.47], [0.27, 0.52], [0.305, 0.575]),
  ),
  // Pole arm, high grip.
  neonArc([0.02, 0.615], [0.1, 0.665], [DURANDS_DANCER_POLE_U, 0.675]),
  // Free arm, swept straight out behind — clear of the back outline, so the
  // two lines diverge instead of tangling.
  neonArc([-0.015, 0.61], [-0.1, 0.635], [-0.19, 0.6]),
  // Ponytail, streaming back off the head, held ABOVE the shoulder line so it
  // never reads as part of the face.
  neonArc([-0.045, 0.735], [-0.115, 0.75], [-0.165, 0.715]),
];

/**
 * FRAME B limbs — the LOW kick of the same leg, the grip slid down the pole,
 * the free arm flung up, the ponytail tossed: frame A's mirror beat, so the
 * two-frame flip reads as one can-can kick.
 */
const DURANDS_DANCER_LIMBS_B: ReadonlyArray<readonly SignPoint[]> = [
  // Kicking leg, extended low.
  neonStroke(
    neonArc([0.045, 0.375], [0.13, 0.33], [0.19, 0.3]),
    neonArc([0.19, 0.3], [0.25, 0.27], [0.295, 0.215]),
  ),
  // Pole arm, lower grip.
  neonArc([0.02, 0.615], [0.09, 0.6], [DURANDS_DANCER_POLE_U, 0.55]),
  // Free arm, flung up and out.
  neonArc([-0.01, 0.605], [-0.09, 0.66], [-0.14, 0.7]),
  // Ponytail, tossed high — above the raised hand, so the two stay distinct.
  neonArc([-0.045, 0.735], [-0.1, 0.79], [-0.155, 0.78]),
];

/**
 * Turns a set of strokes into instance matrices, in the building's own space:
 * `originX`/`originY` place the figure's (0, 0) — the centre of its feet —
 * and `z` is the one plane the whole figure is drawn on, just proud of the
 * board behind it. Returns the tube segments and the joint circles separately
 * because they are two different geometries, and so two different parts. The
 * head and bust circles are the BODY's alone, so callers add those
 * themselves.
 */
function buildDancerStrokes(
  strokes: ReadonlyArray<readonly SignPoint[]>,
  originX: number,
  originY: number,
  z: number,
): { segments: Matrix4[]; circles: Matrix4[] } {
  const segments: Matrix4[] = [];
  const circles: Matrix4[] = [];
  for (const stroke of strokes) {
    for (let i = 0; i + 1 < stroke.length; i++) {
      const [u1, v1] = stroke[i];
      const [u2, v2] = stroke[i + 1];
      segments.push(dancerSegment(originX + u1, originY + v1, originX + u2, originY + v2, z));
      // A circle at every INTERIOR joint: two tubes meeting at an angle leave a
      // notch on the outside of the bend, and a real neon tube bends instead of
      // mitring. The stroke's two ends are left open — they are the drawing's
      // own ends (a fingertip, a foot), not corners.
      if (i > 0) {
        circles.push(dancerCircle(originX + u1, originY + v1, z, DURANDS_DANCER_JOINT_RADIUS));
      }
    }
  }
  return { segments, circles };
}

/**
 * A saloon building plus its flashing sign and marquee bulbs, and the
 * materials animate() needs a handle to pulse: the sign, the two bulb phase
 * groups, and the dancer's two pose groups (lit on the same phase clock).
 */
interface DurandsBuilding {
  readonly parts: StructurePart[];
  readonly signMaterial: MeshLambertMaterial;
  readonly marqueePhaseAMaterial: MeshLambertMaterial;
  readonly marqueePhaseBMaterial: MeshLambertMaterial;
  readonly dancerPoseAMaterial: MeshLambertMaterial;
  readonly dancerPoseBMaterial: MeshLambertMaterial;
}

/**
 * Builds Durand's part list: a two-storey false-front saloon — dark red-brown
 * ground floor behind a covered boardwalk, a lighter warm-red jettied second
 * storey, a deep-red false front carrying the flashing name sign and its
 * marquee, and above the roofline the rooftop dancer sign. Same "list of
 * (geometry, material, local transforms)" shape every other tier keeps (see
 * the file banner) — Durand's is not a special case to the instancer below,
 * only to this function.
 *
 * FOOTPRINT (composition pass). Every horizontal extent below is measured
 * against STRUCTURE_FOOTPRINT_RADIUS, exactly like the six standard tiers.
 * Durand's used to reach 0.6 units in +Z — its porch hung a third of a cell
 * past its own ground on the front — which is the one variant that could still
 * straddle a terrace step after the tiers themselves were bounded. The body
 * and porch now share the cell between them: the back wall stands at the
 * bound, the porch's front posts stand at the bound, and everything else is
 * between. Height is deliberately NOT bounded — a sign is meant to be seen
 * over the roofs around it, and nothing about a tall sign can hang over a
 * cliff.
 */
function buildDurandsParts(): DurandsBuilding {
  // ── Footprint budget: the whole building lives between ±FOOTPRINT in X/Z ──
  const bodyHalfWidth = 0.40;
  const jettyHalfWidth = 0.44; // the widest part of the building, still inside the bound
  const backZ = -STRUCTURE_FOOTPRINT_RADIUS;
  const bodyDepth = 0.5;
  const bodyFrontZ = backZ + bodyDepth;
  const bodyCenterZ = (backZ + bodyFrontZ) / 2;
  const porchFrontZ = STRUCTURE_FOOTPRINT_RADIUS;
  const porchDepth = porchFrontZ - bodyFrontZ;
  const porchCenterZ = (bodyFrontZ + porchFrontZ) / 2;
  const porchHalfWidth = bodyHalfWidth + 0.02;

  const groundFloorHeight = 0.55;
  const secondFloorHeight = 0.45;
  const secondFloorTopY = groundFloorHeight + secondFloorHeight;

  // Boardwalk: the plank deck the porch stands on. Beyond looking right, it
  // gives the whole building a base plane, which is what keeps the ground floor
  // from reading as a box dropped in the snow.
  const boardwalkHeight = 0.04;
  const boardwalk: StructurePart = {
    geometry: new BoxGeometry(porchHalfWidth * 2, boardwalkHeight, porchDepth),
    material: lambert(0x6b4a2e),
    localMatrices: [at(0, boardwalkHeight / 2, porchCenterZ)],
  };

  const groundFloor: StructurePart = {
    geometry: new BoxGeometry(bodyHalfWidth * 2, groundFloorHeight, bodyDepth),
    material: lambert(0x7a2a20),
    localMatrices: [at(0, groundFloorHeight / 2, bodyCenterZ)],
  };

  // Jettied (overhanging) second storey — a classic saloon/frontier detail:
  // wider than the floor beneath it, not merely stacked on top of it.
  const secondDepth = bodyDepth + 0.04;
  const secondCenterZ = bodyCenterZ + 0.02;
  const secondFrontZ = secondCenterZ + secondDepth / 2;
  const secondFloor: StructurePart = {
    geometry: new BoxGeometry(jettyHalfWidth * 2, secondFloorHeight, secondDepth),
    material: lambert(0x8f3325),
    localMatrices: [at(0, groundFloorHeight + secondFloorHeight / 2, secondCenterZ)],
  };

  // False front: a flat parapet standing proud of the roofline, flush with
  // the second storey's front face — the silhouette that makes a saloon read
  // as a saloon rather than as a plain box house.
  const falseFrontHeight = 0.3;
  const falseFrontDepth = 0.06;
  const falseFrontTopY = secondFloorTopY + falseFrontHeight;
  const falseFrontY = secondFloorTopY + falseFrontHeight / 2;
  const falseFrontZ = secondFrontZ + falseFrontDepth / 2;
  const falseFront: StructurePart = {
    geometry: new BoxGeometry(jettyHalfWidth * 2, falseFrontHeight, falseFrontDepth),
    material: lambert(0x9c2b1e),
    localMatrices: [at(0, falseFrontY, falseFrontZ)],
  };

  // Porch roof over the boardwalk, and the two posts holding its front edge up.
  const porchThickness = 0.05;
  const porchRoof: StructurePart = {
    geometry: new BoxGeometry(porchHalfWidth * 2, porchThickness, porchDepth + 0.04),
    material: lambert(0x4a2015),
    localMatrices: [at(0, groundFloorHeight - porchThickness / 2, porchCenterZ)],
  };
  const postInset = 0.05;
  const postX = porchHalfWidth - postInset;
  const postZ = porchFrontZ - postInset;
  const postHeight = groundFloorHeight - porchThickness;
  const porchPosts: StructurePart = {
    geometry: new CylinderGeometry(0.028, 0.028, postHeight, 6),
    material: lambert(0xac8a55),
    localMatrices: [at(postX, postHeight / 2, postZ), at(-postX, postHeight / 2, postZ)],
  };

  // Flat roof cap over the second storey — the missing plane that made the
  // building read as an open-topped box from behind and above. A frontier
  // false-front building has a flat (very shallow) roof hidden behind the
  // parapet; a thin dark slab inset from the jetty's edges reads as exactly
  // that, and its inset keeps it clear of the false front's own back face.
  const roofCapThickness = 0.025;
  const roofCapInset = 0.03;
  const roofCap: StructurePart = {
    geometry: new BoxGeometry(
      jettyHalfWidth * 2 - roofCapInset,
      roofCapThickness,
      secondDepth - roofCapInset,
    ),
    material: lambert(0x3f2418),
    localMatrices: [at(0, secondFloorTopY + roofCapThickness / 2, secondCenterZ - roofCapInset / 2)],
  };

  // Lit windows: two upstairs on the jetty, two flanking the doors under the
  // porch. The ground-floor pair is new in the composition pass — under a deep
  // porch roof the whole ground floor fell into shadow, so the storey the
  // saloon doors are in read as an empty void beneath the building.
  //
  // REAR AND SIDE OPENINGS (missing-sections pass): the same window part now
  // carries two rear upstairs windows and one lit window on each jetty side —
  // the building is orbited in-game, and every face it shows blank reads as
  // an unfinished model, not as a modest back wall. Side windows are the same
  // thin box yawed a quarter turn so its glass faces ±X.
  const windowZ = secondFrontZ + 0.01;
  const groundWindowZ = bodyFrontZ + 0.01;
  const upstairsWindowY = groundFloorHeight + secondFloorHeight * 0.55;
  const rearWindowZ = backZ - 0.01;
  const sideWindowQuarterTurn = new Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 2);
  const sideWindowAt = (x: number, y: number, z: number): Matrix4 =>
    new Matrix4().compose(new Vector3(x, y, z), sideWindowQuarterTurn, new Vector3(1, 1, 1));
  const windows: StructurePart = {
    geometry: new BoxGeometry(0.11, 0.13, 0.02),
    material: windowMaterial(),
    localMatrices: [
      at(0.24, upstairsWindowY, windowZ),
      at(-0.24, upstairsWindowY, windowZ),
      at(0.28, groundFloorHeight * 0.6, groundWindowZ),
      at(-0.28, groundFloorHeight * 0.6, groundWindowZ),
      at(0.22, upstairsWindowY, rearWindowZ),
      at(-0.22, upstairsWindowY, rearWindowZ),
      sideWindowAt(jettyHalfWidth + 0.01, upstairsWindowY, secondCenterZ),
      sideWindowAt(-(jettyHalfWidth + 0.01), upstairsWindowY, secondCenterZ),
    ],
  };

  // Back door: plain, unlit, and off-centre — the service entrance a saloon
  // actually has, and one more thing that stops the rear face reading blank.
  const backDoorHeight = 0.3;
  const backDoor: StructurePart = {
    geometry: new BoxGeometry(0.13, backDoorHeight, 0.02),
    material: lambert(0x3a1410),
    localMatrices: [at(0.15, backDoorHeight / 2, rearWindowZ)],
  };

  // Saloon doors: a pair of half-height café doors, hung clear of the floor —
  // the entrance detail that makes this specifically a SALOON rather than a
  // generic two-storey frontier building.
  const saloonDoorHeight = 0.26;
  const saloonDoorHalfWidth = 0.09;
  const saloonDoorGap = 0.01;
  const saloonDoorClearance = 0.06; // hung above the floor, like a real café door
  const saloonDoorY = boardwalkHeight + saloonDoorClearance + saloonDoorHeight / 2;
  const saloonDoors: StructurePart = {
    geometry: new BoxGeometry(saloonDoorHalfWidth * 2 - saloonDoorGap, saloonDoorHeight, 0.02),
    material: lambert(0x5a2015),
    localMatrices: [
      at(saloonDoorHalfWidth + saloonDoorGap / 2, saloonDoorY, bodyFrontZ + 0.01),
      at(-(saloonDoorHalfWidth + saloonDoorGap / 2), saloonDoorY, bodyFrontZ + 0.01),
    ],
  };

  // The name sign: mounted proud of the false front's own face so it never
  // z-fights with the board behind it, on the false front's centreline.
  const signHalfWidth = 0.3;
  const signHalfHeight = 0.08;
  const signThickness = 0.02;
  const signGap = 0.01;
  const signX = 0;
  const signY = secondFloorTopY + falseFrontHeight * 0.5;
  const signZ = falseFrontZ + falseFrontDepth / 2 + signThickness / 2 + signGap;
  const signMaterial = new MeshLambertMaterial({
    map: DURANDS_SIGN_TEXTURE,
    flatShading: true,
    emissive: DURANDS_SIGN_EMISSIVE_COLOR,
    emissiveIntensity: DURANDS_SIGN_EMISSIVE_MIN,
  });
  const sign: StructurePart = {
    geometry: new BoxGeometry(signHalfWidth * 2, signHalfHeight * 2, signThickness),
    material: signMaterial,
    localMatrices: [at(signX, signY, signZ)],
  };

  // Marquee bulbs: a closed ring of small spheres walking the sign board's
  // own border (see rectangleBorderPoints above), split into two phase
  // groups by alternating index — the "odd/even bulbs alternate" chase the
  // brief asks for. The border rectangle is the sign's own half-extents plus
  // a fixed outward margin, so the frame always sits just outside the board
  // whatever the sign's own dimensions are, rather than a second set of
  // hand-tuned coordinates that could drift out of sync with it.
  const marqueeHalfWidth = signHalfWidth + DURANDS_MARQUEE_BULB_MARGIN;
  const marqueeHalfHeight = signHalfHeight + DURANDS_MARQUEE_BULB_MARGIN;
  const marqueePerimeter = 2 * (marqueeHalfWidth + marqueeHalfHeight) * 2;
  const marqueeBulbCount = Math.round(marqueePerimeter / DURANDS_MARQUEE_BULB_TARGET_SPACING);
  const marqueeBulbZ = signZ + signThickness / 2 + DURANDS_MARQUEE_BULB_GAP;
  const marqueeBorder = rectangleBorderPoints(marqueeBulbCount, marqueeHalfWidth, marqueeHalfHeight);

  // One geometry, shared by both phase groups — they differ only in WHICH
  // border positions they occupy and which material (and therefore which
  // brightness) they carry, exactly like the two roof panels a gable already
  // shares one geometry between.
  const marqueeBulbGeometry = new SphereGeometry(DURANDS_MARQUEE_BULB_RADIUS, 6, 4);
  const marqueePhaseAMatrices: Matrix4[] = [];
  const marqueePhaseBMatrices: Matrix4[] = [];
  marqueeBorder.forEach((point, index) => {
    const matrix = at(signX + point.x, signY + point.y, marqueeBulbZ);
    (index % 2 === 0 ? marqueePhaseAMatrices : marqueePhaseBMatrices).push(matrix);
  });

  const marqueePhaseAMaterial = new MeshLambertMaterial({
    color: DURANDS_MARQUEE_BULB_SOCKET_COLOR,
    flatShading: true,
    emissive: DURANDS_MARQUEE_BULB_COLOR,
    emissiveIntensity: DURANDS_MARQUEE_BULB_EMISSIVE_MAX,
  });
  const marqueePhaseBMaterial = new MeshLambertMaterial({
    color: DURANDS_MARQUEE_BULB_SOCKET_COLOR,
    flatShading: true,
    emissive: DURANDS_MARQUEE_BULB_COLOR,
    emissiveIntensity: DURANDS_MARQUEE_BULB_EMISSIVE_MIN,
  });
  const marqueeBulbsPhaseA: StructurePart = {
    geometry: marqueeBulbGeometry,
    material: marqueePhaseAMaterial,
    localMatrices: marqueePhaseAMatrices,
  };
  const marqueeBulbsPhaseB: StructurePart = {
    geometry: marqueeBulbGeometry,
    material: marqueePhaseBMaterial,
    localMatrices: marqueePhaseBMatrices,
  };

  // ── The rooftop dancer sign ────────────────────────────────────────────
  // A dark cabinet on two legs above the false front: gold neon border, the
  // steadily-lit pole and body, and the two alternating limb sets. Standing it
  // up here — rather than tucking the figure under the porch, where it began —
  // is what gives the figure room to be sign-sized at all: the board is taller
  // than the storey below it, and nothing overlaps it from any angle a player
  // can orbit to.
  const dancerBoardHalfWidth = 0.34; // widened for the kick's reach; still inside the false front's 0.40
  const dancerBoardHalfHeight = 0.45;
  const dancerBoardThickness = 0.03;
  const dancerLegHeight = 0.1;
  const dancerBoardBottomY = falseFrontTopY + dancerLegHeight;
  const dancerBoardY = dancerBoardBottomY + dancerBoardHalfHeight;
  const dancerBoardZ = falseFrontZ;
  const dancerLegs: StructurePart = {
    geometry: new CylinderGeometry(0.018, 0.018, dancerLegHeight, 5),
    material: lambert(0x3a3226),
    localMatrices: [
      at(dancerBoardHalfWidth * 0.7, falseFrontTopY + dancerLegHeight / 2, dancerBoardZ),
      at(-dancerBoardHalfWidth * 0.7, falseFrontTopY + dancerLegHeight / 2, dancerBoardZ),
    ],
  };
  const dancerBoard: StructurePart = {
    geometry: new BoxGeometry(dancerBoardHalfWidth * 2, dancerBoardHalfHeight * 2, dancerBoardThickness),
    material: lambert(0x2a1218),
    localMatrices: [at(0, dancerBoardY, dancerBoardZ)],
  };

  // The figure's own origin on the board: the centre of its feet, one margin
  // up from the board's bottom edge. Every drawing point above is relative to it.
  const dancerFigureBaseY = dancerBoardBottomY + 0.05;
  const dancerZ = dancerBoardZ + dancerBoardThickness / 2 + DURANDS_DANCER_TUBE_RADIUS;

  // The gold border: four tubes and four corner dots just inside the board's
  // edge, steady, in the marquee's colour family — the cabinet's own trim.
  const dancerFrameMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_FRAME_COLOR,
    emissiveIntensity: DURANDS_DANCER_FRAME_EMISSIVE_INTENSITY,
  });
  const frameU = dancerBoardHalfWidth - DURANDS_DANCER_FRAME_INSET;
  const frameTop = dancerBoardY + dancerBoardHalfHeight - DURANDS_DANCER_FRAME_INSET;
  const frameBottom = dancerBoardY - dancerBoardHalfHeight + DURANDS_DANCER_FRAME_INSET;
  const dancerFrameTubes: StructurePart = {
    geometry: new CylinderGeometry(
      DURANDS_DANCER_FRAME_TUBE_RADIUS,
      DURANDS_DANCER_FRAME_TUBE_RADIUS,
      DURANDS_DANCER_SEGMENT_UNIT,
      5,
    ),
    material: dancerFrameMaterial,
    localMatrices: [
      dancerSegment(-frameU, frameTop, frameU, frameTop, dancerZ),
      dancerSegment(-frameU, frameBottom, frameU, frameBottom, dancerZ),
      dancerSegment(-frameU, frameBottom, -frameU, frameTop, dancerZ),
      dancerSegment(frameU, frameBottom, frameU, frameTop, dancerZ),
    ],
  };

  // The pole: one steadily-lit tube running the board's full height. It is
  // the stage, not the performer, so it never blinks — a chase that took the
  // pole with it would read as the pole vanishing, not as the dancer moving.
  const dancerPole: StructurePart = {
    geometry: new CylinderGeometry(
      DURANDS_DANCER_POLE_RADIUS,
      DURANDS_DANCER_POLE_RADIUS,
      dancerBoardHalfHeight * 2 - 0.04,
      6,
    ),
    material: new MeshLambertMaterial({
      color: DURANDS_DANCER_TUBE_COLOR,
      flatShading: true,
      emissive: DURANDS_DANCER_POLE_COLOR,
      emissiveIntensity: DURANDS_DANCER_POLE_EMISSIVE_INTENSITY,
    }),
    localMatrices: [at(DURANDS_DANCER_POLE_U, dancerBoardY, dancerZ)],
  };

  // Materials: the BODY holds steady; only the LIMB sets ride the phase clock
  // (animate() swaps dancerPoseAMaterial/dancerPoseBMaterial exactly as
  // before — the interface is unchanged, the meaning of the groups is).
  const dancerBodyMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_NEON_COLOR,
    emissiveIntensity: DURANDS_DANCER_BODY_EMISSIVE_INTENSITY,
  });
  // TRANSPARENT + depthWrite off: animate() drives opacity in lockstep with
  // emissive so the off frame's limbs are truly absent (see its comment), and
  // a fully-faded limb must not write depth or it would punch invisible holes
  // in the lit limbs crossing behind it.
  const dancerPoseAMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_NEON_COLOR,
    emissiveIntensity: DURANDS_DANCER_EMISSIVE_MAX,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const dancerPoseBMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_NEON_COLOR,
    emissiveIntensity: DURANDS_DANCER_EMISSIVE_MIN,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const dancerSegmentGeometry = new CylinderGeometry(
    DURANDS_DANCER_TUBE_RADIUS,
    DURANDS_DANCER_TUBE_RADIUS,
    DURANDS_DANCER_SEGMENT_UNIT,
    5,
  );
  const dancerCircleGeometry = new SphereGeometry(DURANDS_DANCER_HEAD_RADIUS, 8, 6);

  const body = buildDancerStrokes(DURANDS_DANCER_BODY_STROKES, 0, dancerFigureBaseY, dancerZ);
  // The steady circles ride with the body: the head, and the bust nested at
  // the front outline's apex — the emphasis the owner asked for by name.
  body.circles.push(
    dancerCircle(
      DURANDS_DANCER_BODY_HEAD[0],
      dancerFigureBaseY + DURANDS_DANCER_BODY_HEAD[1],
      dancerZ,
      DURANDS_DANCER_HEAD_RADIUS,
    ),
    dancerCircle(
      DURANDS_DANCER_BODY_BUST[0],
      dancerFigureBaseY + DURANDS_DANCER_BODY_BUST[1],
      dancerZ,
      DURANDS_DANCER_BUST_RADIUS,
    ),
  );
  const limbsA = buildDancerStrokes(DURANDS_DANCER_LIMBS_A, 0, dancerFigureBaseY, dancerZ);
  const limbsB = buildDancerStrokes(DURANDS_DANCER_LIMBS_B, 0, dancerFigureBaseY, dancerZ);

  const dancerBodyTubes: StructurePart = {
    geometry: dancerSegmentGeometry,
    material: dancerBodyMaterial,
    localMatrices: body.segments,
  };
  const dancerBodyCircles: StructurePart = {
    geometry: dancerCircleGeometry,
    material: dancerBodyMaterial,
    localMatrices: body.circles,
  };
  const dancerPoseATubes: StructurePart = {
    geometry: dancerSegmentGeometry,
    material: dancerPoseAMaterial,
    localMatrices: limbsA.segments,
  };
  const dancerPoseACircles: StructurePart = {
    geometry: dancerCircleGeometry,
    material: dancerPoseAMaterial,
    localMatrices: limbsA.circles,
  };
  const dancerPoseBTubes: StructurePart = {
    geometry: dancerSegmentGeometry,
    material: dancerPoseBMaterial,
    localMatrices: limbsB.segments,
  };
  const dancerPoseBCircles: StructurePart = {
    geometry: dancerCircleGeometry,
    material: dancerPoseBMaterial,
    localMatrices: limbsB.circles,
  };

  return {
    parts: [
      boardwalk,
      groundFloor,
      secondFloor,
      falseFront,
      roofCap,
      porchRoof,
      porchPosts,
      windows,
      backDoor,
      saloonDoors,
      sign,
      marqueeBulbsPhaseA,
      marqueeBulbsPhaseB,
      dancerLegs,
      dancerBoard,
      dancerFrameTubes,
      dancerPole,
      dancerBodyTubes,
      dancerBodyCircles,
      dancerPoseATubes,
      dancerPoseACircles,
      dancerPoseBTubes,
      dancerPoseBCircles,
    ],
    signMaterial,
    marqueePhaseAMaterial,
    marqueePhaseBMaterial,
    dancerPoseAMaterial,
    dancerPoseBMaterial,
  };
}

// ── Instancing ────────────────────────────────────────────────────────────────

/** Where one structure stands and how it varies. World units; y is the ground. */
export interface StructurePlacement {
  readonly x: number;
  readonly z: number;
  /**
   * The CELL this structure stands on — the input every per-building COSMETIC
   * ROLL hashes (Durand's skin, the fishing-hut variant).
   *
   * Carried separately from x/z rather than derived from them, because x/z
   * are WORLD units and every roll in this plugin hashes integers: since the
   * 2026-08-21 quarter-cell re-sample a world coordinate is `cell × 0.25`, so
   * hashing it truncates four cells onto one hash — cells 0..3 all roll
   * identically, and every roll clusters in 4×4 blocks. That is a real defect
   * this field fixes (isDurandsCell was being fed world x/z), not a
   * hypothetical: the rolls are integer-domain functions, so they must be
   * given the integer domain.
   */
  readonly cellX: number;
  readonly cellY: number;
  readonly groundY: number;
  readonly tier: StructureTier;
  readonly scale: number;
  readonly yaw: number;
  /** Which people live here — drives the per-instance race tint below. */
  readonly race: SettlerRace;
  /** Where this settlement stands (card 33, site.ts) — selects a top-tier model variant; see SITE_TOP_TIER_VARIANTS. */
  readonly site: SiteKind;
}

/**
 * Per-race whole-building tints, applied through InstancedMesh.setColorAt so
 * the tier materials stay SHARED (one material per part, as ever) while every
 * instance still declares its people. THREE multiplies the instance colour
 * into the material colour, so both values sit near white: far enough from it
 * that two districts read as different at gameplay zoom, close enough that a
 * watchtower still reads as the same stone.
 *
 *   * RUDYS (dog people) — a warm hearth cast, sunned timber and tan hides;
 *   * UNOS (cat people) — a cool moonlit cast, slate and cream.
 */
export const RACE_TINTS: Readonly<Record<SettlerRace, number>> = {
  rudy: 0xffe9cf,
  uno: 0xd9e4f5,
};

export interface StructureModels {
  readonly root: Group;
  apply(placements: readonly StructurePlacement[]): void;
  /** Advances the Durand's sign flash and marquee bulb chase by `dt` seconds. A no-op otherwise — nothing else in this plugin animates per-frame. */
  animate(dt: number): void;
  dispose(): void;
}

/** Floats one instance matrix occupies in an InstancedMesh's `instanceMatrix` — one Matrix4. */
const MATRIX_ELEMENT_COUNT = 16;

/** Floats one instance colour occupies in an InstancedMesh's `instanceColor` — one RGB triple. */
const COLOR_ELEMENT_COUNT = 3;

/**
 * Marks the LIVE PREFIX of an instance attribute for upload, and nothing beyond
 * it — the replacement for a bare `needsUpdate = true` (GH #263).
 *
 * WHY A BARE FLAG WAS EXPENSIVE. three's `WebGLAttributes.updateBuffer` takes
 * its "whole array" branch whenever `updateRanges` is empty, and it never looks
 * at `mesh.count` — so these meshes, allocated at STRUCTURES_CAP × the part's
 * local-matrix count, re-uploaded their whole CAPACITY every time one building
 * was founded or felled: 36 meshes, 102 400 slots, 6.55 MB of `instanceMatrix`
 * plus up to 1.23 MB of `instanceColor`, for a delta that may hold one cell.
 * Same defect and same fix as the flora rigs (plugins/flora/client/
 * instanceBounds.ts) and this plugin's own skiffModels.ts.
 *
 * CLEARED BEFORE THE RANGE IS ADDED, for skiffModels.ts's reason: three only
 * clears an attribute's ranges when it actually uploads, so a pass whose mesh
 * was frustum-culled would otherwise leave its range behind for this one to
 * accumulate onto.
 *
 * AN EMPTY MESH IS LEFT ALONE ENTIRELY — not even its ranges cleared. Nothing
 * is drawn at `count === 0`, so there is nothing to upload; and clearing the
 * ranges of an attribute whose version is still ahead of the uploaded buffer is
 * exactly how a later render falls back into the whole-array branch this
 * function exists to avoid.
 *
 * NOT ATTEMPTED, and named rather than left implicit: skipping the upload for a
 * mesh whose CONTENTS did not change. Knowing that needs a shadow copy of every
 * matrix to compare against — more memory than the buffer itself and a compare
 * per float — so a full apply() pass always re-uploads its own live prefix.
 */
function uploadInstancePrefix(
  attribute: InstancedBufferAttribute,
  instanceCount: number,
  elementsPerInstance: number,
): void {
  if (instanceCount === 0) return;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, instanceCount * elementsPerInstance);
  attribute.needsUpdate = true;
}

/**
 * Throws unless the stated asset height ceiling is still no taller than the
 * tallest tier this file actually builds from primitives.
 *
 * WHY A RUNTIME CHECK FOR A CONSTANT. TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS
 * is a number copied out of tier 5's own local constants, and the preload's fit
 * check is only as honest as that copy. Stale LOW is harmless (a stricter
 * budget); stale HIGH — someone lowers the watchtower — silently licenses an
 * imported model to stand taller than anything in the game. Measured on the
 * models just built, so the drift cannot survive one attach. Loud rather than
 * quiet for the reason the tier-count check above is: the fix is a one-line
 * constant edit, and a silently wrong skyline is not noticed for weeks.
 */
function assertHeightBudgetStillHolds(tierParts: readonly StructurePart[][]): void {
  let tallestProcedural = 0;
  for (let tier = 0; tier < tierParts.length; tier++) {
    if (tier === IMPORTED_STRUCTURE_TIER) continue; // the budget is ABOUT this tier
    tallestProcedural = Math.max(tallestProcedural, partsStandingHeight(tierParts[tier]));
  }
  if (TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS > tallestProcedural) {
    throw new Error(
      `structures: TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS is ` +
        `${TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS}, but the tallest procedural tier now ` +
        `stands ${tallestProcedural.toFixed(3)} — lower the constant to match, or an imported ` +
        `asset may tower over every building in the game`,
    );
  }
}

export function createStructureModels(): StructureModels {
  // MERGED, not as authored: a tier is written as ~100 parts because that is
  // how a building is legible to write, and drawn as a handful because that is
  // how a building is cheap to draw. mergeParts() is the whole of that
  // translation — see parts.ts for which materials may share a surface and why
  // it asks the material rather than trusting a flag on the part.
  //
  // Safe to apply to the tiers specifically because nothing here is animated:
  // animate() below drives Durand's materials only, and Durand's is built
  // separately and deliberately left unmerged so those handles stay live.
  const tierParts = buildTierParts().map((parts) => mergeParts(parts));
  if (tierParts.length !== STRUCTURE_TIER_COUNT) {
    // Defensive: a mismatch here means a tier was added to the wire contract
    // (protocol.ts) without a matching model, which would silently drop that
    // tier's buildings from the scene rather than fail loudly at boot.
    throw new Error(`structures: built ${tierParts.length} tier models, expected ${STRUCTURE_TIER_COUNT}`);
  }
  assertHeightBudgetStillHolds(tierParts);

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const root = new Group();
  root.name = 'structures:buildings';

  // One InstancedMesh per (tier, part), capacity = STRUCTURES_CAP × however
  // many instances that part contributes per building (1, or 2 for a
  // mirrored roof panel). Every mesh assumes the worst case — every standing
  // structure is this tier — the same over-allocate-once trade flora makes
  // for its per-kind meshes.
  const meshesByTier: InstancedMesh[][] = tierParts.map((parts) =>
    parts.map((part) => {
      geometries.push(part.geometry);
      materials.push(part.material);
      const mesh = new InstancedMesh(part.geometry, part.material, STRUCTURES_CAP * part.localMatrices.length);
      mesh.count = 0;
      root.add(mesh);
      return mesh;
    }),
  );

  // Durand's own InstancedMesh set, built and capacity-allocated exactly like
  // a seventh tier's would be, but kept OUT of tierParts/meshesByTier: it is
  // not tier 6 on the wire (there is no tier 6 — MAX_STRUCTURE_TIER is still
  // 5), only a skin `apply()` below picks in place of tier 5's own meshes for
  // the cells ./durands.ts selects. Capacity is STRUCTURES_CAP again rather
  // than STRUCTURES_CAP / 6: the ~1-in-6 share is an average over many cells,
  // not a per-world guarantee, and the server's own STRUCTURES_CAP is the
  // only bound this client can rely on without risking `count` outrunning
  // `mesh.instanceMatrix` in some adversarial-but-legal cell layout.
  const durands = buildDurandsParts();
  // mergeSharedSurface, NOT mergeParts: Durand's is the one building that keeps
  // material handles (the five animate() pulses below), and mergeParts' second
  // step disposes duplicate signatures — which would silently drop one of the
  // marquee's two identically-authored phase materials and stop the chase. The
  // surface step cannot touch a held material: every one of the five is
  // emissive or transparent, and canShareOneSurface() rejects both.
  //
  // FITTED FIRST — Durand's is the one model that did not fit its ground
  // (measured 2026-08-23). Axis-aligned it reaches 0.475 against a 0.455
  // bound, and its RADIAL reach — what a YAWED building actually sweeps, see
  // parts.ts's partsRadialReach — is 0.634, which at STRUCTURE_SCALE_MAX puts
  // a corner 0.697 world units out over ground the server surveyed only to
  // STRUCTURE_SURVEYED_GROUND_RADIUS (0.625, protocol.ts). At some yaws the
  // saloon stood on land nobody checked: the "buildings straddle terrace
  // edges" defect, on the model most likely to be looked at.
  //
  // Fitted rather than re-authored: 400 lines of hand-tuned neon sign geometry
  // scaled uniformly about the origin until it fits, which is invisible beside
  // the alternative and cannot be re-broken by a later edit to the sign. Every
  // other model in this plugin already fits, and fitToRadius is a no-op on one
  // that does.
  const durandsParts = mergeSharedSurface(
    fitToRadius(durands.parts, STRUCTURE_SURVEYED_GROUND_RADIUS / STRUCTURE_SCALE_MAX),
  );
  const durandsMeshes: InstancedMesh[] = durandsParts.map((part) => {
    geometries.push(part.geometry);
    materials.push(part.material);
    const mesh = new InstancedMesh(part.geometry, part.material, STRUCTURES_CAP * part.localMatrices.length);
    mesh.count = 0;
    root.add(mesh);
    return mesh;
  });

  // SITE_TOP_TIER_VARIANTS' own InstancedMesh sets (card 33) — built and
  // capacity-allocated exactly like Durand's set above, and for the same
  // reason kept out of tierParts/meshesByTier: a site variant is a skin
  // apply() picks in place of MAX_STRUCTURE_TIER's normal meshes, not a
  // tier of its own. Capacity is STRUCTURES_CAP again for the identical
  // reason Durand's comment above gives — the server's own cap is the only
  // per-world bound this client can rely on. It is affordable at ten
  // variants only because every variant's parts arrive MERGED (parts.ts):
  // one part per material, one local matrix each, so a variant costs
  // STRUCTURES_CAP × 1 instance slots per material rather than
  // STRUCTURES_CAP × (every authored bundle, block and fish).
  //
  // Built HERE rather than at module scope so their geometries and materials
  // are owned by this instance and die with dispose() — the harbour variant
  // they replace was a module-level const, which meant dispose() disposed
  // geometries a later attach() would then render through.
  const siteVariantParts: Partial<Record<SiteKind, StructurePart[][]>> = {};
  const siteVariantMeshes: Partial<Record<SiteKind, InstancedMesh[][]>> = {};
  for (const siteKind of Object.keys(SITE_TOP_TIER_VARIANTS) as SiteKind[]) {
    const built = SITE_TOP_TIER_VARIANTS[siteKind]!.builders.map((build) => build());
    siteVariantParts[siteKind] = built;
    siteVariantMeshes[siteKind] = built.map((parts) =>
      parts.map((part) => {
        geometries.push(part.geometry);
        materials.push(part.material);
        const mesh = new InstancedMesh(part.geometry, part.material, STRUCTURES_CAP * part.localMatrices.length);
        mesh.count = 0;
        root.add(mesh);
        return mesh;
      }),
    );
  }

  // Scratch objects, reused across every instance of every rebuild — the same
  // discipline flora's apply() keeps, for the same reason (a rebuild fires on
  // every founding, upgrade and demolition; per-instance allocation would
  // churn hundreds of short-lived objects on every one of those).
  const buildingPosition = new Vector3();
  const buildingRotation = new Quaternion();
  const buildingScale = new Vector3();
  const buildingMatrix = new Matrix4();
  const instanceMatrix = new Matrix4();
  // One scratch Color per race, built once — a tint never changes, so there is
  // nothing to recompute per instance.
  const raceTints: Readonly<Record<SettlerRace, Color>> = {
    rudy: new Color(RACE_TINTS.rudy),
    uno: new Color(RACE_TINTS.uno),
  };

  /** Seconds since attach — the only state animate() advances. */
  let durandsFlashElapsedSeconds = 0;

  /**
   * Writes one building's instances into `meshes`, part by part, advancing
   * `counts` (one slot per part, mutated in place — the caller owns the
   * array and reads it back after every placement in this apply() pass).
   * Shared by both the per-tier path and the Durand's path below so the two
   * do not carry two copies of the same nested loop.
   */
  function writeInstances(
    parts: StructurePart[],
    meshes: InstancedMesh[],
    counts: number[],
    tint: Color | null,
  ): void {
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const mesh = meshes[partIndex];
      let count = counts[partIndex];
      // Capacity (STRUCTURES_CAP × localMatrices.length, see the allocation
      // above) covers every placement the caller can hand in: the
      // server-side registry itself never exceeds STRUCTURES_CAP structures,
      // so `count` cannot outrun `mesh.instanceMatrix`.
      for (const local of part.localMatrices) {
        instanceMatrix.multiplyMatrices(buildingMatrix, local);
        // Tint before matrix, at the same index: setColorAt lazily allocates
        // the instanceColor buffer zero-filled (i.e. black), so every slot at
        // or below a mesh's final count must be written each pass — which
        // this loop guarantees, because every instance of a tinted mesh comes
        // through here. Durand's passes null and its meshes therefore never
        // grow an instanceColor buffer at all: the landmark stays exactly the
        // neon it was authored as, whichever district it lights up.
        if (tint !== null) mesh.setColorAt(count, tint);
        mesh.setMatrixAt(count++, instanceMatrix);
      }
      counts[partIndex] = count;
    }
  }

  /** Finalises one mesh list after a full apply() pass: instance count, upload flag, and a fresh bounding sphere. */
  function finalizeMeshes(meshes: InstancedMesh[], counts: number[]): void {
    for (let partIndex = 0; partIndex < meshes.length; partIndex++) {
      const mesh = meshes[partIndex];
      mesh.count = counts[partIndex];
      uploadInstancePrefix(mesh.instanceMatrix, mesh.count, MATRIX_ELEMENT_COUNT);
      // Present exactly when writeInstances tinted this mesh at least once in
      // its lifetime (setColorAt allocates it) — uploaded every pass for the
      // same reason the matrix is, and over the same prefix: writeInstances
      // writes a colour at every index below `count` on a tinted mesh.
      if (mesh.instanceColor !== null) {
        uploadInstancePrefix(mesh.instanceColor, mesh.count, COLOR_ELEMENT_COUNT);
      }
      // MANDATORY, not tidiness — see flora's identical call: an
      // InstancedMesh's cached bounding sphere is stale after any matrix
      // change, and frustum culling against a stale sphere makes a building
      // vanish when the camera moves.
      mesh.computeBoundingSphere();
    }
  }

  return {
    root,

    apply(placements: readonly StructurePlacement[]): void {
      const counts = meshesByTier.map((parts) => parts.map(() => 0));
      const durandsCounts = durandsMeshes.map(() => 0);
      const siteVariantCounts: Partial<Record<SiteKind, number[][]>> = {};
      for (const siteKind of Object.keys(SITE_TOP_TIER_VARIANTS) as SiteKind[]) {
        siteVariantCounts[siteKind] = siteVariantParts[siteKind]!.map((parts) => parts.map(() => 0));
      }

      for (const placement of placements) {
        buildingPosition.set(placement.x, placement.groundY, placement.z);
        buildingRotation.setFromAxisAngle(Y_AXIS, placement.yaw);
        buildingScale.setScalar(placement.scale);
        buildingMatrix.compose(buildingPosition, buildingRotation, buildingScale);

        // SITE_TOP_TIER_VARIANTS is checked FIRST and gated on
        // MAX_STRUCTURE_TIER inline (mirroring isDurandsCell's own
        // tier-gate-as-part-of-the-contract shape): a site variant is a
        // categorical fact about this settlement's ground, not a rarity, so
        // it wins over Durand's roll below rather than competing with it —
        // see the SITE_TOP_TIER_VARIANTS banner above for why.
        const variantSet = SITE_TOP_TIER_VARIANTS[placement.site];
        if (placement.tier === MAX_STRUCTURE_TIER && variantSet !== undefined) {
          const built = siteVariantParts[placement.site]!;
          // The roll is the site's own (fishingHuts.ts for coastal), and it
          // hashes the CELL — see StructurePlacement.cellX. Clamped defensively
          // rather than trusted: a pick() that ever returned out of range would
          // otherwise index undefined and take the whole frame down.
          const variant = Math.min(Math.max(variantSet.pick(placement.cellX, placement.cellY), 0), built.length - 1);
          writeInstances(
            built[variant],
            siteVariantMeshes[placement.site]![variant],
            siteVariantCounts[placement.site]![variant],
            raceTints[placement.race],
          );
          continue;
        }

        // isDurandsCell's own contract gates this to MAX_STRUCTURE_TIER (see
        // ./durands.ts) — nothing below the top tier can ever come back true.
        if (isDurandsCell(placement.tier, placement.cellX, placement.cellY)) {
          writeInstances(durandsParts, durandsMeshes, durandsCounts, null);
          continue;
        }

        const parts = tierParts[placement.tier];
        const meshes = meshesByTier[placement.tier];
        if (parts === undefined || meshes === undefined) continue; // defensive: unknown tier, dropped rather than crashing the frame
        writeInstances(parts, meshes, counts[placement.tier], raceTints[placement.race]);
      }

      for (let tier = 0; tier < meshesByTier.length; tier++) finalizeMeshes(meshesByTier[tier], counts[tier]);
      finalizeMeshes(durandsMeshes, durandsCounts);
      for (const siteKind of Object.keys(SITE_TOP_TIER_VARIANTS) as SiteKind[]) {
        const meshes = siteVariantMeshes[siteKind]!;
        const counts = siteVariantCounts[siteKind]!;
        for (let variant = 0; variant < meshes.length; variant++) finalizeMeshes(meshes[variant], counts[variant]);
      }
    },

    animate(dt: number): void {
      durandsFlashElapsedSeconds += dt;
      const angle = durandsFlashElapsedSeconds * (DURANDS_TWO_PI / DURANDS_SIGN_FLASH_PERIOD_SECONDS);
      const t = (Math.sin(angle) + 1) / 2; // remap sin's [-1, 1] to [0, 1]
      durands.signMaterial.emissiveIntensity =
        DURANDS_SIGN_EMISSIVE_MIN + t * (DURANDS_SIGN_EMISSIVE_MAX - DURANDS_SIGN_EMISSIVE_MIN);

      // Marquee bulb chase: same sine shape as the sign, at half its period
      // (see DURANDS_MARQUEE_BULB_PERIOD_SECONDS's own comment for the
      // frequency arithmetic against the 3 Hz ceiling), phase B exactly
      // π out of phase with phase A so one group is brightest exactly when
      // the other is dimmest.
      const marqueeAngle = durandsFlashElapsedSeconds * (DURANDS_TWO_PI / DURANDS_MARQUEE_BULB_PERIOD_SECONDS);
      const phaseAT = (Math.sin(marqueeAngle) + 1) / 2;
      const phaseBT = (Math.sin(marqueeAngle + Math.PI) + 1) / 2;
      durands.marqueePhaseAMaterial.emissiveIntensity =
        DURANDS_MARQUEE_BULB_EMISSIVE_MIN + phaseAT * (DURANDS_MARQUEE_BULB_EMISSIVE_MAX - DURANDS_MARQUEE_BULB_EMISSIVE_MIN);
      durands.marqueePhaseBMaterial.emissiveIntensity =
        DURANDS_MARQUEE_BULB_EMISSIVE_MIN + phaseBT * (DURANDS_MARQUEE_BULB_EMISSIVE_MAX - DURANDS_MARQUEE_BULB_EMISSIVE_MIN);

      // Neon dancer: the two LIMB SETS swap on the SAME phase clock as the
      // bulbs (set A lit with phase A, set B with phase B) — the two-frame
      // sign trick; the body itself never blinks (2026-08-19 redesign). No
      // new frequency is introduced; see the dancer constants' banner for why
      // this stays inside the marquee's ceiling arithmetic.
      //
      // OPACITY RIDES THE SAME VALUE AS EMISSIVE: an "off" limb must be GONE,
      // not merely dark — a dark tube still catches the scene light on its
      // curved face and reads as a black slash across the lit board (seen in
      // review renders). Same t, so the fade introduces no second frequency.
      durands.dancerPoseAMaterial.emissiveIntensity =
        DURANDS_DANCER_EMISSIVE_MIN + phaseAT * (DURANDS_DANCER_EMISSIVE_MAX - DURANDS_DANCER_EMISSIVE_MIN);
      durands.dancerPoseAMaterial.opacity = phaseAT;
      durands.dancerPoseBMaterial.emissiveIntensity =
        DURANDS_DANCER_EMISSIVE_MIN + phaseBT * (DURANDS_DANCER_EMISSIVE_MAX - DURANDS_DANCER_EMISSIVE_MIN);
      durands.dancerPoseBMaterial.opacity = phaseBT;
    },

    dispose(): void {
      for (const parts of meshesByTier) for (const mesh of parts) mesh.dispose();
      for (const mesh of durandsMeshes) mesh.dispose();
      for (const variants of Object.values(siteVariantMeshes)) {
        for (const meshes of variants!) for (const mesh of meshes) mesh.dispose();
      }
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}

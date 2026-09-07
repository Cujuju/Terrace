// Low-poly procedural buildings, drawn as INSTANCES — one InstancedMesh per
// (tier, part), exactly flora's "a tree is not an object" argument extended
// to six silhouettes instead of two.
//
// A building is a small fixed list of PARTS (a wall, a roof panel, a
// chimney...), each pre-built as ONE geometry with one or more LOCAL
// transforms relative to the building's own origin. Placing a whole building
// is: compose position/yaw/scale into a matrix once, then for every part and
// local transform, multiply the two and write one instance. The shape of "a
// building" IS the list of (geometry, material, local transforms) triples.
//
// SIX TIERS, EACH A DIFFERENT SILHOUETTE AND MATERIAL, moving together at
// every step (never scale alone) so they stay legible at orbit-camera
// distance the way flora's two tree kinds do:
//
//   0 camp           canvas tent + campfire        lowest, roundest, warmest colour
//   1 hut             round wall + conical thatch   first solid drum
//   2 timber-house    box wall + gable roof         first hard edges (ridge roof)
//   3 longhouse       longer/lower box + chimney    widest footprint, low profile
//   4 stone-cottage   STONE wall + tile roof         first grey/stone material
//   5 watchtower      tall narrow tower + parapet    tallest, narrowest, first vertical silhouette
//
// Same rules as flora/monsters' models.ts files: no per-object lights, flat
// shading so a low-segment primitive reads as deliberate style, not low detail.
//
// TEXTURES AND EXTERNAL ASSETS ARE ALLOWED (owner, 2026-09-04, superseding
// this file's original "generated in this file" rule). A tier may load an
// authored .glb instead of primitives — tier 2 is the first, see
// IMPORTED_STRUCTURE_TIER — arriving as the SAME (geometry, material, local
// transforms) list every procedural tier is, bound by the same footprint
// contract. The procedural builder of a replaced tier stays as the fallback
// when no asset is installed.
//
// FIDELITY PASSES (owner: "these structures need more detail", then "a house
// reads as a brown tile with four spikes"): two passes added doors, glowing
// windows, framed surrounds, roof course strips (GableRoof.courseMatrices),
// and per-tier detail (firepits, wattle bands, log framing, stone quoins,
// arrow slits, crenellations — see each tier's own comments). All still just
// more (geometry, material, local transforms) entries on the same fixed list
// — see "Fidelity-pass helpers" below for the shared ring/window plumbing.
//
// TRIANGLE BUDGET (instanced, so totals multiply by standing structures per
// tier, bounded by STRUCTURES_CAP = 512): camp 404, hut 568, timber-house
// 928, longhouse 504, stone-cottage 1428, watchtower 1196 (up from 260-1140
// before the second fidelity pass). Worst legal case (512 heaviest-tier
// structures) is ~731k triangles, the same order the terrain mesh costs;
// segment counts stay at 3-8 — detail is bought with more PARTS, not rounder primitives.

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
// The render kit, reached by path exactly as plugins/boats reaches it.
// rigAsset.ts loads and validates the file; staticAsset.ts turns it into the
// part list this plugin already draws.
import {
  assertAssetFits,
  loadRigAsset,
  type RigAsset,
} from '../../../client/src/render/rigAsset.ts';
import { flattenAssetParts } from '../../../client/src/render/staticAsset.ts';
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
 * WHY IT EXISTS. The server's isBuildableCell only guarantees the cell and
 * its four orthogonal neighbours share a terrace band — nothing about
 * diagonals or ground further out. A model wider than its own cell stands on
 * unchecked ground, and the terraced renderer draws a band step a quarter
 * cell inside the higher cell (vertexGrid.ts's CONTOUR_SAMPLE_CLEARANCE), so
 * an over-wide building hangs off a cliff. This bound is what test/models.test.ts
 * asserts every tier against, rather than hand-shrinking one offender.
 *
 * WHY THIS VALUE — DERIVED, NOT STATED (2026-08-21). The ground a building
 * needs is STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS wide (protocol.ts, one world
 * unit — one terrace tread at the steepest legal slope). Half of that is the
 * largest reach keeping a model over its own tread; dividing by
 * STRUCTURE_SCALE_MAX (protocol.ts, the max per-cell variation scale) gives
 * the bound on the unscaled model: 0.5 / 1.1 ≈ 0.4545. The server derives its
 * own neighbourhood from the same span via cellsAcross(), so the two sides
 * can't drift — before the 2026-08-21 re-sample they only agreed because a
 * cell happened to equal one world unit.
 */
export const STRUCTURE_FOOTPRINT_RADIUS =
  STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS / 2 / STRUCTURE_SCALE_MAX;

function lambert(color: number, options: { emissive?: number } = {}): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true, emissive: options.emissive ?? 0x000000 });
}

// ── The imported tier: an authored .glb where a tier used to be primitives ───
//
// Owner decision 2026-09-04: a plugin may ship external model assets. Tier 2
// is the first taken up on it.

/**
 * Which tier is drawn from the .glb rather than built from primitives.
 *
 * TIER 2, THE TIMBER-HOUSE: the asset is a timber-framed cottage with a
 * gable roof (assets/LICENSES.md), tier 2's own design line, not an
 * approximation. Not tier 4: the stone-cottage's identity is its MATERIAL
 * BREAK to stone, and a timber house standing in for it would erase the one
 * step that changes material rather than shape.
 */
const IMPORTED_STRUCTURE_TIER = 2;

/**
 * How tall, in world units, the tallest procedural tier stands: the
 * watchtower's spire apex (tower 1.3 + parapet 0.14 + roof 0.4).
 *
 * The CEILING an imported model is measured against, so no asset can tower
 * over the tallest silhouette. VERIFIED against the built models on every
 * attach (createStructureModels), not merely stated, since a copied-out
 * number goes stale the moment its source is edited, and stale HIGH licenses
 * an asset to dwarf every building.
 */
const TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS = 1.84;

/**
 * The budget an imported building must fit, in world units.
 *
 * ASSETS ARE AUTHORED IN WORLD UNITS, the same frame this file's matrices
 * are in, so parts load with no conversion step (orchestrator decision
 * 2026-09-04: the war boat and wildlife's deer are authored the same way,
 * with no runtime scale; this tier was the odd one out).
 *
 * x/z restate the footprint contract for an asset: a tier may reach
 * STRUCTURE_FOOTPRINT_RADIUS from its origin either way, so the whole model
 * spans twice that — one bound shared with the procedural tiers rather than
 * two that can drift. y is the height ceiling above.
 */
const IMPORTED_STRUCTURE_FOOTPRINT_WORLD_UNITS = {
  x: STRUCTURE_FOOTPRINT_RADIUS * 2,
  z: STRUCTURE_FOOTPRINT_RADIUS * 2,
  y: TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS,
};

/**
 * The loaded building asset, or null until preloadStructureModels installs one.
 *
 * MODULE-SCOPED, NEVER DISPOSED BY THIS PLUGIN'S dispose() (D3). The asset
 * owns its geometries/materials/textures; createStructureModels takes
 * CLONES (importedStructureParts) so mergeParts — which disposes what it's
 * handed — never sees an asset-owned object. Tracking parts separately to
 * free the asset after the meshes buys nothing: the file is ~180 KB and
 * re-loading it per attach would be strictly worse.
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
  // Lamps-only (null environment): timber and thatch have no sky to mirror —
  // see ClientPluginCtx.loadRigAsset for the choice.
  installStructureAsset(await loadRigAsset(url, null));
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
  // Measured BEFORE anything is assigned or freed, so a model that overruns
  // its plot cannot replace a good one.
  try {
    assertAssetFits(asset, IMPORTED_STRUCTURE_FOOTPRINT_WORLD_UNITS);
  } catch (cause) {
    throw new Error(
      `structure asset: the model breaks the footprint contract — a building must stand ` +
        `strictly over the ground the server surveys for it (see STRUCTURE_FOOTPRINT_RADIUS)`,
      { cause },
    );
  }
  // THE PREVIOUS ASSET IS FREED, NOT DROPPED: preload() runs on every mount,
  // so without this each remount leaks the old file's buffers. Safe because
  // the host unmounts a plugin before remounting it, so createStructureModels'
  // own dispose() has already freed the merged clones sharing this asset's
  // textures — only the textures were ever shared (see importedStructureParts).
  importedBuildingAsset?.dispose();
  importedBuildingAsset = asset;
}

/**
 * The imported tier as parts in this file's own model space, or null when no
 * asset is installed (the caller falls back to the procedural builder).
 *
 * THREE STEPS, EACH LOAD-BEARING: (1) flattenAssetParts turns the file's
 * meshes into ASSET-OWNED (geometry, material, local matrices) — see
 * staticAsset.ts; (2) every part is copied, since the merge this list is
 * about to go through disposes what it's handed, and Material.clone() shares
 * TEXTURE objects (never duplicates), keeping texels asset-owned; (3) the
 * copies go through Durand's same radial fit (parts.ts's partsRadialReach) —
 * a model may fit its axis-aligned footprint and still swing a corner over
 * unsurveyed ground once yawed. A no-op here, since this model already fits.
 *
 * NO SCALE STEP, DELIBERATELY: an asset is authored in the same world units
 * this file's matrices are in, so local matrices load in already meaning
 * what they say — a conversion step would be a second place for size to
 * drift, uncaught by the load-time assert.
 */
function importedStructureParts(): StructurePart[] | null {
  if (importedBuildingAsset === null) return null;
  const owned = flattenAssetParts(importedBuildingAsset).map((part) => ({
    geometry: part.geometry.clone(),
    material: part.material.clone(),
    localMatrices: part.localMatrices.map((local) => local.clone()),
  }));
  return fitToRadius(owned, STRUCTURE_SURVEYED_GROUND_RADIUS / STRUCTURE_SCALE_MAX);
}

// ── Fidelity-pass helpers ────────────────────────────────────────────────────
//
// Added for the "more detail per tier" pass: doors, windows, chimney pots,
// framing, quoins, crenellations — all still one more local transform (or
// part) on each tier's fixed list, every transform a FIXED literal, never
// derived from a per-cell hash (per-building variation stays
// structureVariation's yaw/scale roll and durands.ts's skin roll, both spent
// before this file runs).

/** One full turn — a deliberate second copy of DURANDS_TWO_PI: that constant is Durand's own flash timing, and sharing it here would let an unrelated edit reach into the tower's crenellation layout. */
const FULL_TURN_RADIANS = Math.PI * 2;

/**
 * `count` local transforms evenly spaced around a circle of `radius` at
 * height `y`, centred on the building's origin — the shared block behind
 * every "ring of small repeated details" (firepit stones, arrow slits,
 * crenellations). `faceOutward` yaws each instance so its local +Z axis
 * points away from the centre, for parts like arrow slits whose front face
 * must face out through the wall regardless of the building's own yaw.
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
 * Every box-walled house tier and Durand's put their door and windows on the
 * +Z face — picked once, here, so every tier's "front" reads the same way.
 */

/**
 * Warm interior lamplight glow shared by every house tier's windows from
 * timber-house up (camp and hut read as lived-in through fire/smoke-vent
 * instead). One colour keeps "habitation" legible as the same cue
 * everywhere. Static — only Durand's sign and marquee pulse via animate().
 */
const WINDOW_GLOW_COLOR = 0xffcf7a;
const WINDOW_FRAME_COLOR = 0x2a1c10;
/** Restrained on purpose: lit without competing with Durand's own sign, this plugin's one focal emissive element (see DURANDS_SIGN_EMISSIVE_MAX). */
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
// A GABLE ROOF IS FOUR THINGS, NOT ONE: two sloped panels, the two TYMPANUM
// triangles closing the wall between wall-top and ridge, and a ridge cap over
// the seam. Until this pass only the panels existed, so every gable tier
// shipped two open triangles you could see through — the owner's "missing
// sections". The root cause was the helper handing out a quarter of a roof
// and leaving the rest for each tier to remember, so `gableRoof` now returns
// the WHOLE roof as one value — no call returns half a gable any more.

/** Half-base of the unit triangular prism `TRIANGLE_PRISM_UNIT` builds, at radius 1: sin(120°). */
const TRIANGLE_PRISM_HALF_BASE = Math.sqrt(3) / 2;
/** Apex-to-base height of that same unit triangle: 1 (apex) + 0.5 (base) = 1.5. */
const TRIANGLE_PRISM_HEIGHT = 1.5;
/** How far the unit triangle's base sits below the geometry's own origin, as a fraction of its height. */
const TRIANGLE_PRISM_BASE_FRACTION = 0.5 / TRIANGLE_PRISM_HEIGHT;

/** Lays the unit prism's triangular cross-section flat in the XY plane, apex up, prism length along Z. A CylinderGeometry with 3 radial segments IS a triangular prism (vertices at 0°, 120°, 240°) — the teepee door's own primitive-reuse trick, one axis-swap further. */
const TRIANGLE_PRISM_LIE_FLAT = new Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2);

/**
 * One isoceles triangle standing in the XZ-normal plane at `z`: `halfBase`
 * wide, `rise` tall, `thickness` deep, base resting on `baseY`. Every
 * dimension is a scale on the shared unit prism, so a gable end costs one
 * more local transform, not a bespoke geometry.
 *
 * Scale axes are the prism's pre-rotation frame, since Matrix4.compose
 * applies scale before rotation: the cylinder's X is triangle width, Z is
 * height, Y (the extrusion axis) is thickness.
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
   * FIDELITY PASS 2026-08-20: course strips laid on the panels —
   * ROOF_COURSES_PER_PANEL per panel, eave to ridge, each proud of the panel
   * face with a joint gap, reading as shingle/plank/tile courses rather than
   * a flat slab. Same "whole roof" contract as endMatrices: adding one part
   * gets course lines, and no tier can get the strip arithmetic wrong.
   */
  readonly courseMatrices: Matrix4[];
  /** Local-X length of one course strip's box geometry (its run down the slope). */
  readonly courseSlopeLength: number;
}

/** How thick the tympanum slab is. Thin enough to read as a gable wall, thick enough for flat shading to catch it. */
const GABLE_END_THICKNESS = 0.04;
/** FIDELITY PASS 2026-08-20: course-strip rows per roof panel. Four is the fewest that reads as "rows of shingles" rather than a stripe at orbit-camera distance. */
const ROOF_COURSES_PER_PANEL = 4;
/** Fraction of each course's slot left open — STONE_JOINT_FRACTION's trick recoloured: the panel shows through as a shadow line. Larger than the stone joints (0.06) since a roof is seen at a shallower angle. */
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
 * half-width plus eave overhang); `halfLength` is centre-to-eave along the
 * RIDGE; `wallHalfLength` is the wall's own half-extent along the ridge,
 * where the tympanum triangles stand.
 *
 * `ridgeAlongX` yaws the roof a quarter turn so the ridge runs along X
 * instead of Z — the longhouse needs this since its ridge runs down its
 * length, not its short axis.
 *
 * The tympanum's half-base is `halfSpan`, not the wall's half-width, so its
 * sloping edges lie exactly on the panels' centre planes — a seam that can't
 * open however the numbers are re-tuned. Sizing to the wall instead would
 * make its edges steeper than the roof and poke through the panel faces.
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
    // GableRoof.courseMatrices). Local +X runs down the slope, local +Y is
    // the panel normal — which for sign = -1 points DOWN from the raw
    // rotation (cos(angle) < 0), burying that panel's courses in the roof
    // void (seen in preview: the longhouse's camera-facing slope rendered
    // bare). Negating the down case pins the offset to the SKYWARD normal.
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
// tower, a recentred sign). Same discipline as the fidelity pass: every
// addition is one more (geometry, material, local transforms) entry, every
// transform a FIXED literal, never a per-cell hash roll.

/**
 * A tube segment BETWEEN two arbitrary 3D points: midpoint, length and
 * orientation are all derived from the endpoints, so a building is authored
 * as a joint skeleton rather than hand-placed matrices — dancerSegment's
 * (Durand's section) trick, generalised from its fixed-Z 2D plane to full
 * 3D, since the teepee's lodge-poles and log courses need segments that
 * leave that plane. `unitLength` is the shared geometry's built length; the
 * matrix's Y-scale stretches it to the endpoints' real distance.
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
 * FIXED (course + position) pattern so the mix is identical on every
 * building. Each tier builds its own fresh MeshLambertMaterial per shade
 * (windowMaterial's "every tier gets its own instance" convention), so
 * dispose() walks one flat list with no double-dispose risk.
 */
const STONE_SHADE_COLORS: readonly [number, number, number] = [0x9c968c, 0x8b8b86, 0x76736c];

/** What shows through the block joints: the wall box under the veneer, painted darker than every shade above so a joint reads as a shadow line — the cheapest way for a field of blocks to read as one wall. */
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
 * How much of a block's slot the mortar joint takes, as a fraction of the
 * slot's width and course height. Small on purpose: 0.14 read at game
 * distance as scattered tiles on a bare wall, not a coursed face (owner:
 * "missing sections"). The wall box behind the veneer is painted
 * STONE_MORTAR_COLOR, so the joint shows a shadow line, not the wall's colour.
 */
const STONE_JOINT_FRACTION = 0.06;

/**
 * A grid of small, slightly proud stone blocks tiling one FLAT rectangular
 * wall face. `faceHalfWidth` is the face's own half-span; `fixedAxis`/
 * `fixedValue` place its plane. Column count is the closest whole divisor of
 * the face's width to `STONE_BLOCK_TARGET_WIDTH` (DURANDS_MARQUEE_BULB_TARGET_SPACING's
 * same "target spacing, nearest divisor" trick), so blocks tile edge-to-edge
 * with no fractional remainder.
 *
 * Every course spans the whole face. Alternate courses stagger by half a
 * slot (running bond) and close both ends with a HALF block rather than
 * dropping a column — dropping one left a half-slot hole at both ends,
 * reading as bites out of the wall's corners. Each block's width is baked
 * into its own matrix, since one shared scale could only describe one block
 * size per face.
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

/** Splits a flat list of StoneBlocks into one StructurePart per shared shade (STONE_SHADE_COLORS): one geometry, one material, many local transforms per part — never one part per block. */
function stonePartsByShade(blocks: readonly StoneBlock[], geometry: BufferGeometry): StructurePart[] {
  return STONE_SHADE_COLORS.map((_, shadeIndex) => ({
    geometry,
    material: stoneMaterial(shadeIndex),
    localMatrices: blocks.filter((block) => block.shadeIndex === shadeIndex).map((block) => block.matrix),
  }));
}

// ── Fidelity-pass 2026-08-20 helpers ────────────────────────────────────────
//
// Owner feedback: from the orbit camera "a house reads as a brown tile with
// four spikes". Roofs gain course strips (GableRoof.courseMatrices), doors
// gain frames, walls gain trim — same rules as the rest of the file. The two
// helpers below exist because roof courses and door frames appear on
// several tiers, and per-tier copies of their arithmetic is exactly the
// drift the gable-roof contract was written to end.

/** One StructurePart of roof course strips for `gable`, in `color` — the GableRoof.courseMatrices field made concrete, built from the gable's own measured slope so a tier can't mismatch matrices and strip length. */
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
 * at `z` on the +Z front, centred on `x`, standing on `baseY`. Returns three
 * local matrices for a UNIT cube geometry — each bar's dimensions baked into
 * its own matrix (stoneBlocksForFace's trick), so one geometry serves every
 * frame in the file.
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

  // EVERY TIER BELOW IS BOUND BY STRUCTURE_FOOTPRINT_RADIUS: no part may
  // reach further than that from the origin in X or Z, so a building at max
  // variation scale is exactly one cell wide. test/models.test.ts measures
  // every tier against it — a test, not a convention, since "keep it small"
  // is exactly the rule hand-authored numbers drift out of.

  // ── Tier 0: camp — a teepee beside a campfire's ember glow. The shortest,
  // roundest-toned silhouette: nothing here stands taller than half a cell.
  //
  // COMPOSITION PASS. Lodge-poles now run from the GROUND, outside the hide,
  // up through the smoke hole (previously mid-air, crossing above the apex —
  // read as sticks thrown at a cone, not a frame the tent is built on). The
  // door grew from a 0.11-radius chip to a real opening; the woodpile shrank
  // to read as three logs, not one slab.
  {
    const TENT_RADIUS = 0.24;
    const tentHeight = 0.5;
    const tentX = -0.13; // off-centre so the hearth cluster below has room on the tent's +X side
    const tent: StructurePart = {
      geometry: new ConeGeometry(TENT_RADIUS, tentHeight, 8),
      material: lambert(0xcbb994),
      localMatrices: [at(tentX, tentHeight / 2, 0)],
    };

    // Dark triangular door opening on the tent's +Z meridian — the same unit
    // triangular prism the gable ends use (trianglePrismMatrix), so the
    // camp's opening and the house gables are one primitive.
    const TEEPEE_DOOR_HALF_BASE = 0.085;
    const TEEPEE_DOOR_RISE = 0.24;
    const TEEPEE_DOOR_DEPTH = 0.02; // just enough extrusion for flat shading to read this as a face, not a zero-thickness plane
    const TEEPEE_DOOR_PROUD_MARGIN = 0.012; // clears the tent's own sloped surface — see doorZ below
    // The tent is a CONE: radius shrinks with height, so the door's z-offset
    // must be sized to the SMALLEST radius it spans (its own top) or the
    // upper half clips inside the hide. Safe direction: floating proud, never buried.
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

    // Lodge-poles: three poles from the ground outside the hide, through the
    // smoke hole, to a common crossing point above the apex. Each pole's
    // endpoints are computed independently (segmentMatrix), not mirrored —
    // gableRoof's own reasoning: a bug in one can't silently mirror into the next.
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

    // Firepit ring: small stones circling the fire — the watchtower's own
    // fixed-ring trick, at camp scale. Centred on the fire's own offset, not
    // the building origin, since the fire is off-centre from the tent.
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

    // A small woodpile beside the hearth — three split logs stacked
    // two-and-one, reading as "primitive camp" (fuel, not just a fire).
    // Clustered with the fire and its stone ring, clear of the tent's silhouette.
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

    // FIDELITY PASS 2026-08-20: two camp additions a working camp visibly
    // HAS — a cooking spit over the fire, and the ring of stones real
    // teepees pin their hide's skirt with.
    //
    // Spit: two uprights leaning over the fire, one crossbar — three
    // segments via segmentMatrix, the lodgepoles' own joint-skeleton authoring.
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

    // Hide-pinning stones: a ring pinning the hide's skirt — circleRingMatrices
    // again, centred on the tent's own off-centre x. Fewer, smaller and
    // squarer than the firepit stones so the two rings read as different jobs.
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

  // ── Tier 1: hut — a round wattle-and-daub wall under a conical THATCH
  // roof. First solid drum shape; still no hard edges.
  //
  // COMPOSITION PASS. The two thatch layers used to be independently-sized
  // cones whose seam overhung thin air, reading as stacked discs, not
  // thatch. They are now FRUSTA sharing a radius at the seam (skirt top ===
  // cap bottom) — the only construction where the join can't open.
  {
    const wallRadiusTop = 0.26;
    const wallRadiusBottom = 0.275;
    const wallHeight = 0.42;
    const wall: StructurePart = {
      geometry: new CylinderGeometry(wallRadiusTop, wallRadiusBottom, wallHeight, 8),
      material: lambert(0x9c7a52),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };

    // Straw palette: the skirt a shade darker than the cap so the seam reads
    // as a texture break even under flat shading.
    const THATCH_CAP_COLOR = 0xdcb95a;
    const THATCH_SKIRT_COLOR = 0xc3a047;

    // Skirt: the wider, shorter lower roof layer, oversized relative to the
    // wall per the brief; its EAVE radius is what the fringe ring hangs from.
    const skirtEaveRadius = 0.38;
    const skirtTopRadius = 0.3;
    const skirtHeight = 0.13;
    const roofSkirt: StructurePart = {
      geometry: new CylinderGeometry(skirtTopRadius, skirtEaveRadius, skirtHeight, 8),
      material: lambert(THATCH_SKIRT_COLOR),
      localMatrices: [at(0, wallHeight + skirtHeight / 2, 0)],
    };

    // Cap: the taller upper layer, standing on the skirt's TOP radius so the
    // two meet edge to edge (see this tier's banner).
    const capHeight = 0.3;
    const roofCap: StructurePart = {
      geometry: new ConeGeometry(skirtTopRadius, capHeight, 8),
      material: lambert(THATCH_CAP_COLOR),
      localMatrices: [at(0, wallHeight + skirtHeight + capHeight / 2, 0)],
    };

    // Door: a dark plank on the drum's +Z face, low and narrow — a hut's
    // doorway, not a house's. z stands proud of the drum's radius so the
    // plank reads as mounted, not half-swallowed.
    const doorHeight = 0.27;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.13, doorHeight, 0.03),
      material: lambert(0x3a2416),
      localMatrices: [at(0, doorHeight / 2, wallRadiusBottom + 0.015)],
    };

    // Thatch fringe: small boxes standing in for straw bundles past the
    // eave, raggeding the silhouette. Count is the nearest divisor of the
    // eave's circumference to the target spacing — the marquee bulb ring's
    // own trick, for the same even-ring-no-gap reason.
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

    // Smoke vent: a dark cap at the roof's apex, standing in for a chimney a
    // hut this primitive wouldn't have — a hole in the thatch, not masonry.
    const smokeVentHeight = 0.05;
    const smokeVent: StructurePart = {
      geometry: new CylinderGeometry(0.045, 0.045, smokeVentHeight, 6),
      material: lambert(0x2a1c10),
      localMatrices: [at(0, wallHeight + skirtHeight + capHeight - smokeVentHeight / 2, 0)],
    };

    // FIDELITY PASS 2026-08-20: four hut additions, each a visible fact of
    // wattle-and-daub construction.
    //
    // Wattle bands: the horizontal withy courses a wattle wall is woven
    // around, as two thin dark rings proud of the drum — what makes the wall
    // read as WOVEN, not a plastered tube.
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
    // doorFrameMatrices contract, in rough pole timber to match a hut's joinery.
    const HUT_DOOR_WIDTH = 0.13; // the door part's own width, restated for the frame
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(0x54381f),
      localMatrices: doorFrameMatrices(HUT_DOOR_WIDTH, doorHeight, 0, 0, wallRadiusBottom + 0.015),
    };

    // Upper thatch courses: two conical bands wrapping the CAP, darker and
    // proud of the surface, reading as LAYERED COURSES — the wattle bands'
    // trick, moved to the roof. Band radii follow the cone's own taper (the
    // teepee door's "surface moves inward with height" reasoning).
    //
    // (First attempt, tilted straw bundles like the eave fringe, read as
    // merlons in preview 2026-08-20; a surface-hugging band can't mis-read that way.)
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
        // A unit cylinder can't scale into a frustum, so approximate each
        // course as a cylinder at the band's MEAN radius: over 0.045 height
        // the cone narrows by 0.0225, invisible at this tier's viewing distance.
        const meanRadius = (bottomRadius + topRadius) / 2;
        return new Matrix4().compose(
          new Vector3(0, y, 0),
          new Quaternion(),
          new Vector3(meanRadius, CAP_COURSE_HEIGHT, meanRadius),
        );
      }),
    };

    // Daub footing: a low, wider ring at the drum's base — the mud sill a
    // wattle wall stands on, keeping the drum from reading as planted
    // straight into the terrain (the watchtower's plinth, at hut scale).
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

  // ── Tier 2: timber-house — walls of stacked LOG COURSES under a gable
  // roof: the first tier with hard edges.
  //
  // All four walls are one `logCourses` part: one unit-length cylinder,
  // stretched and placed per course via segmentMatrix. Every course
  // OVERHANGS its corner by LOG_END_OVERHANG, so the cylinder's own flat end
  // cap shows as the log-end cap a cabin corner is made of — no separate part needed.
  //
  // COMPOSITION PASS: the roof is now a whole gable (panels, closed ends,
  // ridge cap — see gableRoof), where before it was two panels over an open
  // triangle.
  //
  // SUPERSEDED BY THE IMPORTED ASSET (2026-09-04, IMPORTED_STRUCTURE_TIER):
  // when assets/timber-house.glb is installed, this tier is that model. Kept
  // whole as the FALLBACK when no asset is installed, and as the record of
  // how the tier's silhouette was arrived at (the asset was chosen to match
  // it). Built lazily inside this function so unused primitives are never allocated.
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
      // Front/back walls run along X, left/right along Z. Every course
      // overhangs both ends, so the perpendicular wall's logs poke past this
      // wall's face at every corner — the interlocking joint a log cabin shows.
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
    // Tympanum triangles take the WALL's timber colour, not the roof's: a
    // gable end is the wall carrying on upward, not a second roof panel.
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

    // Door and windows, centred on the +Z wall face (the shared front-face
    // convention). z clears the logs' own overhanging radius, not a flat box face.
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

    // FIDELITY PASS 2026-08-20: shingle roof courses (GableRoof.courseMatrices),
    // a framed door, plank shutters, a lit loft window — all a log-built
    // house's own vocabulary, none borrowed from a later tier's masonry.
    const roofCourses = roofCoursesPart(gable, 0x7c332a); // one shade under the panels' red — courses in the panel's own material
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(0x54331c), // hewn-timber frame, lighter than the dark doorway it outlines
      localMatrices: doorFrameMatrices(TIMBER_DOOR_WIDTH, doorHeight, 0, 0, openingZ),
    };

    // Shutters: one plank per side of each window, in the gable ends' darker
    // timber so they read as joinery against the log courses.
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

    // Loft window: one small glow in the +Z tympanum — the storey the
    // gable's closed triangle implies. z clears the tympanum's own half-thickness.
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

  // ── Tier 3: longhouse — longer and lower than the timber house, with a
  // smoking chimney: the widest silhouette in the progression.
  //
  // COMPOSITION PASS, two changes. (1) The ridge now runs along the LONG
  // axis (gableRoof's `ridgeAlongX`) — it used to run across the short one,
  // reading as a shallow slab draped the wrong way. (2) Length is now
  // bounded by STRUCTURE_FOOTPRINT_RADIUS like every tier: at half-width
  // 1.05 this building was 2.3 cells across at max scale, overlapping
  // neighbours and hanging off terrace steps its own cell's check never covered.
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

    // Chimney: rooted BELOW the ridge line, rising through the roof plane
    // rather than balanced on top — a stack starting at the surface it
    // pierces can't hide that seam; one starting inside the roof has nothing to hide.
    const chimneyHeight = 0.3;
    const chimneyX = wallHalfLength * 0.55;
    const chimneyBaseY = wallHeight; // inside the roof void, under the panels
    const chimneyY = chimneyBaseY + chimneyHeight / 2;
    // Stack and pot re-proportioned in the composition pass: at 0.08 square
    // in pale grey the stack read as a factory smokestack, and its pot was
    // wider than the stack it capped.
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
    // overhang, where a hall this shape is entered.
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
        // FIDELITY PASS 2026-08-20: the rear face gets the same pair — a
        // blank back wall reads as an unfinished model in an orbited hall.
        at(WINDOW_X, WINDOW_Y, -openingZ),
        at(-WINDOW_X, WINDOW_Y, -openingZ),
      ],
    };

    // FIDELITY PASS 2026-08-20 (this tier was the worst "brown tile"
    // offender). The hall becomes TIMBER-FRAMED: visible post-and-beam
    // framing, plank roof courses, eave posts, a framed door, lit loft
    // triangles at both gables.
    // Course shade: two steps darker than the panels' 0x746558 — a one-step
    // first draft vanished into the panel at the orbit camera's angle.
    const roofCourses = roofCoursesPart(gable, 0x574a3e); // weathered plank courses, legibly darker than the panels
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(0x3f2c1a),
      localMatrices: doorFrameMatrices(LONGHOUSE_DOOR_WIDTH, doorHeight, 0, 0, openingZ),
    };

    // Wall framing: corner posts at all four arrises, a stud between each
    // opening, a mid-rail the studs meet — the exposed frame that makes a
    // long wall read as BUILT, not extruded. One unit-cube part; each bar's
    // size rides its own matrix (doorFrameMatrices' trick, wall-wide).
    const FRAME_BAR = 0.032; // heavier than a door jamb (0.028): structural timber, not trim
    const FRAME_PROUD = 0.008; // how far the framing stands proud of the wall face
    const FRAME_COLOR = 0x3f2c1a; // one dark oak for every framing member and the door frame alike
    const framePostScale = new Vector3(FRAME_BAR, wallHeight, FRAME_BAR);
    const frameIdentity = new Quaternion();
    const framingMatrices: Matrix4[] = [];
    // Corner posts: proud of both faces they meet, so the arris reads framed from any angle.
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
    // Studs: midway between windows and gable ends — a real frame's bay divisions.
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
    // Mid-rail: one horizontal member at the windows' sill line, tying the studs together.
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
    // walk a working hall's entrance has, changing the near-ground
    // silhouette toward the design table's "widest footprint, low profile".
    const EAVE_POST_RADIUS = 0.016;
    const EAVE_POST_XS = [0.3, 0, -0.3]; // door bay centred, one post per flanking bay
    const eavePostZ = wallHalfDepth + eave - EAVE_POST_RADIUS; // under the eave's own outer edge
    const eavePostHeight = wallHeight; // ground to wall-top, where the roof plane begins
    const eavePosts: StructurePart = {
      geometry: new CylinderGeometry(EAVE_POST_RADIUS, EAVE_POST_RADIUS, eavePostHeight, 5),
      material: lambert(FRAME_COLOR),
      localMatrices: EAVE_POST_XS.map((x) => at(x, eavePostHeight / 2, eavePostZ)),
    };

    // Loft lights: one glow in each gable triangle (ridge along X, so
    // tympana face ±X — Durand's own side-window trick, yawed a quarter turn).
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

  // ── Tier 4: stone-cottage — a STONE wall (first material break) under a
  // clay-tile roof with a round chimney: semi-advanced masonry, still a house.
  //
  // COMPOSITION PASS: closed gable ends (gableRoof), and the veneer
  // re-proportioned — its blocks used to be taller than wide and 0.025
  // proud, reading as sugar cubes glued to a box; real coursing is
  // LANDSCAPE and barely proud, so blocks are now wider than tall and half as deep.
  {
    const wallHeight = 0.55;
    const wallHalfWidth = 0.29;
    const wallHalfDepth = 0.21;
    // How far the veneer stands proud of the flat wall. Declared here since
    // the door and windows need it too, to clear the veneer's outer face.
    const STONE_BLOCK_DEPTH = 0.015;
    // Painted as MORTAR, not stone: the veneer covers the whole face, so all
    // that's still visible of this box is the joint lines between blocks.
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
    // Gable ends take the wall's stone grey, darker, reading as masonry in
    // shadow rather than a third roof plane.
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

    // Chimney, rooted below the roof plane for the longhouse's own reason.
    const chimneyHeight = 0.36;
    const chimneyX = wallHalfWidth * 0.5;
    const chimneyBaseY = wallHeight;
    // Same re-proportioning and shared stone palette as the longhouse's
    // stack, so both tiers' chimneys read as the same masonry.
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

    // Door and windows on the +Z face. z clears the veneer's outer face
    // (STONE_BLOCK_DEPTH) plus a small gap, not just the bare wall.
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
        // longhouse's own blank-back-wall reasoning, one tier up.
        at(WINDOW_X, WINDOW_Y, -cottageOpeningZ),
        at(-WINDOW_X, WINDOW_Y, -cottageOpeningZ),
      ],
    };

    // FIDELITY PASS 2026-08-20: the cottage's additions are all DRESSED-STONE
    // details — the quoins' own masonry story: tile roof courses, cut sills
    // and lintels, a stone door surround, a chimney-pierce collar.
    const roofCourses = roofCoursesPart(gable, 0xa2452a); // one shade under the panels' clay red — fired-tile courses
    const doorFrame: StructurePart = {
      geometry: unitBoxGeometry(),
      material: lambert(STONE_SHADE_COLORS[0]), // the quoins' own pale dressed stone
      localMatrices: doorFrameMatrices(COTTAGE_DOOR_WIDTH, doorHeight, 0, 0, cottageOpeningZ),
    };

    // Sills and lintels: one cut stone under and over each window, wider
    // than the glass — the header-and-sill pair a coursed wall shows around
    // an opening. One unit-cube part; sizes ride the matrices.
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

    // Chimney collar: a battered course where the stack pierces the roof —
    // flashing made visible as masonry. A VERTICAL frustum over a SLOPED
    // plane floats on the downslope side and buries on the upslope side
    // unless sized from both: base seats below the surface at its DOWNSLOPE
    // rim, top clears it at its UPSLOPE rim, so no daylight opens under it
    // from any angle. The panel drops ridgeRise over halfSpan; ridge runs
    // along Z here, so distance is measured in X.
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
    // carried up so the habitation glow stays constant across gable tiers.
    const LOFT_WINDOW_RISE_FRACTION = 0.35;
    const loftWindow: StructurePart = {
      geometry: new BoxGeometry(0.06, 0.07, 0.02),
      material: windowMaterial(),
      localMatrices: [at(0, wallHeight + ridgeRise * LOFT_WINDOW_RISE_FRACTION, wallHalfDepth + GABLE_END_THICKNESS / 2 + 0.012)],
    };

    // Stone quoins: the classic masonry tell for "first material break" —
    // dressed corner stone proud of the coursing between it. One full-height
    // pilaster per corner, four in all.
    //
    // COMPOSITION PASS: this was three loose cubes per corner, reading as
    // sugar cubes balanced on the arris and leaving the veneer's corner seam
    // showing. A quoin's job is to dress the corner along its whole height,
    // proud of the veneer's outer face, hiding the seam where two coursing faces meet.
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

    // The veneer: one shared block geometry tiled across all four faces via
    // stoneBlocksForFace, split by stonePartsByShade — the wall box stays
    // the substrate underneath (a veneer, not a replacement, unlike the
    // timber-house's log courses which ARE the wall).
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

  // ── Tier 5: watchtower — a tall narrow stone tower with a parapet ring and
  // slate roof. The one VERTICAL silhouette: taller than wide, where every
  // house tier is wider than tall.
  //
  // COMPOSITION PASS. Crenellations used to ride the parapet's CIRCUMradius
  // while the parapet was a ten-sided prism, so merlons balanced on corners
  // with daylight beneath. They now share the parapet's segment count and
  // sit on its INRADIUS, standing squarely on one facet. The stone veneer
  // gets the cottage's own landscape re-proportioning.
  {
    const towerHeight = 1.3;
    const towerRadiusTop = 0.22;
    const towerRadiusBottom = 0.24;
    /** Sides on every round part of this tier, so tower, parapet and plinth are facet-aligned rather than three different polygons stacked. */
    const TOWER_SIDES = 8;
    // How far the stone-block ring stands proud of the tapered shaft,
    // declared here since the door needs it too — see towerDoorZ below.
    const STONE_TOWER_BLOCK_DEPTH = 0.018;
    const tower: StructurePart = {
      geometry: new CylinderGeometry(towerRadiusTop, towerRadiusBottom, towerHeight, TOWER_SIDES),
      // Mortar, not stone — the coursing covers this shaft; only joint lines stay visible.
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

    // Door at the base, on the +Z face — the one round-walled tier, so the
    // door sits directly on the tower's radius. z clears the stone ring's outer face.
    const doorHeight = 0.28;
    const towerDoorZ = towerRadiusBottom + STONE_TOWER_BLOCK_DEPTH + 0.01;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.12, doorHeight, 0.04),
      material: lambert(0x2a2018),
      localMatrices: [at(0, doorHeight / 2, towerDoorZ)],
    };

    // Arrow slits: thin glows evenly ringed, not all facing one way — a
    // watchtower sees in every direction. Reuses the window glow for the
    // same "there is a light behind this opening" cue. Two bands: one band
    // up a 1.3-unit shaft reads as a single lit floor, not a manned tower.
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

    // Crenellations: merlon blocks proud of the parapet ring, since a plain
    // ring reads as a collar, not a fortification. One merlon per facet,
    // centred on its inradius, standing squarely on flat stone.
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

    // Base plinth: a wider footing ring at the tower's foot — the parapet's
    // ground-level counterpart, founding the tower on masonry, not bare terrain.
    const plinthHeight = 0.11;
    const plinth: StructurePart = {
      geometry: new CylinderGeometry(towerRadiusBottom + 0.05, towerRadiusBottom + 0.09, plinthHeight, TOWER_SIDES),
      material: lambert(0x6f6a63),
      localMatrices: [at(0, plinthHeight / 2, 0)],
    };

    // The tower's wall is a CYLINDER, so stoneBlocksForFace's flat-face grid
    // doesn't apply; this builds the round equivalent — courses of small
    // boxes ringed via circleRingMatrices, reading the SAME STONE_SHADE_COLORS
    // cycle so cottage and tower share one palette.
    //
    // COMPOSITION PASS, two changes. (1) Each course rides the shaft's own
    // radius at that height, not one fixed radius (which left top courses a
    // block-depth clear of the wall, reading as a loose collar). (2) Blocks
    // fill their slots (STONE_JOINT_FRACTION) instead of a seventh empty,
    // which made the shaft read as scattered patches.
    const STONE_TOWER_COURSE_COUNT = 7;
    const STONE_TOWER_TARGET_SPACING = 0.15;
    const towerStoneBandBottom = plinthHeight;
    const towerStoneBandTop = towerHeight - 0.05;
    const towerStoneBand = towerStoneBandTop - towerStoneBandBottom;
    const towerCourseHeight = towerStoneBand / STONE_TOWER_COURSE_COUNT;
    /** The shaft's own radius at height `y` — the cylinder tapers linearly from bottom to top. */
    const towerRadiusAt = (y: number): number =>
      towerRadiusBottom + (towerRadiusTop - towerRadiusBottom) * (y / towerHeight);
    // Nearest whole divisor of the ring's circumference (stoneBlocksForFace's
    // own trick), fixed across courses and measured at the band's midpoint.
    const towerStoneMidRadius = towerRadiusAt((towerStoneBandBottom + towerStoneBandTop) / 2);
    const towerStoneRingCount = Math.round(
      (FULL_TURN_RADIANS * towerStoneMidRadius) / STONE_TOWER_TARGET_SPACING,
    );
    const towerStoneHalfSlotAngle = Math.PI / towerStoneRingCount; // half of one slot's own angular width
    // A stone block in front of an arrow slit would defeat it. Rather than
    // reasoning about which courses overlap the slit bands, this carves a
    // full-height angular seam at each slit's angle — no block within
    // ARROW_SLIT_ANGLE_CLEARANCE at ANY course.
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
      // Block width follows the course's own circumference, so a narrower
      // top course gets narrower stones rather than overlapping ones.
      const courseBlockScale = new Matrix4().makeScale(
        ((FULL_TURN_RADIANS * courseRadius) / towerStoneRingCount) * (1 - STONE_JOINT_FRACTION),
        towerCourseHeight * (1 - STONE_JOINT_FRACTION),
        1,
      );
      for (let i = 0; i < ring.length; i++) {
        // Same angle formula circleRingMatrices uses internally — recomputed
        // here only to test against the slit seam, not to rebuild the matrix.
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

    // FIDELITY PASS 2026-08-20: four tower additions, a fortification's own
    // vocabulary — corbels under the parapet, a stone door surround with
    // threshold, an eave ring where the roof meets the parapet, and a spire
    // banner (the one silhouette flourish, on the tier meant to be seen far away).
    //
    // Corbels: the parapet overhangs the shaft with nothing visibly holding
    // it; one bracket per facet under its rim makes the ring read as BUILT
    // onto the tower. Same facet/inradius discipline as the merlons, offset
    // half a turn so each corbel sits under a merlon, not a gap.
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
    // base — a doorFrameMatrices frame plus a wide step, so the entrance
    // reads as an entrance from orbit height, not a dark chip on the drum.
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

    // Eave ring: a slim collar under the slate cone's rim, closing the step
    // where roof meets parapet — the hut's footing reasoning, at the top instead.
    const EAVE_RING_HEIGHT = 0.035;
    const EAVE_RING_RADIUS = towerRadiusTop + 0.055; // a hair past the cone's base (towerRadiusTop + 0.04)
    const eaveRing: StructurePart = {
      geometry: new CylinderGeometry(EAVE_RING_RADIUS, EAVE_RING_RADIUS, EAVE_RING_HEIGHT, TOWER_SIDES),
      material: lambert(0x2e3b42), // the slate's own family, darker — an under-eave shadow course
      localMatrices: [at(0, towerHeight + parapetHeight + EAVE_RING_HEIGHT / 2, 0)],
    };

    // Banner: a short staff with a pennant — pure silhouette, no emissive
    // (arrow slits keep the "manned" glow role). Height is the one axis the
    // footprint bound deliberately leaves free.
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
// (fishingHuts.ts) instead of the stone watchtower, one rolled per cell from
// its own coordinates.
//
// Replaces the single raised dock lookout that shipped with card 33; the
// dispatch around it is unchanged in shape and priority — a site variant
// still wins over Durand's ~1-in-6 roll (see apply() below), being a
// categorical fact rather than a rarity. New: a site offers a SET of models
// and picks between them per-cell, hence SiteVariantSet's `pick`.
//
// EXTENDING IT: a second site kind is one more SITE_TOP_TIER_VARIANTS entry
// (builders + a pick function, or one builder and `() => 0`) — the dispatch,
// allocation and disposal below need no further change.

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
// At MAX_STRUCTURE_TIER, a deterministic ~1-in-6 slice of cells (./durands.ts)
// render as "Durand's" instead of the watchtower: a two-storey saloon in the
// same low-poly style, plus one exception — a small sign with real text,
// since no combination of boxes and cones can spell out a NAMED building.
//
// The text is a CanvasTexture drawn ONCE at module init: every sign shows
// the identical string, so one canvas/texture is shared like one geometry
// is — and keeps the sign INSTANCED, since the usual reason a texture
// breaks instancing (a different image per instance) doesn't apply here.

/** Canvas the sign text is rasterised into. Proportioned for a short word. */
const DURANDS_SIGN_CANVAS_WIDTH = 512;
const DURANDS_SIGN_CANVAS_HEIGHT = 128;

/** The sign's text. Drawn once; never assembled from a per-instance string. */
const DURANDS_SIGN_TEXT = "Durand's";

/** `bold <px> sans-serif`: no external font asset, `sans-serif` resolves to whatever the platform ships. `bold` is load-bearing — the regular weight's thin strokes alias badly at this board's size. */
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
  // A null 2D context leaves the canvas blank rather than throwing at module
  // init — a blank board is a cosmetic miss, not a crash.

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Built once, at module init — every Durand's sign instance shares this texture. */
const DURANDS_SIGN_TEXTURE = buildDurandsSignTexture();

/**
 * Seconds for one full flash cycle (dim → bright → dim), ~0.625 Hz.
 *
 * Bounded well under the 3 Hz photosensitive-seizure ceiling (WCAG; also
 * cited by weather/client/sky.ts's lightning and monsters/client/dread.ts's
 * strike). A continuous low-frequency pulse, not a strobe, so it needs no
 * prefers-reduced-motion gate — nothing to reduce at this period.
 */
export const DURANDS_SIGN_FLASH_PERIOD_SECONDS = 1.6;

/** Warm gold — the sign's own lettering hue, so the glow reads as letters lighting up, not a stage light hitting the board. */
const DURANDS_SIGN_EMISSIVE_COLOR = 0xf2c85b;

/**
 * Emissive intensity bounds the flash between. Minimum isn't zero: at 0 the
 * board still reads as painted wood under scene lights, so "dark" means
 * "unlit sign", not "invisible sign". Maximum (matching relics/client/index.ts's
 * GEM_EMISSIVE_INTENSITY) reads as lit without ACES blowing it to white.
 */
const DURANDS_SIGN_EMISSIVE_MIN = 0.05;
const DURANDS_SIGN_EMISSIVE_MAX = 1.4;

/** One full turn, for turning a period in seconds into an angular rate. */
const DURANDS_TWO_PI = Math.PI * 2;

// ── Marquee bulbs: little blinking lights around the sign header ───────────
//
// Owner feedback: little blinking lights around the header. A border of
// small emissive bulbs framing all four edges, split into two PHASE GROUPS
// so alternating bulbs chase rather than blink together — each its own
// InstancedMesh sharing one material.
//
// FREQUENCY CEILING: reuses the sign's own continuous sine (never a hard
// on/off cut — the more seizure-relevant pattern under WCAG), phase-locked
// to the sign's period at HALF it, 180° out of phase between groups:
//
//   sign  period 1.6 s  → 0.625 Hz
//   bulbs period 0.8 s  → 1.25  Hz
//   combined            → 1.875 Hz
//
// 1.875 Hz sits 37.5% below the 3 Hz ceiling even summed (treating sign +
// bulbs as one combined stimulus, the conservative reading).
export const DURANDS_MARQUEE_BULB_PERIOD_SECONDS = DURANDS_SIGN_FLASH_PERIOD_SECONDS / 2;

/** Warm incandescent bulb glass, whiter than the sign's lettering, so bulbs read as their own light source. Only ever the EMISSIVE colour (see DURANDS_MARQUEE_BULB_SOCKET_COLOR) — a bright base colour would keep a dim bulb looking lit regardless of emissiveIntensity, silencing the chase. */
const DURANDS_MARQUEE_BULB_COLOR = 0xffe9a8;
/** Dark bulb-socket base colour — windowMaterial()'s own "dark frame, bright emissive" split, for the same reason: dark base + swinging emissive is what makes "off" actually read as off. */
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

/** `count` points evenly spaced around a rectangle's border (half-width `hw`, half-height `hh`), from the top-left corner clockwise — the rectangle case of circleRingMatrices, since the sign board isn't a circle. */
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
// Owner request, twice: a dancer on the pole, then "they look terrible, and
// they don't have any boobs" — both about the same root cause: the figure
// was a 0.42-unit skeleton tucked behind a porch post, too small to read
// past CAMERA_MIN_DISTANCE. Now the building's ROOFTOP SIGN: a 0.78-unit
// figure on its own board above the false front, unobstructed.
//
// STILL A SIGN, NOT A BODY: glowing TUBE OUTLINE only — a profile traced as
// polylines plus circles for head and bust. No surface, no anatomy; the bust
// curve is what makes the silhouette female.
//
// Two fixed poses alternate on the marquee's phase clock — the classic
// two-pose animated-sign trick, apparent motion with zero per-frame matrix
// work and no new flash frequency beyond the bulb sine already counted above.

/** Neon-pink tube glow; deliberately not the marquee's gold so the figure reads as its own sign element. */
const DURANDS_DANCER_NEON_COLOR = 0xff4f96;
/** Dark tube base. REDESIGN 2026-08-19: matched to the board's colour (was maroon 0x33202b) so an OFF tube disappears into the board instead of standing as a dark "ghost figure" scribble. */
const DURANDS_DANCER_TUBE_COLOR = 0x241016;
/** Fully dark, not the bulbs' visible-when-off floor: an OFF neon LIMB must vanish — the two-frame trick is that only one limb set exists at a time. */
const DURANDS_DANCER_EMISSIVE_MIN = 0.0;
/** Slightly under the bulbs' max: the figure is set dressing, the name sign stays focal. */
const DURANDS_DANCER_EMISSIVE_MAX = 1.0;
/** The BODY outline never blinks: held a shade under the limbs' peak so the moving limbs carry the eye. */
const DURANDS_DANCER_BODY_EMISSIVE_INTENSITY = 0.85;
/** Neon-tube radius, raised from 0.018 in the 2026-08-19 redesign: the line's weight carries the silhouette at game distance, and smooth-arc strokes can afford heavier lines without tangling. */
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
/** The board's neon border: a steady warm-gold tube rectangle inside the edge (marquee's colour family) — turns the black slab into a lit sign CABINET. Steady since it's framing, not animation, adding no flash frequency. */
const DURANDS_DANCER_FRAME_COLOR = 0xffd98a;
const DURANDS_DANCER_FRAME_EMISSIVE_INTENSITY = 0.55;
/** How far the border tube sits in from the board's edge. */
const DURANDS_DANCER_FRAME_INSET = 0.035;
/** Border tube: slimmer than the figure's line, so the frame stays quieter than the dancer. */
const DURANDS_DANCER_FRAME_TUBE_RADIUS = 0.012;

/** A point in the sign board's own 2D frame: `u` across it, `v` up from the figure's feet. */
type SignPoint = readonly [u: number, v: number];

/** One neon tube segment BETWEEN two joints in the building's front (x, y) plane: midpoint, length and Z-tilt derived from the endpoints, so every limb connects by construction (hand-placed midpoints rendered as a disconnected jumble). */
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
  // Depth is NOT the drawn radius: a full sphere at head/bust radius reaches
  // deeper than the tube stand-off, poking out the board's back face (seen
  // as pink dots on the sign's rear). Squashing to the tube's half-depth
  // puts the back face exactly on the board, whatever the drawn radius.
  const depthScale = DURANDS_DANCER_TUBE_RADIUS / DURANDS_DANCER_HEAD_RADIUS;
  return new Matrix4().compose(new Vector3(x, y, z), new Quaternion(), new Vector3(scale, scale, depthScale));
}

// ── The drawing (redesigned from scratch, owner request 2026-08-19) ────────
//
// THREE DECISIONS replace the old two-full-figure design:
//
//   1. SMOOTH ARCS, NOT CORNERED POLYLINES: quadratic arcs sampled into
//      short runs (neonArc/neonStroke) so a line bends gradually, like a
//      real bent-glass tube (the old polylines cornered hard, reading as scribble).
//   2. THE BODY NEVER BLINKS; ONLY LIMBS SWAP. Everything identical in both
//      frames draws once on a steady material; only the kicking leg, arms
//      and ponytail alternate — halves the tube count and removes the old
//      "ghost of the other pose" legibility fault.
//   3. A CAN-CAN KICK: one high and one low kick of the SAME leg, with the
//      free arm counter-swinging — one legible motion instead of two
//      unrelated poses.

/** Arc samples per quadratic. Four runs keeps consecutive tube headings within ~15° — a visually smooth bend — without flooding the instancer. */
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

/** THE BODY — everything both frames share, drawn once and lit steadily. Profile facing the pole (+u): chin high, bust out front, waist pinched, seat out back, weight on one straight leg with a pointed foot. */
const DURANDS_DANCER_BODY_STROKES: ReadonlyArray<readonly SignPoint[]> = [
  // Front outline: chin → throat → bust → under-bust → pinched waist → belly → hip.
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

/** FRAME A limbs — the HIGH kick: leg swept up toward the pole, high grip, free arm trailing low behind, ponytail streaming back. */
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

/** FRAME B limbs — the LOW kick of the same leg, grip slid down, free arm flung up, ponytail tossed: frame A's mirror beat, so the flip reads as one can-can kick. */
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
 * Turns a set of strokes into instance matrices in the building's space:
 * `originX`/`originY` place the figure's feet, `z` is the one plane it's
 * drawn on. Segments and joint circles are returned separately (two
 * geometries, two parts); the head and bust circles are the BODY's alone,
 * added by callers themselves.
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
      // A circle at every INTERIOR joint: two tubes meeting at an angle leave
      // a notch, and a real neon tube bends instead of mitring. The stroke's
      // ends are left open — they're the drawing's own ends, not corners.
      if (i > 0) {
        circles.push(dancerCircle(originX + u1, originY + v1, z, DURANDS_DANCER_JOINT_RADIUS));
      }
    }
  }
  return { segments, circles };
}

/** A saloon building plus its flashing sign and marquee bulbs, and the materials animate() needs a handle to pulse: the sign, two bulb phase groups, and the dancer's two pose groups. */
interface DurandsBuilding {
  readonly parts: StructurePart[];
  readonly signMaterial: MeshLambertMaterial;
  readonly marqueePhaseAMaterial: MeshLambertMaterial;
  readonly marqueePhaseBMaterial: MeshLambertMaterial;
  readonly dancerPoseAMaterial: MeshLambertMaterial;
  readonly dancerPoseBMaterial: MeshLambertMaterial;
}

/**
 * Builds Durand's part list: a two-storey false-front saloon — ground floor
 * behind a covered boardwalk, a jettied second storey, a false front
 * carrying the sign and marquee, and a rooftop dancer sign. Same
 * (geometry, material, local transforms) shape every tier keeps — Durand's
 * is a special case only to this function, not the instancer below.
 *
 * FOOTPRINT (composition pass). Every horizontal extent is measured against
 * STRUCTURE_FOOTPRINT_RADIUS like the six tiers. Durand's used to reach 0.6
 * units in +Z (porch hanging a third of a cell past its ground) — the one
 * variant that could still straddle a terrace step after the tiers were
 * bounded. Body and porch now share the cell: back wall and porch posts
 * both stand at the bound. Height is NOT bounded — a sign is meant to be
 * seen over roofs, and height can't hang over a cliff.
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

  // Boardwalk: the plank deck the porch stands on — gives the building a
  // base plane, keeping the ground floor from reading as a box in the snow.
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

  // Jettied (overhanging) second storey — wider than the floor beneath it, not merely stacked on top.
  const secondDepth = bodyDepth + 0.04;
  const secondCenterZ = bodyCenterZ + 0.02;
  const secondFrontZ = secondCenterZ + secondDepth / 2;
  const secondFloor: StructurePart = {
    geometry: new BoxGeometry(jettyHalfWidth * 2, secondFloorHeight, secondDepth),
    material: lambert(0x8f3325),
    localMatrices: [at(0, groundFloorHeight + secondFloorHeight / 2, secondCenterZ)],
  };

  // False front: a flat parapet proud of the roofline, flush with the second
  // storey's front — the silhouette that makes a saloon read as a saloon.
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
  // building read as open-topped from above. A frontier building's flat
  // roof hides behind the parapet; a thin inset slab reads as exactly that.
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
  // porch (new in the composition pass — the porch roof left the ground
  // floor a shadowed void without them).
  //
  // REAR AND SIDE OPENINGS: the same part now carries two rear upstairs
  // windows and one per jetty side — an orbited building showing a blank
  // face reads as unfinished. Side windows are the same box yawed a quarter turn.
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

  // Back door: plain, unlit, off-centre — a service entrance, one more thing keeping the rear face from reading blank.
  const backDoorHeight = 0.3;
  const backDoor: StructurePart = {
    geometry: new BoxGeometry(0.13, backDoorHeight, 0.02),
    material: lambert(0x3a1410),
    localMatrices: [at(0.15, backDoorHeight / 2, rearWindowZ)],
  };

  // Saloon doors: a pair of half-height café doors, hung clear of the
  // floor — the entrance detail that makes this specifically a SALOON.
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

  // The name sign: mounted proud of the false front so it never z-fights, on the front's centreline.
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

  // Marquee bulbs: a closed ring walking the sign board's border
  // (rectangleBorderPoints), split into two phase groups by alternating
  // index. The border is the sign's half-extents plus a fixed margin, so
  // the frame always sits just outside the board rather than drifting from
  // a second set of hand-tuned coordinates.
  const marqueeHalfWidth = signHalfWidth + DURANDS_MARQUEE_BULB_MARGIN;
  const marqueeHalfHeight = signHalfHeight + DURANDS_MARQUEE_BULB_MARGIN;
  const marqueePerimeter = 2 * (marqueeHalfWidth + marqueeHalfHeight) * 2;
  const marqueeBulbCount = Math.round(marqueePerimeter / DURANDS_MARQUEE_BULB_TARGET_SPACING);
  const marqueeBulbZ = signZ + signThickness / 2 + DURANDS_MARQUEE_BULB_GAP;
  const marqueeBorder = rectangleBorderPoints(marqueeBulbCount, marqueeHalfWidth, marqueeHalfHeight);

  // One geometry, shared by both phase groups — they differ only in which
  // border positions and material they carry, like a gable's two roof panels.
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
  // A dark cabinet on two legs above the false front: gold neon border,
  // steadily-lit pole and body, and the alternating limb sets. Standing it
  // here (not tucked under the porch, where it began) is what gives the
  // figure room to be sign-sized, with nothing overlapping it from any orbit angle.
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

  // The figure's origin on the board: the centre of its feet. Every drawing
  // point above is relative to it.
  const dancerFigureBaseY = dancerBoardBottomY + 0.05;
  const dancerZ = dancerBoardZ + dancerBoardThickness / 2 + DURANDS_DANCER_TUBE_RADIUS;

  // The gold border: four tubes just inside the board's edge, steady, the marquee's colour family.
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

  // The pole: one steadily-lit tube the board's full height. Never blinks —
  // it's the stage, not the performer; a chase taking it would read as vanishing, not moving.
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

  // Materials: the BODY holds steady; only the LIMB sets ride the phase clock (animate() swaps dancerPoseAMaterial/dancerPoseBMaterial).
  const dancerBodyMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_NEON_COLOR,
    emissiveIntensity: DURANDS_DANCER_BODY_EMISSIVE_INTENSITY,
  });
  // TRANSPARENT + depthWrite off: animate() drives opacity with emissive so
  // the off frame's limbs are truly absent; a faded limb must not write
  // depth or it punches invisible holes in lit limbs crossing behind it.
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
  // The steady circles ride with the body: head, and bust nested at the front outline's apex.
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
   * The CELL this structure stands on — the input every per-building
   * COSMETIC ROLL hashes (Durand's skin, the fishing-hut variant).
   *
   * Carried separately from x/z: those are WORLD units, and since the
   * 2026-08-21 quarter-cell re-sample a coordinate is `cell × 0.25`, so
   * hashing it truncates four cells onto one hash — a real defect
   * (isDurandsCell was being fed world x/z), since the rolls are
   * integer-domain functions needing the integer domain.
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
 * tier materials stay SHARED while every instance still declares its
 * people. Three multiplies instance colour into material colour, so both
 * sit near white: distinguishable at gameplay zoom, close enough that a
 * watchtower still reads as stone.
 *
 *   * RUDYS (dog people) — warm hearth cast, sunned timber and tan hides;
 *   * UNOS (cat people) — cool moonlit cast, slate and cream.
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
 * Marks the LIVE PREFIX of an instance attribute for upload, nothing beyond
 * it — the replacement for a bare `needsUpdate = true` (GH #263).
 *
 * WHY A BARE FLAG WAS EXPENSIVE. three's `WebGLAttributes.updateBuffer`
 * takes its "whole array" branch whenever `updateRanges` is empty and never
 * looks at `mesh.count` — so these meshes re-uploaded their whole capacity
 * on every founding or felling: 36 meshes, 102,400 slots, 6.55 MB plus up to
 * 1.23 MB of colour, for a delta that may hold one cell. Same fix as the
 * flora rigs and this plugin's own skiffModels.ts.
 *
 * CLEARED BEFORE THE RANGE IS ADDED (skiffModels.ts's reason): three only
 * clears ranges when it actually uploads, so a culled pass would otherwise
 * leave its range for this one to accumulate onto.
 *
 * AN EMPTY MESH IS LEFT ALONE ENTIRELY: nothing draws at `count === 0`, and
 * clearing ranges on an attribute ahead of the uploaded buffer is exactly
 * how a later render falls back to the whole-array branch.
 *
 * NOT ATTEMPTED: skipping upload for unchanged mesh contents. That needs a
 * shadow copy of every matrix — more memory than the buffer itself — so a
 * full apply() pass always re-uploads its live prefix.
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

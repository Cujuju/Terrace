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
// The rules those plugins' models.ts files keep, kept here too: no textures,
// no per-object lights, no external assets, everything generated in this
// file, flat shading so a low-segment primitive reads as a deliberate
// faceted style rather than as low detail.
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

import {
  BoxGeometry,
  CanvasTexture,
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
  type Material,
} from 'three';
import { STRUCTURES_CAP, STRUCTURE_TIER_COUNT, type StructureTier } from '../protocol.ts';
import { isDurandsCell } from './durands.ts';

// ── Shared build helpers ─────────────────────────────────────────────────────

const Z_AXIS = new Vector3(0, 0, 1);
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

function lambert(color: number, options: { emissive?: number } = {}): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true, emissive: options.emissive ?? 0x000000 });
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

/**
 * The two local transforms for a symmetric gable roof panel: the SAME
 * geometry (a thin box whose local +X axis is its slope) placed once tilted
 * up-and-out to the right of the ridge and once to the left. Each side is
 * computed independently from its own (dx, dy) = (±halfSpan, -ridgeRise)
 * direction rather than derived from the other by a mirror formula — half
 * the arithmetic, and a bug in one side cannot silently be "the same bug,
 * mirrored" in the other.
 *
 * `halfSpan` is measured to the EAVE (wall half-width plus overhang), so the
 * panel's outer edge overhangs the wall exactly as far as a real eave would.
 */
function gableRoofPanelMatrices(halfSpan: number, ridgeRise: number, wallTopY: number): Matrix4[] {
  const matrices: Matrix4[] = [];
  for (const sign of [1, -1] as const) {
    const angle = Math.atan2(-ridgeRise, sign * halfSpan);
    const position = new Vector3((sign * halfSpan) / 2, wallTopY + ridgeRise / 2, 0);
    const rotation = new Quaternion().setFromAxisAngle(Z_AXIS, angle);
    matrices.push(new Matrix4().compose(position, rotation, new Vector3(1, 1, 1)));
  }
  return matrices;
}

/** Slope length of a gable roof panel — the box geometry's own length (local X). */
function gableSlopeLength(halfSpan: number, ridgeRise: number): number {
  return Math.hypot(halfSpan, ridgeRise);
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
 * A grid of small, slightly proud stone blocks tiling one FLAT rectangular
 * wall face — the stone-cottage's four walls. `faceHalfWidth` is the face's
 * own half-span along whichever axis it runs; `fixedAxis`/`fixedValue` place
 * the face's plane (the wall's `x = ±wallHalfWidth` faces use fixedAxis 'x',
 * its `z = ±wallDepth/2` faces use 'z'). Column count is the closest whole
 * divisor of the face's width to `STONE_BLOCK_TARGET_WIDTH` — the same
 * "target spacing, actual count is the nearest divisor" trick
 * DURANDS_MARQUEE_BULB_TARGET_SPACING already uses for the marquee bulb
 * ring — so blocks tile edge-to-edge with no fractional remainder, whatever
 * the face's own width happens to be. Alternate courses shift by a half
 * block-slot (a running-bond stagger, one interior column short of the full
 * row) for the "staggered joints" look coursed masonry has; any resulting
 * edge irregularity is exactly where the tier's own quoins already stand
 * proud of the corner, so the two details cover for each other rather than
 * fighting for the same pixels.
 */
function stoneBlocksForFace(
  faceHalfWidth: number,
  wallHeight: number,
  courseCount: number,
  fixedAxis: 'x' | 'z',
  fixedValue: number,
  targetBlockWidth: number,
  blockGapFraction: number,
): { blocks: StoneBlock[]; blockWidth: number; blockHeight: number } {
  const faceWidth = faceHalfWidth * 2;
  const columnCount = Math.max(2, Math.round(faceWidth / targetBlockWidth));
  const slotWidth = faceWidth / columnCount;
  const blockWidth = slotWidth * blockGapFraction;
  const rowHeight = wallHeight / courseCount;
  const blockHeight = rowHeight * blockGapFraction;
  // Rotate the block geometry (authored flat against a 'z'-normal face, its
  // own local X spanning the face's width) a quarter turn for an 'x'-normal
  // face, so its width axis becomes Z instead of X.
  const rotation = new Quaternion().setFromAxisAngle(Y_AXIS, fixedAxis === 'x' ? Math.PI / 2 : 0);

  const blocks: StoneBlock[] = [];
  for (let course = 0; course < courseCount; course++) {
    const staggered = course % 2 === 1;
    const columnsThisCourse = staggered ? columnCount - 1 : columnCount;
    const rowStartOffset = staggered ? slotWidth : slotWidth / 2;
    const y = rowHeight * (course + 0.5);
    for (let column = 0; column < columnsThisCourse; column++) {
      const across = -faceHalfWidth + rowStartOffset + slotWidth * column;
      const position =
        fixedAxis === 'z' ? new Vector3(across, y, fixedValue) : new Vector3(fixedValue, y, across);
      blocks.push({
        matrix: new Matrix4().compose(position, rotation, new Vector3(1, 1, 1)),
        shadeIndex: (course + column) % STONE_SHADE_COLORS.length,
      });
    }
  }
  return { blocks, blockWidth, blockHeight };
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

// ── One building tier: a fixed list of (geometry, material, local transforms) ─

interface StructurePart {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** One matrix per instance this part contributes, per building of this tier. */
  readonly localMatrices: Matrix4[];
}

function buildTierParts(): StructurePart[][] {
  const tiers: StructurePart[][] = [];

  // ── Tier 0: camp — a teepee: a conical hide tent beside a campfire's ember
  // glow. The shortest, roundest-toned silhouette in the progression: nothing
  // here stands taller than half a cell.
  //
  // REMODEL (owner: "make it read as a teepee") — the cone primitive was
  // already there; what was missing was everything that actually reads as
  // "teepee" rather than "cone": an 8-sided (round, not 4-sided/pyramidal)
  // profile, crossed lodge-poles poking out the smoke hole at the top, and a
  // dark triangular door opening at the base. The old 45°-yaw on the tent
  // existed only to align a flat face of the 4-sided cone forward; an 8-sided
  // cone has no single "flat face" worth aligning, so that yaw is dropped —
  // the tent now sits at yaw 0, which is also what makes the door's own
  // placement math below (computed on the +Z meridian) line up with what the
  // tent geometry actually shows there.
  {
    const TENT_RADIUS = 0.42;
    const tentHeight = 0.55;
    const tentX = -0.16; // off-centre so the hearth cluster below has room on the tent's +X side
    const tent: StructurePart = {
      geometry: new ConeGeometry(TENT_RADIUS, tentHeight, 8),
      material: lambert(0xcbb994),
      localMatrices: [at(tentX, tentHeight / 2, 0)],
    };

    // Dark triangular door opening, set into the tent's own +Z meridian near
    // its base. Built from a 3-radial-segment ConeGeometry laid on its side:
    // with radialSegments = 3, a cone's "circle" cross-section IS a
    // triangle (vertices at 0°, 120°, 240°), and rotating the whole cone -90°
    // about X swaps its axis (originally the height axis, Y) for Z, so the
    // triangular cross-section — which used to be perpendicular to the
    // ground — now lies flat, facing +Z, with `TEEPEE_DOOR_DEPTH` as its
    // (barely-there) protruding apex. One geometry, no new primitive kind.
    const TEEPEE_DOOR_RADIUS = 0.11; // the door "triangle's" half-span, expressed as the underlying cone's own radius param
    const TEEPEE_DOOR_DEPTH = 0.02; // just enough extrusion for flat shading to read this as a face, not a zero-thickness plane
    const TEEPEE_DOOR_PROUD_MARGIN = 0.02; // clears the tent's own sloped surface — see doorZ below
    // The -90°-about-X rotation puts the triangle's two base corners at
    // local y = -0.5 * radius and its apex at local y = +radius (derived,
    // not eyeballed, from CylinderGeometry's own vertex layout: the
    // radialSegments = 3 base circle's first vertex sits at (x=0, z=radius)
    // before the rotation, which maps to (y=+radius) after it). Translating
    // up by 0.5 * radius puts the two base corners on the ground.
    const teepeeDoorBottomY = TEEPEE_DOOR_RADIUS * 0.5;
    const teepeeDoorTopY = teepeeDoorBottomY + TEEPEE_DOOR_RADIUS;
    // The tent is a CONE, not a cylinder: its radius shrinks with height, so
    // a flat door needs its z-offset sized to the SMALLEST radius it spans
    // (its own top) or its lower half would clip inside the sloped hide.
    // That leaves a small gap between the door's bottom edge and the tent's
    // surface, which at this scale reads as shadow, not as a visible seam —
    // the safe direction to be wrong in is "floating slightly proud",
    // never "buried in the wall".
    const teepeeDoorTopRadius = TENT_RADIUS * (1 - teepeeDoorTopY / tentHeight);
    const doorZ = teepeeDoorTopRadius + TEEPEE_DOOR_PROUD_MARGIN;
    const teepeeDoor: StructurePart = {
      geometry: new ConeGeometry(TEEPEE_DOOR_RADIUS, TEEPEE_DOOR_DEPTH, 3),
      material: lambert(0x241708),
      localMatrices: [
        new Matrix4().compose(
          new Vector3(tentX, teepeeDoorBottomY, doorZ),
          new Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2),
          new Vector3(1, 1, 1),
        ),
      ],
    };

    // Crossed lodge-poles: two poles standing in for the ends a real
    // teepee's lodge-pole frame pokes out through the smoke hole, crossing
    // near the tent's own apex and past it on both sides — the single
    // clearest "teepee, not just a cone" cue a smooth cone alone cannot
    // give. Each pole's two endpoints are computed independently (see
    // segmentMatrix above) rather than one mirrored off the other, the same
    // reasoning gableRoofPanelMatrices gives for its own two independently-
    // placed panels: a bug in one is not silently "the same bug, mirrored"
    // in the other.
    const TEEPEE_POLE_RADIUS = 0.012;
    const TEEPEE_POLE_UNIT_LENGTH = 0.1;
    const TEEPEE_POLE_ABOVE_APEX = 0.16; // how far each pole pokes out past the tent's own roofline
    const lodgepoles: StructurePart = {
      geometry: new CylinderGeometry(TEEPEE_POLE_RADIUS, TEEPEE_POLE_RADIUS, TEEPEE_POLE_UNIT_LENGTH, 5),
      material: lambert(0x4a3420),
      localMatrices: [
        segmentMatrix(
          new Vector3(tentX + 0.22, tentHeight * 0.55, 0.16),
          new Vector3(tentX - 0.16, tentHeight + TEEPEE_POLE_ABOVE_APEX, -0.12),
          TEEPEE_POLE_UNIT_LENGTH,
        ),
        segmentMatrix(
          new Vector3(tentX - 0.22, tentHeight * 0.55, 0.13),
          new Vector3(tentX + 0.17, tentHeight + TEEPEE_POLE_ABOVE_APEX, -0.14),
          TEEPEE_POLE_UNIT_LENGTH,
        ),
      ],
    };
    const fireHeight = 0.16;
    const fire: StructurePart = {
      geometry: new ConeGeometry(0.08, fireHeight, 6),
      material: lambert(0x3a2010, { emissive: 0xd9540f }),
      localMatrices: [at(0.28, fireHeight / 2, 0.1)],
    };

    // Firepit ring: small stones circling the fire — the same fixed-ring
    // trick the watchtower's crenellations use below, at camp scale. Centred
    // on the fire's own (x, z) offset, not the building origin, since the
    // fire itself is off-centre from the tent.
    const FIREPIT_STONE_COUNT = 5;
    const FIREPIT_STONE_RADIUS = 0.12;
    const stoneHeight = 0.05;
    const firepitStones: StructurePart = {
      geometry: new CylinderGeometry(0.035, 0.04, stoneHeight, 5),
      material: lambert(0x8a8478),
      localMatrices: circleRingMatrices(FIREPIT_STONE_COUNT, FIREPIT_STONE_RADIUS, stoneHeight / 2, false).map(
        (ring) => ring.premultiply(at(0.28, 0, 0.1)),
      ),
    };

    // A small woodpile beside the hearth — three split logs, laid on their
    // sides, stacked two-and-one. Reads as "primitive camp" the way a
    // firepit alone does not: there is fuel here, not just a fire. Clustered
    // on the SAME side as the fire and its stone ring (the tent's own
    // footprint is the widest thing at this tier — see the tent's own
    // rotated-cone shape above — so anything placed on its far side reads as
    // hidden behind it from the standard preview camera angle; the hearth
    // side stays clear of the tent's silhouette from every angle that matters).
    const logRadius = 0.03;
    const logLength = 0.22;
    const logRotation = new Quaternion().setFromAxisAngle(Z_AXIS, Math.PI / 2);
    const woodpile: StructurePart = {
      geometry: new CylinderGeometry(logRadius, logRadius, logLength, 5),
      material: lambert(0x5a3d22),
      localMatrices: [
        new Matrix4().compose(new Vector3(0.48, logRadius, 0.02), logRotation, new Vector3(1, 1, 1)),
        new Matrix4().compose(new Vector3(0.48, logRadius * 3, 0.02), logRotation, new Vector3(1, 1, 1)),
        new Matrix4().compose(new Vector3(0.46, logRadius * 5, 0.08), logRotation, new Vector3(1, 1, 1)),
      ],
    };

    tiers.push([tent, fire, firepitStones, woodpile, teepeeDoor, lodgepoles]);
  }

  // ── Tier 1: hut (the settler hut) — a round wattle-and-daub wall under a
  // conical THATCH roof. First solid drum shape; still no hard edges
  // anywhere on it.
  //
  // REMODEL (owner: "the roof must read as STRAW/THATCH... texture the
  // silhouette") — two changes, both from the brief's own examples: (1) a
  // warm straw palette on the roof, distinct from the old roof colour, and
  // (2) the roof built as TWO stacked, slightly offset cones (a wide, short
  // "skirt" layer under a narrower, taller cap) rather than one clean cone —
  // the "two or three stacked, slightly offset roof slabs" reading — plus a
  // fringe ring of small angled boxes at the eave in place of the old smooth
  // disc, so the eave's own edge is ragged rather than a lathe-turned rim.
  {
    const wallHeight = 0.5;
    const wall: StructurePart = {
      geometry: new CylinderGeometry(0.42, 0.44, wallHeight, 8),
      material: lambert(0x9c7a52),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };

    // Straw palette: the skirt (lower, wider layer) a shade darker than the
    // cap (upper, narrower layer) so the seam between them reads as a
    // texture break even under flat shading, not just a silhouette step.
    const THATCH_CAP_COLOR = 0xdcb95a;
    const THATCH_SKIRT_COLOR = 0xc3a047;

    // Skirt: the wider, shorter lower roof layer — "oversized" relative to
    // the wall it sits on, per the brief, and wider than the cap above it so
    // its own edge is what the fringe ring (below) sits on.
    const skirtHeight = 0.16;
    const skirtRadius = 0.62;
    const roofSkirt: StructurePart = {
      geometry: new ConeGeometry(skirtRadius, skirtHeight, 8),
      material: lambert(THATCH_SKIRT_COLOR),
      localMatrices: [at(0, wallHeight + skirtHeight / 2, 0)],
    };

    // Cap: the narrower, taller upper roof layer, stacked directly on the
    // skirt's own apex — the second of the "two or three stacked, slightly
    // offset slabs" the brief asks for.
    const capHeight = 0.4;
    const capRadius = 0.5;
    const roofCap: StructurePart = {
      geometry: new ConeGeometry(capRadius, capHeight, 8),
      material: lambert(THATCH_CAP_COLOR),
      localMatrices: [at(0, wallHeight + skirtHeight + capHeight / 2, 0)],
    };

    // Door: a dark plank set into the drum's +Z face, low and narrow — a
    // wattle-and-daub hut's doorway, not a house's.
    const doorHeight = 0.3;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.16, doorHeight, 0.03),
      material: lambert(0x3a2416),
      // z = 0.45: a hair proud of the drum's own radius (0.42-0.44, tapered)
      // at every height the door spans, so the plank reads as mounted on the
      // wall rather than partly swallowed by it.
      localMatrices: [at(0, doorHeight / 2, 0.45)],
    };

    // Thatch fringe: a ring of small boxes standing in for straw bundles
    // hanging past the skirt's own eave — replaces the old single smooth
    // disc (a lathe-turned rim reads as timber, not straw) with many small
    // faceted blocks, each tilted slightly outward-and-down, so the eave's
    // own silhouette is ragged rather than a clean circle. Count is the
    // closest whole divisor of the skirt's own circumference to the target
    // spacing below — the same "target spacing, nearest divisor" trick
    // DURANDS_MARQUEE_BULB_TARGET_SPACING already uses for the marquee bulb
    // ring, reused here for the same reason: an even ring with no leftover
    // gap, whatever the skirt's own radius happens to be.
    const FRINGE_TARGET_SPACING = 0.1;
    const fringeCount = Math.round((FULL_TURN_RADIANS * skirtRadius) / FRINGE_TARGET_SPACING);
    const fringeTiltRadians = Math.PI / 7; // hangs the bundle's outer end down past the eave line, rather than standing it straight out
    const fringeGeometry = new BoxGeometry(0.05, 0.1, 0.02);
    const fringe: StructurePart = {
      geometry: fringeGeometry,
      material: lambert(0xb8944a),
      localMatrices: circleRingMatrices(fringeCount, skirtRadius, wallHeight, true).map((ring) =>
        ring.multiply(new Matrix4().makeRotationX(fringeTiltRadians)),
      ),
    };

    // Smoke vent: a dark cap at the roof's own apex, standing in for a
    // chimney a hut this primitive would not have — a hole in the thatch,
    // not a masonry stack.
    const smokeVentHeight = 0.05;
    const smokeVent: StructurePart = {
      geometry: new CylinderGeometry(0.05, 0.05, smokeVentHeight, 6),
      material: lambert(0x2a1c10),
      localMatrices: [at(0, wallHeight + skirtHeight + capHeight - smokeVentHeight / 2, 0)],
    };

    tiers.push([wall, roofSkirt, roofCap, door, fringe, smokeVent]);
  }

  // ── Tier 2: timber-house — walls built of stacked LOG COURSES under a
  // peaked (gable) roof: the first tier with hard edges anywhere on it.
  //
  // REMODEL (owner: "walls made of LOGS — replace flat walls with stacked
  // horizontal log courses"). All four walls become one `logCourses` part:
  // one unit-length cylinder geometry, stretched and placed per course via
  // segmentMatrix (see the Remodel-pass helpers above) — the same
  // instancing shape every other multi-instance part in this file already
  // has, just with segmentMatrix doing the per-course placement work
  // gableRoofPanelMatrices does for roof panels. Every course on every wall
  // OVERHANGS its own corner by LOG_END_OVERHANG, so the cylinder's own flat
  // end-cap (CylinderGeometry is capped by default) is what shows as the
  // "log-end caps visible on the front corners" the brief asks for — no
  // separate cap part needed, the overhanging log ends already have caps by
  // construction. The old square corner battens (timberPosts) are dropped:
  // they stood in for half-timbered post-and-beam framing, which is a
  // different wall technique than a log-cabin's rounded, interlocking
  // corners — keeping both would put a square post through the same corner
  // the round log ends now occupy.
  {
    const wallHeight = 0.55;
    const wallHalfWidth = 0.45;
    const wallDepth = 0.7;

    const LOG_COURSE_COUNT = 5; // within the brief's "4-6 courses"
    const logDiameter = wallHeight / LOG_COURSE_COUNT;
    const logRadius = logDiameter / 2;
    const LOG_END_OVERHANG = 0.05; // how far each course pokes out past the corner it meets — see the tier's own banner comment
    const LOG_UNIT_LENGTH = 0.1;
    const logGeometry = new CylinderGeometry(logRadius, logRadius, LOG_UNIT_LENGTH, 8);

    const logMatrices: Matrix4[] = [];
    for (let course = 0; course < LOG_COURSE_COUNT; course++) {
      const y = logRadius + course * logDiameter;
      const frontZ = wallDepth / 2;
      const backZ = -wallDepth / 2;
      const rightX = wallHalfWidth;
      const leftX = -wallHalfWidth;
      // Front and back walls run along X; left and right walls run along Z.
      // Every course overhangs both its own ends by LOG_END_OVERHANG, which
      // is what makes the perpendicular wall's log ends poke past this
      // wall's own face at every corner (and vice versa) — the interlocking
      // corner joint a real log cabin shows.
      logMatrices.push(
        segmentMatrix(
          new Vector3(-wallHalfWidth - LOG_END_OVERHANG, y, frontZ),
          new Vector3(wallHalfWidth + LOG_END_OVERHANG, y, frontZ),
          LOG_UNIT_LENGTH,
        ),
        segmentMatrix(
          new Vector3(-wallHalfWidth - LOG_END_OVERHANG, y, backZ),
          new Vector3(wallHalfWidth + LOG_END_OVERHANG, y, backZ),
          LOG_UNIT_LENGTH,
        ),
        segmentMatrix(
          new Vector3(leftX, y, -wallDepth / 2 - LOG_END_OVERHANG),
          new Vector3(leftX, y, wallDepth / 2 + LOG_END_OVERHANG),
          LOG_UNIT_LENGTH,
        ),
        segmentMatrix(
          new Vector3(rightX, y, -wallDepth / 2 - LOG_END_OVERHANG),
          new Vector3(rightX, y, wallDepth / 2 + LOG_END_OVERHANG),
          LOG_UNIT_LENGTH,
        ),
      );
    }
    const logCourses: StructurePart = {
      geometry: logGeometry,
      material: lambert(0x7a5232),
      localMatrices: logMatrices,
    };

    const ridgeRise = 0.35;
    const eave = 0.08;
    const halfSpan = wallHalfWidth + eave;
    const roof: StructurePart = {
      geometry: new BoxGeometry(gableSlopeLength(halfSpan, ridgeRise), 0.05, wallDepth + eave * 2),
      material: lambert(0x8a3a2e),
      localMatrices: gableRoofPanelMatrices(halfSpan, ridgeRise, wallHeight),
    };

    // Door, centred on the +Z wall face (see the shared "+Z is the front"
    // convention above every box-walled tier follows). z is now set past the
    // logs' own overhanging radius, not a flat box face.
    const doorZ = wallDepth / 2 + logRadius + 0.02;
    const doorHeight = 0.34;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.16, doorHeight, 0.03),
      material: lambert(0x2e1c10),
      localMatrices: [at(0, doorHeight / 2, doorZ)],
    };

    // Windows, one either side of the door — first tier with actual glass to
    // light. Static warm glow (see windowMaterial's own comment).
    const windows: StructurePart = {
      geometry: new BoxGeometry(0.1, 0.12, 0.02),
      material: windowMaterial(),
      localMatrices: [at(0.22, 0.32, doorZ), at(-0.22, 0.32, doorZ)],
    };

    // Ridge cap: a thin cap tile over the seam where the two roof panels
    // meet — closes the gap gableRoofPanelMatrices' two independently-placed
    // panels leave at the very ridge line.
    const ridgeCapThickness = 0.05;
    const ridgeCap: StructurePart = {
      geometry: new BoxGeometry(0.07, ridgeCapThickness, wallDepth + eave * 2),
      material: lambert(0x5a2820),
      localMatrices: [at(0, wallHeight + ridgeRise - ridgeCapThickness / 2, 0)],
    };

    tiers.push([logCourses, roof, door, windows, ridgeCap]);
  }

  // ── Tier 3: longhouse — longer and lower than the timber house (a
  // workshop's footprint, not its height), with a smoking chimney: the
  // widest silhouette in the whole progression.
  //
  // REMODEL (owner: "physically LONGER — it should read as the settlement's
  // big hall"). wallHalfWidth was already this file's own name for the
  // tier's defining measure (the file banner calls this tier out as the
  // "widest footprint" in the whole progression), so it is the axis this
  // pass stretches: 0.68 → 1.05, roughly half again as wide, keeping
  // wallDepth fixed so the building reads as ELONGATED rather than merely
  // bigger. Everything downstream of wallHalfWidth (the roof span, the
  // chimney's own x offset) is already expressed as a function of it, so it
  // rescales for free.
  {
    const wallHeight = 0.48;
    const wallHalfWidth = 1.05;
    const wallDepth = 0.6;
    const wall: StructurePart = {
      geometry: new BoxGeometry(wallHalfWidth * 2, wallHeight, wallDepth),
      material: lambert(0x5a4028),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };
    const ridgeRise = 0.28;
    const eave = 0.1;
    const halfSpan = wallHalfWidth + eave;
    const roof: StructurePart = {
      geometry: new BoxGeometry(gableSlopeLength(halfSpan, ridgeRise), 0.05, wallDepth + eave * 2),
      material: lambert(0x746558),
      localMatrices: gableRoofPanelMatrices(halfSpan, ridgeRise, wallHeight),
    };
    const chimneyHeight = 0.3;
    const chimneyY = wallHeight + ridgeRise * 0.5 + chimneyHeight / 2;
    const chimneyX = wallHalfWidth * 0.55;
    const chimney: StructurePart = {
      geometry: new BoxGeometry(0.1, chimneyHeight, 0.1),
      material: lambert(0x8b8b86),
      localMatrices: [at(chimneyX, chimneyY, 0)],
    };

    // Chimney pot: a flared cap on top of the chimney stack — the smoking
    // chimney the tier's own doc comment promises gets something for the
    // smoke to actually rise out of.
    const potHeight = 0.08;
    const chimneyPot: StructurePart = {
      geometry: new CylinderGeometry(0.06, 0.045, potHeight, 6),
      material: lambert(0x5a4a3a),
      localMatrices: [at(chimneyX, chimneyY + chimneyHeight / 2 + potHeight / 2, 0)],
    };

    // Door, centred on the +Z wall face.
    const doorHeight = 0.3;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.16, doorHeight, 0.03),
      material: lambert(0x2a1a10),
      localMatrices: [at(0, doorHeight / 2, wallDepth / 2 + 0.01)],
    };

    // Windows flanking the door — the longhouse's wide face has room for two
    // without crowding the entrance.
    const windows: StructurePart = {
      geometry: new BoxGeometry(0.12, 0.13, 0.02),
      material: windowMaterial(),
      localMatrices: [
        at(0.28, 0.28, wallDepth / 2 + 0.01),
        at(-0.28, 0.28, wallDepth / 2 + 0.01),
      ],
    };

    // REMODEL (owner: porch posts "look wrong" — remove or relocate to
    // flank the gable-end door): the door already sits at the gable end (the
    // roof ridge above runs along Z per gableRoofPanelMatrices, so the
    // triangular gable faces are the ±Z walls — the same wall the door is
    // already on), so "relocate to flank the door" would land the posts
    // right back where they used to be. The actual defect is that these
    // posts stood free with no porch roof over them (unlike Durand's own
    // porchPosts, which carry an actual porchRoof slab) — two bare cylinders
    // beside a door read as an unfinished detail, not a porch. Removing them
    // is the direct fix; building a real porch (a header beam and roof slab)
    // is new scope this note did not ask for, so it is a deliberate cut, not
    // an oversight.

    tiers.push([wall, roof, chimney, chimneyPot, door, windows]);
  }

  // ── Tier 4: stone-cottage — a STONE wall (first material break in the
  // progression) under a clay-tile roof, with a round chimney: semi-advanced
  // masonry, still a house.
  {
    const wallHeight = 0.6;
    const wallHalfWidth = 0.5;
    const wallDepth = 0.75;
    // How far the stone-block veneer (below) stands proud of the flat wall
    // beneath it. Declared up here, ahead of the veneer itself, because the
    // door and windows need it too: they must clear the veneer's own outer
    // face, not just the bare wall, or they end up interpenetrating whatever
    // stone blocks the grid places over their opening.
    const STONE_BLOCK_DEPTH = 0.025;
    const wall: StructurePart = {
      geometry: new BoxGeometry(wallHalfWidth * 2, wallHeight, wallDepth),
      material: lambert(0x8b8b86),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };
    const ridgeRise = 0.4;
    const eave = 0.09;
    const halfSpan = wallHalfWidth + eave;
    const roof: StructurePart = {
      geometry: new BoxGeometry(gableSlopeLength(halfSpan, ridgeRise), 0.05, wallDepth + eave * 2),
      material: lambert(0xb5502e),
      localMatrices: gableRoofPanelMatrices(halfSpan, ridgeRise, wallHeight),
    };
    const chimneyHeight = 0.4;
    const chimneyY = wallHeight + ridgeRise * 0.5 + chimneyHeight / 2;
    const chimneyX = wallHalfWidth * 0.5;
    const chimney: StructurePart = {
      geometry: new CylinderGeometry(0.07, 0.09, chimneyHeight, 6),
      material: lambert(0x77726c),
      localMatrices: [at(chimneyX, chimneyY, 0)],
    };

    // Chimney pot, same idea as the longhouse's own (above) — masonry-tier
    // materials for this one, matching the chimney's own stone-grey.
    const potHeight = 0.09;
    const chimneyPot: StructurePart = {
      geometry: new CylinderGeometry(0.05, 0.04, potHeight, 6),
      material: lambert(0x5a5650),
      localMatrices: [at(chimneyX, chimneyY + chimneyHeight / 2 + potHeight / 2, 0)],
    };

    // Door, centred on the +Z wall face. z clears the stone veneer's own
    // outer face (STONE_BLOCK_DEPTH, declared above) plus the usual small
    // proud gap, not just the bare wall beneath it.
    const doorHeight = 0.36;
    const cottageOpeningZ = wallDepth / 2 + STONE_BLOCK_DEPTH + 0.01;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.16, doorHeight, 0.03),
      material: lambert(0x3a2416),
      localMatrices: [at(0, doorHeight / 2, cottageOpeningZ)],
    };

    // Windows flanking the door, same z as the door for the same reason.
    const windows: StructurePart = {
      geometry: new BoxGeometry(0.11, 0.13, 0.02),
      material: windowMaterial(),
      localMatrices: [at(0.26, 0.34, cottageOpeningZ), at(-0.26, 0.34, cottageOpeningZ)],
    };

    // Stone quoins: the tier's own doc comment calls out "the first material
    // break" — quoins are the classic masonry tell that goes with it, stone
    // blocks stacked proud at every vertical corner. Three courses per
    // corner, four corners: twelve fixed blocks, the same "one fixed layout,
    // shared by every building of this tier" rule every ring above keeps.
    const quoinSize = 0.1;
    const quoinCourseYs = [wallHeight * 0.15, wallHeight * 0.5, wallHeight * 0.85];
    const quoinCornerXZ: ReadonlyArray<readonly [number, number]> = [
      [wallHalfWidth + quoinSize / 2 - 0.01, wallDepth / 2 + quoinSize / 2 - 0.01],
      [wallHalfWidth + quoinSize / 2 - 0.01, -(wallDepth / 2 + quoinSize / 2 - 0.01)],
      [-(wallHalfWidth + quoinSize / 2 - 0.01), wallDepth / 2 + quoinSize / 2 - 0.01],
      [-(wallHalfWidth + quoinSize / 2 - 0.01), -(wallDepth / 2 + quoinSize / 2 - 0.01)],
    ];
    const quoinMatrices: Matrix4[] = [];
    for (const [x, z] of quoinCornerXZ) {
      for (const y of quoinCourseYs) quoinMatrices.push(at(x, y, z));
    }
    const quoins: StructurePart = {
      geometry: new BoxGeometry(quoinSize, quoinSize, quoinSize),
      material: lambert(0x9c968c),
      localMatrices: quoinMatrices,
    };

    // REMODEL (owner: "walls must read as STONE — a grid of slightly proud
    // stone blocks in 2-3 shades"). One shared block geometry tiled across
    // all four wall faces via stoneBlocksForFace (see the Remodel-pass
    // helpers above), split into STONE_SHADE_COLORS.length StructureParts by
    // stonePartsByShade — the wall box itself stays as the solid substrate
    // underneath, so this is a veneer layer, not a wall replacement (unlike
    // the timber-house's log courses, which fully replace their wall: a
    // stone wall's coursing sits ON a solid wall, a log wall's courses ARE
    // the wall).
    const STONE_BLOCK_TARGET_WIDTH = 0.11;
    const STONE_COURSE_COUNT = 6;
    const STONE_BLOCK_FILL_FRACTION = 0.82; // fraction of each course/column slot a block actually fills — the rest reads as the mortar joint
    const stoneBlockGeometry = new BoxGeometry(1, 1, STONE_BLOCK_DEPTH); // unit width/height; each face scales its own blocks below
    const stoneBlocks: StoneBlock[] = [];
    for (const face of [
      { half: wallHalfWidth, axis: 'z' as const, value: wallDepth / 2 + STONE_BLOCK_DEPTH / 2 },
      { half: wallHalfWidth, axis: 'z' as const, value: -(wallDepth / 2 + STONE_BLOCK_DEPTH / 2) },
      { half: wallDepth / 2, axis: 'x' as const, value: wallHalfWidth + STONE_BLOCK_DEPTH / 2 },
      { half: wallDepth / 2, axis: 'x' as const, value: -(wallHalfWidth + STONE_BLOCK_DEPTH / 2) },
    ]) {
      const { blocks, blockWidth, blockHeight } = stoneBlocksForFace(
        face.half,
        wallHeight,
        STONE_COURSE_COUNT,
        face.axis,
        face.value,
        STONE_BLOCK_TARGET_WIDTH,
        STONE_BLOCK_FILL_FRACTION,
      );
      // stoneBlocksForFace's matrices carry each block's real position and
      // facing but assume a UNIT-sized geometry (see stoneBlockGeometry
      // above); scale each block by ITS OWN face's (width, height) here —
      // the front/back faces (wallHalfWidth-wide) and the left/right faces
      // (wallDepth-wide) tile to different column counts, so they land on
      // different block widths, and applying one global scale to every face
      // would size the narrower faces' blocks wrong.
      const faceScale = new Matrix4().makeScale(blockWidth, blockHeight, 1);
      for (const block of blocks) block.matrix.multiply(faceScale);
      stoneBlocks.push(...blocks);
    }
    const stoneWalls = stonePartsByShade(stoneBlocks, stoneBlockGeometry);

    tiers.push([wall, roof, chimney, chimneyPot, door, windows, quoins, ...stoneWalls]);
  }

  // ── Tier 5: watchtower — a tall narrow stone tower with a parapet ring and
  // a slate roof. The one VERTICAL silhouette in the set: taller than every
  // other tier is wide, where every house tier is wider than it is tall.
  {
    const towerHeight = 1.55;
    const towerRadius = 0.3;
    // How far the stone-block ring (below) stands proud of the tower's own
    // tapered surface, declared up here because the door needs to clear its
    // outer face too — see doorZ below and the ring's own comment further
    // down for why the ring itself is sized off the tower's WIDEST radius.
    const STONE_TOWER_BLOCK_DEPTH = 0.03;
    const tower: StructurePart = {
      geometry: new CylinderGeometry(towerRadius, towerRadius * 1.08, towerHeight, 8),
      material: lambert(0x8b8b86),
      localMatrices: [at(0, towerHeight / 2, 0)],
    };
    const parapetHeight = 0.16;
    const parapet: StructurePart = {
      geometry: new CylinderGeometry(towerRadius + 0.1, towerRadius + 0.1, parapetHeight, 10),
      material: lambert(0x6f6a63),
      localMatrices: [at(0, towerHeight + parapetHeight / 2, 0)],
    };
    const roofHeight = 0.45;
    const roof: StructurePart = {
      geometry: new ConeGeometry(towerRadius + 0.06, roofHeight, 8),
      material: lambert(0x3a4a52),
      localMatrices: [at(0, towerHeight + parapetHeight + roofHeight / 2, 0)],
    };

    // Door at the tower's base, on the +Z face of the drum — the one tier
    // whose wall is round rather than boxed, so the door sits directly on
    // the tower's own radius instead of a flat wall face. z clears the
    // stone ring's own outer face (STONE_TOWER_BLOCK_DEPTH, declared above),
    // not just the bare tapered wall beneath it, for the same reason the
    // stone-cottage's door was moved off the bare wall face above.
    const doorHeight = 0.3;
    const towerDoorZ = towerRadius * 1.08 + STONE_TOWER_BLOCK_DEPTH + 0.01;
    const door: StructurePart = {
      geometry: new BoxGeometry(0.14, doorHeight, 0.04),
      material: lambert(0x2a2018),
      localMatrices: [at(0, doorHeight / 2, towerDoorZ)],
    };

    // Arrow slits: tall thin glows up the shaft, evenly ringed rather than
    // all facing one way — a watchtower is meant to see (and be seen
    // watching) in every direction. Reuses the window glow so "there is a
    // light behind this opening" reads the same cue at every tier tall
    // enough to have upper floors.
    const ARROW_SLIT_COUNT = 3;
    const arrowSlits: StructurePart = {
      geometry: new BoxGeometry(0.03, 0.18, 0.02),
      material: windowMaterial(),
      localMatrices: circleRingMatrices(ARROW_SLIT_COUNT, towerRadius * 0.98, towerHeight * 0.6, true),
    };

    // Crenellations: merlon blocks standing proud of the parapet ring — the
    // tier doc comment's own "parapet ring" made concrete, since a plain
    // ring reads as a collar, not a fortification.
    const CRENELLATION_COUNT = 8;
    const merlonHeight = 0.14;
    const merlonRadius = towerRadius + 0.1;
    const merlons: StructurePart = {
      geometry: new BoxGeometry(0.09, merlonHeight, 0.06),
      material: lambert(0x6f6a63),
      localMatrices: circleRingMatrices(
        CRENELLATION_COUNT,
        merlonRadius,
        towerHeight + parapetHeight + merlonHeight / 2 - 0.02,
        true,
      ),
    };

    // Base plinth: a wider stone footing ring at the tower's foot — the
    // parapet's counterpart at ground level, so the tower reads as founded
    // on masonry rather than planted straight into the terrain.
    const plinthHeight = 0.12;
    const plinth: StructurePart = {
      geometry: new CylinderGeometry(towerRadius + 0.1, towerRadius + 0.15, plinthHeight, 8),
      material: lambert(0x6f6a63),
      localMatrices: [at(0, plinthHeight / 2, 0)],
    };

    // REMODEL (owner: "same stone-wall treatment as the cottage, consistent
    // shades, so cottage and tower read as the same masonry era"). The
    // tower's wall is a CYLINDER, not a box, so stoneBlocksForFace's flat-
    // face grid does not apply directly; this builds the equivalent for a
    // round wall — courses of small boxes ringed around the shaft via
    // circleRingMatrices (faceOutward: true, exactly like the arrow slits
    // and merlons above), reading the SAME STONE_SHADE_COLORS in the SAME
    // fixed (course + position) cycle stoneBlocksForFace uses, so the two
    // tiers' masonry is drawn from one shared palette rather than two
    // similar-but-different ones. The tower TAPERS (towerRadius at the top,
    // towerRadius * 1.08 at the base — see `tower` above), so a stone ring
    // built at one fixed radius would clip into the wider base if that
    // radius were sized to the narrower top; using the tower's own WIDEST
    // radius (the base) for every course keeps every ring proud of the
    // actual surface everywhere, at the cost of standing slightly further
    // proud than strictly necessary near the top — the same "proud
    // everywhere, buried nowhere" trade the teepee's door makes above.
    const STONE_TOWER_COURSE_COUNT = 5;
    const STONE_TOWER_TARGET_SPACING = 0.1;
    const STONE_TOWER_BLOCK_FILL_FRACTION = 0.82;
    const towerStoneRadius = towerRadius * 1.08 + STONE_TOWER_BLOCK_DEPTH / 2;
    const towerStoneBand = towerHeight * 0.85; // stays clear of the plinth (below) and the parapet (above)
    // Nearest whole divisor of the ring's own circumference, same
    // "target spacing" trick stoneBlocksForFace and the marquee bulbs both
    // use — computed once, since it does not depend on which course.
    const towerStoneRingCount = Math.round((FULL_TURN_RADIANS * towerStoneRadius) / STONE_TOWER_TARGET_SPACING);
    const towerStoneSlotWidth = (FULL_TURN_RADIANS * towerStoneRadius) / towerStoneRingCount;
    const towerStoneHalfSlotAngle = Math.PI / towerStoneRingCount; // half of one slot's own angular width (FULL_TURN_RADIANS / ringCount), halved again
    // The brief says "keep... slits" — a stone block landing in front of one
    // (at any course; ARROW_SLIT_COUNT = 3 divides evenly into most sensible
    // ring counts, so without this every EVEN course would otherwise land a
    // block on exactly every slit) would defeat that. Rather than reasoning
    // about which specific courses vertically overlap the slit band, this
    // carves a full-height angular seam at each slit's own angle — no stone
    // block within ARROW_SLIT_ANGLE_CLEARANCE of a slit's angle, at ANY
    // course — the masonry equivalent of a real tower's slits being built
    // INTO the coursing (framed by stone on either side) rather than one
    // course happening to leave a gap there by chance.
    const ARROW_SLIT_ANGLES = Array.from(
      { length: ARROW_SLIT_COUNT },
      (_, i) => (FULL_TURN_RADIANS * i) / ARROW_SLIT_COUNT,
    );
    const ARROW_SLIT_ANGLE_CLEARANCE = towerStoneHalfSlotAngle * 2; // one full slot's width, centred on the slit
    const towerStoneBlocks: StoneBlock[] = [];
    for (let course = 0; course < STONE_TOWER_COURSE_COUNT; course++) {
      const y = (towerStoneBand / STONE_TOWER_COURSE_COUNT) * (course + 0.5);
      const startAngle = course % 2 === 1 ? towerStoneHalfSlotAngle : 0; // running-bond stagger, ring case
      const ring = circleRingMatrices(towerStoneRingCount, towerStoneRadius, y, true, startAngle);
      for (let i = 0; i < ring.length; i++) {
        // Same angle formula circleRingMatrices used internally to place
        // ring[i] — recomputed here (cheaply) only to test it against the
        // slit seam, not to rebuild the matrix itself.
        const angle = startAngle + (FULL_TURN_RADIANS * i) / towerStoneRingCount;
        const nearSlit = ARROW_SLIT_ANGLES.some(
          (slitAngle) => angularDistance(angle, slitAngle) < ARROW_SLIT_ANGLE_CLEARANCE,
        );
        if (nearSlit) continue;
        towerStoneBlocks.push({ matrix: ring[i], shadeIndex: (course + i) % STONE_SHADE_COLORS.length });
      }
    }
    const towerStoneBlockWidth = towerStoneSlotWidth * STONE_TOWER_BLOCK_FILL_FRACTION;
    const towerStoneBlockHeight = (towerStoneBand / STONE_TOWER_COURSE_COUNT) * STONE_TOWER_BLOCK_FILL_FRACTION;
    const towerStoneScale = new Matrix4().makeScale(towerStoneBlockWidth, towerStoneBlockHeight, 1);
    for (const block of towerStoneBlocks) block.matrix.multiply(towerStoneScale);
    const towerStoneGeometry = new BoxGeometry(1, 1, STONE_TOWER_BLOCK_DEPTH);
    const towerStoneWalls = stonePartsByShade(towerStoneBlocks, towerStoneGeometry);

    tiers.push([tower, parapet, roof, door, arrowSlits, merlons, plinth, ...towerStoneWalls]);
  }

  return tiers;
}

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

// ── Neon dancer: a two-pose sign figure at the right porch post ─────────────
//
// Owner request: a dancer figure on one of the two porch poles. Rendered the
// way a Vegas sign would render it — a stylized NEON SILHOUETTE, not an
// anatomical model: thin glowing segments and a sphere head, mannequin-
// abstract by construction. Two fixed poses are built as separate instanced
// parts and ALTERNATE being lit on the marquee's own phase clock (pose A lit
// with bulb phase A, pose B with phase B), the classic two-pose animated-sign
// trick: apparent motion with zero per-frame matrix work, and no new flash
// frequency — the figure rides the 1.25 Hz bulb sine already counted in the
// marquee's 3 Hz-ceiling arithmetic above, in the same visual cluster.
/** Neon-pink tube glow; deliberately not the marquee's gold so the figure reads as its own sign element. */
const DURANDS_DANCER_NEON_COLOR = 0xff5f9e;
/** Dark tube base — same "dark socket, bright emissive" split the bulbs keep, so the unlit pose actually reads OFF. */
const DURANDS_DANCER_TUBE_COLOR = 0x33202b;
const DURANDS_DANCER_EMISSIVE_MIN = 0.04;
/** Slightly under the bulbs' own max: the figure is set dressing, the sign stays the focal point. */
const DURANDS_DANCER_EMISSIVE_MAX = 1.0;
/** Neon-tube radius: thin enough to read as outline, thick enough to survive game camera distance. */
const DURANDS_DANCER_TUBE_RADIUS = 0.009;
/** Unit length the shared segment cylinder is built at; per-segment matrices scale Y to the real length. */
const DURANDS_DANCER_SEGMENT_UNIT = 0.1;
const DURANDS_DANCER_HEAD_RADIUS = 0.021;
/** Bust spheres on the figure's chest — silhouette curve only, same neon register (owner request 2026-08-19). */
const DURANDS_DANCER_BUST_RADIUS = 0.012;

/**
 * One neon tube segment BETWEEN two joints in the building's front (x, y)
 * plane: midpoint, length and Z-tilt are derived from the endpoints, so the
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
 * Builds Durand's part list: a two-storey box building — dark red-brown
 * ground floor, a lighter warm-red jettied (overhanging) second storey, a
 * deep-red false front rising above the roofline, a porch roof on two tan
 * posts, and the sign mounted proud of the false front. Same "list of
 * (geometry, material, local transforms)" shape every other tier keeps
 * (see the file banner) — Durand's is not a special case to the instancer
 * below, only to this function.
 */
function buildDurandsParts(): DurandsBuilding {
  const groundFloorHeight = 0.55;
  const groundHalfWidth = 0.42;
  const groundDepth = 0.55;
  const groundFloor: StructurePart = {
    geometry: new BoxGeometry(groundHalfWidth * 2, groundFloorHeight, groundDepth),
    material: lambert(0x7a2a20),
    localMatrices: [at(0, groundFloorHeight / 2, 0)],
  };

  // Jettied (overhanging) second storey — a classic saloon/frontier detail:
  // wider than the floor beneath it, not merely stacked on top of it.
  const secondFloorHeight = 0.45;
  const secondHalfWidth = 0.46;
  const secondDepth = 0.55;
  const secondFloor: StructurePart = {
    geometry: new BoxGeometry(secondHalfWidth * 2, secondFloorHeight, secondDepth),
    material: lambert(0x8f3325),
    localMatrices: [at(0, groundFloorHeight + secondFloorHeight / 2, 0)],
  };

  // False front: a flat parapet standing proud of the roofline, flush with
  // the second storey's front face — the silhouette that makes a saloon read
  // as a saloon rather than as a plain box house.
  const falseFrontHeight = 0.28;
  const falseFrontDepth = 0.06;
  const falseFrontY = groundFloorHeight + secondFloorHeight + falseFrontHeight / 2;
  const falseFrontZ = secondDepth / 2 + falseFrontDepth / 2;
  const falseFront: StructurePart = {
    geometry: new BoxGeometry(secondHalfWidth * 2, falseFrontHeight, falseFrontDepth),
    material: lambert(0x9c2b1e),
    localMatrices: [at(0, falseFrontY, falseFrontZ)],
  };

  // Porch roof and its two support posts, overhanging the ground floor's
  // front face.
  const porchDepth = 0.32;
  const porchThickness = 0.05;
  const porchHalfWidth = groundHalfWidth + 0.05;
  const porchZ = groundDepth / 2 + porchDepth / 2;
  const porchRoof: StructurePart = {
    geometry: new BoxGeometry(porchHalfWidth * 2, porchThickness, porchDepth),
    material: lambert(0x4a2015),
    localMatrices: [at(0, groundFloorHeight, porchZ)],
  };

  const postInset = 0.05;
  const postX = porchHalfWidth - postInset;
  const postZ = groundDepth / 2 + porchDepth - postInset;
  const porchPosts: StructurePart = {
    geometry: new CylinderGeometry(0.03, 0.03, groundFloorHeight, 6),
    material: lambert(0xac8a55),
    localMatrices: [at(postX, groundFloorHeight / 2, postZ), at(-postX, groundFloorHeight / 2, postZ)],
  };

  // Upstairs windows on the jettied second storey — the same lit-window cue
  // every house tier from timber-house up carries, so Durand's reads as
  // occupied the same way its neighbours do, on top of its own sign.
  const windows: StructurePart = {
    geometry: new BoxGeometry(0.11, 0.13, 0.02),
    material: windowMaterial(),
    localMatrices: [
      at(0.24, groundFloorHeight + secondFloorHeight * 0.55, secondDepth / 2 + 0.01),
      at(-0.24, groundFloorHeight + secondFloorHeight * 0.55, secondDepth / 2 + 0.01),
    ],
  };

  // Saloon doors: a pair of half-height café doors under the porch, hung
  // clear of the ground — the entrance detail that makes this specifically
  // a SALOON rather than a generic two-storey frontier building.
  const saloonDoorHeight = 0.26;
  const saloonDoorHalfWidth = 0.09;
  const saloonDoorGap = 0.01;
  const saloonDoorClearance = 0.06; // hung above the floor, like a real café door
  const saloonDoorY = saloonDoorClearance + saloonDoorHeight / 2;
  const saloonDoors: StructurePart = {
    geometry: new BoxGeometry(saloonDoorHalfWidth * 2 - saloonDoorGap, saloonDoorHeight, 0.02),
    material: lambert(0x5a2015),
    localMatrices: [
      at(saloonDoorHalfWidth + saloonDoorGap / 2, saloonDoorY, groundDepth / 2 + 0.02),
      at(-(saloonDoorHalfWidth + saloonDoorGap / 2), saloonDoorY, groundDepth / 2 + 0.02),
    ],
  };

  // The sign: mounted proud of the false front's own face so it never
  // z-fights with the board behind it, at a height a passer-by would
  // actually look up and read.
  const signHalfWidth = 0.32;
  const signHalfHeight = 0.08;
  const signThickness = 0.02;
  const signGap = 0.01;
  // Owner call (2026-08-18): recentred. The prior flush-right placement
  // (secondHalfWidth - signHalfWidth) read as off-centre against the false
  // front; the sign now sits on the false front's own centreline. The
  // marquee frame below still derives from the sign's own centre, so it
  // rides along with this unchanged.
  const signX = 0;
  const signY = groundFloorHeight + secondFloorHeight + falseFrontHeight * 0.5;
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
  // shares one geometry between (see gableRoofPanelMatrices).
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

  // The dancer, at the RIGHT porch post ("one of those two poles in the
  // front" — owner). The post itself is the dance pole; both poses hug it.
  // Segment coordinates are hand-placed midpoints in the building's own
  // space, one Z-plane just proud of the post so the tubes never z-fight it.
  const dancerZ = postZ + 0.02;
  const dancerPoseAMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_NEON_COLOR,
    emissiveIntensity: DURANDS_DANCER_EMISSIVE_MAX,
  });
  const dancerPoseBMaterial = new MeshLambertMaterial({
    color: DURANDS_DANCER_TUBE_COLOR,
    flatShading: true,
    emissive: DURANDS_DANCER_NEON_COLOR,
    emissiveIntensity: DURANDS_DANCER_EMISSIVE_MIN,
  });
  const dancerSegmentGeometry = new CylinderGeometry(
    DURANDS_DANCER_TUBE_RADIUS,
    DURANDS_DANCER_TUBE_RADIUS,
    DURANDS_DANCER_SEGMENT_UNIT,
    5,
  );
  const dancerHeadGeometry = new SphereGeometry(DURANDS_DANCER_HEAD_RADIUS, 6, 4);

  // Pose A — upright at the pole: standing leg on the porch, one leg
  // extended, torso up the pole, one arm gripping above, one arm out.
  // Joints are (x, y) in the building's front plane; the porch floor is y=0.
  const hipAX = postX + 0.01;
  const hipAY = 0.16;
  const shoulderAX = postX + 0.02;
  const shoulderAY = 0.3;
  const dancerPoseA: StructurePart = {
    geometry: dancerSegmentGeometry,
    material: dancerPoseAMaterial,
    localMatrices: [
      dancerSegment(postX, 0, hipAX, hipAY, dancerZ), // standing leg
      dancerSegment(hipAX, hipAY, postX - 0.14, 0.21, dancerZ), // extended leg
      dancerSegment(hipAX, hipAY, shoulderAX, shoulderAY, dancerZ), // torso
      dancerSegment(shoulderAX, shoulderAY, postX + 0.03, 0.42, dancerZ - 0.01), // arm gripping pole
      dancerSegment(shoulderAX, shoulderAY, postX - 0.1, 0.24, dancerZ), // free arm out
    ],
  };
  // Head part also carries the bust: two smaller instances of the same
  // sphere geometry (scaled per-matrix) at chest height, offset perpendicular
  // to the torso line — the silhouette curve the owner asked for, kept in the
  // same stylized neon register as the rest of the figure.
  const bustScale = DURANDS_DANCER_BUST_RADIUS / DURANDS_DANCER_HEAD_RADIUS;
  const bustSphere = (x: number, y: number, z: number): Matrix4 =>
    new Matrix4().compose(
      new Vector3(x, y, z),
      new Quaternion(),
      new Vector3(bustScale, bustScale, bustScale),
    );
  const dancerPoseAHead: StructurePart = {
    geometry: dancerHeadGeometry,
    material: dancerPoseAMaterial,
    localMatrices: [
      at(shoulderAX + 0.005, shoulderAY + 0.045, dancerZ),
      bustSphere(shoulderAX - 0.006, shoulderAY - 0.048, dancerZ + 0.012),
      bustSphere(shoulderAX + 0.018, shoulderAY - 0.046, dancerZ + 0.012),
    ],
  };

  // Pose B — arched lean away from the pole, one hand keeping hold of it,
  // the other arm trailing.
  const hipBX = postX - 0.03;
  const hipBY = 0.15;
  const shoulderBX = postX - 0.1;
  const shoulderBY = 0.27;
  const dancerPoseB: StructurePart = {
    geometry: dancerSegmentGeometry,
    material: dancerPoseBMaterial,
    localMatrices: [
      dancerSegment(postX, 0, hipBX, hipBY, dancerZ), // legs together
      dancerSegment(hipBX, hipBY, shoulderBX, shoulderBY, dancerZ), // arched torso
      dancerSegment(shoulderBX, shoulderBY, postX + 0.01, 0.38, dancerZ - 0.01), // arm holding pole
      dancerSegment(shoulderBX, shoulderBY, postX - 0.2, 0.2, dancerZ), // trailing arm
    ],
  };
  const dancerPoseBHead: StructurePart = {
    geometry: dancerHeadGeometry,
    material: dancerPoseBMaterial,
    localMatrices: [
      at(shoulderBX - 0.025, shoulderBY + 0.045, dancerZ),
      bustSphere(shoulderBX + 0.002, shoulderBY - 0.04, dancerZ + 0.012),
      bustSphere(shoulderBX + 0.022, shoulderBY - 0.028, dancerZ + 0.012),
    ],
  };

  return {
    parts: [
      groundFloor,
      secondFloor,
      falseFront,
      porchRoof,
      porchPosts,
      windows,
      saloonDoors,
      sign,
      marqueeBulbsPhaseA,
      marqueeBulbsPhaseB,
      dancerPoseA,
      dancerPoseAHead,
      dancerPoseB,
      dancerPoseBHead,
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
  readonly groundY: number;
  readonly tier: StructureTier;
  readonly scale: number;
  readonly yaw: number;
}

export interface StructureModels {
  readonly root: Group;
  apply(placements: readonly StructurePlacement[]): void;
  /** Advances the Durand's sign flash and marquee bulb chase by `dt` seconds. A no-op otherwise — nothing else in this plugin animates per-frame. */
  animate(dt: number): void;
  dispose(): void;
}

export function createStructureModels(): StructureModels {
  const tierParts = buildTierParts();
  if (tierParts.length !== STRUCTURE_TIER_COUNT) {
    // Defensive: a mismatch here means a tier was added to the wire contract
    // (protocol.ts) without a matching model, which would silently drop that
    // tier's buildings from the scene rather than fail loudly at boot.
    throw new Error(`structures: built ${tierParts.length} tier models, expected ${STRUCTURE_TIER_COUNT}`);
  }

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
  const durandsMeshes: InstancedMesh[] = durands.parts.map((part) => {
    geometries.push(part.geometry);
    materials.push(part.material);
    const mesh = new InstancedMesh(part.geometry, part.material, STRUCTURES_CAP * part.localMatrices.length);
    mesh.count = 0;
    root.add(mesh);
    return mesh;
  });

  // Scratch objects, reused across every instance of every rebuild — the same
  // discipline flora's apply() keeps, for the same reason (a rebuild fires on
  // every founding, upgrade and demolition; per-instance allocation would
  // churn hundreds of short-lived objects on every one of those).
  const buildingPosition = new Vector3();
  const buildingRotation = new Quaternion();
  const buildingScale = new Vector3();
  const buildingMatrix = new Matrix4();
  const instanceMatrix = new Matrix4();

  /** Seconds since attach — the only state animate() advances. */
  let durandsFlashElapsedSeconds = 0;

  /**
   * Writes one building's instances into `meshes`, part by part, advancing
   * `counts` (one slot per part, mutated in place — the caller owns the
   * array and reads it back after every placement in this apply() pass).
   * Shared by both the per-tier path and the Durand's path below so the two
   * do not carry two copies of the same nested loop.
   */
  function writeInstances(parts: StructurePart[], meshes: InstancedMesh[], counts: number[]): void {
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
      mesh.instanceMatrix.needsUpdate = true;
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

      for (const placement of placements) {
        buildingPosition.set(placement.x, placement.groundY, placement.z);
        buildingRotation.setFromAxisAngle(Y_AXIS, placement.yaw);
        buildingScale.setScalar(placement.scale);
        buildingMatrix.compose(buildingPosition, buildingRotation, buildingScale);

        // isDurandsCell's own contract gates this to MAX_STRUCTURE_TIER (see
        // ./durands.ts) — nothing below the top tier can ever come back true.
        if (isDurandsCell(placement.tier, placement.x, placement.z)) {
          writeInstances(durands.parts, durandsMeshes, durandsCounts);
          continue;
        }

        const parts = tierParts[placement.tier];
        const meshes = meshesByTier[placement.tier];
        if (parts === undefined || meshes === undefined) continue; // defensive: unknown tier, dropped rather than crashing the frame
        writeInstances(parts, meshes, counts[placement.tier]);
      }

      for (let tier = 0; tier < meshesByTier.length; tier++) finalizeMeshes(meshesByTier[tier], counts[tier]);
      finalizeMeshes(durandsMeshes, durandsCounts);
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

      // Neon dancer: the two poses swap on the SAME phase clock as the bulbs
      // (pose A lit with phase A, pose B with phase B) — the two-pose sign
      // trick. No new frequency is introduced; see the dancer constants'
      // banner for why this stays inside the marquee's ceiling arithmetic.
      durands.dancerPoseAMaterial.emissiveIntensity =
        DURANDS_DANCER_EMISSIVE_MIN + phaseAT * (DURANDS_DANCER_EMISSIVE_MAX - DURANDS_DANCER_EMISSIVE_MIN);
      durands.dancerPoseBMaterial.emissiveIntensity =
        DURANDS_DANCER_EMISSIVE_MIN + phaseBT * (DURANDS_DANCER_EMISSIVE_MAX - DURANDS_DANCER_EMISSIVE_MIN);
    },

    dispose(): void {
      for (const parts of meshesByTier) for (const mesh of parts) mesh.dispose();
      for (const mesh of durandsMeshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}

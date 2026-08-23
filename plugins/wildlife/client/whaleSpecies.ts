// The three whales, as anatomy.
//
// One "whale" on the wire is drawn as one of three real species, chosen from
// the creature's id so an individual keeps the same body for its whole life.
// They are deliberately not variations on a theme: a humpback, a blue whale and
// a sperm whale disagree about nearly every proportion an animal has, and the
// point of drawing three is that you can tell which is which at a glance.
//
// Sizing: whales draw their size class PER MEMBER (WHALE_SIZE_WEIGHTS with
// sizeDraw 'per-member' on the server, and WILDLIFE_SIZE_MODEL_SCALE applied to
// the rig here), so a big/medium/small axis genuinely exists — but it is NOT
// what separates these three bodies. They are SPECIES variants (humpback /
// blue / sperm), chosen by entity id — an axis orthogonal to the size-class
// scale — and they are all authored into the SAME envelope the shipped whale
// occupied, then scaled to fit it exactly. See WHALE_ENVELOPE for why that
// matters.
import {
  Box3,
  BufferGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  Shape,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { finGeometry, profileFromPoints, sweptHull, type BodyProfile } from './whaleHull.ts';

/** The three bodies a whale can be drawn as. Order is the selection order. */
export const WHALE_SPECIES = ['humpback', 'blue', 'sperm'] as const;
export type WhaleSpecies = (typeof WHALE_SPECIES)[number];

/**
 * The authored envelope every whale body is fitted into, in world units,
 * measured from the whale this replaces.
 *
 * These are not style choices, they are the placement contract:
 * `SWIM_PROFILES.whale` (placement.ts) guarantees only `minClearance` 0.7 of
 * water between the swim origin and the sea surface, and `minSubmergence` 0.7
 * below. The old model's crown sat at y = 0.670 and its belly at y = -0.575,
 * and those two figures are what the clearance numbers were tuned against
 * (see WHALE_DORSAL_HEIGHT in models.ts for that history, including the
 * 2026-08-19 report of a whale that read as capsized because its dorsal was
 * buried). A body that fits inside this box cannot break through the sea
 * surface or sink into the seabed anywhere the old one did not.
 */
export const WHALE_ENVELOPE = {
  crownY: 0.670,
  bellyY: -0.575,
  length: 5.05,
} as const;

/** Authoring length every profile below is written against, before fitting. */
const AUTHORED_LENGTH = 6.2;

/** One species' shared, instance-independent geometry. */
export interface WhaleGeometrySet {
  readonly species: WhaleSpecies;
  /** Parts rigid to the body, with their local placement. */
  readonly bodyParts: readonly WhalePart[];
  /** Parts that hinge with the tail stroke. */
  readonly flukeParts: readonly WhalePart[];
  /** Uniform scale that fits the assembled body into WHALE_ENVELOPE. */
  readonly fitScale: number;
}

interface WhalePart {
  readonly geometry: BufferGeometry;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
}

function part(
  geometry: BufferGeometry,
  position: readonly [number, number, number] = [0, 0, 0],
  rotation: readonly [number, number, number] = [0, 0, 0],
): WhalePart {
  return { geometry, position, rotation };
}

// ── Humpback ────────────────────────────────────────────────────────────────
// Recognised, in the order the eye takes it in, by: flippers nearly a third of
// body length with a scalloped leading edge; a barrel chest collapsing to a
// narrow tail stock; tubercles knobbling the rostrum; broad flukes with a
// serrated trailing edge; and the hump the animal is named for.

const HUMPBACK_TUBERCLE_EXTENT = 0.19;
const HUMPBACK_TUBERCLE_HEIGHT = 0.030;
const HUMPBACK_TUBERCLE_ROWS = 5;
const HUMPBACK_TUBERCLE_PER_ROW = 7;
const HUMPBACK_MAX_HALF_WIDTH = 0.60;

function humpbackSet(): WhaleGeometrySet {
  const width = profileFromPoints([
    [0.00, 0.14], [0.04, 0.34], [0.09, 0.53], [0.15, 0.70], [0.22, 0.85],
    [0.30, 0.96], [0.36, 1.00], [0.45, 0.97], [0.55, 0.87], [0.65, 0.71],
    [0.74, 0.54], [0.82, 0.38], [0.89, 0.25], [0.95, 0.15], [1.00, 0.09],
  ]);
  // Height runs its own course: barrel-deep amidships, then holding its height
  // while the width goes away, so the peduncle is a blade the flukes grow out
  // of rather than a rod they are pinned to.
  const heightRatio = profileFromPoints([
    [0.00, 0.95], [0.10, 1.05], [0.25, 1.18], [0.40, 1.20], [0.55, 1.18],
    [0.70, 1.30], [0.82, 1.60], [0.92, 2.00], [1.00, 2.20],
  ]);
  const halfWidth: BodyProfile = (t) => Math.max(0.03, width(t) * HUMPBACK_MAX_HALF_WIDTH);
  const halfHeight: BodyProfile = (t) => halfWidth(t) * heightRatio(t);
  const hull = sweptHull({
    length: AUTHORED_LENGTH, rings: 120, segments: 56,
    halfWidth, halfHeight,
    displace: (t, theta) => {
      let d = 0;
      const up = Math.cos(theta - Math.PI / 2); // +1 on the back, -1 on the belly
      d += 0.05 * Math.exp(-Math.pow((t - 0.62) / 0.09, 2)) * Math.max(0, up);
      if (t < HUMPBACK_TUBERCLE_EXTENT) {
        const row = Math.round((t / HUMPBACK_TUBERCLE_EXTENT) * (HUMPBACK_TUBERCLE_ROWS - 1));
        const rowT = (row / (HUMPBACK_TUBERCLE_ROWS - 1)) * HUMPBACK_TUBERCLE_EXTENT;
        const along = Math.exp(-Math.pow((t - rowT) / (HUMPBACK_TUBERCLE_EXTENT / 9), 2));
        const around = Math.cos(theta * HUMPBACK_TUBERCLE_PER_ROW + row * 1.1);
        // Knobs ride the crown of the rostrum and the jaw line, not the flanks,
        // which |up| going to zero at the sides takes care of.
        d += HUMPBACK_TUBERCLE_HEIGHT * along * Math.max(0, around) * Math.abs(up);
      }
      return d;
    },
  });

  const bodyParts: WhalePart[] = [part(hull)];
  const PECTORAL_ROOT_X = 1.30;
  for (const sign of [1, -1]) {
    bodyParts.push(part(
      finGeometry((shape, s) => {
        shape.moveTo(0.30, 0);
        // Scalloped leading edge -- the humpback's tell, and unmistakable even
        // as a silhouette.
        shape.quadraticCurveTo(0.28, s * 0.50, 0.20, s * 0.72);
        shape.quadraticCurveTo(0.26, s * 0.86, 0.14, s * 1.04);
        shape.quadraticCurveTo(0.20, s * 1.20, 0.06, s * 1.42);
        shape.quadraticCurveTo(-0.02, s * 1.60, -0.20, s * 1.66);
        shape.quadraticCurveTo(-0.34, s * 1.58, -0.30, s * 1.36);
        shape.quadraticCurveTo(-0.34, s * 0.90, -0.30, s * 0.44);
        shape.quadraticCurveTo(-0.24, s * 0.16, 0.30, 0);
      }, sign, 0.075),
      [PECTORAL_ROOT_X, -0.14, sign * seatZ(halfWidth, PECTORAL_ROOT_X)],
      [sign * 0.30, sign * -0.22, -0.16],
    ));
  }
  const DORSAL_X = -0.85;
  bodyParts.push(part(
    uprightFin((shape) => {
      shape.moveTo(0.30, 0);
      shape.quadraticCurveTo(0.16, 0.20, -0.16, 0.34);
      shape.quadraticCurveTo(-0.30, 0.30, -0.24, 0.14);
      shape.quadraticCurveTo(-0.30, 0.06, -0.34, 0);
      shape.lineTo(0.30, 0);
    }, 0.07),
    [DORSAL_X, seatY(halfHeight, DORSAL_X), 0],
  ));

  // Far enough aft that the hull's own tail tip is covered by the fluke roots
  // rather than showing between them as a needle.
  const FLUKE_ROOT_X = -2.80;
  const flukeParts = [1, -1].map((sign) => part(
    finGeometry((shape, s) => {
      shape.moveTo(0.30, 0);
      shape.quadraticCurveTo(0.16, s * 0.55, -0.16, s * 1.30);
      shape.quadraticCurveTo(-0.30, s * 1.44, -0.46, s * 1.32);
      // Trailing edge scalloped into three serrations, then the deep notch.
      shape.quadraticCurveTo(-0.34, s * 1.10, -0.42, s * 0.94);
      shape.quadraticCurveTo(-0.30, s * 0.76, -0.40, s * 0.58);
      shape.quadraticCurveTo(-0.26, s * 0.40, -0.38, s * 0.24);
      shape.quadraticCurveTo(-0.30, s * 0.10, 0.30, 0);
    }, sign, 0.07),
    [FLUKE_ROOT_X, 0, 0],
    [0, 0, -0.06],
  ));
  return finish('humpback', bodyParts, flukeParts);
}

// ── Blue whale ──────────────────────────────────────────────────────────────
// The opposite animal: long and slim, a flat spade of a rostrum with one ridge
// down it, ventral pleats at the throat, and a nub of a dorsal set three
// quarters of the way back.

const BLUE_MAX_HALF_WIDTH = 0.46;
const BLUE_PLEAT_START = 0.03;
const BLUE_PLEAT_END = 0.34;
const BLUE_PLEAT_COUNT = 11;
const BLUE_PLEAT_DEPTH = 0.016;
const BLUE_RIDGE_END = 0.16;
const BLUE_RIDGE_HEIGHT = 0.022;

function blueSet(): WhaleGeometrySet {
  const width = profileFromPoints([
    [0.00, 0.10], [0.03, 0.26], [0.08, 0.45], [0.14, 0.62], [0.22, 0.80],
    [0.32, 0.93], [0.42, 1.00], [0.52, 0.98], [0.62, 0.89], [0.72, 0.73],
    [0.80, 0.56], [0.87, 0.39], [0.93, 0.25], [0.97, 0.15], [1.00, 0.08],
  ]);
  // Wider than tall at the head, taller than wide at the tail. That inversion
  // along one body is the species, and the reason this is a sweep and not a
  // lathe.
  const heightRatio = profileFromPoints([
    [0.00, 0.62], [0.08, 0.66], [0.16, 0.78], [0.28, 0.98], [0.42, 1.06],
    [0.58, 1.08], [0.72, 1.24], [0.84, 1.62], [0.93, 2.05], [1.00, 2.30],
  ]);
  const halfWidth: BodyProfile = (t) => Math.max(0.028, width(t) * BLUE_MAX_HALF_WIDTH);
  const hull = sweptHull({
    length: AUTHORED_LENGTH, rings: 130, segments: 56,
    halfWidth,
    halfHeight: (t) => halfWidth(t) * heightRatio(t),
    displace: (t, theta) => {
      let d = 0;
      const up = Math.cos(theta - Math.PI / 2);
      if (t < BLUE_RIDGE_END && up > 0.55) {
        d += BLUE_RIDGE_HEIGHT * (1 - t / BLUE_RIDGE_END) * Math.pow((up - 0.55) / 0.45, 2);
      }
      if (t > BLUE_PLEAT_START && t < BLUE_PLEAT_END && up < -0.25) {
        const along = Math.sin(Math.PI * (t - BLUE_PLEAT_START) / (BLUE_PLEAT_END - BLUE_PLEAT_START));
        const across = Math.max(0, Math.cos(theta * BLUE_PLEAT_COUNT));
        d -= BLUE_PLEAT_DEPTH * along * across * Math.min(1, (-up - 0.25) / 0.5);
      }
      return d;
    },
  });

  const bodyParts: WhalePart[] = [part(hull)];
  const PECTORAL_ROOT_X = 1.28;
  for (const sign of [1, -1]) {
    bodyParts.push(part(
      finGeometry((shape, s) => {
        shape.moveTo(0.26, 0);
        shape.quadraticCurveTo(0.20, s * 0.34, 0.02, s * 0.78);
        shape.quadraticCurveTo(-0.06, s * 0.92, -0.16, s * 0.86);
        shape.quadraticCurveTo(-0.20, s * 0.50, -0.24, s * 0.20);
        shape.quadraticCurveTo(-0.16, s * 0.06, 0.26, 0);
      }, sign, 0.055),
      [PECTORAL_ROOT_X, -0.10, sign * seatZ(halfWidth, PECTORAL_ROOT_X)],
      [sign * 0.22, sign * -0.30, -0.10],
    ));
  }
  // Seated INTO the back so there is no daylight under the fin, which is what
  // made an earlier version read as a fin hovering above the animal.
  const BLUE_DORSAL_X = -1.55; // three quarters back, where the species carries it
  bodyParts.push(part(uprightFin((shape) => {
    shape.moveTo(0.16, 0);
    shape.quadraticCurveTo(0.08, 0.13, -0.10, 0.20);
    shape.quadraticCurveTo(-0.17, 0.16, -0.15, 0.07);
    shape.lineTo(-0.18, 0);
    shape.lineTo(0.16, 0);
  }, 0.055), [BLUE_DORSAL_X, seatY((t) => halfWidth(t) * heightRatio(t), BLUE_DORSAL_X), 0]));

  const flukeParts = [1, -1].map((sign) => part(
    finGeometry((shape, s) => {
      shape.moveTo(0.28, 0);
      shape.quadraticCurveTo(0.14, s * 0.60, -0.20, s * 1.34);
      shape.lineTo(-0.42, s * 1.24);
      shape.lineTo(-0.34, s * 0.10);
      shape.quadraticCurveTo(-0.20, s * 0.03, 0.28, 0);
    }, sign, 0.06),
    [-2.80, 0, 0],
  ));
  return finish('blue', bodyParts, flukeParts);
}

// ── Sperm whale ─────────────────────────────────────────────────────────────
// A third of the animal is head, and it does not taper — it stops. Boxy in
// section, an underslung pole of a jaw beneath it, no dorsal fin at all: a
// hump two thirds back followed by knuckles ridging the tail stock.

const SPERM_MAX_HALF_WIDTH = 0.56;
const SPERM_HEAD_END = 0.33;
const SPERM_WRINKLE_START = 0.34;
const SPERM_WRINKLE_END = 0.62;
const SPERM_WRINKLE_COUNT = 16;
const SPERM_WRINKLE_DEPTH = 0.010;
const SPERM_KNUCKLE_START = 0.72;
const SPERM_KNUCKLE_END = 0.93;
const SPERM_KNUCKLE_COUNT = 5;
const SPERM_KNUCKLE_HEIGHT = 0.030;

function spermSet(): WhaleGeometrySet {
  const width = profileFromPoints([
    [0.00, 0.72], [0.02, 0.86], [0.06, 0.95], [0.14, 0.99], [0.24, 1.00],
    [0.33, 0.97], [0.44, 0.90], [0.55, 0.79], [0.66, 0.65], [0.76, 0.50],
    [0.84, 0.37], [0.90, 0.26], [0.95, 0.16], [1.00, 0.08],
  ]);
  const heightRatio = profileFromPoints([
    [0.00, 1.02], [0.10, 1.06], [0.22, 1.08], [0.33, 1.06], [0.48, 1.02],
    [0.62, 1.10], [0.74, 1.34], [0.86, 1.75], [0.94, 2.10], [1.00, 2.30],
  ]);
  const halfWidth: BodyProfile = (t) => Math.max(0.030, width(t) * SPERM_MAX_HALF_WIDTH);
  const hull = sweptHull({
    length: AUTHORED_LENGTH, rings: 140, segments: 56,
    halfWidth,
    halfHeight: (t) => halfWidth(t) * heightRatio(t),
    boxiness: (t) => (t < SPERM_HEAD_END
      ? 1 - Math.pow(t / SPERM_HEAD_END, 2) * 0.75
      : Math.max(0, 0.25 - (t - SPERM_HEAD_END))),
    // Almost no axial reach on the nose cap: the face is a wall, and a
    // hemispherical cap puts a bulbous dome where the blunt front belongs.
    noseCapRings: 5,
    noseCapReach: 0.18,
    displace: (t, theta) => {
      let d = 0;
      const up = Math.cos(theta - Math.PI / 2);
      d += 0.055 * Math.exp(-Math.pow((t - 0.68) / 0.055, 2)) * Math.max(0, up);
      if (t > SPERM_KNUCKLE_START && t < SPERM_KNUCKLE_END && up > 0.2) {
        const u = (t - SPERM_KNUCKLE_START) / (SPERM_KNUCKLE_END - SPERM_KNUCKLE_START);
        const along = Math.max(0, Math.cos(u * Math.PI * SPERM_KNUCKLE_COUNT * 2 - Math.PI));
        d += SPERM_KNUCKLE_HEIGHT * along * Math.pow(up, 3) * (1 - u * 0.5);
      }
      if (t > SPERM_WRINKLE_START && t < SPERM_WRINKLE_END) {
        const along = Math.sin(Math.PI * (t - SPERM_WRINKLE_START) / (SPERM_WRINKLE_END - SPERM_WRINKLE_START));
        const across = Math.max(0, Math.cos(t * SPERM_WRINKLE_COUNT * Math.PI * 2));
        d -= SPERM_WRINKLE_DEPTH * along * across * (1 - Math.abs(up));
      }
      return d;
    },
  });

  const jawProfile = profileFromPoints([
    [0.00, 0.20], [0.20, 0.95], [0.60, 1.00], [0.85, 0.80], [1.00, 0.30],
  ]);
  const JAW_HALF_WIDTH = 0.12;
  const jaw = sweptHull({
    length: 2.40, rings: 40, segments: 20,
    halfWidth: (t) => Math.max(0.012, jawProfile(t) * JAW_HALF_WIDTH),
    halfHeight: (t) => Math.max(0.012, jawProfile(t) * JAW_HALF_WIDTH * 0.85),
  });
  // Low enough to show BELOW the head instead of hiding inside it, and stopping
  // short of the snout so the head overhangs it, which is what "underslung"
  // looks like.
  jaw.translate(1.85, -0.60, 0);

  const bodyParts: WhalePart[] = [part(hull), part(jaw)];
  const PECTORAL_ROOT_X = 0.95;
  for (const sign of [1, -1]) {
    bodyParts.push(part(
      finGeometry((shape, s) => {
        shape.moveTo(0.24, 0);
        shape.quadraticCurveTo(0.22, s * 0.28, 0.12, s * 0.52);
        shape.quadraticCurveTo(0.02, s * 0.62, -0.14, s * 0.54);
        shape.quadraticCurveTo(-0.22, s * 0.34, -0.24, s * 0.14);
        shape.quadraticCurveTo(-0.16, s * 0.04, 0.24, 0);
      }, sign, 0.07),
      [PECTORAL_ROOT_X, -0.24, sign * seatZ(halfWidth, PECTORAL_ROOT_X)],
      [sign * 0.34, sign * -0.18, -0.20],
    ));
  }
  const flukeParts = [1, -1].map((sign) => part(
    finGeometry((shape, s) => {
      shape.moveTo(0.30, 0);
      shape.quadraticCurveTo(0.10, s * 0.62, -0.26, s * 1.42);
      shape.lineTo(-0.46, s * 1.30);
      shape.lineTo(-0.40, s * 0.16);
      shape.quadraticCurveTo(-0.22, s * 0.02, 0.30, 0);
    }, sign, 0.07),
    [-2.80, 0, 0],
  ));
  return finish('sperm', bodyParts, flukeParts);
}

// ── Shared assembly ─────────────────────────────────────────────────────────

/** A dorsal fin: the same kind of outline as a flipper, standing upright. */
function uprightFin(buildOutline: (shape: Shape) => void, depth: number): BufferGeometry {
  const shape = new Shape();
  buildOutline(shape);
  const geometry = new ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: depth * 0.3, bevelSize: depth * 0.42,
    bevelSegments: 2, curveSegments: 20,
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

/** Fraction of the local half-width a flipper root is planted at. */
const FIN_ROOT_INSET = 0.72;
/** How far a dorsal's base is sunk below the back, in authoring units. */
const DORSAL_SEAT_DEPTH = 0.06;

/** Body t for a station x, on the authored body. */
function bodyT(x: number): number {
  return (AUTHORED_LENGTH / 2 - x) / AUTHORED_LENGTH;
}

/**
 * Z at which a flipper is rooted: inside the flank rather than on it, so the
 * join is buried and no seam shows however the fin is angled.
 */
function seatZ(halfWidth: BodyProfile, x: number): number {
  return halfWidth(bodyT(x)) * FIN_ROOT_INSET;
}

/**
 * Y at which a dorsal is seated: the back's own height at that station, less a
 * bite so the fin's root sits INSIDE the body. Derived rather than written down
 * because a profile edit must move the fin with it -- an earlier hand-written
 * figure left a fin hovering with daylight under it.
 */
function seatY(halfHeight: BodyProfile, x: number): number {
  return halfHeight(bodyT(x)) - DORSAL_SEAT_DEPTH;
}

/**
 * Measures the assembled body and works out the uniform scale that fits it
 * into WHALE_ENVELOPE, so a profile edit can never quietly push a dorsal
 * through the sea surface. Done once per species, at pool construction.
 */
function finish(
  species: WhaleSpecies,
  bodyParts: readonly WhalePart[],
  flukeParts: readonly WhalePart[],
): WhaleGeometrySet {
  const probe = new Group();
  for (const p of [...bodyParts, ...flukeParts]) {
    const mesh = new Mesh(p.geometry);
    mesh.position.set(...(p.position as [number, number, number]));
    mesh.rotation.set(...(p.rotation as [number, number, number]));
    probe.add(mesh);
  }
  probe.updateWorldMatrix(true, true);
  const box = new Box3().setFromObject(probe);
  const size = box.getSize(new Vector3());
  const fitScale = Math.min(
    WHALE_ENVELOPE.crownY / Math.max(box.max.y, 1e-6),
    Math.abs(WHALE_ENVELOPE.bellyY) / Math.max(Math.abs(box.min.y), 1e-6),
    WHALE_ENVELOPE.length / Math.max(size.x, 1e-6),
  );
  return { species, bodyParts, flukeParts, fitScale };
}

/** Builds all three bodies. Call once; the geometries are shared thereafter. */
export function buildWhaleGeometrySets(): readonly WhaleGeometrySet[] {
  return [humpbackSet(), blueSet(), spermSet()];
}

/** Every geometry in a set, for the disposal pool. */
export function geometriesOf(set: WhaleGeometrySet): readonly BufferGeometry[] {
  return [...set.bodyParts, ...set.flukeParts].map((p) => p.geometry);
}

/**
 * One instance of a whale: the body, and the fluke group the tail stroke
 * hinges. Geometries and the material are shared with every other whale of the
 * same species; only the Mesh objects and the two Groups are per-creature.
 */
export function assembleWhale(set: WhaleGeometrySet, material: Material): {
  readonly body: Object3D;
  readonly flukes: Object3D;
} {
  const body = new Group();
  body.scale.setScalar(set.fitScale);
  for (const p of set.bodyParts) {
    const mesh = new Mesh(p.geometry, material);
    mesh.position.set(...(p.position as [number, number, number]));
    mesh.rotation.set(...(p.rotation as [number, number, number]));
    body.add(mesh);
  }
  // The flukes hinge as one unit about the peduncle, so they hang off their own
  // Group whose rotation IS the stroke — the same pivot-per-hinge recipe the
  // bird's wings and the old whale's flukes use.
  const flukes = new Group();
  for (const p of set.flukeParts) {
    const mesh = new Mesh(p.geometry, material);
    mesh.position.set(...(p.position as [number, number, number]));
    mesh.rotation.set(...(p.rotation as [number, number, number]));
    flukes.add(mesh);
  }
  body.add(flukes);
  return { body, flukes };
}

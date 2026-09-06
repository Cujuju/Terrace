// The three whales, as anatomy — one of them still built here.
//
// One "whale" on the wire is drawn as one of three real species, chosen from
// the creature's id so an individual keeps the same body for its whole life.
// They are deliberately not variations on a theme: a humpback, a blue whale and
// a sperm whale disagree about nearly every proportion an animal has, and the
// point of drawing three is that you can tell which is which at a glance.
//
// SINCE 2026-09-04 (fish+whales arc, pass 6) the HUMPBACK is a Blender-built
// asset — species/humpback.ts, ../assets/humpback.glb — and since pass 7
// (2026-09-05) so is the BLUE WHALE — species/blueWhale.ts,
// ../assets/blue-whale.glb; their procedural sets are gone from here (the
// profile numbers are the reference silhouettes in tools/blender/
// build_humpback.py's and build_blue_whale.py's headers). The sperm body
// stays procedural until its own pass; `buildWhaleGeometrySets` returns that
// one, tagged with its species, and models.ts looks a body up by that tag,
// never by index. WHALE_SPECIES and WHALE_ENVELOPE are unchanged: the order
// is a contract with every living whale, and the envelope is the placement
// contract every body — asset or procedural — fills or fits.
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
 * How many of those bodies are still built HERE (sperm) rather than loaded
 * from a file: what index.ts's draw-object table counts as the two-surface
 * whale herds.
 */
export const PROCEDURAL_WHALE_BODIES = 1;

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

/**
 * Builds the procedural bodies (PROCEDURAL_WHALE_BODIES of them). Call once;
 * the geometries are shared thereafter.
 */
export function buildWhaleGeometrySets(): readonly WhaleGeometrySet[] {
  const sets = [spermSet()];
  if (sets.length !== PROCEDURAL_WHALE_BODIES) {
    throw new Error(`whaleSpecies: ${String(sets.length)} procedural bodies built but PROCEDURAL_WHALE_BODIES says ${String(PROCEDURAL_WHALE_BODIES)}`);
  }
  return sets;
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

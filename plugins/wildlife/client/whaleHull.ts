// Swept-surface geometry, the one place a whale body is built.
//
// The rest of models.ts is spheres, cones and boxes: five silhouettes you can
// tell apart at fifty cells, flat-shaded to match terraced terrain. Whales are
// the exception, by owner decision (2026-08-21: "higher resolution with smooth
// tapers"). They are the largest thing in the water, the one creature the
// camera gets close to, and a stack of ellipsoids reads as stacked ellipsoids
// at that range.
//
// A whale body is a swept surface: elliptical cross-sections whose half-width
// and half-height vary INDEPENDENTLY along the body. That independence is the
// whole point — a lathe (one radius per station) cannot give a blue whale both
// a flat spade of a head and a tall blade of a tail stock, and it is that
// inversion, not the vertex count, that makes the shape read as an animal.
//
// Both ends are closed here, always. Three earlier hand-rolled candidates each
// terminated their ring loop without a cap, leaving a hole you could see the
// backdrop through; closing the surface is not something a caller should be
// able to forget.
import {
  BufferGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Shape,
} from 'three';

/** Rings spent rounding each end closed. Four reads as rounded at any range. */
const DEFAULT_CAP_RINGS = 4;
/**
 * How far a cap reaches along X, as a multiple of the end ring's larger radius.
 * 1.0 would be a hemisphere; under that keeps a rostrum blunt rather than
 * bulbous. Overridable per species — a sperm whale's face is a wall, and
 * forcing a hemisphere onto it puts a dome where the blunt front should be.
 */
const DEFAULT_NOSE_CAP_REACH = 0.85;
const DEFAULT_TAIL_CAP_REACH = 0.6;
/** Superellipse exponent at full boxiness — a rounded square, not a hard box. */
const MAX_SECTION_EXPONENT = 5;

/** A value that varies along the body: 0 at the nose (+X), 1 at the tail tip. */
export type BodyProfile = (t: number) => number;

export interface SweptHullOptions {
  /** Nose-to-tail extent in world units, before any fit scaling. */
  readonly length: number;
  /** Cross-sections along the body, and vertices around each one. */
  readonly rings: number;
  readonly segments: number;
  readonly halfWidth: BodyProfile;
  readonly halfHeight: BodyProfile;
  /** Radial relief added per vertex — tubercles, pleats, knuckles, humps. */
  readonly displace?: ((t: number, theta: number) => number) | undefined;
  /** 0 = elliptical section, 1 = rounded square. */
  readonly boxiness?: BodyProfile | undefined;
  readonly noseCapRings?: number | undefined;
  readonly tailCapRings?: number | undefined;
  readonly noseCapReach?: number | undefined;
  readonly tailCapReach?: number | undefined;
}

/** A closed swept body centred on the origin, nose toward +X. */
export function sweptHull(options: SweptHullOptions): BufferGeometry {
  const {
    length, rings, segments, halfWidth, halfHeight,
    displace, boxiness,
    noseCapRings = DEFAULT_CAP_RINGS,
    tailCapRings = DEFAULT_CAP_RINGS,
    noseCapReach = DEFAULT_NOSE_CAP_REACH,
    tailCapReach = DEFAULT_TAIL_CAP_REACH,
  } = options;

  const positions: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];

  /**
   * One ring of exactly `segments` vertices, WRAPPED rather than duplicated at
   * the seam. Duplicating the seam vertex leaves every seam edge owned by a
   * single triangle — a surface that looks closed and tests open — and lets the
   * two coincident vertices average their normals separately, which draws a
   * faint crease down the animal's whole length.
   */
  function pushRing(x: number, a: number, b: number, t: number, scale: number): void {
    ringStart.push(positions.length / 3);
    const exponent = boxiness
      ? 2 / (2 + (MAX_SECTION_EXPONENT - 2) * Math.max(0, Math.min(1, boxiness(t))))
      : 1;
    for (let j = 0; j < segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      const relief = displace ? displace(t, theta) : 0;
      const ra = (a + relief) * scale;
      const rb = (b + relief) * scale;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const cz = exponent === 1 ? c : Math.sign(c) * Math.pow(Math.abs(c), exponent);
      const sy = exponent === 1 ? s : Math.sign(s) * Math.pow(Math.abs(s), exponent);
      positions.push(x, rb * sy, ra * cz);
    }
  }

  const noseX = length / 2;
  const tailX = -length / 2;
  const noseA = halfWidth(0);
  const noseB = halfHeight(0);
  const tailA = halfWidth(1);
  const tailB = halfHeight(1);

  const noseReach = Math.max(noseA, noseB) * noseCapReach;
  const nosePole = positions.length / 3;
  positions.push(noseX + noseReach, 0, 0);
  for (let k = 1; k < noseCapRings; k++) {
    const phi = (k / noseCapRings) * (Math.PI / 2);
    pushRing(noseX + noseReach * Math.cos(phi), noseA, noseB, 0, Math.sin(phi));
  }

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    pushRing(noseX - t * length, halfWidth(t), halfHeight(t), t, 1);
  }

  const tailReach = Math.max(tailA, tailB) * tailCapReach;
  for (let k = tailCapRings - 1; k >= 1; k--) {
    const phi = (k / tailCapRings) * (Math.PI / 2);
    pushRing(tailX - tailReach * Math.cos(phi), tailA, tailB, 1, Math.sin(phi));
  }
  const tailPole = positions.length / 3;
  positions.push(tailX - tailReach, 0, 0);

  for (let j = 0; j < segments; j++) {
    indices.push(nosePole, ringStart[0]! + ((j + 1) % segments), ringStart[0]! + j);
  }
  for (let r = 0; r < ringStart.length - 1; r++) {
    const cur = ringStart[r]!;
    const next = ringStart[r + 1]!;
    for (let j = 0; j < segments; j++) {
      const k = (j + 1) % segments;
      // Counter-clockwise seen from OUTSIDE the body — three's front face.
      // Rings run nose to tail (x decreasing) and theta runs +Z toward +Y, so
      // the outward winding is (cur, cur+1, next), not (cur, next, cur+1).
      // The body shipped wound the other way (2026-09-02): every flank
      // triangle faced inward while the two caps faced out, so the renderer
      // culled the near flank and drew the far wall's inside — a convex hull
      // looks the same either way, which is how it went unnoticed, but any
      // part seated inside the body (a fin root) showed through the skin.
      indices.push(cur + j, cur + k, next + j);
      indices.push(next + j, cur + k, next + k);
    }
  }
  const last = ringStart[ringStart.length - 1]!;
  for (let j = 0; j < segments; j++) {
    indices.push(tailPole, last + j, last + ((j + 1) % segments));
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A body profile authored as ANATOMY rather than as an equation: control points
 * `[t, value]` from nose to tail, Catmull-Rom interpolated and clamped.
 *
 * Sums of gaussians and sine powers are almost impossible to steer — moving the
 * widest point also changes how fat it is, and every correction breaks
 * something upstream. Control points state what the animal measures at each
 * station, which is how the shape is judged in the first place.
 */
export function profileFromPoints(points: readonly (readonly [number, number])[]): BodyProfile {
  const ts = points.map((p) => p[0]);
  const vs = points.map((p) => p[1]);
  return (t: number): number => {
    const x = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < ts.length - 2 && x > ts[i + 1]!) i++;
    const t0 = ts[i]!;
    const t1 = ts[i + 1]!;
    const u = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
    const p0 = vs[Math.max(0, i - 1)]!;
    const p1 = vs[i]!;
    const p2 = vs[i + 1]!;
    const p3 = vs[Math.min(vs.length - 1, i + 2)]!;
    const u2 = u * u;
    const u3 = u2 * u;
    return 0.5 * (
      2 * p1
      + (-p0 + p2) * u
      + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
      + (-p0 + 3 * p1 - 3 * p2 + p3) * u3
    );
  };
}

/**
 * A fin, flipper or fluke: a closed outline extruded to a thin slab and laid
 * into the XZ plane, so its span runs along ±Z and its thickness along Y.
 * `sign` mirrors the outline for the opposite side of the body.
 */
export function finGeometry(
  buildOutline: (shape: Shape, sign: number) => void,
  sign: number,
  depth: number,
): BufferGeometry {
  const shape = new Shape();
  buildOutline(shape, sign);
  const geometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.35,
    bevelSize: depth * 0.5,
    bevelSegments: 2,
    curveSegments: 24,
  });
  // The outline lives in XY and extrusion runs along +Z; rotating about X lays
  // it flat with thickness in Y, which is how a fin sits on a body facing +X.
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, -depth / 2, 0);
  return geometry;
}

import { BufferGeometry, Float32BufferAttribute } from 'three';

const DEFAULT_CAP_RINGS = 4;
const DEFAULT_NOSE_CAP_REACH = 0.85;
const DEFAULT_TAIL_CAP_REACH = 0.6;
const MAX_SECTION_EXPONENT = 5;

export type BodyProfile = (t: number) => number;

export interface SweptHullOptions {
  readonly length: number;
  readonly rings: number;
  readonly segments: number;
  readonly halfWidth: BodyProfile;
  readonly halfHeight: BodyProfile;
  readonly displace?: ((t: number, theta: number) => number) | undefined;
  readonly boxiness?: BodyProfile | undefined;
  readonly noseCapRings?: number | undefined;
  readonly tailCapRings?: number | undefined;
  readonly noseCapReach?: number | undefined;
  readonly tailCapReach?: number | undefined;
}

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

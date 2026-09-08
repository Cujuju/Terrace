import {
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Shape,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const FIN_BEVEL_THICKNESS_RATIO = 0.3;
const FIN_BEVEL_SIZE_RATIO = 0.42;
const FIN_BEVEL_SEGMENTS = 1;
const FIN_CURVE_SEGMENTS = 7;

export function indexed(geometry: BufferGeometry): BufferGeometry {
  const welded = mergeVertices(geometry);
  geometry.dispose();
  welded.computeVertexNormals();
  return welded;
}

export function flatFin(
  buildOutline: (shape: Shape, sign: number) => void,
  sign: number,
  depth: number,
): BufferGeometry {
  const shape = new Shape();
  buildOutline(shape, sign);
  const geometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * FIN_BEVEL_THICKNESS_RATIO,
    bevelSize: depth * FIN_BEVEL_SIZE_RATIO,
    bevelSegments: FIN_BEVEL_SEGMENTS,
    curveSegments: FIN_CURVE_SEGMENTS,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, -depth / 2, 0);
  return indexed(geometry);
}

export function uprightFin(
  buildOutline: (shape: Shape) => void,
  depth: number,
  bevelDepth: number = depth,
): BufferGeometry {
  const shape = new Shape();
  buildOutline(shape);
  const geometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevelDepth * FIN_BEVEL_THICKNESS_RATIO,
    bevelSize: bevelDepth * FIN_BEVEL_SIZE_RATIO,
    bevelSegments: FIN_BEVEL_SEGMENTS,
    curveSegments: FIN_CURVE_SEGMENTS,
  });
  geometry.translate(0, 0, -depth / 2);
  return indexed(geometry);
}

export interface LimbOptions {
  readonly rootRadius: number;
  readonly tipRadius: number;
  readonly length: number;
  readonly radialSegments: number;
  readonly heightSegments: number;
}

export function limb(options: LimbOptions): BufferGeometry {
  const { rootRadius, tipRadius, length, radialSegments, heightSegments } = options;
  const geometry = new CylinderGeometry(
    rootRadius,
    tipRadius,
    length,
    radialSegments,
    heightSegments,
  );
  geometry.translate(0, -length / 2, 0);
  return geometry;
}

export function smoothEllipsoid(
  length: number,
  height: number,
  width: number,
  widthSegments: number,
  heightSegments: number,
): BufferGeometry {
  const geometry = new SphereGeometry(0.5, widthSegments, heightSegments);
  geometry.scale(length, height, width);
  return geometry;
}

export interface HornOptions {
  readonly path: readonly Vector3[];
  readonly rootRadius: number;
  readonly tipRadius: number;
  readonly tubularSegments: number;
  readonly radialSegments: number;
}

export function taperedTube(options: HornOptions): BufferGeometry {
  const { path, rootRadius, tipRadius, tubularSegments, radialSegments } = options;
  const curve = new CatmullRomCurve3(path.map((p) => p.clone()));
  const geometry = new TubeGeometry(curve, tubularSegments, rootRadius, radialSegments, false);
  const positions = geometry.getAttribute('position');
  const perRing = radialSegments + 1;
  const centre = new Vector3();
  const vertex = new Vector3();
  for (let ring = 0; ring <= tubularSegments; ring++) {
    const t = ring / tubularSegments;
    curve.getPointAt(t, centre);
    const scale = (rootRadius + (tipRadius - rootRadius) * t) / rootRadius;
    for (let j = 0; j < perRing; j++) {
      const index = ring * perRing + j;
      vertex.fromBufferAttribute(positions, index);
      vertex.sub(centre).multiplyScalar(scale).add(centre);
      positions.setXYZ(index, vertex.x, vertex.y, vertex.z);
    }
  }
  positions.needsUpdate = true;
  return capTube(geometry, tubularSegments, radialSegments, curve);
}

function capTube(
  tube: BufferGeometry,
  tubularSegments: number,
  radialSegments: number,
  curve: CatmullRomCurve3,
): BufferGeometry {
  const positions = Array.from(tube.getAttribute('position').array as Float32Array);
  const indices = Array.from(tube.getIndex()!.array as Uint16Array | Uint32Array);
  const perRing = radialSegments + 1;
  const centre = new Vector3();
  for (const [ring, reverse] of [[0, true], [tubularSegments, false]] as const) {
    curve.getPointAt(ring / tubularSegments, centre);
    const centreIndex = positions.length / 3;
    positions.push(centre.x, centre.y, centre.z);
    const ringStart = ring * perRing;
    for (let j = 0; j < radialSegments; j++) {
      const a = ringStart + j;
      const b = ringStart + j + 1;
      if (reverse) indices.push(centreIndex, b, a);
      else indices.push(centreIndex, a, b);
    }
  }
  const capped = new BufferGeometry();
  capped.setAttribute('position', new Float32BufferAttribute(positions, 3));
  capped.setIndex(indices);
  capped.computeVertexNormals();
  tube.dispose();
  return capped;
}

export function deform(geometry: BufferGeometry, fn: (v: Vector3) => void): BufferGeometry {
  const positions = geometry.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < positions.count; i++) {
    v.fromBufferAttribute(positions, i);
    fn(v);
    positions.setXYZ(i, v.x, v.y, v.z);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

export function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  return (index ? index.count : geometry.getAttribute('position').count) / 3;
}

// The small geometry vocabulary the species files share, on top of
// ../whaleHull.ts's swept hull.
//
// Everything here returns INDEXED geometry, deliberately. rigSkin.ts groups a
// rig's parts into surfaces by material signature AND by indexed/non-indexed,
// so a hull (indexed) beside an extruded fin (three's ExtrudeGeometry is not)
// costs a second draw call per species. Welding the extrusion's vertices
// (`mergeVertices`) makes it indexed at no visible cost, and a whole species
// then bakes to ONE surface — which is the number client/index.ts budgets per
// species and the number the 140 fps rule is paid in.
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

/**
 * Bevel proportions for a fin slab, as fractions of its thickness. A fin is a
 * plate with rounded edges: enough bevel to catch light along the edge, not so
 * much that a thin fin becomes a lens.
 */
const FIN_BEVEL_THICKNESS_RATIO = 0.3;
const FIN_BEVEL_SIZE_RATIO = 0.42;
const FIN_BEVEL_SEGMENTS = 1;
/** Outline subdivision for the curved fin edges. */
const FIN_CURVE_SEGMENTS = 7;

/** Welds coincident vertices so an extrusion joins the indexed surfaces. */
export function indexed(geometry: BufferGeometry): BufferGeometry {
  const welded = mergeVertices(geometry);
  geometry.dispose();
  welded.computeVertexNormals();
  return welded;
}

/**
 * A flat fin, flipper or wing lying in the XZ plane (span along ±Z, thickness
 * along Y) — whaleHull's `finGeometry`, indexed. `sign` mirrors it for the
 * other side of the body.
 */
export function flatFin(
  buildOutline: (shape: Shape, sign: number) => void,
  sign: number,
  depth: number,
): BufferGeometry {
  // The same construction as whaleHull's finGeometry, at this kit's leaner
  // tessellation: a whale is one of ~20 on screen, a fish one of hundreds, and
  // the 24-segment / 2-bevel flipper cost more than the hull it hung on.
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
  // Outline in XY, extruded along +Z; lay it flat with thickness in Y.
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, -depth / 2, 0);
  return indexed(geometry);
}

/**
 * An upright fin standing in the XY plane (thickness along Z): a dorsal, a
 * caudal blade, an anal fin. The outline is authored with +X forward and +Y
 * up, exactly as the animal is seen from the side.
 */
export function uprightFin(buildOutline: (shape: Shape) => void, depth: number): BufferGeometry {
  const shape = new Shape();
  buildOutline(shape);
  const geometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * FIN_BEVEL_THICKNESS_RATIO,
    bevelSize: depth * FIN_BEVEL_SIZE_RATIO,
    bevelSegments: FIN_BEVEL_SEGMENTS,
    curveSegments: FIN_CURVE_SEGMENTS,
  });
  geometry.translate(0, 0, -depth / 2);
  return indexed(geometry);
}

export interface LimbOptions {
  /** Radius at the hip/shoulder end. */
  readonly rootRadius: number;
  /** Radius at the hoof/paw end. */
  readonly tipRadius: number;
  /** Root-to-tip length. */
  readonly length: number;
  readonly radialSegments: number;
  readonly heightSegments: number;
}

/**
 * A tapered limb hanging DOWN from its root: the root is at the origin and the
 * tip at y = -length, so a Group placed at the hip swings it about the hip.
 */
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

/** A smooth ellipsoid of the given FULL extents (length along X, height Y, width Z). */
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
  /** Control points from root to tip, in the parent's space. */
  readonly path: readonly Vector3[];
  readonly rootRadius: number;
  readonly tipRadius: number;
  readonly tubularSegments: number;
  readonly radialSegments: number;
}

/**
 * A horn, tusk or whip tail: a tube along a Catmull-Rom path that TAPERS from
 * root to tip. TubeGeometry has one radius, so the taper is applied afterwards
 * by scaling each ring about the path — the rings are laid out in path order,
 * `radialSegments + 1` vertices per ring, which is what makes that possible
 * without rebuilding the tube.
 */
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

/**
 * TubeGeometry is OPEN at both ends — a neck or a tail root shows as a hole
 * you can see the backdrop through. Closes both rings with a fan to a centre
 * vertex on the path.
 */
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

/**
 * Sets the geometry's vertex positions through `fn`, in place. For the small
 * asymmetries a swept body cannot express — a shark's flattened belly, a ray's
 * depressed body.
 */
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

/** Triangle count of an indexed or non-indexed geometry — for the budget notes. */
export function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  return (index ? index.count : geometry.getAttribute('position').count) / 3;
}

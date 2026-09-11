import type { BufferGeometry } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// A flat-shaded material takes its normals from screen derivatives (NodeBuilder.isFlatShading),
// so vertices that differ only by face normal weld into one indexed vertex the GPU shades once.
export function weldFlatShaded(geometry: BufferGeometry): BufferGeometry {
  geometry.deleteAttribute('normal');
  const welded = mergeVertices(geometry);
  geometry.dispose();
  welded.computeVertexNormals();
  return welded;
}

// Welds only vertices identical in every attribute: exact, so smooth-shaded surfaces keep
// their normals; it undoes the duplication `toNonIndexed` baked in.
export function weldIdentical(geometry: BufferGeometry): BufferGeometry {
  const welded = mergeVertices(geometry);
  geometry.dispose();
  return welded;
}

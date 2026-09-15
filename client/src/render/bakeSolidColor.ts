import { BufferAttribute, Color, type BufferGeometry } from 'three';

// Paints every vertex of a colorless geometry with one solid color, so a
// shared white `vertexColors` material renders exactly what a per-color
// `material.color` did before: output = white × baked = original color.
// three converts the hex through the same working-space path as
// `new Color(hex)` on a material, so the floats match bit-for-bit.
// Throws when the geometry already carries a color attribute — merging two
// color sources silently would be a visual bug, never a blend.
export function bakeSolidColor(geometry: BufferGeometry, hex: number): BufferGeometry {
  if (geometry.getAttribute('color') !== undefined) {
    throw new Error('bakeSolidColor: geometry already has a color attribute.');
  }
  const color = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

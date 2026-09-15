import { BufferAttribute, Color, type BufferGeometry } from 'three';

// Paints every vertex one solid color so a shared white `vertexColors`
// material renders what `material.color` did. Throws on an existing color
// attribute — a silent blend would be a bug.
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

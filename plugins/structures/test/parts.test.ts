// The part-merge contract (client/partMerge.ts). These build real Three.js
// objects but never a WebGLRenderer, so they run headless — BufferGeometry and
// the material classes are plain data structures (the same thing
// plugins/boats/test/models.test.ts relies on).
//
// What is asserted here is the CONTRACT, not any one tier's wiring: which
// materials may share a draw call, and that merging preserves the triangles,
// the world positions and the colours a separate-mesh build would have drawn.
// What a picture would show is verified by eye through client/preview.html —
// this covers the arithmetic a picture is bad at.

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  DoubleSide,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
} from 'three';
import { canShareOneSurface, mergeSurfaceParts, type StructurePart } from '../client/partMerge.ts';

/** A plain surface material, exactly as models.ts's `lambert()` builds one. */
function plainLambert(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true, emissive: 0x000000 });
}

/** A unit-cube part at `matrices`, in `color`. */
function boxPart(color: number, matrices: Matrix4[]): StructurePart {
  return { geometry: new BoxGeometry(1, 1, 1), material: plainLambert(color), localMatrices: matrices };
}

/** Every distinct vertex position in a geometry, as "x,y,z" strings. */
function positionKeys(part: StructurePart): Set<string> {
  const position = part.geometry.getAttribute('position');
  const keys = new Set<string>();
  const point = new Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    keys.add(`${point.x.toFixed(4)},${point.y.toFixed(4)},${point.z.toFixed(4)}`);
  }
  return keys;
}

function triangleCount(part: StructurePart): number {
  const index = part.geometry.index;
  const vertices = index !== null ? index.count : part.geometry.getAttribute('position').count;
  return (vertices / 3) * part.localMatrices.length;
}

describe('which materials may share one surface', () => {
  it('accepts a plain opaque flat-shaded Lambert surface', () => {
    expect(canShareOneSurface(plainLambert(0x886644))).toBe(true);
  });

  it('rejects a glowing material, because emissive is a whole-draw-call uniform', () => {
    // models.ts's windowMaterial() and the campfire — folding these in would
    // silently unlight them, which is the exact failure this guard exists for.
    const window = new MeshLambertMaterial({
      color: 0x2a1c10,
      flatShading: true,
      emissive: 0xffcf7a,
      emissiveIntensity: 0.5,
    });
    expect(canShareOneSurface(window)).toBe(false);
  });

  it('rejects a transparent material, which needs its own draw order', () => {
    const dancerLimb = new MeshLambertMaterial({ flatShading: true, transparent: true, opacity: 0 });
    expect(canShareOneSurface(dancerLimb)).toBe(false);
  });

  it('rejects a smooth-shaded material, which the flat-shaded surface would re-shade', () => {
    expect(canShareOneSurface(new MeshLambertMaterial({ color: 0x886644 }))).toBe(false);
  });

  it('rejects a double-sided material, which the front-faced surface would cull', () => {
    expect(canShareOneSurface(new MeshLambertMaterial({ flatShading: true, side: DoubleSide }))).toBe(false);
  });

  it('rejects a material that is not Lambert at all', () => {
    expect(canShareOneSurface(new MeshBasicMaterial({ color: 0x886644 }))).toBe(false);
  });
});

describe('merging a building s parts', () => {
  it('collapses every plain part into one, and leaves the glowing ones alone', () => {
    const lit: StructurePart = {
      geometry: new BoxGeometry(0.1, 0.1, 0.1),
      material: new MeshLambertMaterial({ flatShading: true, emissive: 0xffcf7a }),
      localMatrices: [new Matrix4()],
    };
    const merged = mergeSurfaceParts([
      boxPart(0x886644, [new Matrix4()]),
      boxPart(0x445566, [new Matrix4().makeTranslation(2, 0, 0)]),
      lit,
      boxPart(0x998877, [new Matrix4().makeTranslation(0, 2, 0)]),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[1]).toBe(lit); // untouched, still its own draw call
    expect((merged[0].material as MeshLambertMaterial).vertexColors).toBe(true);
    // One instance per building, not one per part per local transform.
    expect(merged[0].localMatrices).toHaveLength(1);
    expect(merged[0].localMatrices[0].equals(new Matrix4())).toBe(true);
  });

  it('leaves a list with nothing to gain exactly as it was', () => {
    // One mergeable part is already one draw call. Merging it would cost a
    // colour attribute and a geometry copy and save nothing.
    const parts = [boxPart(0x886644, [new Matrix4()])];
    expect(mergeSurfaceParts(parts)).toEqual(parts);
  });

  it('draws the same triangles it was handed', () => {
    const parts = [
      boxPart(0x886644, [new Matrix4(), new Matrix4().makeTranslation(2, 0, 0)]),
      boxPart(0x445566, [new Matrix4().makeTranslation(0, 2, 0)]),
    ];
    const before = parts.reduce((total, part) => total + triangleCount(part), 0);
    const merged = mergeSurfaceParts(parts);
    expect(merged).toHaveLength(1);
    expect(triangleCount(merged[0])).toBe(before);
  });

  it('bakes each local transform into the vertices, so the parts stay where they were placed', () => {
    // The merged surface carries an IDENTITY transform, so if the bake were
    // skipped every part would collapse onto the building's origin.
    const merged = mergeSurfaceParts([
      boxPart(0x886644, [new Matrix4().makeTranslation(5, 0, 0)]),
      boxPart(0x445566, [new Matrix4().makeTranslation(0, 7, 0)]),
    ]);
    const keys = positionKeys(merged[0]);
    expect(keys.has('5.5000,0.5000,0.5000')).toBe(true); // a corner of the first box, still at x = 5
    expect(keys.has('0.5000,7.5000,0.5000')).toBe(true); // a corner of the second, still at y = 7
  });

  it('paints every vertex with its own part s colour, in the linear working space', () => {
    const first = plainLambert(0x886644);
    const second = plainLambert(0x445566);
    const merged = mergeSurfaceParts([
      { geometry: new BoxGeometry(1, 1, 1), material: first, localMatrices: [new Matrix4()] },
      { geometry: new BoxGeometry(1, 1, 1), material: second, localMatrices: [new Matrix4()] },
    ]);

    const colors = merged[0].geometry.getAttribute('color');
    const positions = merged[0].geometry.getAttribute('position').count;
    expect(colors.count).toBe(positions);
    // Material.color is already linear (three converts the authored sRGB hex on
    // construction) and a `color` attribute is read as linear too, so the
    // channels must match VERBATIM — a conversion either way would show up here
    // long before it showed up as washed-out buildings.
    expect(colors.getX(0)).toBeCloseTo(first.color.r, 6);
    expect(colors.getY(0)).toBeCloseTo(first.color.g, 6);
    expect(colors.getZ(0)).toBeCloseTo(first.color.b, 6);
    expect(colors.getX(colors.count - 1)).toBeCloseTo(second.color.r, 6);
    expect(colors.getY(colors.count - 1)).toBeCloseTo(second.color.g, 6);
    expect(colors.getZ(colors.count - 1)).toBeCloseTo(second.color.b, 6);
  });
});

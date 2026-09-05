// The part-merge contract (client/parts.ts). These build real Three.js
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
  DataTexture,
  DoubleSide,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Vector3,
  type Texture,
} from 'three';
import { canShareOneSurface, mergeParts, mergeSharedSurface, type StructurePart } from '../client/parts.ts';

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
    const merged = mergeParts([
      boxPart(0x886644, [new Matrix4()]),
      boxPart(0x445566, [new Matrix4().makeTranslation(2, 0, 0)]),
      lit,
      boxPart(0x998877, [new Matrix4().makeTranslation(0, 2, 0)]),
    ]);

    expect(merged).toHaveLength(2);
    // Still its own draw call, and still ITS material — only the geometry is
    // rebuilt, because step 2 bakes the local matrices in like step 1 does.
    expect(merged[1].material).toBe(lit.material);
    expect((merged[0].material as MeshLambertMaterial).vertexColors).toBe(true);
    // One instance per building, not one per part per local transform.
    expect(merged[0].localMatrices).toHaveLength(1);
    expect(merged[0].localMatrices[0].equals(new Matrix4())).toBe(true);
  });

  it('spends no colour attribute on a lone shareable part, which is already one call', () => {
    // One shareable part cannot be reduced further, so it must NOT be turned
    // into a vertex-coloured surface: that would cost a colour attribute and a
    // geometry copy for no reduction at all. It still goes through signature
    // grouping, which is what bakes its local matrices in.
    const material = plainLambert(0x886644);
    const merged = mergeParts([
      { geometry: new BoxGeometry(1, 1, 1), material, localMatrices: [new Matrix4()] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].material).toBe(material);
    expect(merged[0].geometry.getAttribute('color')).toBeUndefined();
  });

  it('mergeSharedSurface hands back every un-shareable part untouched, handles and all', () => {
    // THE PROPERTY DURAND'S RIDES ON. It keeps five material handles for
    // animate() to pulse, and two of them — the marquee's phase groups — are
    // authored identically, so mergeParts' signature step would fold them
    // together and dispose one. mergeSharedSurface must return both, as the
    // very same objects.
    const phaseA = new MeshLambertMaterial({ flatShading: true, emissive: 0xffcf7a, emissiveIntensity: 0.5 });
    const phaseB = new MeshLambertMaterial({ flatShading: true, emissive: 0xffcf7a, emissiveIntensity: 0.5 });
    const bulbA: StructurePart = { geometry: new BoxGeometry(0.1, 0.1, 0.1), material: phaseA, localMatrices: [new Matrix4()] };
    const bulbB: StructurePart = { geometry: new BoxGeometry(0.1, 0.1, 0.1), material: phaseB, localMatrices: [new Matrix4()] };

    const merged = mergeSharedSurface([
      boxPart(0x886644, [new Matrix4()]),
      bulbA,
      boxPart(0x445566, [new Matrix4().makeTranslation(2, 0, 0)]),
      bulbB,
    ]);

    expect(merged).toHaveLength(3); // one surface + both bulbs, separately
    expect(merged[1]).toBe(bulbA);
    expect(merged[2]).toBe(bulbB);
    // The handles animate() drives must still be the live materials on the
    // drawn parts — identical settings must not have collapsed them into one.
    expect(merged[1].material).toBe(phaseA);
    expect(merged[2].material).toBe(phaseB);
  });

  it('mergeParts WOULD fold those same two bulbs together — which is why Durand s does not use it', () => {
    // The counterpart to the test above, asserting the hazard is real rather
    // than imagined. If this ever stops folding them, the comment in models.ts
    // steering Durand's away from mergeParts needs revisiting.
    const glow = () => new MeshLambertMaterial({ flatShading: true, emissive: 0xffcf7a, emissiveIntensity: 0.5 });
    const merged = mergeParts([
      { geometry: new BoxGeometry(0.1, 0.1, 0.1), material: glow(), localMatrices: [new Matrix4()] },
      { geometry: new BoxGeometry(0.1, 0.1, 0.1), material: glow(), localMatrices: [new Matrix4()] },
    ]);
    expect(merged).toHaveLength(1);
  });

  it('groups the un-shareable remainder by material, instead of leaving one call each', () => {
    // Two windows lit identically are one draw call, not two — the reduction
    // that step 2 contributes on top of the surface.
    const glow = () => new MeshLambertMaterial({ flatShading: true, emissive: 0xffcf7a });
    const merged = mergeParts([
      { geometry: new BoxGeometry(0.1, 0.1, 0.1), material: glow(), localMatrices: [new Matrix4()] },
      { geometry: new BoxGeometry(0.1, 0.1, 0.1), material: glow(), localMatrices: [new Matrix4().makeTranslation(1, 0, 0)] },
    ]);
    expect(merged).toHaveLength(1);
  });

  it('draws the same triangles it was handed', () => {
    const parts = [
      boxPart(0x886644, [new Matrix4(), new Matrix4().makeTranslation(2, 0, 0)]),
      boxPart(0x445566, [new Matrix4().makeTranslation(0, 2, 0)]),
    ];
    const before = parts.reduce((total, part) => total + triangleCount(part), 0);
    const merged = mergeParts(parts);
    expect(merged).toHaveLength(1);
    expect(triangleCount(merged[0])).toBe(before);
  });

  it('bakes each local transform into the vertices, so the parts stay where they were placed', () => {
    // The merged surface carries an IDENTITY transform, so if the bake were
    // skipped every part would collapse onto the building's origin.
    const merged = mergeParts([
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
    const merged = mergeParts([
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

// ── Textured parts, since a tier can be an imported model (2026-09-04) ──────
//
// Everything above was written while every material in this plugin was a flat
// colour. An imported asset brings a textured one, and two questions the merge
// could answer loosely until now become load-bearing: which textured parts may
// share a draw call, and what the merged geometry has to carry for the
// survivor to sample the right texels.

/** A 1x1 texture. Only its IDENTITY is read here, never its texels. */
function texture(): Texture {
  return new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
}

function texturedPart(material: MeshStandardMaterial): StructurePart {
  return { geometry: new BoxGeometry(1, 1, 1), material, localMatrices: [new Matrix4()] };
}

describe('merging textured parts', () => {
  it('keeps two parts with different normal maps apart', () => {
    const map = texture();
    const merged = mergeParts([
      texturedPart(new MeshStandardMaterial({ map, normalMap: texture() })),
      texturedPart(new MeshStandardMaterial({ map, normalMap: texture() })),
    ]);

    // Two surfaces, because they shade differently. Before the map identity
    // joined the signature these merged into one, shaded by whichever material
    // happened to be first — see client/src/render/materialMaps.ts's header.
    expect(merged).toHaveLength(2);
  });

  it('merges two parts that sample exactly the same textures', () => {
    const map = texture();
    const normalMap = texture();
    const merged = mergeParts([
      texturedPart(new MeshStandardMaterial({ map, normalMap })),
      texturedPart(new MeshStandardMaterial({ map, normalMap })),
    ]);

    expect(merged).toHaveLength(1);
  });

  it('keeps the uv attribute of a merged textured surface', () => {
    const map = texture();
    const merged = mergeParts([
      texturedPart(new MeshStandardMaterial({ map })),
      texturedPart(new MeshStandardMaterial({ map })),
    ]);

    const uv = merged[0].geometry.getAttribute('uv');
    const position = merged[0].geometry.getAttribute('position');
    expect(uv).toBeDefined();
    // One uv per vertex of BOTH parts: a short (or absent) uv array is a
    // surface reading one texel for every triangle — the whole building
    // painted one flat wrong colour.
    expect(uv.count).toBe(position.count);
  });

  it('refuses the shared surface to a part that samples any texture at all', () => {
    // Not just `map`: the surface replaces the material outright, so a part
    // carrying only a normal map would have that map silently thrown away.
    const normalOnly = new MeshLambertMaterial({ flatShading: true, normalMap: texture() });
    expect(canShareOneSurface(normalOnly)).toBe(false);
  });
});

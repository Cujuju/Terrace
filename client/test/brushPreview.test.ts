import { describe, expect, it } from 'vitest';
import { Scene, type BufferAttribute, Line, LineSegments, Mesh, type Object3D, type Material } from 'three';
import {
  BAND_HEIGHT,
  DEFAULT_SCULPT_AMOUNT,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  applySculpt,
  createHeightmap,
  forEachFootprintOffset,
  sculptOptionsOf,
} from '@terrace/shared';
import {
  createBrushPreview,
  type BrushSelection,
  type CursorSurface,
} from '../src/render/brushPreview.ts';
import { createDenialCue } from '../src/render/denialCue.ts';
import { CELL_WORLD_SIZE } from '../src/config.ts';
import { BRUSH_RADII } from '../src/state/hudState.ts';

function fakeCanvas(): CursorSurface & { on: boolean; writes: number } {
  const surface = {
    on: false,
    writes: 0,
    classList: {
      toggle(_token: string, force: boolean): void {
        surface.on = force;
        surface.writes++;
      },
    },
  };
  return surface;
}

function outlineOf(scene: Scene): Line {
  const loop = scene.children.find(
    (c): c is Line => c instanceof Line && !(c instanceof LineSegments),
  );
  expect(loop).toBeDefined();
  return loop as Line;
}

function outlinePoints(line: Line): { x: number; z: number }[] {
  const position = line.geometry.getAttribute('position') as BufferAttribute;
  // The buffers are preallocated past the draw range: only the drawn prefix holds vertices.
  const count = Math.min(line.geometry.drawRange.count, position.count);
  const points: { x: number; z: number }[] = [];
  for (let i = 0; i < count; i++) {
    points.push({ x: position.getX(i) / CELL_WORLD_SIZE, z: position.getZ(i) / CELL_WORLD_SIZE });
  }
  return points;
}

function extent(line: Line): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const { x, z } of outlinePoints(line)) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

function encloses(points: { x: number; z: number }[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function renderedCells(
  radius: number,
  tool: 'stamp' | 'smooth',
  profile: 'soft' | 'hard',
): Set<string> {
  // Mirrors the preview probe: dry band-aligned ground, union of both
  // directions, so the outline never changes with sculpt mode.
  const DRY_GROUND = 8 * BAND_HEIGHT;
  const span = 2 * (MAX_BRUSH_RADIUS + 2);
  const centre = span >> 1;
  const changed = new Set<string>();
  for (const dir of [1, -1] as const) {
    const map = createHeightmap(span);
    map.cells.fill(DRY_GROUND);
    applySculpt(
      map,
      centre,
      centre,
      radius,
      DEFAULT_SCULPT_AMOUNT * dir,
      sculptOptionsOf({ type: 'sculpt', x: centre, y: centre, radius, dir, tool, profile }),
    );
    for (let j = 0; j < span; j++) {
      for (let i = 0; i < span; i++) {
        // Edited cells are detected by height change, not band change: a
        // soft edge can move heights within one drawn band.
        if (map.cells[j * span + i]! !== DRY_GROUND) {
          changed.add(`${i - centre},${j - centre}`);
        }
      }
    }
  }
  return changed;
}

function footprintReach(radius: number): number {
  let reach = 0;
  forEachFootprintOffset(radius, (dx, dy) => {
    if (Math.abs(dx) > reach) reach = Math.abs(dx);
    if (Math.abs(dy) > reach) reach = Math.abs(dy);
  });
  return reach;
}

function brush(radius: number): BrushSelection {
  return { radius, tool: 'stamp', profile: 'hard', dir: 1 };
}

const TEST_WORLD_SIZE_CELLS = 64;

const NEVER_DENIED = createDenialCue(() => false);

const FLAT_GROUND = { yAt: () => null, revisionAt: () => 0 };

describe('world-edge clipping', () => {
  const hover = { x: 0, y: 0, surfaceY: 0, face: 'tread', grabbable: false } as const;
  const stamp = { radius: BRUSH_RADII[0]!, tool: 'stamp', profile: 'hard', dir: 1 } as const;

  function footprintMaterials(scene: Scene): Material[] {
    return scene.children
      .filter((c): c is Line | LineSegments | Mesh => c instanceof Line || c instanceof Mesh)
      .map((c) => c.material as Material);
  }

  function cutAt(material: Material, nx: number, nz: number): number {
    const plane = material.clippingPlanes!.find((p) => p.normal.x === nx && p.normal.z === nz);
    expect(plane).toBeDefined();
    return -plane!.constant / (nx !== 0 ? nx : nz);
  }

  it('cuts the ring, skirt and cell grid at the editable extent, and follows a world switch', () => {
    let size = TEST_WORLD_SIZE_CELLS;
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas(), () => size, NEVER_DENIED, FLAT_GROUND);
    preview.update(hover, stamp);

    const clipped = footprintMaterials(scene).filter((m) => m.clippingPlanes !== null && m.clippingPlanes.length > 0);
    expect(clipped).toHaveLength(3);
    for (const material of clipped) {
      expect(material.clippingPlanes).toHaveLength(4);
      expect(cutAt(material, 1, 0)).toBe(-0.5 * CELL_WORLD_SIZE);
      expect(cutAt(material, -1, 0)).toBe((size - 0.5) * CELL_WORLD_SIZE);
      expect(cutAt(material, 0, 1)).toBe(-0.5 * CELL_WORLD_SIZE);
      expect(cutAt(material, 0, -1)).toBe((size - 0.5) * CELL_WORLD_SIZE);
    }

    size = TEST_WORLD_SIZE_CELLS * 2;
    preview.update(hover, stamp);
    for (const material of clipped) {
      expect(cutAt(material, -1, 0)).toBe((size - 0.5) * CELL_WORLD_SIZE);
      expect(cutAt(material, 0, -1)).toBe((size - 0.5) * CELL_WORLD_SIZE);
    }
    preview.dispose();
  });

  it('leaves the outline geometry itself position-independent — clipping is the material\'s job', () => {
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas(), () => TEST_WORLD_SIZE_CELLS, NEVER_DENIED, FLAT_GROUND);
    const line = outlineOf(scene);
    preview.update(hover, stamp);
    const centre = outlinePoints(line);
    preview.update({ ...hover, x: TEST_WORLD_SIZE_CELLS - 1, y: TEST_WORLD_SIZE_CELLS - 1 }, stamp);
    expect(outlinePoints(line)).toEqual(centre);
    preview.dispose();
  });
});

describe('createBrushPreview', () => {
  it('encloses exactly the cells the brush edits, and no others', () => {
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas(), () => TEST_WORLD_SIZE_CELLS, NEVER_DENIED, FLAT_GROUND);
    const line = outlineOf(scene);

    for (const radius of BRUSH_RADII) {
      preview.update({ x: 0, y: 0, surfaceY: 0, face: 'tread', grabbable: false }, brush(radius));
      const points = outlinePoints(line);
      expect(points.length).toBeGreaterThanOrEqual(3);

      const edited = new Set<string>();
      forEachFootprintOffset(radius, (dx, dy) => edited.add(`${dx},${dy}`));

      const scan = footprintReach(radius) + 2;
      for (let dz = -scan; dz <= scan; dz++) {
        for (let dx = -scan; dx <= scan; dx++) {
          expect({ radius, dx, dz, enclosed: encloses(points, dx, dz) }).toEqual({
            radius, dx, dz, enclosed: edited.has(`${dx},${dz}`),
          });
        }
      }
    }

    preview.dispose();
  });

  it('outlines exactly what one click renders, for every tool, edge and direction', () => {
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas(), () => TEST_WORLD_SIZE_CELLS, NEVER_DENIED, FLAT_GROUND);
    const line = outlineOf(scene);

    for (const radius of [1, 2, 4, 8]) {
      const footprint = new Set<string>();
      forEachFootprintOffset(radius, (dx, dy) => footprint.add(`${dx},${dy}`));
      for (const tool of ['stamp', 'smooth'] as const) {
        for (const profile of ['soft', 'hard'] as const) {
          for (const dir of [1, -1] as const) {
            preview.update({ x: 0, y: 0, surfaceY: 0, face: 'tread', grabbable: false }, { radius, tool, profile, dir });
            const points = outlinePoints(line);

            const rendered = renderedCells(radius, tool, profile);
            // Melt outlines its footprint: on flat ground it renders
            // nothing, but the stroke still reaches those cells on rough
            // ground. Stamp keeps the exact rendered-cells contract.
            const wanted = tool === 'smooth' ? footprint : rendered;
            const scan = footprintReach(radius) + 2;
            for (let dz = -scan; dz <= scan; dz++) {
              for (let dx = -scan; dx <= scan; dx++) {
                expect({
                  radius, tool, profile, dir, dx, dz, enclosed: encloses(points, dx, dz),
                }).toEqual({
                  radius, tool, profile, dir, dx, dz, enclosed: wanted.has(`${dx},${dz}`),
                });
              }
            }
          }
        }
      }
    }

    preview.dispose();
  });

  it('never draws a vertex outside the cells the brush edits', () => {
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas(), () => TEST_WORLD_SIZE_CELLS, NEVER_DENIED, FLAT_GROUND);
    const line = outlineOf(scene);

    for (const radius of BRUSH_RADII) {
      preview.update({ x: 0, y: 0, surfaceY: 0, face: 'tread', grabbable: false }, brush(radius));

      const edited = new Set<string>();
      forEachFootprintOffset(radius, (dx, dy) => edited.add(`${dx},${dy}`));

      for (const { x, z } of outlinePoints(line)) {
        const i = Math.round(x - Math.sign(x) * 1e-9);
        const j = Math.round(z - Math.sign(z) * 1e-9);
        expect({ radius, x, z, inside: edited.has(`${i},${j}`) }).toEqual({
          radius, x, z, inside: true,
        });
      }
    }

    preview.dispose();
  });

  it('draws the shared edge of every adjacent pair of footprint cells, once', () => {
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas(), () => TEST_WORLD_SIZE_CELLS, NEVER_DENIED, FLAT_GROUND);
    const grids = scene.children.filter(
      (c): c is LineSegments => c instanceof LineSegments,
    );

    for (const radius of BRUSH_RADII) {
      preview.update({ x: 0, y: 0, surfaceY: 0, face: 'tread', grabbable: false }, brush(radius));

      const edited = new Set<string>();
      forEachFootprintOffset(radius, (dx, dy) => edited.add(`${dx},${dy}`));
      let expected = 0;
      forEachFootprintOffset(radius, (dx, dy) => {
        if (edited.has(`${dx + 1},${dy}`)) expected++;
        if (edited.has(`${dx},${dy + 1}`)) expected++;
      });

      const counts = grids.map(
        (g) =>
          Math.min(g.geometry.drawRange.count, g.geometry.getAttribute('position').count) / 2,
      );
      expect({ radius, hasGrid: counts.includes(expected) }).toEqual({
        radius, hasGrid: true,
      });
    }

    preview.dispose();
  });

  it('centres every radius outline on the object origin', () => {
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas(), () => TEST_WORLD_SIZE_CELLS, NEVER_DENIED, FLAT_GROUND);
    const line = outlineOf(scene);

    for (const radius of BRUSH_RADII) {
      preview.update({ x: 0, y: 0, surfaceY: 0, face: 'tread', grabbable: false }, brush(radius));
      const { minX, maxX, minZ, maxZ } = extent(line);
      expect(minX).toBeCloseTo(-maxX);
      expect(minZ).toBeCloseTo(-maxZ);
      expect(maxX).toBeCloseTo(maxZ);
      const reach = footprintReach(radius);
      expect(maxX).toBeGreaterThan(reach);
      expect(maxX).toBeLessThanOrEqual(reach + 0.5);
    }

    preview.dispose();
  });

  it('places the outline at the hovered cell centre', () => {
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas(), () => TEST_WORLD_SIZE_CELLS, NEVER_DENIED, FLAT_GROUND);
    const line = outlineOf(scene);

    preview.update({ x: 7, y: 11, surfaceY: 3, face: 'tread', grabbable: false }, brush(MIN_BRUSH_RADIUS));
    expect(line.position.x).toBeCloseTo(7 * CELL_WORLD_SIZE);
    expect(line.position.z).toBeCloseTo(11 * CELL_WORLD_SIZE);
    expect(line.visible).toBe(true);

    preview.dispose();
  });

  it('hides the pointer exactly while an outline is drawn', () => {
    const scene = new Scene();
    const canvas = fakeCanvas();
    const preview = createBrushPreview(scene, canvas, () => TEST_WORLD_SIZE_CELLS, NEVER_DENIED, FLAT_GROUND);

    expect(canvas.on).toBe(false);

    preview.update({ x: 3, y: 4, surfaceY: 1, face: 'tread', grabbable: false }, brush(MIN_BRUSH_RADIUS));
    expect(canvas.on).toBe(true);

    preview.update(null, brush(MIN_BRUSH_RADIUS));
    expect(canvas.on).toBe(false);

    preview.update({ x: 3, y: 4, surfaceY: 1, face: 'tread', grabbable: false }, brush(MIN_BRUSH_RADIUS));
    preview.update({ x: 3, y: 4, surfaceY: 1, face: 'tread', grabbable: false }, brush(MAX_BRUSH_RADIUS + 1));
    expect(canvas.on).toBe(false);

    preview.update({ x: 3, y: 4, surfaceY: 1, face: 'tread', grabbable: false }, brush(MIN_BRUSH_RADIUS));
    preview.dispose();
    expect(canvas.on).toBe(false);
  });

  it('writes the cursor class only when it changes', () => {
    const scene = new Scene();
    const canvas = fakeCanvas();
    const preview = createBrushPreview(scene, canvas, () => TEST_WORLD_SIZE_CELLS, NEVER_DENIED, FLAT_GROUND);

    for (let frame = 0; frame < 60; frame++) {
      preview.update({ x: 2, y: 2, surfaceY: 0, face: 'tread', grabbable: false }, brush(MIN_BRUSH_RADIUS));
    }
    expect(canvas.writes).toBe(1);

    for (let frame = 0; frame < 60; frame++) preview.update(null, brush(MIN_BRUSH_RADIUS));
    expect(canvas.writes).toBe(2);

    preview.dispose();
  });
});

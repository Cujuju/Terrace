// Brush-outline geometry tests. Like frontierFog.test.ts these build real
// Three.js objects but never a WebGLRenderer, so they run headless.
//
// The contract under test is the one the player sees: the outline must sit ON
// the cells the brush edits. Because every brush footprint is symmetric about
// its centre cell, that reduces to a check the geometry can make on its own —
// the outline's bounding box is centred on the object's origin, and the object
// is positioned at the hovered cell's centre.

import { describe, expect, it } from 'vitest';
import { Scene, type BufferAttribute, type LineLoop } from 'three';
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS, forEachFootprintOffset } from '@terrace/shared';
import { createBrushPreview, type CursorSurface } from '../src/render/brushPreview.ts';
import { CELL_WORLD_SIZE } from '../src/config.ts';

/**
 * Stands in for the canvas: records whether the cursor-hiding class is on, and
 * counts writes so the per-frame call can be shown not to touch the DOM while
 * the state is unchanged.
 */
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

/** The single closed line the preview adds to the scene. */
function outlineOf(scene: Scene): LineLoop {
  expect(scene.children).toHaveLength(1);
  return scene.children[0] as LineLoop;
}

/** The outline's local vertices as (x, z) pairs, in cells. */
function outlinePoints(line: LineLoop): { x: number; z: number }[] {
  const position = line.geometry.getAttribute('position') as BufferAttribute;
  const points: { x: number; z: number }[] = [];
  for (let i = 0; i < position.count; i++) {
    points.push({ x: position.getX(i) / CELL_WORLD_SIZE, z: position.getZ(i) / CELL_WORLD_SIZE });
  }
  return points;
}

/** Min/max of the outline's local positions on the X and Z axes. */
function extent(line: LineLoop): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const { x, z } of outlinePoints(line)) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Ray-crossing test against the closed outline. */
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

/** How far the footprint reaches from its centre cell, in cells. */
function footprintReach(radius: number): number {
  let reach = 0;
  forEachFootprintOffset(radius, (dx, dy) => {
    if (Math.abs(dx) > reach) reach = Math.abs(dx);
    if (Math.abs(dy) > reach) reach = Math.abs(dy);
  });
  return reach;
}

describe('createBrushPreview', () => {
  it('encloses exactly the cells the brush edits, and no others', () => {
    // The terrain's honesty invariant, applied to the preview: a contour never
    // crosses a cell centre, so the region it bounds is a set of whole cells.
    // Asserting membership at cell centres — rather than a bounding box — is
    // what makes this a test of the PROMISE ("these cells move") instead of a
    // snapshot of whichever smoothing pass happens to be configured.
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas());
    const line = outlineOf(scene);

    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      preview.update({ x: 0, y: 0, surfaceY: 0 }, radius);
      const points = outlinePoints(line);
      expect(points.length).toBeGreaterThanOrEqual(3);

      const edited = new Set<string>();
      forEachFootprintOffset(radius, (dx, dy) => edited.add(`${dx},${dy}`));

      const scan = footprintReach(radius) + 2; // a ring of clear cells around it
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

  it('centres every radius outline on the object origin', () => {
    // Every footprint is symmetric about its centre cell, so the outline of one
    // must be too. This is what catches a half-cell placement error: it fails
    // the moment the drawn shape stops agreeing with the cells it stands for,
    // whatever geometry is used to draw it.
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas());
    const line = outlineOf(scene);

    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      preview.update({ x: 0, y: 0, surfaceY: 0 }, radius);
      const { minX, maxX, minZ, maxZ } = extent(line);
      expect(minX).toBeCloseTo(-maxX);
      expect(minZ).toBeCloseTo(-maxZ);
      expect(maxX).toBeCloseTo(maxZ);
      // It must still reach out over the outermost edited cells: past their
      // centres, and never past the cell edge beyond them.
      const reach = footprintReach(radius);
      expect(maxX).toBeGreaterThan(reach);
      expect(maxX).toBeLessThanOrEqual(reach + 0.5);
    }

    preview.dispose();
  });

  it('places the outline at the hovered cell centre', () => {
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas());
    const line = outlineOf(scene);

    preview.update({ x: 7, y: 11, surfaceY: 3 }, MIN_BRUSH_RADIUS);
    expect(line.position.x).toBeCloseTo(7 * CELL_WORLD_SIZE);
    expect(line.position.z).toBeCloseTo(11 * CELL_WORLD_SIZE);
    expect(line.visible).toBe(true);

    preview.dispose();
  });

  it('hides the pointer exactly while an outline is drawn', () => {
    const scene = new Scene();
    const canvas = fakeCanvas();
    const preview = createBrushPreview(scene, canvas);

    // Nothing hovered yet: the player still has their arrow.
    expect(canvas.on).toBe(false);

    preview.update({ x: 3, y: 4, surfaceY: 1 }, MIN_BRUSH_RADIUS);
    expect(canvas.on).toBe(true);

    // Off the terrain — sky, off-world, pointer gone. The arrow must come back
    // rather than leave the player with no pointer and no outline.
    preview.update(null, MIN_BRUSH_RADIUS);
    expect(canvas.on).toBe(false);

    // An illegal radius hides the outline too, and must restore the arrow on
    // that path as well.
    preview.update({ x: 3, y: 4, surfaceY: 1 }, MIN_BRUSH_RADIUS);
    preview.update({ x: 3, y: 4, surfaceY: 1 }, MAX_BRUSH_RADIUS + 1);
    expect(canvas.on).toBe(false);

    // Disposing must not strand the page with a hidden pointer.
    preview.update({ x: 3, y: 4, surfaceY: 1 }, MIN_BRUSH_RADIUS);
    preview.dispose();
    expect(canvas.on).toBe(false);
  });

  it('writes the cursor class only when it changes', () => {
    const scene = new Scene();
    const canvas = fakeCanvas();
    const preview = createBrushPreview(scene, canvas);

    // `update` runs every frame; a steady hover must not touch the DOM.
    for (let frame = 0; frame < 60; frame++) {
      preview.update({ x: 2, y: 2, surfaceY: 0 }, MIN_BRUSH_RADIUS);
    }
    expect(canvas.writes).toBe(1);

    for (let frame = 0; frame < 60; frame++) preview.update(null, MIN_BRUSH_RADIUS);
    expect(canvas.writes).toBe(2);

    preview.dispose();
  });
});

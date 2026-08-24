// Brush-outline geometry tests. Like frontierFog.test.ts these build real
// Three.js objects but never a WebGLRenderer, so they run headless.
//
// The contract under test is the one the player sees: the outline must sit ON
// the cells the brush edits. Because every brush footprint is symmetric about
// its centre cell, that reduces to a check the geometry can make on its own —
// the outline's bounding box is centred on the object's origin, and the object
// is positioned at the hovered cell's centre.

import { describe, expect, it } from 'vitest';
import { Scene, type BufferAttribute, LineLoop, LineSegments, type Object3D } from 'three';
import {
  DEFAULT_SCULPT_AMOUNT,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  applySculpt,
  bandOf,
  createHeightmap,
  forEachFootprintOffset,
  sculptOptionsOf,
} from '@terrace/shared';
import {
  createBrushPreview,
  type BrushSelection,
  type CursorSurface,
} from '../src/render/brushPreview.ts';
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

/** The closed outline line the preview adds to the scene (the crosshair is a separate LineSegments). */
function outlineOf(scene: Scene): LineLoop {
  const loop = scene.children.find((c): c is LineLoop => c instanceof LineLoop);
  expect(loop).toBeDefined();
  return loop as LineLoop;
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

/**
 * The cells one click of this brush VISIBLY changes on flat band-aligned
 * ground, computed the long way round — a real sculpt on a real heightmap,
 * compared band for band. Deliberately not the preview's own helper: a test
 * that asked the module for its own answer would agree with any bug.
 */
function renderedCells(
  radius: number,
  tool: 'stamp' | 'smooth',
  profile: 'soft' | 'hard',
): Set<string> {
  const span = 2 * (MAX_BRUSH_RADIUS + 2);
  const centre = span >> 1;
  const map = createHeightmap(span);
  const before = map.cells.map(bandOf);
  applySculpt(
    map,
    centre,
    centre,
    radius,
    DEFAULT_SCULPT_AMOUNT,
    sculptOptionsOf({ type: 'sculpt', x: centre, y: centre, radius, dir: 1, tool, profile }),
  );
  const changed = new Set<string>();
  for (let j = 0; j < span; j++) {
    for (let i = 0; i < span; i++) {
      if (bandOf(map.cells[j * span + i]!) !== before[j * span + i]) {
        changed.add(`${i - centre},${j - centre}`);
      }
    }
  }
  return changed;
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

/**
 * A brush selection at the stamp+hard combination — the one the outline was
 * always true for, and the HUD's default since 2026-08-22. Tests that are about
 * radius say so by varying only the radius.
 */
function brush(radius: number): BrushSelection {
  return { radius, tool: 'stamp', profile: 'hard' };
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
      preview.update({ x: 0, y: 0, surfaceY: 0, hitRiser: false, grabbable: false }, brush(radius));
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

  it('outlines exactly what one click renders, for every tool and edge', () => {
    // THE CONTRACT THE WHOLE MODULE EXISTS FOR (owner, 2026-08-22: "I want the
    // outline to be exactly the same size as what I'm going to get for a single
    // click on flat land"). The reference is not the footprint — that is the
    // set of cells whose stored HEIGHT moves, and it only equals what the
    // player sees under stamp+hard. It is a real applySculpt on a flat map,
    // compared band for band, which is what the player actually sees.
    //
    // Tool and edge are both varied because both move the answer: measured on
    // the 0.75 brush, one click renders 0.75 units as a stamp and 0.25 as a
    // smooth. An outline blind to that was the bug.
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas());
    const line = outlineOf(scene);

    for (const radius of [1, 2, 4, 8]) {
      for (const tool of ['stamp', 'smooth'] as const) {
        for (const profile of ['soft', 'hard'] as const) {
          preview.update({ x: 0, y: 0, surfaceY: 0, hitRiser: false, grabbable: false }, { radius, tool, profile });
          const points = outlinePoints(line);

          const rendered = renderedCells(radius, tool, profile);
          const scan = footprintReach(radius) + 2;
          for (let dz = -scan; dz <= scan; dz++) {
            for (let dx = -scan; dx <= scan; dx++) {
              expect({
                radius, tool, profile, dx, dz, enclosed: encloses(points, dx, dz),
              }).toEqual({
                radius, tool, profile, dx, dz, enclosed: rendered.has(`${dx},${dz}`),
              });
            }
          }
        }
      }
    }

    preview.dispose();
  });

  it('never draws a vertex outside the cells the brush edits', () => {
    // STRICTER THAN THE TEST ABOVE, and it has to be (owner, 2026-08-22: "draw
    // the brush outline inside the cells the brush edits, not outside"). Cell-
    // centre membership tolerates an outline that bulges up to half a cell into
    // ground the brush will not touch, because a bulge that small never reaches
    // the next centre. This asserts the promise at the only place it can be
    // broken — every vertex of the line itself.
    //
    // It is a real regression guard, not a restatement: before the clamp in
    // brushPreview.ts, Chaikin pushed 24 of radius 8's 96 vertices and 48 of
    // radius 16's 160 over concave steps, overhanging by 0.1875 of a cell.
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas());
    const line = outlineOf(scene);

    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      preview.update({ x: 0, y: 0, surfaceY: 0, hitRiser: false, grabbable: false }, brush(radius));

      const edited = new Set<string>();
      forEachFootprintOffset(radius, (dx, dy) => edited.add(`${dx},${dy}`));

      for (const { x, z } of outlinePoints(line)) {
        // A point lies in the union of the edited unit squares exactly when the
        // cell it rounds into is edited: cell (i, j) covers [i±0.5, j±0.5], and
        // rounding is what picks that cell. Float slop at an exact cell edge is
        // absorbed by nudging the point a hair inward before rounding.
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
    // The cell grid the owner asked to see inside the ring. Interior edges
    // only: the footprint's own boundary is the ring's line, and emitting it
    // here too would double its brightness. "Once" is the half of the contract
    // that a segment count alone would not catch — a grid drawn from all four
    // edges of every cell looks identical and is twice the geometry.
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas());
    const grids = scene.children.filter(
      (c): c is LineSegments => c instanceof LineSegments,
    );

    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      preview.update({ x: 0, y: 0, surfaceY: 0, hitRiser: false, grabbable: false }, brush(radius));

      const edited = new Set<string>();
      forEachFootprintOffset(radius, (dx, dy) => edited.add(`${dx},${dy}`));
      let expected = 0;
      forEachFootprintOffset(radius, (dx, dy) => {
        if (edited.has(`${dx + 1},${dy}`)) expected++;
        if (edited.has(`${dx},${dy + 1}`)) expected++;
      });

      // The crosshair is a LineSegments too and never changes with radius, so
      // the grid is identified as the one whose vertex count tracks the
      // footprint rather than by its position in the scene.
      const counts = grids.map((g) => g.geometry.getAttribute('position').count / 2);
      expect({ radius, hasGrid: counts.includes(expected) }).toEqual({
        radius, hasGrid: true,
      });
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
      preview.update({ x: 0, y: 0, surfaceY: 0, hitRiser: false, grabbable: false }, brush(radius));
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

    preview.update({ x: 7, y: 11, surfaceY: 3, hitRiser: false, grabbable: false }, brush(MIN_BRUSH_RADIUS));
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

    preview.update({ x: 3, y: 4, surfaceY: 1, hitRiser: false, grabbable: false }, brush(MIN_BRUSH_RADIUS));
    expect(canvas.on).toBe(true);

    // Off the terrain — sky, off-world, pointer gone. The arrow must come back
    // rather than leave the player with no pointer and no outline.
    preview.update(null, brush(MIN_BRUSH_RADIUS));
    expect(canvas.on).toBe(false);

    // An illegal radius hides the outline too, and must restore the arrow on
    // that path as well.
    preview.update({ x: 3, y: 4, surfaceY: 1, hitRiser: false, grabbable: false }, brush(MIN_BRUSH_RADIUS));
    preview.update({ x: 3, y: 4, surfaceY: 1, hitRiser: false, grabbable: false }, brush(MAX_BRUSH_RADIUS + 1));
    expect(canvas.on).toBe(false);

    // Disposing must not strand the page with a hidden pointer.
    preview.update({ x: 3, y: 4, surfaceY: 1, hitRiser: false, grabbable: false }, brush(MIN_BRUSH_RADIUS));
    preview.dispose();
    expect(canvas.on).toBe(false);
  });

  it('writes the cursor class only when it changes', () => {
    const scene = new Scene();
    const canvas = fakeCanvas();
    const preview = createBrushPreview(scene, canvas);

    // `update` runs every frame; a steady hover must not touch the DOM.
    for (let frame = 0; frame < 60; frame++) {
      preview.update({ x: 2, y: 2, surfaceY: 0, hitRiser: false, grabbable: false }, brush(MIN_BRUSH_RADIUS));
    }
    expect(canvas.writes).toBe(1);

    for (let frame = 0; frame < 60; frame++) preview.update(null, brush(MIN_BRUSH_RADIUS));
    expect(canvas.writes).toBe(2);

    preview.dispose();
  });
});

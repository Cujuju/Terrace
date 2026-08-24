// The RIBBON's contract (client/src/render/water/waterCourse.ts).
//
// These are contract tests, not callsite tests: what the owner asked for on
// 2026-08-23 is a river that "draws as a single object" and that never draws
// below the ocean, so those are exactly the two properties asserted — over a
// course walked down a terraced cone, the same fixture shape the retired
// riser integration test used.
//
// REPLACES waterFallIntegration.test.ts, which drove the region tread builder
// and the per-segment riser as a pair. There is no riser any more: a fall is
// the stretch of the strip where two consecutive cross-sections differ in
// height, so "is a fall emitted at all" is no longer a question a separate
// classifier can get wrong, and it is covered here by the drop assertion.
import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, bandOf } from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../src/config.ts';
import {
  appendCourseRibbon,
  type CourseNode,
  type GroundSampler,
} from '../src/render/water/waterCourse.ts';

/** World Y per band, matching riverRig's own bandWorldY at HEIGHT_WORLD_SCALE. */
const BAND_WORLD_Y = 0.25;
/** The sea plane, in the same world units — riverRig's seaSurfaceY. */
const SEA_SURFACE_Y = 1 / 32;
/** Height units the cone loses per cell of course: five bands a cell. */
const DROP_PER_CELL = BAND_HEIGHT * 5;
const SUMMIT = BAND_HEIGHT * 20;

/**
 * The cone the course runs down, as the RIBBON sees it: the drawn (terraced)
 * ground at any point, in the same band-quantised world Y riverRig hands over.
 * The flank falls along +X only, so a cross-section's two rims sit at the same
 * height and the drape is a pure test of "is it on the ground", not of tilt.
 */
const coneGround: GroundSampler = (cellX) =>
  bandOf(SUMMIT - Math.max(0, Math.floor(cellX) - 32) * DROP_PER_CELL) * BAND_WORLD_Y;

/** A course running straight down a flank, one cell per step. */
function coneCourse(steps: number): CourseNode[] {
  const nodes: CourseNode[] = [];
  for (let step = 0; step <= steps; step++) {
    const height = SUMMIT - step * DROP_PER_CELL;
    nodes.push({
      cellX: 32.5 + step,
      cellY: 32.5,
      surfaceY: bandOf(height) * BAND_WORLD_Y,
      pooled: false,
    });
  }
  return nodes;
}

/**
 * How many connected components the triangle soup has under EXACT vertex
 * equality. The ribbon's promise is that consecutive quads reuse their
 * neighbour's rim vertices verbatim, so anything but 1 means a join opened.
 */
function componentCount(positions: readonly number[]): number {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const add = (key: string): void => {
    if (!parent.has(key)) parent.set(key, key);
  };
  const union = (a: string, b: string): void => {
    add(a);
    add(b);
    parent.set(find(a), find(b));
  };
  for (let i = 0; i < positions.length; i += 9) {
    const keys = [0, 3, 6].map(
      (o) => `${positions[i + o]},${positions[i + o + 1]},${positions[i + o + 2]}`,
    );
    union(keys[0]!, keys[1]!);
    union(keys[1]!, keys[2]!);
  }
  const roots = new Set<string>();
  for (const key of parent.keys()) roots.add(find(key));
  return roots.size;
}

describe('a course ribbon', () => {
  it('is ONE connected object from source to mouth, however often it steps down', () => {
    const triangles: number[] = [];
    appendCourseRibbon(coneCourse(6), coneGround, SEA_SURFACE_Y, triangles);

    expect(triangles.length).toBeGreaterThan(0);
    expect(componentCount(triangles)).toBe(1);
  });

  it('draws the vertical faces, not only the flat treads', () => {
    const triangles: number[] = [];
    appendCourseRibbon(coneCourse(6), coneGround, SEA_SURFACE_Y, triangles);

    // A triangle spanning two heights is falling water; one at a single height
    // is a tread. The cone drops five bands a cell, so both must be present.
    let falling = 0;
    let flat = 0;
    for (let i = 0; i < triangles.length; i += 9) {
      const ys = [triangles[i + 1]!, triangles[i + 4]!, triangles[i + 7]!];
      if (Math.min(...ys) === Math.max(...ys)) flat++;
      else falling++;
    }
    expect(flat).toBeGreaterThan(0);
    expect(falling).toBeGreaterThan(0);
  });

  it('paints every tread vertex onto the ground under IT, not under the centre', () => {
    // A flank falling along +Z as well as +X, so the two rims of a
    // cross-section sit at DIFFERENT heights — the case a centre-height
    // cross-section gets wrong by hanging its outer rim over the step.
    const tilted: GroundSampler = (cellX, cellY) =>
      bandOf(SUMMIT - (Math.floor(cellX) + Math.floor(cellY)) * DROP_PER_CELL) * BAND_WORLD_Y;

    const triangles: number[] = [];
    appendCourseRibbon(coneCourse(6), tilted, SEA_SURFACE_Y, triangles);

    // Only FLAT triangles are treads; a fall's top edge deliberately stands at
    // the upstream height over the downstream column, which is the water
    // leaving the lip rather than water floating over ground.
    let treadVertices = 0;
    for (let i = 0; i < triangles.length; i += 9) {
      const ys = [triangles[i + 1]!, triangles[i + 4]!, triangles[i + 7]!];
      if (Math.min(...ys) !== Math.max(...ys)) continue;
      for (const o of [0, 3, 6]) {
        const x = triangles[i + o]! / CELL_WORLD_SIZE;
        const z = triangles[i + o + 2]! / CELL_WORLD_SIZE;
        expect(triangles[i + o + 1]!).toBeCloseTo(Math.max(SEA_SURFACE_Y, tilted(x, z)), 10);
        treadVertices++;
      }
    }
    expect(treadVertices).toBeGreaterThan(0);
  });

  it('never writes a vertex below the sea, and stops at the waterline', () => {
    // A course that runs on past the shore: the last nodes are under the sea.
    const nodes = coneCourse(6);
    nodes.push(
      { cellX: 39.5, cellY: 32.5, surfaceY: 0, pooled: false },
      { cellX: 40.5, cellY: 32.5, surfaceY: -BAND_WORLD_Y, pooled: false },
    );

    const triangles: number[] = [];
    appendCourseRibbon(nodes, coneGround, SEA_SURFACE_Y, triangles);

    let lowest = Infinity;
    for (let i = 1; i < triangles.length; i += 3) lowest = Math.min(lowest, triangles[i]!);
    expect(lowest).toBe(SEA_SURFACE_Y);
    // …and it still reaches the waterline rather than stopping short of it.
    expect(triangles.length).toBeGreaterThan(0);
    expect(componentCount(triangles)).toBe(1);
  });

  it('leaves a pooled stretch to the lake region, but still joins it', () => {
    const nodes: CourseNode[] = [
      { cellX: 10.5, cellY: 10.5, surfaceY: 3 * BAND_WORLD_Y, pooled: false },
      { cellX: 11.5, cellY: 10.5, surfaceY: 2 * BAND_WORLD_Y, pooled: true },
      { cellX: 12.5, cellY: 10.5, surfaceY: 2 * BAND_WORLD_Y, pooled: true },
      { cellX: 13.5, cellY: 10.5, surfaceY: 2 * BAND_WORLD_Y, pooled: true },
      { cellX: 14.5, cellY: 10.5, surfaceY: BAND_WORLD_Y, pooled: false },
    ];

    // A flat shelf: the pool's own surface is what varies here, not the ground.
    const shelf: GroundSampler = () => 2 * BAND_WORLD_Y;

    const withPool: number[] = [];
    appendCourseRibbon(nodes, shelf, SEA_SURFACE_Y, withPool);

    const allFlowing: number[] = [];
    appendCourseRibbon(
      nodes.map((node) => ({ ...node, pooled: false })),
      shelf,
      SEA_SURFACE_Y,
      allFlowing,
    );

    // The two pool-interior segments are skipped; the entry and exit are not.
    expect(withPool.length).toBeLessThan(allFlowing.length);
    expect(withPool.length).toBeGreaterThan(0);
  });
});

// The CONTRACT of the vertical sheet a water region is poured over its lip
// with (client/src/render/water/waterRiser.ts). Replaces waterApron.test.ts,
// which tested the run-scan and the per-vertex normal the riser deletes.
//
// These are contract tests, not wiring tests. Every one of them states a
// promise the rest of the water pipeline leans on:
//
//   1. Every riser's top edge is two CONSECUTIVE vertices of the region's own
//      loop, verbatim — the reason a top seam cannot exist.
//   2. No riser on a segment whose outside is dry, or whose outside water is
//      at the same band or higher — a rising bank gets no waterfall.
//   3. A riser's foot lands OUTSIDE its top edge, on the lower region's side.
//   4. A one-vertex lip still emits. This is the `fork` defect: the apron
//      required a run of two and drew nothing at a channel's snout.
//   5. The two halves of a loop split by a marching-tile border put their feet
//      in the SAME place, so no slit runs down the centre of a fall.
//
// No WebGLRenderer and no DOM: appendRiserSurfaces writes a plain triangle
// soup from plain point loops.

import { describe, expect, it } from 'vitest';
import {
  WATER_RISER_LEAN_CELLS,
  appendRiserSurfaces,
} from '../src/render/water/waterRiser.ts';
import { RECT_NONE, RECT_WEST, type ContourLoop } from '../src/terrain/contours.ts';
import { CELL_WORLD_SIZE } from '../src/config.ts';

/** The band the region under test draws its tread at. */
const SURFACE_BAND = 4;
/** World Y of a band, in the same shape the rig uses: a fixed step per band. */
const BAND_STEP_WORLD_Y = 0.25;
const bandWorldY = (band: number): number => band * BAND_STEP_WORLD_Y;
const CREST_Y = bandWorldY(SURFACE_BAND);

/** One triangle of the soup, as three (x, y, z) world-unit points. */
interface Triangle {
  readonly points: readonly (readonly [number, number, number])[];
}

function trianglesOf(soup: readonly number[]): Triangle[] {
  const out: Triangle[] = [];
  for (let i = 0; i < soup.length; i += 9) {
    out.push({
      points: [
        [soup[i]!, soup[i + 1]!, soup[i + 2]!],
        [soup[i + 3]!, soup[i + 4]!, soup[i + 5]!],
        [soup[i + 6]!, soup[i + 7]!, soup[i + 8]!],
      ],
    });
  }
  return out;
}

/**
 * A closed loop around the four corners of one cell, in CELL coordinates,
 * counter-clockwise in (x, z) — the handedness assembleLoops emits, which the
 * riser's outward normal depends on. `rects` optionally flags border points.
 */
function squareLoop(cx: number, cz: number, half: number, rects?: number[]): ContourLoop {
  const raw: [number, number][] = [
    [cx - half, cz - half],
    [cx + half, cz - half],
    [cx + half, cz + half],
    [cx - half, cz + half],
  ];
  return raw.map(([x, z], index) => ({ x, z, rect: rects?.[index] ?? RECT_NONE }));
}

/** Cell coordinates → world, the one conversion the riser performs. */
const world = (cells: number): number => cells * CELL_WORLD_SIZE;

describe('water riser', () => {
  it('hangs every sheet from two consecutive loop vertices, verbatim', () => {
    const loop = squareLoop(8, 8, 0.5);
    const soup: number[] = [];
    // Water one band lower everywhere outside: every segment pours.
    appendRiserSurfaces([loop], SURFACE_BAND, CREST_Y, bandWorldY, () => SURFACE_BAND - 1, soup);

    const triangles = trianglesOf(soup);
    expect(triangles.length).toBe(loop.length * 2);

    // Every vertex sitting at the crest height must BE a loop vertex, and the
    // pairs that appear together must be ring neighbours.
    const loopKeys = new Set(loop.map((p) => `${world(p.x)},${world(p.z)}`));
    for (const triangle of triangles) {
      for (const [x, y, z] of triangle.points) {
        if (y !== CREST_Y) continue;
        expect(loopKeys.has(`${x},${z}`), `crest vertex (${x},${z}) is not a loop vertex`).toBe(
          true,
        );
      }
    }
  });

  it('draws nothing where the outside is dry', () => {
    const soup: number[] = [];
    appendRiserSurfaces([squareLoop(8, 8, 0.5)], SURFACE_BAND, CREST_Y, bandWorldY, () => null, soup);
    expect(soup.length).toBe(0);
  });

  it('draws nothing where the outside water is at the same band or higher', () => {
    for (const outsideBand of [SURFACE_BAND, SURFACE_BAND + 1]) {
      const soup: number[] = [];
      appendRiserSurfaces(
        [squareLoop(8, 8, 0.5)],
        SURFACE_BAND,
        CREST_Y,
        bandWorldY,
        () => outsideBand,
        soup,
      );
      expect(soup.length, `band ${outsideBand} outside drew a fall`).toBe(0);
    }
  });

  it('pours only off the side the lower water is on, never off the far bank', () => {
    // A one-cell channel running along z at x = 8. Lower water lies to the
    // EAST only (x > 8.5); the west side is a rising bank with no water.
    const loop = squareLoop(8, 8, 0.5);
    const soup: number[] = [];
    appendRiserSurfaces([loop], SURFACE_BAND, CREST_Y, bandWorldY, (cellX) =>
      cellX > 8.5 ? SURFACE_BAND - 1 : null, soup);

    const triangles = trianglesOf(soup);
    expect(triangles.length, 'the east segment alone should pour').toBe(2);
    for (const triangle of triangles) {
      for (const [x] of triangle.points) {
        expect(x, 'a fall was drawn off the west bank').toBeGreaterThanOrEqual(world(8.5) - 1e-9);
      }
    }
  });

  it('lands its foot outside the lip, at the lower band, one lean out', () => {
    const loop = squareLoop(8, 8, 0.5);
    const soup: number[] = [];
    appendRiserSurfaces([loop], SURFACE_BAND, CREST_Y, bandWorldY, (cellX) =>
      cellX > 8.5 ? SURFACE_BAND - 1 : null, soup);

    const feet = trianglesOf(soup)
      .flatMap((triangle) => triangle.points)
      .filter(([, y]) => y !== CREST_Y);
    expect(feet.length).toBeGreaterThan(0);
    for (const [x, y] of feet) {
      expect(y, 'the foot is not at the lower band').toBe(bandWorldY(SURFACE_BAND - 1));
      // The east face is at x = 8.5 cells; its outward normal is +x, so every
      // foot stands exactly one lean beyond it.
      expect(x).toBeCloseTo(world(8.5 + WATER_RISER_LEAN_CELLS), 12);
    }
  });

  it('emits from a lip one segment long — the snout the apron could not see', () => {
    // The `fork` regression, as a contract: a single qualifying segment is a
    // fall. The apron required MIN_LIP_RUN_VERTICES = 2 consecutive lip
    // VERTICES and drew nothing here.
    const loop = squareLoop(8, 8, 0.5);
    const soup: number[] = [];
    appendRiserSurfaces([loop], SURFACE_BAND, CREST_Y, bandWorldY, (cellX, cellZ) =>
      cellX > 8.5 && cellZ > 7.9 && cellZ < 8.1 ? SURFACE_BAND - 1 : null, soup);
    expect(soup.length, 'a one-segment lip drew nothing').toBeGreaterThan(0);
  });

  it('draws no fall along a marching-tile closing edge', () => {
    // Both endpoints on the west border AND sharing that border's axis: the
    // straight segment assembleLoops closes a clipped outline with. Across it
    // lies the same region's other half, so it is interior water.
    const loop: ContourLoop = [
      { x: 8, z: 7, rect: RECT_WEST },
      { x: 8, z: 9, rect: RECT_WEST },
      { x: 9, z: 9, rect: RECT_NONE },
      { x: 9, z: 7, rect: RECT_NONE },
    ];
    const soup: number[] = [];
    appendRiserSurfaces([loop], SURFACE_BAND, CREST_Y, bandWorldY, () => SURFACE_BAND - 1, soup);

    // Three real segments pour; the border-closing one does not.
    expect(trianglesOf(soup).length).toBe(3 * 2);
    for (const triangle of trianglesOf(soup)) {
      const onBorderFoot = triangle.points.some(
        ([x, y]) => y !== CREST_Y && x < world(8) - 1e-9,
      );
      expect(onBorderFoot, 'a fall was drawn off the tile-border closing edge').toBe(false);
    }
  });

  it('puts the two halves of a border-split loop on the same foot', () => {
    // The `fork` slit: a course running ALONG a tile border arrives as two
    // half-loops that share their border points exactly. Mirror-image normals
    // would separate their feet and leave a gap down the centre of the fall.
    // Each half here is a triangle with its tip on the border at (8, 9).
    const west: ContourLoop = [
      { x: 8, z: 7, rect: RECT_WEST },
      { x: 7, z: 8, rect: RECT_NONE },
      { x: 8, z: 9, rect: RECT_WEST },
    ];
    const east: ContourLoop = [
      { x: 8, z: 9, rect: RECT_WEST },
      { x: 9, z: 8, rect: RECT_NONE },
      { x: 8, z: 7, rect: RECT_WEST },
    ];
    const soup: number[] = [];
    appendRiserSurfaces([west, east], SURFACE_BAND, CREST_Y, bandWorldY, () => SURFACE_BAND - 1, soup);

    // The foot hanging from the shared border point (8, 9) is the one within a
    // lean of it; the other corner of the same quad hangs from the segment's
    // far end, a whole cell away.
    const footY = bandWorldY(SURFACE_BAND - 1);
    const reach = world(WATER_RISER_LEAN_CELLS) * 1.01;
    const feetAtSharedTop = new Set<string>();
    for (const [x, y, z] of trianglesOf(soup).flatMap((triangle) => triangle.points)) {
      if (y !== footY) continue;
      if (Math.hypot(x - world(8), z - world(9)) > reach) continue;
      feetAtSharedTop.add(`${x},${z}`);
    }
    expect(feetAtSharedTop.size, 'the two halves put their feet in different places').toBe(1);
  });

  it('extends to the water that is really there when a band between is dry', () => {
    // A multi-band drop where the intermediate band holds no water: the sheet
    // must reach the region that EXISTS rather than stopping at a band nothing
    // is drawn at.
    const soup: number[] = [];
    appendRiserSurfaces(
      [squareLoop(8, 8, 0.5)],
      SURFACE_BAND,
      CREST_Y,
      bandWorldY,
      () => SURFACE_BAND - 3,
      soup,
    );
    const feet = trianglesOf(soup)
      .flatMap((triangle) => triangle.points)
      .filter(([, y]) => y !== CREST_Y);
    expect(feet.length).toBeGreaterThan(0);
    for (const [, y] of feet) expect(y).toBe(bandWorldY(SURFACE_BAND - 3));
  });

  it('is deterministic: the same input writes the same soup', () => {
    const build = (): number[] => {
      const soup: number[] = [];
      appendRiserSurfaces(
        [squareLoop(8, 8, 0.5), squareLoop(12, 12, 0.5)],
        SURFACE_BAND,
        CREST_Y,
        bandWorldY,
        (cellX) => (cellX > 8.5 ? SURFACE_BAND - 1 : null),
        soup,
      );
      return soup;
    };
    expect(build()).toEqual(build());
  });
});

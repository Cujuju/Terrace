/**
 * Tests for waterApron.ts — pure geometry, no terrain, no browser, no WebGL.
 * Loops are hand-built; `probeLipFootBand` is stubbed per case.
 */
import { describe, expect, it } from 'vitest';
import {
  appendApronSurfaces,
  WATER_APRON_CREST_CELLS,
  WATER_FACE_CLEARANCE_WORLD_UNITS,
} from '../src/render/water/waterApron';
import { CELL_WORLD_SIZE } from '../src/config';
import type { ContourLoop } from '../src/terrain/contours';

const CREST_Y = 10;
const BAND_HEIGHT = 2;
const footWorldYOf = (band: number) => band * BAND_HEIGHT;

/** A square loop, inside on the left (counter-clockwise in (x,z)). */
function squareLoop(x0 = 0, z0 = 0, size = 8): ContourLoop {
  const pts: ContourLoop = [];
  for (let i = 0; i <= size; i++) pts.push({ x: x0 + i, z: z0, rect: 0 });
  for (let i = 1; i <= size; i++) pts.push({ x: x0 + size, z: z0 + i, rect: 0 });
  for (let i = size - 1; i >= 0; i--) pts.push({ x: x0 + i, z: z0 + size, rect: 0 });
  for (let i = size - 1; i >= 1; i--) pts.push({ x: x0, z: z0 + i, rect: 0 });
  return pts;
}

/**
 * Stub oracle: lip along the whole south edge (z=0, outward normal −z).
 * Tolerance is loose because neighbour-averaged normals tilt slightly at
 * anything near a corner — the real oracle is band lookup, not line matching.
 */
function southEdgeProbe(minX: number, maxX: number, band: number) {
  return (cx: number, cz: number) =>
    cz < -0.3 && cz > -0.7 && cx >= minX && cx <= maxX ? band : null;
}

/** Group raw floats into world-space vertices. */
function vertices(out: number[]): [number, number, number][] {
  const v: [number, number, number][] = [];
  for (let i = 0; i < out.length; i += 3)
    v.push([out[i], out[i + 1], out[i + 2]]);
  return v;
}

describe('appendApronSurfaces', () => {
  it('1. emits row-0 vertices bit-identical to the loop vertex world coords', () => {
    const loop = squareLoop();
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, southEdgeProbe(0, 8, 0), out);
    expect(out.length).toBeGreaterThan(0);
    const verts = vertices(out);
    const world = new Set(
      loop.map((p) => `${p.x * CELL_WORLD_SIZE},${p.z * CELL_WORLD_SIZE}`),
    );
    // Every crest-level vertex whose XZ matches a loop point must equal that
    // loop point's world coordinates EXACTLY (=== via the string key of the
    // exact float bits), not by epsilon.
    let checked = 0;
    for (const [x, y, z] of verts) {
      if (y !== CREST_Y) continue;
      if (world.has(`${x},${z}`)) checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // And at least one crest vertex is EXACTLY the first lip vertex's coords.
    const p = loop[1]; // (1, 0), a south-edge lip vertex
    expect(
      verts.some(
        ([x, y, z]) =>
          y === CREST_Y &&
          x === p.x * CELL_WORLD_SIZE &&
          z === p.z * CELL_WORLD_SIZE,
      ),
    ).toBe(true);
  });

  it('2. leaves out untouched when nothing is below', () => {
    const out: number[] = [];
    appendApronSurfaces([squareLoop()], CREST_Y, footWorldYOf, () => null, out,);
    expect(out).toHaveLength(0);
  });

  it('3. the drop is one clean step, crest to foot, and never climbs', () => {
    // SUPERSEDED CONTRACT, deliberately (owner, 2026-08-22: "what if we simply
    // drew it down the side of the layer"). This used to assert the opposite -
    // that every descending edge had horizontal extent, and that no two
    // vertices shared an XZ with different heights - because a fall was then a
    // sloped chute and a vertical curtain was the failure being guarded
    // against. Drawing the fall ON the riser makes that sharing the POINT: the
    // strip is the terrace face, and a face is vertical.
    //
    // What still has to hold is that the water only ever goes down, and that
    // it uses exactly two levels: the one it left and the one it lands on.
    const loop = squareLoop();
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, southEdgeProbe(0, 8, 0), out);
    expect(out.length).toBeGreaterThan(0);

    const verts = vertices(out);
    const footY = footWorldYOf(0);
    for (const [, y] of verts) {
      expect(y).toBeLessThanOrEqual(CREST_Y + 1e-9);
      expect(y).toBeGreaterThanOrEqual(footY - 1e-9);
      expect(y === CREST_Y || y === footY).toBe(true);
    }
  });

  it('4. the fall is a vertical strip lying on the terrace face', () => {
    // The sheet is no longer projected outward past the lip: the water
    // region's lip arc IS the terrain's own cap contour there, and the riser
    // under it is vertical, so the fall is that arc extruded straight DOWN.
    // What has to hold is that the strip is vertical - its top and bottom
    // share their XZ - and that it spans exactly crest to foot.
    const loop = squareLoop();
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, southEdgeProbe(0, 8, 0), out);
    const verts = vertices(out);
    expect(verts.length).toBeGreaterThan(0);

    const levels = new Set(verts.map(([, y]) => y));
    expect(levels).toEqual(new Set([CREST_Y, footWorldYOf(0)]));

    // Every foot vertex stands directly under a crest vertex.
    const crestXZ = new Set(
      verts.filter(([, y]) => y === CREST_Y).map(([x, , z]) => `${x},${z}`),
    );
    for (const [x, y, z] of verts) {
      if (y !== footWorldYOf(0)) continue;
      expect(crestXZ.has(`${x},${z}`)).toBe(true);
    }

    // And the strip stands off the rock rather than inside it: no vertex is
    // further out than the crest hold plus that clearance.
    const maxOut = WATER_APRON_CREST_CELLS * CELL_WORLD_SIZE + WATER_FACE_CLEARANCE_WORLD_UNITS;
    for (const [x, , z] of verts) {
      const outward = Math.min(
        ...loop.map((q) => Math.hypot(x - q.x * CELL_WORLD_SIZE, z - q.z * CELL_WORLD_SIZE)),
      );
      expect(outward).toBeLessThanOrEqual(maxOut + 1e-9);
    }
  });

  it('5. a run seeing several levels below it lands on the HIGHEST of them', () => {
    // The sheet drops ONE terrace step, onto water that is really there, and
    // the region it lands on carries the cascade further down. Reaching for
    // the lowest water a run can see is what threw a wall of water from the
    // summit of a thin spire to its foot, hanging unsupported in open air
    // because a spire that narrow hides none of it (owner, 2026-08-22).
    const loop = squareLoop();
    // Left half of the lip sees water 3 bands down, right half 2 bands down.
    const probe = (cx: number, cz: number) => {
      const hit = southEdgeProbe(0, 8, 0)(cx, cz);
      return hit === null ? null : cx < 4 ? 1 : 2;
    };
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, probe, out,);
    const minY = Math.min(...vertices(out).map(([, y]) => y));
    expect(minY).toBe(footWorldYOf(2));
  });

  it('6a. one isolated lip vertex emits nothing', () => {
    const loop = squareLoop();
    // Window narrower than one vertex spacing → exactly one lip vertex.
    const probe = (cx: number, cz: number) =>
      cz < -0.3 && cz > -0.7 && Math.abs(cx - 4) < 0.26 ? 0 : null;
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, probe, out,);
    expect(out).toHaveLength(0);
  });

  it('6b. two adjacent lip vertices emit exactly one sheet', () => {
    const loop = squareLoop();
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, southEdgeProbe(3, 4, 0), out);
    expect(out.length).toBeGreaterThan(0);
  });

  it('6c. two separated runs emit two disjoint sheets', () => {
    const loop = squareLoop(0, 0, 12);
    const out: number[] = [];
    // Runs sit well clear of the corners so every lip probe lands true.
    appendApronSurfaces(
      [loop],
      CREST_Y,
      footWorldYOf,
      (cx, cz) =>
        (southEdgeProbe(2, 4, 0)(cx, cz) ??
          southEdgeProbe(8, 10, 0)(cx, cz)), out,
    );
    expect(out.length).toBeGreaterThan(0);
    // Foot-row vertices cluster into exactly two x-intervals separated by a
    // gap wider than a cell — one sheet per run.
    const xsAtFoot = vertices(out)
      .filter(([, y]) => y === footWorldYOf(0))
      .map(([x]) => x)
      .sort((a, b) => a - b);
    let groups = 1;
    for (let i = 1; i < xsAtFoot.length; i++)
      if (xsAtFoot[i] - xsAtFoot[i - 1] > 1.5 * CELL_WORLD_SIZE) groups++;
    expect(groups).toBe(2);
  });
});

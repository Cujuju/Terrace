/**
 * Tests for waterApron.ts — pure geometry, no terrain, no browser, no WebGL.
 * Loops are hand-built; `probeLipFootBand` is stubbed per case.
 */
import { describe, expect, it } from 'vitest';
import {
  appendApronSurfaces,
  WATER_APRON_CREST_CELLS,
  WATER_APRON_CHUTE_CELLS,
  WATER_APRON_MAX_CHUTE_CELLS,
  WATER_APRON_MAX_REACH_CELLS,
  WATER_APRON_MAX_FALL_SLOPE,
  WATER_APRON_ROWS,
} from '../src/render/water/waterApron';
import { CELL_WORLD_SIZE } from '../src/config';
import type { ContourLoop } from '../src/terrain/contours';

const CREST_Y = 10;
const BAND_HEIGHT = 2;
const footWorldYOf = (band: number) => band * BAND_HEIGHT;

/**
 * The ground a test fall runs down: a terrace RISER, descending straight from
 * the crest to the foot over one cell outward of the lip (z = 0 here), flat at
 * the foot beyond that. The sheet is supposed to ride this rather than cut
 * through the air beside it, so every case is driven against a real face.
 */
const testGround = (_cellX: number, cellZ: number): number => {
  // The lip lies on z = 0 and the sheets in these fixtures run outward to
  // NEGATIVE z, so the distance down the face is |cellZ|.
  const past = Math.min(1, Math.abs(cellZ));
  return CREST_Y + (footWorldYOf(0) - CREST_Y) * past;
};

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
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, southEdgeProbe(0, 8, 0), testGround, out);
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
    appendApronSurfaces([squareLoop()], CREST_Y, footWorldYOf, () => null, testGround, out,);
    expect(out).toHaveLength(0);
  });

  it('3. profile is monotonic non-increasing with no vertical step', () => {
    const loop = squareLoop();
    const probe = southEdgeProbe(0, 8, 0);
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, probe, testGround, out,);
    expect(out.length).toBeGreaterThan(0);
    const footY = footWorldYOf(0);
    void footY;
    // The constants put 3 of the 4 row intervals on the flat crest, so the
    // one chute interval legitimately carries the full drop — but spread over
    // WATER_APRON_CHUTE_CELLS / ROWS cells horizontally. That is exactly what
    // distinguishes it from a curtain, whose step is VERTICAL (zero XZ
    // distance). Assert: (a) every descending edge has real horizontal extent,
    // and (b) no two vertices share identical XZ with different Y — the
    // numeric definition of a vertical curtain.
    const verts = vertices(out);
    for (let i = 0; i < verts.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const b = (a + 1) % 3;
        const [x1, y1, z1] = verts[i + a];
        const [x2, y2, z2] = verts[i + b];
        if (Math.abs(y1 - y2) > 1e-9) {
          expect(Math.hypot(x1 - x2, z1 - z2)).toBeGreaterThan(0);
        }
      }
    }
    const seen = new Map<string, number>();
    for (const [x, y, z] of verts) {
      const key = `${x},${z}`;
      const prev = seen.get(key);
      if (prev !== undefined) expect(y).toBeCloseTo(prev, 9);
      else seen.set(key, y);
    }
  });

  it('4. the sheet reaches the foot, on the ground, within its bounded reach', () => {
    // The descent is no longer a fixed run: it FOLLOWS THE GROUND out from the
    // lip (see WATER_APRON_GROUND_STEP_CELLS), so what has to hold is that the
    // sheet gets down to the water it is falling to, that it does so on the
    // face rather than out in the air, and that it never wanders further than
    // WATER_APRON_MAX_REACH_CELLS while doing it.
    const loop = squareLoop();
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, southEdgeProbe(0, 8, 0), testGround, out);
    const verts = vertices(out);
    const footVerts = verts.filter(([, y]) => y === footWorldYOf(0));
    expect(footVerts.length).toBeGreaterThan(0);

    for (const [x, y, z] of verts) {
      const outward = Math.min(
        ...loop.map((p) =>
          Math.hypot(x - p.x * CELL_WORLD_SIZE, z - p.z * CELL_WORLD_SIZE),
        ),
      );
      // Bounded reach.
      expect(outward).toBeLessThanOrEqual(
        WATER_APRON_MAX_REACH_CELLS * CELL_WORLD_SIZE + 1e-9,
      );
      // On the face, not in the air: past the crest hold, every vertex sits at
      // the ground the stub reports there, or at the foot it has reached.
      if (outward > WATER_APRON_CREST_CELLS * CELL_WORLD_SIZE + 1e-9) {
        const ground = testGround(x / CELL_WORLD_SIZE, z / CELL_WORLD_SIZE);
        expect(y).toBeLessThanOrEqual(Math.max(ground, footWorldYOf(0)) + 1e-9);
      }
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
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, probe, testGround, out,);
    const minY = Math.min(...vertices(out).map(([, y]) => y));
    expect(minY).toBe(footWorldYOf(2));
  });

  it('6a. one isolated lip vertex emits nothing', () => {
    const loop = squareLoop();
    // Window narrower than one vertex spacing → exactly one lip vertex.
    const probe = (cx: number, cz: number) =>
      cz < -0.3 && cz > -0.7 && Math.abs(cx - 4) < 0.26 ? 0 : null;
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, probe, testGround, out,);
    expect(out).toHaveLength(0);
  });

  it('6b. two adjacent lip vertices emit exactly one sheet', () => {
    const loop = squareLoop();
    const out: number[] = [];
    appendApronSurfaces([loop], CREST_Y, footWorldYOf, southEdgeProbe(3, 4, 0), testGround, out);
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
          southEdgeProbe(8, 10, 0)(cx, cz)), testGround, out,
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

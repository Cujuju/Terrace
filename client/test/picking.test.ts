import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_HEIGHT,
  quantizeToBand,
  type ChunkPayload,
  type JoinSnapshotMessage,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';
import {
  pickTerrainCellByRay,
  pointerToNdc,
  worldPointToCell,
  type Vec3,
} from '../src/terrain/picking.ts';
import { applySnapshot, createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

const RECT = { left: 100, top: 50, width: 800, height: 400 };

/** toEqual distinguishes -0 from 0, which is noise here. */
function expectNdc(actual: { x: number; y: number } | null, x: number, y: number): void {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(x);
  expect(actual!.y).toBeCloseTo(y);
}

describe('pointerToNdc', () => {
  it('maps the centre of the viewport to the NDC origin', () => {
    expectNdc(pointerToNdc(100 + 400, 50 + 200, RECT), 0, 0);
  });

  it('maps the corners, flipping Y', () => {
    // Top-left of the canvas is (-1, +1) in NDC.
    expectNdc(pointerToNdc(100, 50, RECT), -1, 1);
    // Bottom-right is (+1, -1).
    expectNdc(pointerToNdc(900, 450, RECT), 1, -1);
  });

  it('accounts for the canvas offset within the page', () => {
    // Same client point, different rect origin, different result.
    const shifted = { ...RECT, left: 0, top: 0 };
    expectNdc(pointerToNdc(400, 200, shifted), 0, 0);
    expect(pointerToNdc(400, 200, RECT)).not.toEqual({ x: 0, y: 0 });
  });

  it('reports null for an unlaid-out canvas instead of producing NaN', () => {
    expect(pointerToNdc(10, 10, { left: 0, top: 0, width: 0, height: 400 })).toBeNull();
    expect(pointerToNdc(10, 10, { left: 0, top: 0, width: 800, height: 0 })).toBeNull();
  });
});

describe('worldPointToCell', () => {
  const WORLD = 128;

  /**
   * The world-space point at cell-space coordinate `cells` — the conversion
   * worldPointToCell has to undo. Every case below is stated in CELL space,
   * because that is what the function's contract is about; passing the cell
   * number straight in would have silently tested a quarter of the world since
   * the 2026-08-21 re-sample, when a cell stopped being a world unit.
   */
  const at = (cells: number): number => cells * CELL_WORLD_SIZE;

  it('rounds to the nearest cell, because a vertex is a cell', () => {
    expect(worldPointToCell(at(10.4), at(20.4), WORLD)).toEqual({ x: 10, y: 20 });
    expect(worldPointToCell(at(10.6), at(20.6), WORLD)).toEqual({ x: 11, y: 21 });
  });

  it('maps world X to cell x and world Z to cell y', () => {
    expect(worldPointToCell(at(3), at(7), WORLD)).toEqual({ x: 3, y: 7 });
  });

  it('accepts the half-cell margin at each edge and clamps into the world', () => {
    // Also pins the -0 normalisation: rounding -0.4 gives -0, and a cell index
    // of -0 must never escape (toEqual would distinguish it from 0).
    expect(worldPointToCell(at(-0.4), at(-0.4), WORLD)).toEqual({ x: 0, y: 0 });

    expect(worldPointToCell(at(WORLD - 1 + 0.4), at(WORLD - 1 + 0.4), WORLD)).toEqual({
      x: WORLD - 1,
      y: WORLD - 1,
    });
  });

  it('rejects points beyond the terrain extent', () => {
    expect(worldPointToCell(at(-1), at(0), WORLD)).toBeNull();
    expect(worldPointToCell(at(0), at(-1), WORLD)).toBeNull();
    expect(worldPointToCell(at(WORLD), at(0), WORLD)).toBeNull();
    expect(worldPointToCell(at(0), at(WORLD), WORLD)).toBeNull();
  });

  it('rejects non-finite coordinates rather than emitting NaN cells', () => {
    expect(worldPointToCell(Number.NaN, 0, WORLD)).toBeNull();
    expect(worldPointToCell(0, Number.POSITIVE_INFINITY, WORLD)).toBeNull();
  });

  it('never returns a cell outside the map', () => {
    for (let i = 0; i < WORLD * 2; i++) {
      const p = at(i / 2);
      const cell = worldPointToCell(p, p, WORLD);
      if (cell === null) continue;
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x).toBeLessThan(WORLD);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeLessThan(WORLD);
    }
  });
});

describe('pickTerrainCellByRay', () => {
  /** 64 cells = 4×4 chunks: room for a revealed/unrevealed frontier. */
  const WORLD = 64;
  const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

  /**
   * A mirror with `revealed` chunks sent, each cell's height decided by
   * `heightOf`. Only revealed chunks are marked received, which is exactly the
   * condition the march tests before it will accept a cell.
   */
  function world(
    heightOf: (x: number, y: number) => number,
    revealed?: ReadonlyArray<readonly [number, number]>,
  ): TerrainMirror {
    const mirror = createTerrainMirror(WORLD);
    const perEdge = WORLD / CHUNK_SIZE;
    const chunks: ChunkPayload[] = [];
    for (let cy = 0; cy < perEdge; cy++) {
      for (let cx = 0; cx < perEdge; cx++) {
        if (revealed && !revealed.some(([rx, ry]) => rx === cx && ry === cy)) continue;
        const heights = new Array<number>(CELLS_PER_CHUNK);
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            heights[ly * CHUNK_SIZE + lx] = heightOf(cx * CHUNK_SIZE + lx, cy * CHUNK_SIZE + ly);
          }
        }
        chunks.push({ cx, cy, heights });
      }
    }
    applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks } as JoinSnapshotMessage);
    return mirror;
  }

  const DOWN = { x: 0, y: -1, z: 0 };
  /** Well above MAX_HEIGHT's world Y, so every ray starts outside the terrain. */
  const SKY_Y = MAX_HEIGHT * HEIGHT_WORLD_SCALE + 10;
  const above = (x: number, z: number): Vec3 => ({
    x: x * CELL_WORLD_SIZE,
    y: SKY_Y,
    z: z * CELL_WORLD_SIZE,
  });

  it('picks the cell straight below a downward ray', () => {
    const mirror = world(() => 0);
    expect(pickTerrainCellByRay(mirror, above(7, 11), DOWN)).toEqual({
      x: 7,
      y: 11,
      surfaceY: 0,
    });
  });

  it('reports the RENDERED surface — the band cap, not the raw height', () => {
    // Mid-band: the mesh draws the cap at the band floor, so the pick must
    // agree or the brush outline would float above (or sink into) the tread.
    const raw = BAND_HEIGHT * 3 + BAND_HEIGHT / 2;
    const mirror = world(() => raw);
    const hit = pickTerrainCellByRay(mirror, above(4, 4), DOWN);
    expect(hit!.surfaceY).toBe(quantizeToBand(raw) * HEIGHT_WORLD_SCALE);
    expect(hit!.surfaceY).toBe(BAND_HEIGHT * 3 * HEIGHT_WORLD_SCALE);
  });

  it('agrees with the renderer everywhere, over a varied height field', () => {
    // THE CONTRACT: vertexGrid.ts's honesty invariant says the cap over a cell
    // centre sits at exactly quantizeToBand(h). A vertical ray through a cell
    // centre must therefore return that cell and that height — for every cell,
    // not just the easy ones.
    const heightOf = (x: number, y: number): number =>
      ((x * 37 + y * 101) % 21) * BAND_HEIGHT - 5 * BAND_HEIGHT + (x % 7);
    const mirror = world(heightOf);
    for (let y = 0; y < WORLD; y++) {
      for (let x = 0; x < WORLD; x++) {
        const hit = pickTerrainCellByRay(mirror, above(x, y), DOWN);
        expect(hit).toEqual({
          x,
          y,
          surfaceY: quantizeToBand(heightOf(x, y)) * HEIGHT_WORLD_SCALE,
        });
      }
    }
  });

  it('picks the tall cell when a shallow ray strikes its riser', () => {
    // A wall: cells at x >= 32 stand ten bands above the flat ground west of
    // them. A ray coming in low from the west hits the CLIFF FACE, and the
    // cell it names must be the one whose face that is.
    const TOP = BAND_HEIGHT * 10;
    const mirror = world((x) => (x >= 32 ? TOP : 0));
    const rayY = (BAND_HEIGHT * 5) * HEIGHT_WORLD_SCALE; // half way up the face
    const hit = pickTerrainCellByRay(
      mirror,
      { x: 20 * CELL_WORLD_SIZE, y: rayY, z: 20 * CELL_WORLD_SIZE },
      { x: 1, y: 0, z: 0 },
    );
    expect(hit).toEqual({ x: 32, y: 20, surfaceY: TOP * HEIGHT_WORLD_SCALE });
  });

  it('walks over a lower plateau to land on the higher ground behind it', () => {
    const NEAR_TOP_Y = BAND_HEIGHT * HEIGHT_WORLD_SCALE;
    const FAR_TOP_Y = BAND_HEIGHT * 8 * HEIGHT_WORLD_SCALE;
    const mirror = world((x) => (x >= 40 ? BAND_HEIGHT * 8 : BAND_HEIGHT));

    // Aimed down and east, shallow enough to stay clear of the near low ground
    // for all 30 cells of it and low enough to strike the far wall the moment
    // it arrives. THE SLOPE IS DERIVED, not written down (2026-08-21): a ray's
    // descent is world units of drop per world unit of RUN, and 30 cells of
    // run stopped being 30 world units at the re-sample. A literal -0.25 left
    // the ray a quarter of the way down and sailing over the far wall.
    const startX = 10 * CELL_WORLD_SIZE;
    const wallX = 40 * CELL_WORLD_SIZE;
    // Arrive halfway up the far face: unambiguously above the near tread the
    // whole way, unambiguously into the far one.
    const arriveY = (NEAR_TOP_Y + FAR_TOP_Y) / 2;
    const startY = FAR_TOP_Y * 2;

    const hit = pickTerrainCellByRay(
      mirror,
      { x: startX, y: startY, z: 30 * CELL_WORLD_SIZE },
      { x: wallX - startX, y: arriveY - startY, z: 0 },
    );
    expect(hit!.x).toBeGreaterThanOrEqual(40);
    expect(hit!.surfaceY).toBe(FAR_TOP_Y);
  });

  it('passes THROUGH unrevealed chunks instead of picking them', () => {
    // Chunk (0,0) is revealed; chunk (1,0) is not. A ray aimed into (1,0)'s
    // territory must find nothing there — that chunk has no mesh, and sending
    // an intent for it would be sculpting land the client was never shown.
    const mirror = world(() => 0, [[0, 0]]);
    expect(pickTerrainCellByRay(mirror, above(4, 4), DOWN)).not.toBeNull();
    expect(pickTerrainCellByRay(mirror, above(20, 4), DOWN)).toBeNull();
  });

  it('lands on revealed terrain BEHIND an unrevealed gap', () => {
    // Chunk (1,0) holds a plateau the ray WOULD strike at x≈22; chunk (2,0)
    // behind it holds lower ground it strikes at x≈42. Revealing (1,0) or not
    // is the only difference between the two picks below, which is what makes
    // this a test of the skip rather than of the geometry.
    const heightOf = (x: number): number =>
      x >= 32 ? BAND_HEIGHT * 4 : x >= 16 ? BAND_HEIGHT * 8 : 0;
    const HIGH_Y = BAND_HEIGHT * 8 * HEIGHT_WORLD_SCALE;

    // THE RAY IS DERIVED FROM THE TWO PLATEAUX, not written down (2026-08-21).
    // A direction's Y is a drop per world unit of RUN, and sixteen cells of run
    // stopped being sixteen world units at the re-sample — a literal slope here
    // described a completely different shot. Stating it as a drop PER CELL, and
    // the run as one cell of X, keeps the geometry this test needs whatever a
    // cell is worth.
    const START_CELL = 2;
    const GAP_CELL = CHUNK_SIZE;
    /** Six cells into the plateau: clear of its lip, well short of its far edge. */
    const STRIKE_CELL = CHUNK_SIZE + 6;
    /** Half the plateau's own height of clearance as the ray reaches its edge. */
    const CLEARANCE_AT_GAP = HIGH_Y * 1.5;
    const DROP_PER_CELL = (CLEARANCE_AT_GAP - HIGH_Y) / (STRIKE_CELL - GAP_CELL);

    const origin: Vec3 = {
      x: START_CELL * CELL_WORLD_SIZE,
      y: CLEARANCE_AT_GAP + DROP_PER_CELL * (GAP_CELL - START_CELL),
      z: 4 * CELL_WORLD_SIZE,
    };
    const direction: Vec3 = { x: CELL_WORLD_SIZE, y: -DROP_PER_CELL, z: 0 };

    const dark = pickTerrainCellByRay(world(heightOf, [[0, 0], [2, 0]]), origin, direction);
    expect(dark).not.toBeNull();
    expect(dark!.x).toBeGreaterThanOrEqual(2 * CHUNK_SIZE);
    expect(dark!.surfaceY).toBe(BAND_HEIGHT * 4 * HEIGHT_WORLD_SCALE);

    const lit = pickTerrainCellByRay(
      world(heightOf, [[0, 0], [1, 0], [2, 0]]),
      origin,
      direction,
    );
    expect(lit!.x).toBeGreaterThanOrEqual(CHUNK_SIZE);
    expect(lit!.x).toBeLessThan(2 * CHUNK_SIZE);
    expect(lit!.surfaceY).toBe(BAND_HEIGHT * 8 * HEIGHT_WORLD_SCALE);
  });

  it('reports null for a ray that never meets the world', () => {
    const mirror = world(() => 0);
    // Pointing up, from above.
    expect(pickTerrainCellByRay(mirror, above(8, 8), { x: 0, y: 1, z: 0 })).toBeNull();
    // Parallel to the ground, above the tallest possible terrain.
    expect(pickTerrainCellByRay(mirror, above(8, 8), { x: 1, y: 0, z: 0 })).toBeNull();
    // Straight down, but outside the world's footprint.
    expect(pickTerrainCellByRay(mirror, above(-40, 8), DOWN)).toBeNull();
    expect(pickTerrainCellByRay(mirror, above(8, WORLD + 40), DOWN)).toBeNull();
  });

  it('picks the edge cell for a ray inside the outermost half-cell', () => {
    // The mesh extends half a cell past the last cell CENTRE, so a click there
    // must still pick the edge cell rather than falling off the world — the
    // same tolerance worldPointToCell grants.
    const mirror = world(() => 0);
    expect(pickTerrainCellByRay(mirror, above(-0.4, 0.2), DOWN)!.x).toBe(0);
    expect(pickTerrainCellByRay(mirror, above(WORLD - 1 + 0.4, 3), DOWN)!.x).toBe(WORLD - 1);
  });

  it('reports null rather than NaN for a degenerate ray', () => {
    const mirror = world(() => 0);
    expect(pickTerrainCellByRay(mirror, above(8, 8), { x: 0, y: 0, z: 0 })).toBeNull();
    expect(
      pickTerrainCellByRay(mirror, above(8, 8), { x: Number.NaN, y: -1, z: 0 }),
    ).toBeNull();
    expect(
      pickTerrainCellByRay(
        mirror,
        { x: Number.POSITIVE_INFINITY, y: SKY_Y, z: 0 },
        DOWN,
      ),
    ).toBeNull();
  });

  it('terminates on every direction in a full sweep', () => {
    // The march's step limit is a backstop, not the exit condition. A ray in
    // any direction — including exactly axis-aligned and exactly diagonal,
    // where a grid walk is most likely to stall — must return promptly.
    const mirror = world((x, y) => ((x + y) % 5) * BAND_HEIGHT);
    for (let deg = 0; deg < 360; deg += 5) {
      const a = (deg * Math.PI) / 180;
      for (const pitch of [-1, -0.2, 0, 0.2]) {
        const hit = pickTerrainCellByRay(
          mirror,
          { x: 32 * CELL_WORLD_SIZE, y: BAND_HEIGHT * 6 * HEIGHT_WORLD_SCALE, z: 32 * CELL_WORLD_SIZE },
          { x: Math.cos(a), y: pitch, z: Math.sin(a) },
        );
        if (hit !== null) {
          expect(hit.x).toBeGreaterThanOrEqual(0);
          expect(hit.x).toBeLessThan(WORLD);
          expect(hit.y).toBeGreaterThanOrEqual(0);
          expect(hit.y).toBeLessThan(WORLD);
        }
      }
    }
  });

  it('never picks a cell in a chunk the client was not sent', () => {
    // Belt and suspenders on the anti-cheat property, swept rather than
    // spot-checked: whatever the ray, the answer is always revealed ground.
    const revealed: ReadonlyArray<readonly [number, number]> = [[1, 1], [2, 1]];
    const mirror = world((x, y) => ((x * 13 + y * 7) % 9) * BAND_HEIGHT, revealed);
    for (let deg = 0; deg < 360; deg += 11) {
      const a = (deg * Math.PI) / 180;
      const hit = pickTerrainCellByRay(
        mirror,
        { x: 32 * CELL_WORLD_SIZE, y: SKY_Y, z: 32 * CELL_WORLD_SIZE },
        { x: Math.cos(a), y: -0.6, z: Math.sin(a) },
      );
      if (hit === null) continue;
      const chunk: readonly [number, number] = [
        Math.floor(hit.x / CHUNK_SIZE),
        Math.floor(hit.y / CHUNK_SIZE),
      ];
      expect(revealed.some(([cx, cy]) => cx === chunk[0] && cy === chunk[1])).toBe(true);
    }
  });
});

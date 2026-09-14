import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CHUNK_SIZE,
  MAX_HEIGHT,
  drawnBandOfSample,
  quantizeToBand,
  setColumn,
  type ChunkPayload,
  type JoinSnapshotMessage,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';
import {
  pickTerrainCellByRay,
  pickTerrainInColumn,
  columnOwningBand,
  pointerToNdc,
  worldPointToCell,
  type Vec3,
} from '../src/terrain/picking.ts';
import { resolvePick } from '../src/terrain/pickBand.ts';
import { applySnapshot, createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

const RECT = { left: 100, top: 50, width: 800, height: 400 };

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
    expectNdc(pointerToNdc(100, 50, RECT), -1, 1);
    expectNdc(pointerToNdc(900, 450, RECT), 1, -1);
  });

  it('accounts for the canvas offset within the page', () => {
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

  const at = (cells: number): number => cells * CELL_WORLD_SIZE;

  it('rounds to the nearest cell, because a vertex is a cell', () => {
    expect(worldPointToCell(at(10.4), at(20.4), WORLD)).toEqual({ x: 10, y: 20 });
    expect(worldPointToCell(at(10.6), at(20.6), WORLD)).toEqual({ x: 11, y: 21 });
  });

  it('maps world X to cell x and world Z to cell y', () => {
    expect(worldPointToCell(at(3), at(7), WORLD)).toEqual({ x: 3, y: 7 });
  });

  it('accepts the half-cell margin at each edge and clamps into the world', () => {
    expect(worldPointToCell(at(-0.4), at(-0.4), WORLD)).toEqual({ x: 0, y: 0 });

    expect(worldPointToCell(at(WORLD - 1 + 0.4), at(WORLD - 1 + 0.4), WORLD)).toEqual({
      x: WORLD - 1,
      y: WORLD - 1,
    });
  });

  it('clamps points beyond the terrain extent to the edge cell (issue #281 A)', () => {
    expect(worldPointToCell(at(-1), at(0), WORLD)).toEqual({ x: 0, y: 0 });
    expect(worldPointToCell(at(0), at(-1), WORLD)).toEqual({ x: 0, y: 0 });
    expect(worldPointToCell(at(WORLD), at(0), WORLD)).toEqual({ x: WORLD - 1, y: 0 });
    expect(worldPointToCell(at(0), at(WORLD), WORLD)).toEqual({ x: 0, y: WORLD - 1 });
    expect(worldPointToCell(at(WORLD * 10), at(-WORLD), WORLD)).toEqual({ x: WORLD - 1, y: 0 });
    expect(worldPointToCell(at(7), at(WORLD + 50), WORLD)).toEqual({ x: 7, y: WORLD - 1 });
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
  const WORLD = 64;
  const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

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
      surfaceY: -BAND_HEIGHT * HEIGHT_WORLD_SCALE,
      face: 'tread',
      hitY: -BAND_HEIGHT * HEIGHT_WORLD_SCALE,
      hitX: 7 * CELL_WORLD_SIZE,
      hitZ: 11 * CELL_WORLD_SIZE,
      spanIndex: 0,
    });
  });

  it('reports the RENDERED surface — the band cap, not the raw height', () => {
    const raw = BAND_HEIGHT * 3 + BAND_HEIGHT / 2;
    const mirror = world(() => raw);
    const hit = pickTerrainCellByRay(mirror, above(4, 4), DOWN);
    expect(hit!.surfaceY).toBe(drawnBandOfSample(raw) * BAND_HEIGHT * HEIGHT_WORLD_SCALE);
    expect(hit!.surfaceY).toBe(BAND_HEIGHT * 4 * HEIGHT_WORLD_SCALE);
  });

  it('agrees with the renderer everywhere, over a varied height field', () => {
    const heightOf = (x: number, y: number): number =>
      ((x * 37 + y * 101) % 21) * BAND_HEIGHT - 5 * BAND_HEIGHT + (x % 7);
    const mirror = world(heightOf);
    for (let y = 0; y < WORLD; y++) {
      for (let x = 0; x < WORLD; x++) {
        const hit = pickTerrainCellByRay(mirror, above(x, y), DOWN);
        expect(hit).toEqual({
          x,
          y,
          surfaceY: drawnBandOfSample(heightOf(x, y)) * BAND_HEIGHT * HEIGHT_WORLD_SCALE,
          face: 'tread',
          hitY: drawnBandOfSample(heightOf(x, y)) * BAND_HEIGHT * HEIGHT_WORLD_SCALE,
          hitX: x * CELL_WORLD_SIZE,
          hitZ: y * CELL_WORLD_SIZE,
          spanIndex: 0,
        });
      }
    }
  });

  it('picks the tall cell when a shallow ray strikes its riser', () => {
    const TOP = BAND_HEIGHT * 10;
    const mirror = world((x) => (x >= 32 ? TOP : 0));
    const rayY = (BAND_HEIGHT * 5) * HEIGHT_WORLD_SCALE;
    const hit = pickTerrainCellByRay(
      mirror,
      { x: 20 * CELL_WORLD_SIZE, y: rayY, z: 20 * CELL_WORLD_SIZE },
      { x: 1, y: 0, z: 0 },
    );
    expect(hit).toEqual({
      x: 32,
      y: 20,
      surfaceY: TOP * HEIGHT_WORLD_SCALE,
      face: 'riser',
      hitY: rayY,
      hitX: (32 - 0.5) * CELL_WORLD_SIZE,
      hitZ: 20 * CELL_WORLD_SIZE,
      spanIndex: 0,
    });
  });

  it('walks over a lower plateau to land on the higher ground behind it', () => {
    const NEAR_TOP_Y = BAND_HEIGHT * HEIGHT_WORLD_SCALE;
    const FAR_TOP_Y = BAND_HEIGHT * 8 * HEIGHT_WORLD_SCALE;
    const mirror = world((x) => (x >= 40 ? BAND_HEIGHT * 8 : BAND_HEIGHT));

    const startX = 10 * CELL_WORLD_SIZE;
    const wallX = 40 * CELL_WORLD_SIZE;
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
    const mirror = world(() => 0, [[0, 0]]);
    expect(pickTerrainCellByRay(mirror, above(4, 4), DOWN)).not.toBeNull();
    expect(pickTerrainCellByRay(mirror, above(20, 4), DOWN)).toBeNull();
  });

  it('lands on revealed terrain BEHIND an unrevealed gap', () => {
    const heightOf = (x: number): number =>
      x >= 32 ? BAND_HEIGHT * 4 : x >= 16 ? BAND_HEIGHT * 8 : 0;
    const HIGH_Y = BAND_HEIGHT * 8 * HEIGHT_WORLD_SCALE;

    const START_CELL = 2;
    const GAP_CELL = CHUNK_SIZE;
    const STRIKE_CELL = CHUNK_SIZE + 6;
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
    expect(pickTerrainCellByRay(mirror, above(8, 8), { x: 0, y: 1, z: 0 })).toBeNull();
    expect(pickTerrainCellByRay(mirror, above(8, 8), { x: 1, y: 0, z: 0 })).toBeNull();
    expect(pickTerrainCellByRay(mirror, above(-40, 8), DOWN)).toBeNull();
    expect(pickTerrainCellByRay(mirror, above(8, WORLD + 40), DOWN)).toBeNull();
  });

  it('picks the edge cell for a ray inside the outermost half-cell', () => {
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

describe('pickTerrainInColumn', () => {
  const WORLD = 64;
  const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

  function world(heightOf: (x: number, y: number) => number): TerrainMirror {
    const mirror = createTerrainMirror(WORLD);
    const perEdge = WORLD / CHUNK_SIZE;
    const chunks: ChunkPayload[] = [];
    for (let cy = 0; cy < perEdge; cy++) {
      for (let cx = 0; cx < perEdge; cx++) {
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

  const SKY_Y = MAX_HEIGHT * HEIGHT_WORLD_SCALE + 10;

  it('answers exactly what the march answers, for the cell the march named', () => {
    const mirror = world((x) => (x >= 32 ? BAND_HEIGHT * 10 : 0));
    const origin = { x: 20 * CELL_WORLD_SIZE, y: BAND_HEIGHT * 5 * HEIGHT_WORLD_SCALE, z: 20 * CELL_WORLD_SIZE };
    const direction = { x: 1, y: -0.05, z: 0 };
    const marched = pickTerrainCellByRay(mirror, origin, direction);
    expect(marched).not.toBeNull();
    expect(pickTerrainInColumn(mirror, marched!.x, marched!.y, origin, direction)).toEqual(marched);
  });

  it('reports the tread of the ground still under the ray after the column is lowered', () => {
    const CELL_X = 30;
    const CELL_Z = 30;
    const HIGH = BAND_HEIGHT * 8;
    const LOW = BAND_HEIGHT * 2;
    const mirror = world((x, y) => (x === CELL_X && y === CELL_Z ? HIGH : LOW));
    const origin = {
      x: (CELL_X - 4) * CELL_WORLD_SIZE,
      y: SKY_Y,
      z: CELL_Z * CELL_WORLD_SIZE,
    };
    const direction = {
      x: 4 * CELL_WORLD_SIZE,
      y: HIGH * HEIGHT_WORLD_SCALE - SKY_Y,
      z: 0,
    };
    const before = pickTerrainInColumn(mirror, CELL_X, CELL_Z, origin, direction);
    expect(before).not.toBeNull();

    setColumn(mirror.map, CELL_X, CELL_Z, [{ floor: BEDROCK_FLOOR, ceiling: LOW }]);
    const after = pickTerrainInColumn(mirror, CELL_X, CELL_Z, origin, direction);
    expect(after).not.toBeNull();
    expect(after!.x).toBe(CELL_X);
    expect(after!.y).toBe(CELL_Z);
    expect(after!.face).toBe('tread');
    expect(after!.surfaceY).toBe(LOW * HEIGHT_WORLD_SCALE);
    expect(after!.hitY).toBe(after!.surfaceY);
    expect(Math.abs(after!.hitX / CELL_WORLD_SIZE - CELL_X)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after!.hitZ / CELL_WORLD_SIZE - CELL_Z)).toBeLessThanOrEqual(0.5);
  });

  it('answers the FLOOR piece through a carved gap', () => {
    const CELL_X = 30;
    const CELL_Z = 30;
    const FLOOR_TOP = BAND_HEIGHT * 3;
    const ROOF_BASE = BAND_HEIGHT * 6;
    const ROOF_TOP = BAND_HEIGHT * 9;
    const mirror = world(() => ROOF_TOP);
    setColumn(mirror.map, CELL_X, CELL_Z, [
      { floor: BEDROCK_FLOOR, ceiling: FLOOR_TOP },
      { floor: ROOF_BASE, ceiling: ROOF_TOP },
    ]);
    // F5: a horizontal ray through the gap passes OVER the floor, so the
    // pinned column correctly misses (null). Descend through the gap onto the
    // floor to prove the floor piece is still pickable without the fallback.
    const gapY = ((FLOOR_TOP + ROOF_BASE) / 2) * HEIGHT_WORLD_SCALE;
    const origin = { x: (CELL_X - 3) * CELL_WORLD_SIZE, y: gapY, z: CELL_Z * CELL_WORLD_SIZE };
    const level = { x: 1, y: 0, z: 0 };
    expect(pickTerrainInColumn(mirror, CELL_X, CELL_Z, origin, level)).toBeNull();
    const descending = { x: 1, y: -0.5, z: 0 };
    const pick = pickTerrainInColumn(mirror, CELL_X, CELL_Z, origin, descending);
    expect(pick).not.toBeNull();
    expect(pick!.spanIndex).toBe(0);
    expect(pick!.face).toBe('tread');
    expect(pick!.surfaceY).toBe(FLOOR_TOP * HEIGHT_WORLD_SCALE);
    expect(pick!.hitY).toBe(pick!.surfaceY);
  });

  it('is null for a ray that misses the cell entirely', () => {
    const mirror = world(() => 0);
    const origin = { x: 10 * CELL_WORLD_SIZE, y: SKY_Y, z: 10 * CELL_WORLD_SIZE };
    expect(pickTerrainInColumn(mirror, 40, 40, origin, { x: 0, y: -1, z: 0 })).toBeNull();
  });

  it('is null off the world, and for a cell in a chunk that was never sent', () => {
    const mirror = createTerrainMirror(WORLD);
    const heights = new Array<number>(CELLS_PER_CHUNK).fill(0);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [{ cx: 0, cy: 0, heights }],
    } as JoinSnapshotMessage);
    const origin = { x: 40 * CELL_WORLD_SIZE, y: SKY_Y, z: 40 * CELL_WORLD_SIZE };
    const down = { x: 0, y: -1, z: 0 };
    expect(pickTerrainInColumn(mirror, 40, 40, origin, down)).toBeNull();
    expect(pickTerrainInColumn(mirror, -1, 0, origin, down)).toBeNull();
    expect(pickTerrainInColumn(mirror, 0, WORLD, origin, down)).toBeNull();
  });

  it('still reports a riser hit when the ray meets the pinned column on its face', () => {
    const mirror = world((x) => (x >= 32 ? BAND_HEIGHT * 10 : 0));
    const origin = {
      x: 30 * CELL_WORLD_SIZE,
      y: BAND_HEIGHT * 5 * HEIGHT_WORLD_SCALE,
      z: 20 * CELL_WORLD_SIZE,
    };
    const pick = pickTerrainInColumn(mirror, 32, 20, origin, { x: 1, y: 0, z: 0 });
    expect(pick).not.toBeNull();
    expect(pick!.face).toBe('riser');
    expect(pick!.hitY).toBe(BAND_HEIGHT * 5 * HEIGHT_WORLD_SCALE);
  });
});

describe('lane D drawn-band probes (F1-F8)', () => {
  const WORLD = 64;
  const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

  function world(
    heightOf: (x: number, y: number) => number,
  ): TerrainMirror {
    const mirror = createTerrainMirror(WORLD);
    const perEdge = WORLD / CHUNK_SIZE;
    const chunks: ChunkPayload[] = [];
    for (let cy = 0; cy < perEdge; cy++) {
      for (let cx = 0; cx < perEdge; cx++) {
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
  const SKY_Y = MAX_HEIGHT * HEIGHT_WORLD_SCALE + 10;
  const above = (x: number, z: number): Vec3 => ({
    x: x * CELL_WORLD_SIZE,
    y: SKY_Y,
    z: z * CELL_WORLD_SIZE,
  });

  it('F1 grazing chord: a horizontal ray that never dips below the drawn cap still hits the wall', () => {
    const mirror = world((x) => (x >= 32 ? BAND_HEIGHT * 10 : 0));
    const rayY = BAND_HEIGHT * 5 * HEIGHT_WORLD_SCALE;
    const hit = pickTerrainCellByRay(
      mirror,
      { x: 20 * CELL_WORLD_SIZE, y: rayY, z: 20 * CELL_WORLD_SIZE },
      { x: 1, y: 0, z: 0 },
    );
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(32);
    expect(hit!.face).toBe('riser');
    expect(hit!.hitY).toBe(rayY);
  });

  it('F2 diagonal owner: a cap strike owned only diagonally resolves instead of vanishing', () => {
    // Orthogonal neighbours are water, the south-east diagonal is a tower.
    // Only the 8-neighbour search can name (12, 12); the old 4-neighbour
    // search returned null here.
    const TOWER = BAND_HEIGHT * 10;
    const mirror = world(() => 0);
    setColumn(mirror.map, 12, 12, [{ floor: BEDROCK_FLOOR, ceiling: TOWER }]);
    const owner = columnOwningBand(
      mirror,
      11,
      11,
      11.9,
      11.9,
      drawnBandOfSample(TOWER),
      TOWER * HEIGHT_WORLD_SCALE,
    );
    expect(owner).toEqual({ x: 12, y: 12, spanIndex: 0 });
    // And the never-null fallback keeps a top-down cap strike on the entered
    // cell instead of vanishing when no neighbour owns the band.
    const hit = pickTerrainCellByRay(mirror, above(11, 11), DOWN);
    expect(hit).not.toBeNull();
  });

  it('F3 shore heights: a sea-level tread resolves to the drawn water band', () => {
    const mirror = world(() => 0);
    const hit = pickTerrainCellByRay(mirror, above(4, 4), DOWN);
    expect(hit).not.toBeNull();
    // drawnBandOfSample(0) is -1 (water); the blocky bandOf(0) would say 0.
    expect(hit!.surfaceY).toBe(drawnBandOfSample(0) * BAND_HEIGHT * HEIGHT_WORLD_SCALE);
    expect(hit!.surfaceY).toBe(-BAND_HEIGHT * HEIGHT_WORLD_SCALE);
  });

  it('F3+P1 bias ceilings: a half-band height names the drawn band above', () => {
    // 8 is half a band: blocky bandOf says 0, drawn bias says 1.
    const mirror = world(() => BAND_HEIGHT / 2);
    const hit = pickTerrainCellByRay(mirror, above(4, 4), DOWN);
    expect(hit).not.toBeNull();
    expect(hit!.surfaceY).toBe(BAND_HEIGHT * HEIGHT_WORLD_SCALE);
  });

  it('F4+F6 slab corner and dy=0 rim: an underside cue snaps to the drawn ceiling', () => {
    const CELL_X = 30;
    const CELL_Z = 30;
    const mirror = world(() => BAND_HEIGHT * 9);
    setColumn(mirror.map, CELL_X, CELL_Z, [
      { floor: BEDROCK_FLOOR, ceiling: BAND_HEIGHT * 3 },
      { floor: BAND_HEIGHT * 6, ceiling: BAND_HEIGHT * 9 },
    ]);
    // Start inside the open gap and rise into the roof slab: the underside
    // cue snaps to the drawn ceiling (hitY == surfaceY).
    const gapY = ((BAND_HEIGHT * 3 + BAND_HEIGHT * 6) / 2) * HEIGHT_WORLD_SCALE;
    const pick = pickTerrainInColumn(
      mirror,
      CELL_X,
      CELL_Z,
      { x: CELL_X * CELL_WORLD_SIZE, y: gapY, z: CELL_Z * CELL_WORLD_SIZE },
      { x: 0, y: 1, z: 0 },
    );
    expect(pick).not.toBeNull();
    expect(pick!.face).toBe('underside');
    expect(pick!.hitY).toBe(pick!.surfaceY);
  });

  it('F7/F8 slab corner: a ray on the exact slab plane still names the wall', () => {
    const mirror = world((x) => (x >= 32 ? BAND_HEIGHT * 10 : 0));
    const seamY = BAND_HEIGHT * 6 * HEIGHT_WORLD_SCALE;
    const hit = pickTerrainCellByRay(
      mirror,
      { x: 20 * CELL_WORLD_SIZE, y: seamY, z: 20 * CELL_WORLD_SIZE },
      { x: 1, y: 0, z: 0 },
    );
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(32);
    expect(hit!.face).toBe('riser');
    expect(hit!.hitY).toBe(seamY);
  });

  it('F5 pinned miss: a level ray over lowered ground returns null', () => {
    const CELL_X = 30;
    const CELL_Z = 30;
    const mirror = world(() => BAND_HEIGHT * 8);
    const origin = { x: (CELL_X - 3) * CELL_WORLD_SIZE, y: BAND_HEIGHT * 8 * HEIGHT_WORLD_SCALE, z: CELL_Z * CELL_WORLD_SIZE };
    setColumn(mirror.map, CELL_X, CELL_Z, [{ floor: BEDROCK_FLOOR, ceiling: BAND_HEIGHT * 2 }]);
    const pick = pickTerrainInColumn(mirror, CELL_X, CELL_Z, origin, { x: 1, y: 0, z: 0 });
    expect(pick).toBeNull();
  });

  it('B0 shore riser: skirt hits resolve to the drawn band of the span cap', () => {
    // The drawn mesh flattens sub-band shore relief (a tread at 5 draws its
    // cap at y=0), so the visible waterline step is the skirt below the cap
    // and the march can only strike it at hitY <= 0. Raw ceil names 0 there
    // and the old shore rule mapped that to water (-1) — but the span draws
    // band 0 and the only nearby lip is the drawn band-0 waterline loop, so
    // -1 starves lipNear and the drag grab silently fails.
    const mirror = world((x) => (x >= 32 ? 5 : 0));
    const skirtHit = {
      x: 32,
      y: 20,
      surfaceY: 0,
      spanIndex: 0,
      face: 'riser' as const,
      hitY: -5 * HEIGHT_WORLD_SCALE,
      hitX: 32 * CELL_WORLD_SIZE,
      hitZ: 20 * CELL_WORLD_SIZE,
    };
    expect(resolvePick(mirror.map, skirtHit)?.band).toBe(0);
    // Control: a skirt hit on a span that itself draws water still maps to -1.
    // (Flat -20 draws band -1 with its cap at -16; the hit sits inside its wall.)
    const sea = world(() => -20);
    const seaHit = {
      ...skirtHit,
      x: 4,
      y: 4,
      hitY: -18 * HEIGHT_WORLD_SCALE,
      hitX: 4 * CELL_WORLD_SIZE,
      hitZ: 4 * CELL_WORLD_SIZE,
    };
    expect(resolvePick(sea.map, seaHit)?.band).toBe(-1);
  });
});

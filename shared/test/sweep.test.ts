import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  MAX_DRAG_SWEEP_CELLS,
  chunksWithinSweep,
  createSeededRng,
  forEachFootprintOffset,
  forEachLineCell,
  forEachSweptCell,
  pointWithinSweep,
  revealChunkIndices,
  revealReachCells,
  strokeSweep,
  sweepAt,
  sweepBetween,
  sweptCellCount,
  type SculptIntent,
} from '../src/index.ts';

const RADII = [1, 4, 8, MAX_BRUSH_RADIUS];

/** A rasterised line strays under one cell from the segment it draws. */
const RASTER_WANDER_CELLS = 1;

const WORLD_SIZE = 16 * CHUNK_SIZE;

/** The oracle: point-to-segment distance the slow, floating way. */
function oracleDistanceSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared === 0) return wx * wx + wy * wy;
  const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / lengthSquared));
  const nx = ax + t * vx - px;
  const ny = ay + t * vy - py;
  return nx * nx + ny * ny;
}

function discThreshold(radius: number): number {
  return radius === 1 ? 1 : radius * (radius - 1);
}

function sweptCells(sweep: ReturnType<typeof sweepAt>): string[] {
  const out: string[] = [];
  forEachSweptCell(sweep, (x, y) => out.push(`${x},${y}`));
  return out;
}

function footprintCells(cx: number, cy: number, radius: number): string[] {
  const out: string[] = [];
  forEachFootprintOffset(radius, (dx, dy) => out.push(`${cx + dx},${cy + dy}`));
  return out;
}

describe('a sweep that goes nowhere is the brush disc', () => {
  const ORIGIN = { x: 40, y: 24 } as const;

  it.each(RADII)('radius %i covers exactly the footprint, in the same order', (radius) => {
    const sweep = sweepAt(ORIGIN.x, ORIGIN.y, radius);
    expect(sweptCells(sweep)).toEqual(footprintCells(ORIGIN.x, ORIGIN.y, radius));
  });

  it.each(RADII)('radius %i counts exactly the footprint cells', (radius) => {
    expect(sweptCellCount(sweepAt(ORIGIN.x, ORIGIN.y, radius))).toBe(
      footprintCells(ORIGIN.x, ORIGIN.y, radius).length,
    );
  });

  it.each(RADII)('radius %i membership equals the footprint membership', (radius) => {
    const sweep = sweepAt(ORIGIN.x, ORIGIN.y, radius);
    const inside = new Set(footprintCells(ORIGIN.x, ORIGIN.y, radius));
    for (let y = ORIGIN.y - radius - 1; y <= ORIGIN.y + radius + 1; y++) {
      for (let x = ORIGIN.x - radius - 1; x <= ORIGIN.x + radius + 1; x++) {
        expect(pointWithinSweep(sweep, x, y)).toBe(inside.has(`${x},${y}`));
      }
    }
  });

  it.each(RADII)('radius %i with added reach is the grown disc the guards test', (radius) => {
    const sweep = sweepAt(ORIGIN.x, ORIGIN.y, radius);
    for (const extra of [1, 2, 5]) {
      const reach = radius + extra;
      for (let y = ORIGIN.y - reach - 1; y <= ORIGIN.y + reach + 1; y++) {
        for (let x = ORIGIN.x - reach - 1; x <= ORIGIN.x + reach + 1; x++) {
          const dx = x - ORIGIN.x;
          const dy = y - ORIGIN.y;
          expect(pointWithinSweep(sweep, x, y, extra)).toBe(dx * dx + dy * dy < reach * reach);
        }
      }
    }
  });

  it.each(RADII)('radius %i reaches exactly the reveal chunks', (radius) => {
    for (const cell of [
      { x: 0, y: 0 },
      { x: 37, y: 5 },
      { x: 128, y: 200 },
      { x: WORLD_SIZE - 1, y: WORLD_SIZE - 1 },
    ]) {
      expect(
        chunksWithinSweep(WORLD_SIZE, sweepAt(cell.x, cell.y, radius), revealReachCells(radius)),
      ).toEqual(revealChunkIndices(WORLD_SIZE, cell.x, cell.y, radius));
    }
  });
});

describe('a drag leg is the capsule its segment thickens into', () => {
  const rng = createSeededRng(0x5eed);
  const legs: { fromX: number; fromY: number; toX: number; toY: number; radius: number }[] = [];
  for (let n = 0; n < 240; n++) {
    const radius = 1 + Math.floor(rng.next() * MAX_BRUSH_RADIUS);
    const length = 1 + Math.floor(rng.next() * MAX_DRAG_SWEEP_CELLS);
    const angle = Math.floor(rng.next() * 8);
    const longAxis = length;
    const shortAxis = Math.floor(rng.next() * (length + 1));
    const dx = angle % 2 === 0 ? longAxis : shortAxis;
    const dy = angle % 2 === 0 ? shortAxis : longAxis;
    legs.push({
      fromX: 64,
      fromY: 64,
      toX: 64 + (angle < 4 ? dx : -dx),
      toY: 64 + (angle % 4 < 2 ? dy : -dy),
      radius,
    });
  }

  it('membership matches the floating-point point-to-segment oracle', () => {
    let checked = 0;
    for (const leg of legs) {
      const sweep = sweepBetween(leg.fromX, leg.fromY, leg.toX, leg.toY, leg.radius);
      const threshold = discThreshold(leg.radius);
      const margin = leg.radius + 1;
      for (let y = Math.min(leg.fromY, leg.toY) - margin; y <= Math.max(leg.fromY, leg.toY) + margin; y++) {
        for (let x = Math.min(leg.fromX, leg.toX) - margin; x <= Math.max(leg.fromX, leg.toX) + margin; x++) {
          const oracle = oracleDistanceSquared(x, y, leg.fromX, leg.fromY, leg.toX, leg.toY);
          expect(pointWithinSweep(sweep, x, y)).toBe(oracle < threshold);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100000);
  });

  it('holds every cell the rasterised sweep writes, within the line wander', () => {
    for (const leg of legs) {
      const sweep = sweepBetween(leg.fromX, leg.fromY, leg.toX, leg.toY, leg.radius);
      forEachLineCell(leg.fromX, leg.fromY, leg.toX, leg.toY, (sx, sy) => {
        forEachFootprintOffset(leg.radius, (dx, dy) => {
          expect(pointWithinSweep(sweep, sx + dx, sy + dy, RASTER_WANDER_CELLS)).toBe(true);
        });
      });
    }
  });

  it('enumerates the same cells, in the same order, every call', () => {
    for (const leg of legs.slice(0, 40)) {
      const sweep = sweepBetween(leg.fromX, leg.fromY, leg.toX, leg.toY, leg.radius);
      const first = sweptCells(sweep);
      expect(sweptCells(sweep)).toEqual(first);
      expect(sweptCellCount(sweep)).toBe(first.length);
      expect(first.every((cell) => cell.split(',').every((n) => Number.isInteger(Number(n))))).toBe(
        true,
      );
    }
  });

  it('covers more ground than the disc at either end', () => {
    const sweep = sweepBetween(10, 10, 26, 10, 4);
    expect(sweptCellCount(sweep)).toBeGreaterThan(sweptCellCount(sweepAt(10, 10, 4)));
  });
});

describe('chunksWithinSweep', () => {
  const SEGMENT_SAMPLES = 20000;

  function oracleChunkReached(
    sweep: ReturnType<typeof sweepBetween>,
    cx: number,
    cy: number,
    reachCells: number,
  ): boolean | null {
    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    const x1 = x0 + CHUNK_SIZE - 1;
    const y1 = y0 + CHUNK_SIZE - 1;
    let best = Number.POSITIVE_INFINITY;
    for (let n = 0; n <= SEGMENT_SAMPLES; n++) {
      const t = n / SEGMENT_SAMPLES;
      const px = sweep.fromX + (sweep.toX - sweep.fromX) * t;
      const py = sweep.fromY + (sweep.toY - sweep.fromY) * t;
      const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
      const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    const reachSquared = reachCells * reachCells;
    const slack = 1e-4;
    if (best < reachSquared - slack) return true;
    if (best > reachSquared + slack) return false;
    return null;
  }

  it('matches a densely sampled rect-to-segment oracle', () => {
    const rng = createSeededRng(0xc0ffee);
    let decided = 0;
    for (let n = 0; n < 24; n++) {
      const radius = 1 + Math.floor(rng.next() * MAX_BRUSH_RADIUS);
      const fromX = 40 + Math.floor(rng.next() * 60);
      const fromY = 40 + Math.floor(rng.next() * 60);
      const toX = fromX + Math.floor(rng.next() * (2 * MAX_DRAG_SWEEP_CELLS + 1)) - MAX_DRAG_SWEEP_CELLS;
      const toY = fromY + Math.floor(rng.next() * (2 * MAX_DRAG_SWEEP_CELLS + 1)) - MAX_DRAG_SWEEP_CELLS;
      const sweep = sweepBetween(fromX, fromY, toX, toY, radius);
      const reach = revealReachCells(radius);
      const reached = new Set(chunksWithinSweep(WORLD_SIZE, sweep, reach));
      const perEdge = WORLD_SIZE / CHUNK_SIZE;
      for (let cy = 0; cy < perEdge; cy++) {
        for (let cx = 0; cx < perEdge; cx++) {
          const oracle = oracleChunkReached(sweep, cx, cy, reach);
          if (oracle === null) continue;
          expect(reached.has(cy * perEdge + cx)).toBe(oracle);
          decided++;
        }
      }
    }
    expect(decided).toBeGreaterThan(5000);
  });

  it('returns chunks row-major and without repeats', () => {
    const sweep = sweepBetween(30, 30, 30 + MAX_DRAG_SWEEP_CELLS, 37, 4);
    const reached = chunksWithinSweep(WORLD_SIZE, sweep, revealReachCells(4));
    expect(new Set(reached).size).toBe(reached.length);
    expect([...reached].sort((a, b) => a - b)).toEqual(reached);
  });

  it('opens a chunk a leg only crosses in the middle', () => {
    const perEdge = WORLD_SIZE / CHUNK_SIZE;
    const radius = 1;
    const reach = revealReachCells(radius);
    const fromX = 8;
    const toX = fromX + 4 * CHUNK_SIZE;
    const y = 8;
    const sweep = sweepBetween(fromX, y, toX, y, radius);
    const crossed = 2 * CHUNK_SIZE;
    const midChunk = Math.floor(crossed / CHUNK_SIZE);
    const index = Math.floor(y / CHUNK_SIZE) * perEdge + midChunk;
    expect(chunksWithinSweep(WORLD_SIZE, sweep, reach)).toContain(index);
    expect(revealChunkIndices(WORLD_SIZE, fromX, y, radius)).not.toContain(index);
  });
});

describe('strokeSweep', () => {
  const BASE: SculptIntent = { type: 'sculpt', x: 30, y: 40, radius: 4, dir: 1 };

  it('a non-drag intent is the disc at its cell', () => {
    expect(strokeSweep(BASE)).toEqual(sweepAt(30, 40, 4));
  });

  it('a drag leg without an origin is the disc at its cell', () => {
    expect(strokeSweep({ ...BASE, tool: 'drag', targetBand: 3 })).toEqual(sweepAt(30, 40, 4));
  });

  it('a drag leg with an origin is the capsule between the two', () => {
    expect(
      strokeSweep({ ...BASE, tool: 'drag', targetBand: 3, fromX: 20, fromY: 35 }),
    ).toEqual(sweepBetween(20, 35, 30, 40, 4));
  });
});

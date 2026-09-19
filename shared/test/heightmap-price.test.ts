import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applySculpt,
  BAND_HEIGHT,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  forEachFootprintOffset,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  CARVE_DEFAULT_DEPTH_BANDS,
  MAX_DRAG_SWEEP_CELLS,
  bandLevelHeight,
  columnSolidUnits,
  displacementOf,
  sculptDisplacementUnits,
  sculptOptionsOf,
  sculptSweepRadius,
  smooth,
  snapshotSolidUnits,
  strokeReachBox,
  type SculptIntent,
} from '../src/index.ts';

function observedDisplacement(
  radius: number,
  profile: 'soft' | 'hard',
  amount: number,
): number {
  const size = 64;
  const map = createHeightmap(size);
  const start = bandLevelHeight(8);
  map.cells.fill(start);

  const options = { tool: 'stamp', profile, anchor: 'clicked' } as const;
  applySculpt(map, 32, 32, radius, amount, options);

  let total = 0;
  forEachFootprintOffset(sculptSweepRadius(radius, profile, 'stamp', 'clicked'), (dx, dy) => {
    total += Math.abs(map.cells[(32 + dy) * size + (32 + dx)]! - start);
  });
  return total;
}

describe('sculptDisplacementUnits', () => {
  it('covers the volume a press moves, exactly for a fill, for every radius × profile', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        const price = sculptDisplacementUnits(radius, 'stamp', profile, CARVE_DEFAULT_DEPTH_BANDS);
        const moved = observedDisplacement(radius, profile, DEFAULT_SCULPT_AMOUNT);
        // A soft press pays for a sheet flat ground gives it no room to hang.
        if (profile === 'hard') expect(price).toBe(moved);
        else expect(price).toBeGreaterThanOrEqual(moved);
      }
    }
  });

  it('prices a lower exactly like the raise that undoes it', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(observedDisplacement(radius, profile, -DEFAULT_SCULPT_AMOUNT)).toBe(
          observedDisplacement(radius, profile, DEFAULT_SCULPT_AMOUNT),
        );
      }
    }
  });

  it('matches the published table of displacement volumes', () => {
    expect(sculptDisplacementUnits(1, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toBe(16);
    expect(sculptDisplacementUnits(2, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toBe(80);
    expect(sculptDisplacementUnits(3, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toBe(336);
    expect(sculptDisplacementUnits(4, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toBe(592);
  });

  it('is one band-cell at the point brush', () => {
    expect(sculptDisplacementUnits(MIN_BRUSH_RADIUS, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toBe(BAND_HEIGHT);
  });

  it('grows with radius', () => {
    for (let radius = MIN_BRUSH_RADIUS; radius < MAX_BRUSH_RADIUS; radius++) {
      expect(sculptDisplacementUnits(radius + 1, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toBeGreaterThan(
        sculptDisplacementUnits(radius, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS),
      );
    }
  });

  it('is a pure integer function of radius and tool', () => {
    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      const units = sculptDisplacementUnits(radius, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS);
      expect(Number.isInteger(units)).toBe(true);
      expect(sculptDisplacementUnits(radius, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toBe(units);
    }
  });

  it('rejects a radius the brush itself would reject', () => {
    for (const bad of [0, MAX_BRUSH_RADIUS + 1, 1.5, Number.NaN]) {
      expect(() => sculptDisplacementUnits(bad, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toThrow(RangeError);
    }
  });

  it('ignores the relaxation spill, which stays deliberately free', () => {
    const size = 64;
    const stampedCells = new Set<number>();
    const stamped = createHeightmap(size);
    stamped.cells.fill(bandLevelHeight(8));
    applyBrush(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, stampedCells, 'hard');
    applyBrush(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, stampedCells, 'hard');

    const slumped = createHeightmap(size);
    slumped.cells.fill(bandLevelHeight(8));
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    const slumpedDiff = applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, {
      tool: 'smooth',
      profile: 'hard',
    });

    expect(slumpedDiff.length).toBeGreaterThan(stampedCells.size);
    expect(sculptDisplacementUnits(4, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toBe(592);
  });

  it('prices a LEVEL FILL at the flat-delta volume, deliberately', () => {
    const map = createHeightmap(32);
    map.cells.fill(BAND_HEIGHT);
    map.cells[cellIndex(map, 16, 16)] = 0;

    const diff = applySculpt(map, 16, 16, MAX_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'stamp',
      profile: 'hard',
    });

    expect(diff).toHaveLength(1);
    expect(sculptDisplacementUnits(MAX_BRUSH_RADIUS, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS)).toBe(749 * BAND_HEIGHT);
  });
});

const WORLD = 128;

const CENTRE = 64;

const SEA_FLOOR = 0;

const WALL_BAND = 12;

const LOW_BAND = 4;

const CARVE_BAND = 8;

function flatWorld(height: number) {
  const map = createHeightmap(WORLD);
  map.cells.fill(height);
  return map;
}

/** Low ground west, a plateau east: a carve needs a face to cut into. */
function walledWorld() {
  const map = flatWorld(bandLevelHeight(LOW_BAND));
  for (let y = 0; y < WORLD; y++) {
    for (let x = CENTRE; x < WORLD; x++) map.cells[y * WORLD + x] = bandLevelHeight(WALL_BAND);
  }
  return map;
}

interface Measured {
  readonly units: number;
  readonly cells: number;
  readonly down: number;
  readonly up: number;
  readonly outsideReach: number;
}

function measure(map: ReturnType<typeof createHeightmap>, intent: SculptIntent): Measured {
  const box = strokeReachBox(WORLD, intent);
  const before = snapshotSolidUnits(map, box.minX, box.minY, box.maxX, box.maxY);
  const diff = applySculpt(
    map,
    intent.x,
    intent.y,
    intent.radius,
    DEFAULT_SCULPT_AMOUNT * intent.dir,
    sculptOptionsOf(intent),
  );

  let down = 0;
  let up = 0;
  let outsideReach = 0;
  for (const cell of diff) {
    if (cell.x < box.minX || cell.x > box.maxX || cell.y < box.minY || cell.y > box.maxY) {
      outsideReach++;
      continue;
    }
    const was = before.get(cellIndex(map, cell.x, cell.y))!;
    const now = columnSolidUnits(map, cell.x, cell.y);
    if (now > was) up += now - was;
    else down += was - now;
  }
  return { units: displacementOf(before, map, diff), cells: diff.length, down, up, outsideReach };
}

function stamp(profile: 'soft' | 'hard', radius: number): SculptIntent {
  return { type: 'sculpt', x: CENTRE, y: CENTRE, radius, dir: 1, tool: 'stamp', profile };
}

describe('displacementOf — what a stroke actually moved', () => {
  it('a hard stamp on flat ground pays the footprint, a full band a cell', () => {
    for (const radius of [1, 2, 4, 8, MAX_BRUSH_RADIUS]) {
      const measured = measure(flatWorld(bandLevelHeight(LOW_BAND)), stamp('hard', radius));
      let footprint = 0;
      forEachFootprintOffset(radius, () => {
        footprint++;
      });
      expect(measured.units).toBe(footprint * BAND_HEIGHT);
      expect(measured.units).toBe(
        sculptDisplacementUnits(radius, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS),
      );
    }
  });

  it('a soft stamp levels its core, and on flat ground its apron is free', () => {
    const measured = measure(flatWorld(bandLevelHeight(LOW_BAND)), stamp('soft', 4));
    expect(measured.units).toBe(measured.up + measured.down);
    // Flat ground leaves the apron nothing to reach down to, so only the core moves.
    expect(measured.units).toBe(
      sculptDisplacementUnits(4, 'stamp', 'soft', CARVE_DEFAULT_DEPTH_BANDS),
    );
  });

  it('a raise out of the sea pays the one unit a cell it moved, not a band', () => {
    const radius = 4;
    const measured = measure(flatWorld(SEA_FLOOR), stamp('hard', radius));
    let footprint = 0;
    forEachFootprintOffset(radius, () => {
      footprint++;
    });
    expect(measured.units).toBe(footprint * bandLevelHeight(0));
    expect((measured.units / bandLevelHeight(0)) * BAND_HEIGHT).toBe(
      sculptDisplacementUnits(radius, 'stamp', 'hard', CARVE_DEFAULT_DEPTH_BANDS),
    );
  });

  it('a carve pays the material it removed, and only the cells it opened', () => {
    for (const radius of [4, 8]) {
      const measured = measure(walledWorld(), {
        type: 'sculpt',
        x: CENTRE + 1,
        y: CENTRE,
        radius,
        dir: -1,
        tool: 'carve',
        spanBand: CARVE_BAND,
        depthBands: CARVE_DEFAULT_DEPTH_BANDS,
      });
      expect(measured.cells).toBeGreaterThan(0);
      expect(measured.units).toBe(measured.cells * CARVE_DEFAULT_DEPTH_BANDS * BAND_HEIGHT);
      expect(measured.up).toBe(0);
    }
  });

  it('a smooth pays both sides of every exchange, the sum of the moves', () => {
    const map = flatWorld(bandLevelHeight(LOW_BAND));
    for (let y = 0; y < WORLD; y++) {
      for (let x = CENTRE; x < WORLD; x++) map.cells[y * WORLD + x] = bandLevelHeight(LOW_BAND + 2);
    }
    const measured = measure(map, {
      type: 'sculpt',
      x: CENTRE,
      y: CENTRE,
      radius: 4,
      dir: 1,
      tool: 'smooth',
    });

    expect(measured.down).toBeGreaterThan(0);
    expect(measured.up).toBeGreaterThan(0);
    expect(measured.units).toBe(measured.down + measured.up);
  });

  it('an empty diff moved nothing, with no special case', () => {
    const map = flatWorld(bandLevelHeight(LOW_BAND));
    const box = strokeReachBox(WORLD, stamp('hard', 4));
    const before = snapshotSolidUnits(map, box.minX, box.minY, box.maxX, box.maxY);
    expect(displacementOf(before, map, [])).toBe(0);
  });

  it('measures the same units however often it is asked', () => {
    const map = flatWorld(bandLevelHeight(LOW_BAND));
    const intent = stamp('hard', 4);
    const box = strokeReachBox(WORLD, intent);
    const before = snapshotSolidUnits(map, box.minX, box.minY, box.maxX, box.maxY);
    const diff = applySculpt(map, intent.x, intent.y, intent.radius, DEFAULT_SCULPT_AMOUNT, sculptOptionsOf(intent));

    const first = displacementOf(before, map, diff);
    expect(displacementOf(before, map, diff)).toBe(first);
    expect(Number.isInteger(first)).toBe(true);
  });
});

describe('strokeReachBox holds everything a stroke writes', () => {
  it('contains the whole diff, for every tool, profile, radius and direction', () => {
    let measured = 0;
    for (const tool of ['stamp', 'smooth', 'drag', 'carve'] as const) {
      for (const radius of [1, 2, 4, 8, MAX_BRUSH_RADIUS]) {
        for (const profile of ['soft', 'hard'] as const) {
          for (const dir of [1, -1] as const) {
            if (tool === 'carve' && dir === 1) continue;
            const base = { type: 'sculpt', x: CENTRE, y: CENTRE, radius, dir, tool, profile } as const;
            const intent: SculptIntent =
              tool === 'drag'
                ? { ...base, targetBand: LOW_BAND, fromX: CENTRE - MAX_DRAG_SWEEP_CELLS, fromY: CENTRE - 7 }
                : tool === 'carve'
                  ? { ...base, spanBand: CARVE_BAND, depthBands: CARVE_DEFAULT_DEPTH_BANDS }
                  : base;
            expect(measure(walledWorld(), intent).outsideReach).toBe(0);
            measured++;
          }
        }
      }
    }
    expect(measured).toBeGreaterThan(60);
  });
});

import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  bandOf,
  BAND_HEIGHT,
  canSpreadBandTo,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  heightAt,
  MIN_BRUSH_RADIUS,
  type Heightmap,
} from '../src/index.ts';

function mapWithPlateau(
  size: number,
  height: number,
  blockHeight: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): ReturnType<typeof createHeightmap> {
  const map = createHeightmap(size);
  map.cells.fill(height);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) map.cells[cellIndex(map, x, y)] = blockHeight;
  }
  return map;
}

describe('canSpreadBandTo — the drag anchor’s adjacency rule', () => {
  const BAND = 3;
  const HIGH = BAND * BAND_HEIGHT;

  it('is true beside ground already at the band, in all eight directions', () => {
    for (const [dx, dy] of [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0], [1, 0],
      [-1, 1], [0, 1], [1, 1],
    ] as const) {
      const map = createHeightmap(16);
      map.cells.fill(0);
      map.cells[cellIndex(map, 8 + dx, 8 + dy)] = HIGH;
      expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(true);
    }
  });

  it('is true beside ground ABOVE the band — a lip may spread off a taller shelf', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    map.cells[cellIndex(map, 9, 8)] = HIGH + BAND_HEIGHT * 4;
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(true);
  });

  it('is false in open ground — a forged band conjures no height', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(false);
  });

  it('is false two cells away — the band creeps one cell at a time', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    map.cells[cellIndex(map, 10, 8)] = HIGH;
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(false);
    expect(canSpreadBandTo(map, 9, 8, BAND)).toBe(true);
  });

  it('ignores the cell’s OWN height — adjacency is about neighbours', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    map.cells[cellIndex(map, 8, 8)] = HIGH;
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(false);
  });

  it('treats off-map neighbours as absent — the world border holds nothing up', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    expect(canSpreadBandTo(map, 0, 0, BAND)).toBe(false);
    map.cells[cellIndex(map, 1, 1)] = HIGH;
    expect(canSpreadBandTo(map, 0, 0, BAND)).toBe(true);
  });
});

describe('applySculpt with the drag anchor — a band extends sideways', () => {
  const BAND = 3;
  const HIGH = BAND * BAND_HEIGHT;
  const DRAG = { tool: 'stamp', profile: 'hard', spill: 'banded', anchor: 'band' } as const;

  it('pulls the grabbed band onto the cell beside it, and stops AT it', () => {
    const map = mapWithPlateau(16, 0, HIGH, 0, 0, 7, 15);
    const diff = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(diff.length).toBe(1);
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(HIGH);
    const again = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(again).toEqual([]);
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(HIGH);
  });

  it('is a NO-OP on a cell that touches no such ground — the anti-cheat rule', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    const before = [...map.cells];
    const diff = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(diff).toEqual([]);
    expect([...map.cells]).toEqual(before);
  });

  it('never touches ground already at or above the grabbed band', () => {
    const map = mapWithPlateau(16, 0, HIGH, 0, 0, 7, 15);
    const tall = (BAND + 4) * BAND_HEIGHT;
    map.cells[cellIndex(map, 8, 8)] = tall;
    const diff = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(diff).toEqual([]);
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(tall);
  });

  it('targets the GRABBED band, not one band off the cell under the cursor', () => {
    const grabbed = 6;
    const map = createHeightmap(16);
    map.cells.fill(0);
    for (let y = 0; y < 16; y++) map.cells[cellIndex(map, 7, y)] = grabbed * BAND_HEIGHT;
    applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: grabbed,
    });
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(grabbed * BAND_HEIGHT);

    const clicked = createHeightmap(16);
    clicked.cells.fill(0);
    for (let y = 0; y < 16; y++) clicked.cells[cellIndex(clicked, 7, y)] = grabbed * BAND_HEIGHT;
    for (let i = 0; i < 20; i++) {
      applySculpt(clicked, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
        tool: 'stamp', profile: 'hard', spill: 'banded', anchor: 'clicked',
      });
    }
    expect(bandOf(clicked.cells[cellIndex(clicked, 8, 8)]!)).toBeGreaterThan(grabbed);
  });

  it('walks: each intent’s result is what makes the next one legal', () => {
    const map = mapWithPlateau(24, 0, HIGH, 0, 0, 7, 23);
    for (let x = 8; x < 14; x++) {
      applySculpt(map, x, 12, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
        ...DRAG,
        targetBand: BAND,
      });
      expect(map.cells[cellIndex(map, x, 12)]).toBe(HIGH);
      expect(map.cells[cellIndex(map, x + 1, 12)]).toBe(0);
    }
  });
});

describe('a soft drag bites its rim at the disc diagonals too (issue #152)', () => {
  const SIZE = 64;
  const PLATEAU_X = 40;
  const TARGET_BAND = 1;
  const RADIUS = 4;
  const CX = 37;
  const CY = 17;
  const BOUNDARY_DX = -2;
  const BOUNDARY_DY = 2;

  it('leaves a refused boundary cell bitten rather than filling it as an enclave', () => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = PLATEAU_X; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = BAND_HEIGHT;
    }

    applySculpt(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'soft',
      targetBand: TARGET_BAND,
    });

    expect(heightAt(map, CX, CY)).toBe(BAND_HEIGHT);
    expect(heightAt(map, CX + BOUNDARY_DX, CY + BOUNDARY_DY)).toBe(0);
  });
});

describe('a pull carries the one level under it and no further', () => {
  const SIZE = 64;
  const TREAD_CELLS = 2;
  const TOP_BAND = 3;
  const STAIR_X = 20;
  const CY = 32;
  const RADIUS = 2;

  const bandAtX = (x: number): number =>
    x < STAIR_X ? TOP_BAND : Math.max(0, TOP_BAND - (Math.floor((x - STAIR_X) / TREAD_CELLS) + 1));

  it('pushes the step below the grabbed band, and leaves the one under that', () => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = bandAtX(x) * BAND_HEIGHT;
    }

    applySculpt(map, STAIR_X, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'hard',
      targetBand: TOP_BAND,
    });

    expect(bandOf(heightAt(map, STAIR_X, CY))).toBe(TOP_BAND);
    expect(bandOf(heightAt(map, STAIR_X + TREAD_CELLS, CY))).toBe(TOP_BAND - 1);
    expect(bandOf(heightAt(map, STAIR_X + 2 * TREAD_CELLS - 1, CY))).toBe(TOP_BAND - 2);
    expect(bandOf(heightAt(map, STAIR_X + 2 * TREAD_CELLS, CY))).toBe(TOP_BAND - 3);
  });
});

describe('a drag sweeps its footprint along the cursor path — no gaps on a flick (2026-09-05)', () => {
  const SIZE = 64;
  const PLAIN_BAND = 1;
  const LIP_BAND = 3;
  const CY = 32;
  const LIP_X = 20;
  const RADIUS = 2;
  const FLICK_CELLS = 12;
  const PULL = { tool: 'drag', profile: 'hard', anchor: 'band', targetBand: LIP_BAND } as const;

  const plateauWithLip = (): Heightmap => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        map.cells[cellIndex(map, x, y)] = (x <= LIP_X ? LIP_BAND : PLAIN_BAND) * BAND_HEIGHT;
      }
    }
    return map;
  };
  const toX = LIP_X + FLICK_CELLS;

  it('a point disc landing clear of the lip fills nothing — the gap the sweep exists to close', () => {
    const map = plateauWithLip();
    const diff = applySculpt(map, toX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, PULL);
    expect(diff).toHaveLength(0);
  });

  it('the same cursor cell swept from the lip fills every cell of the path to the grabbed band', () => {
    const map = plateauWithLip();
    applySculpt(map, toX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...PULL,
      sweepFrom: { x: LIP_X, y: CY },
    });
    for (let x = LIP_X; x <= toX; x++) {
      expect(bandOf(heightAt(map, x, CY))).toBe(LIP_BAND);
    }
    expect(bandOf(heightAt(map, toX + RADIUS, CY))).toBe(PLAIN_BAND);
  });
});

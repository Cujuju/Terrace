import { describe, expect, it } from 'vitest';
import {
  BEDROCK_BAND,
  applySculpt,
  bandLevelHeight,
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
  const HIGH = bandLevelHeight(BAND);

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
  const HIGH = bandLevelHeight(BAND);
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
    const tall = bandLevelHeight(BAND + 4);
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
    for (let y = 0; y < 16; y++) map.cells[cellIndex(map, 7, y)] = bandLevelHeight(grabbed);
    applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: grabbed,
    });
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(bandLevelHeight(grabbed));

    const clicked = createHeightmap(16);
    clicked.cells.fill(0);
    for (let y = 0; y < 16; y++) clicked.cells[cellIndex(clicked, 7, y)] = bandLevelHeight(grabbed);
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
      for (let x = PLATEAU_X; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = bandLevelHeight(TARGET_BAND);
    }

    applySculpt(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'soft',
      targetBand: TARGET_BAND,
    });

    expect(heightAt(map, CX, CY)).toBe(bandLevelHeight(TARGET_BAND));
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

  // Grabbing ground runs to bedrock, so the slab carries everything beneath the
  // grabbed band and the swept steps rise whole. There is no second descent pass.
  it('raises every swept step to the grabbed band, and leaves the steps outside', () => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = bandAtX(x) * BAND_HEIGHT;
    }

    applySculpt(map, STAIR_X, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'hard',
      targetBand: TOP_BAND,
      runFloorBand: BEDROCK_BAND,
    });

    // Both swept steps rise whole: the run carried the ground under the band.
    for (const x of [STAIR_X, STAIR_X + 1]) {
      expect([x, bandOf(heightAt(map, x, CY))]).toEqual([x, TOP_BAND]);
    }
    // The step past the footprint keeps its own band — nothing cascades outward.
    const outside = STAIR_X + TREAD_CELLS;
    expect(bandOf(heightAt(map, outside, CY))).toBe(bandAtX(outside));
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
  // The lip is solid ground, so its run reaches bedrock.
  const PULL = {
    tool: 'drag',
    profile: 'hard',
    anchor: 'band',
    targetBand: LIP_BAND,
    runFloorBand: BEDROCK_BAND,
  } as const;

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

  // The run has no adjacency gate: a point disc writes its own footprint
  // wherever it lands, and the sweep is what joins that footprint to the lip.
  it('a point disc landing clear of the lip fills only its own footprint', () => {
    const map = plateauWithLip();
    applySculpt(map, toX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, PULL);
    expect(bandOf(heightAt(map, toX, CY))).toBe(LIP_BAND);
    // The cells between the lip and the disc are untouched — that is the gap.
    const between = Math.floor((LIP_X + toX - RADIUS) / 2);
    expect(bandOf(heightAt(map, between, CY))).toBe(PLAIN_BAND);
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

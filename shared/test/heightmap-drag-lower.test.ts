import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  bandLevelHeight,
  bandOf,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  BEDROCK_REMNANT_CEILING,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  heightAt,
  MAX_HEIGHT,
  MAX_BAND,
  MIN_BAND,
  MIN_BRUSH_RADIUS,
  readSpans,
  setColumn,
  type Heightmap,
} from '../src/index.ts';

describe('a drag-lower on a tall face is cut back at the grabbed band (2026-09-02)', () => {
  const CAP_BAND = 5;
  const PLAIN_BAND = 0;
  const RADIUS = 4;
  const SIZE = 32;
  const CX = 16;
  const CY = 16;
  const POLE_REACH = 3;
  const DRAG_LOWER = { tool: 'drag', profile: 'hard', anchor: 'band' } as const;

  const poleOnPlain = (): Heightmap => {
    const map = createHeightmap(SIZE);
    for (let y = CY - POLE_REACH; y <= CY + POLE_REACH; y++) {
      for (let x = CX - POLE_REACH; x <= CX + POLE_REACH; x++) {
        map.cells[cellIndex(map, x, y)] = CAP_BAND * BAND_HEIGHT;
      }
    }
    return map;
  };
  const pullIn = (map: Heightmap, band: number): void => {
    applySculpt(map, CX + POLE_REACH, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      ...DRAG_LOWER,
      targetBand: band,
    });
  };
  const eastEdgeBand = (map: Heightmap): number =>
    bandOf(heightAt(map, CX + POLE_REACH, CY));

  it('grabbing a band below the cap cuts the face back to the band beneath the grab', () => {
    for (let grab = CAP_BAND - 1; grab > PLAIN_BAND; grab--) {
      const map = poleOnPlain();
      pullIn(map, grab);
      expect(eastEdgeBand(map)).toBe(grab - 1);
      expect(heightAt(map, CX + POLE_REACH, CY)).toBe(bandLevelHeight(grab - 1));
    }
  });

  it('grabbing the cap takes off one band only — never the band below (owner 2026-09-05)', () => {
    const map = poleOnPlain();
    pullIn(map, CAP_BAND);
    expect(eastEdgeBand(map)).toBe(CAP_BAND - 1);
    expect(heightAt(map, CX + POLE_REACH, CY)).toBe((CAP_BAND - 1) * BAND_HEIGHT);
  });

  it('the cut sweeps the footprint at the grabbed band and stops at its edge', () => {
    const map = poleOnPlain();
    const grab = 3;
    pullIn(map, grab);
    for (let x = CX; x <= CX + POLE_REACH; x++) {
      expect(bandOf(heightAt(map, x, CY))).toBe(grab - 1);
    }
    expect(bandOf(heightAt(map, CX - 1, CY))).toBe(CAP_BAND);
  });
});

describe('a lower seed on a plateau interior leaves a lip a lower pull can widen (2026-09-05)', () => {
  const SIZE = 32;
  const PLATEAU_BAND = 4;
  const CX = 16;
  const CY = 16;
  const RADIUS = 2;
  const LOWER_SEED = { tool: 'stamp', profile: 'hard' } as const;
  const DRAG_LOWER = { tool: 'drag', profile: 'hard', anchor: 'band' } as const;

  it('digs one band at the cursor, then a lower drag grabbing the old band eats the rim', () => {
    const map = createHeightmap(SIZE);
    map.cells.fill(PLATEAU_BAND * BAND_HEIGHT);

    applySculpt(map, CX, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, LOWER_SEED);
    const before = PLATEAU_BAND;
    const after = bandOf(heightAt(map, CX, CY));
    expect(after).toBe(before - 1);

    const rimX = CX + RADIUS;
    expect(bandOf(heightAt(map, rimX, CY))).toBe(before);

    applySculpt(map, CX + 1, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      ...DRAG_LOWER,
      targetBand: before,
    });
    expect(bandOf(heightAt(map, rimX, CY))).toBe(after);
    expect(bandOf(heightAt(map, CX + RADIUS + 3, CY))).toBe(before);
  });
});

describe('a drag finishes, at every band it can name and in both directions', () => {
  const SIZE = 24;
  const GROUND_BAND = 1;
  const ROOF_FLOOR_BAND = 4;
  const ROOF_CAP_BAND = 6;
  const CX = 12;
  const CY = 12;
  const RADIUS = 3;
  const DRAG = { tool: 'drag', profile: 'hard', anchor: 'band' } as const;

  const layeredWorld = (): Heightmap => {
    const map = createHeightmap(SIZE);
    map.cells.fill(bandLevelHeight(GROUND_BAND));
    for (let y = CY - 4; y <= CY + 4; y++) {
      for (let x = CX - 4; x <= CX + 4; x++) {
        setColumn(map, x, y, [
          { floor: BEDROCK_FLOOR, ceiling: bandLevelHeight(GROUND_BAND) },
          { floor: bandLevelHeight(ROOF_FLOOR_BAND), ceiling: bandLevelHeight(ROOF_CAP_BAND) },
        ]);
      }
    }
    return map;
  };

  const expectValidColumns = (map: Heightmap, where: string): void => {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const spans = readSpans(map, x, y);
        expect(spans[0]!.floor, where).toBe(BEDROCK_FLOOR);
        for (let k = 0; k < spans.length; k++) {
          expect(spans[k]!.floor, where).toBeLessThan(spans[k]!.ceiling);
          if (k > 0) expect(spans[k - 1]!.ceiling, where).toBeLessThan(spans[k]!.floor);
        }
      }
    }
  };

  it('settles every targetBand the validator admits, layered column and all', () => {
    for (let band = MIN_BAND; band <= MAX_BAND; band++) {
      for (const dir of [1, -1] as const) {
        const map = layeredWorld();
        applySculpt(map, CX, CY, RADIUS, dir * DEFAULT_SCULPT_AMOUNT, { ...DRAG, targetBand: band });
        expectValidColumns(map, `band ${band} dir ${dir}`);
      }
    }
  });

  it('cuts a column beside ground that reads below bedrock once, then stops', () => {
    const map = createHeightmap(SIZE);
    map.cells[cellIndex(map, CX + 1, CY)] = BEDROCK_FLOOR - BAND_HEIGHT;

    const diff = applySculpt(map, CX, CY, MIN_BRUSH_RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: MIN_BAND,
    });

    expect(diff).toHaveLength(1);
    expect(heightAt(map, CX, CY)).toBe(BEDROCK_REMNANT_CEILING);
    expect(
      applySculpt(map, CX, CY, MIN_BRUSH_RADIUS, -DEFAULT_SCULPT_AMOUNT, {
        ...DRAG,
        targetBand: MIN_BAND,
      }),
    ).toEqual([]);
  });
});

describe('a drag-lower retreats one drawn band and never reaches for bedrock', () => {
  const SIZE = 32;
  const PLAIN_BAND = MIN_BAND + 1;
  const CX = 16;
  const CY = 16;
  const REACH = 3;
  const RADIUS = 4;
  const GRABS = [MIN_BAND + 2, -8, 0, 1, 20, MAX_BAND];
  const DRAG_LOWER = { tool: 'drag', profile: 'hard', anchor: 'band' } as const;

  const towerAt = (band: number): Heightmap => {
    const map = createHeightmap(SIZE);
    map.cells.fill(bandLevelHeight(PLAIN_BAND));
    for (let y = CY - REACH; y <= CY + REACH; y++) {
      for (let x = CX - REACH; x <= CX + REACH; x++) {
        map.cells[cellIndex(map, x, y)] = clampToWorld(bandLevelHeight(band));
      }
    }
    return map;
  };
  const clampToWorld = (h: number): number => (h > MAX_HEIGHT ? MAX_HEIGHT : h);

  it('lands on the level of the band below the grab, at every band it can grab', () => {
    for (const grab of GRABS) {
      const map = towerAt(grab);
      applySculpt(map, CX + REACH, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
        ...DRAG_LOWER,
        targetBand: grab,
      });
      const landed = heightAt(map, CX + REACH, CY);
      expect([grab, landed]).toEqual([grab, bandLevelHeight(grab - 1)]);
      expect([grab, landed > BEDROCK_REMNANT_CEILING]).toEqual([grab, true]);
    }
  });

  it('does nothing where the grabbed band has nowhere to retreat to', () => {
    const map = createHeightmap(SIZE);
    map.cells.fill(bandLevelHeight(9));
    expect(
      applySculpt(map, CX, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, { ...DRAG_LOWER, targetBand: 9 }),
    ).toEqual([]);
  });
});

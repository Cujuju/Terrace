import { describe, expect, it } from 'vitest';
import {
  applySculpt, bandLevelHeight, BEDROCK_BAND, createHeightmap, DEFAULT_SCULPT_AMOUNT,
  MAX_BRUSH_RADIUS, readSpans, SCULPT_PROFILES, SCULPT_TOOLS, setColumn,
  forEachSweptCell, pointWithinSweep, sculptOptionsOf, strokeSweep, strokeWriteSweep,
} from '../src/index.ts';

const WORLD_SIZE = 32;
const CENTRE = WORLD_SIZE / 2;
const RADIUS = 4;
const FLOOR_BAND = 10;
const ROOF = { floorBand: 20, ceiling: bandLevelHeight(22) };

describe('stamp contracts', () => {
  it('bounds drag writes across radii, directions and oblique legs', () => {
    const size = 128;
    const centre = size / 2;
    const grabbedBand = 8;
    const legs = [[16, 0], [0, 16], [16, 7], [7, 16]] as const;
    for (const radius of [1, RADIUS, MAX_BRUSH_RADIUS]) {
      for (const dir of [1, -1] as const) {
        for (const [dx, dy] of legs) {
          const map = createHeightmap(size);
          map.cells.fill(bandLevelHeight(0));
          const intent = { type: 'sculpt', x: centre + dx, y: centre + dy,
            fromX: centre, fromY: centre, radius, dir, tool: 'drag',
            targetBand: grabbedBand, floorBand: 0 } as const;
          if (dir < 0) forEachSweptCell(strokeSweep(intent), (x, y) => {
            map.cells[y * size + x] = bandLevelHeight(grabbedBand);
          });
          const diff = applySculpt(map, intent.x, intent.y, radius, DEFAULT_SCULPT_AMOUNT * dir, sculptOptionsOf(intent));
          expect(diff.length).toBeGreaterThan(0);
          const writes = strokeWriteSweep(intent);
          for (const cell of diff) expect(pointWithinSweep(writes, cell.x, cell.y)).toBe(true);
        }
      }
    }
  });

  it.each(SCULPT_PROFILES)('bounds every %s write while preserving the core sweep', (profile) => {
    const size = 128;
    const centre = size / 2;
    const peakBands = 8;
    for (const radius of [1, RADIUS, MAX_BRUSH_RADIUS]) {
      const map = createHeightmap(size);
      map.cells.fill(bandLevelHeight(FLOOR_BAND));
      map.cells[centre * size + centre] = bandLevelHeight(FLOOR_BAND + peakBands);
      const intent = { type: 'sculpt', x: centre, y: centre, radius, dir: 1, tool: 'stamp', profile } as const;
      const diff = applySculpt(map, centre, centre, radius, DEFAULT_SCULPT_AMOUNT, sculptOptionsOf(intent));
      expect(strokeSweep(intent).radius).toBe(radius);
      for (const cell of diff) expect(pointWithinSweep(strokeWriteSweep(intent), cell.x, cell.y)).toBe(true);
    }
  });
  it.each(SCULPT_PROFILES)('keeps %s lower edges on the grasped layer', (profile) => {
    const flat = createHeightmap(WORLD_SIZE);
    const layered = createHeightmap(WORLD_SIZE);
    flat.cells.fill(bandLevelHeight(FLOOR_BAND));
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        setColumn(layered, x, y, [
          { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(FLOOR_BAND) }, ROOF,
        ]);
      }
    }
    const options = { tool: 'stamp', anchor: 'clicked', profile } as const;
    applySculpt(flat, CENTRE, CENTRE, RADIUS, -DEFAULT_SCULPT_AMOUNT, options);
    applySculpt(layered, CENTRE, CENTRE, RADIUS, -DEFAULT_SCULPT_AMOUNT, { ...options, spanBand: FLOOR_BAND });
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        expect(readSpans(layered, x, y)).toEqual([
          { floorBand: BEDROCK_BAND, ceiling: flat.cells[y * WORLD_SIZE + x] }, ROOF,
        ]);
      }
    }
  });

  it.each([...SCULPT_TOOLS, 'settle'] as const)('validates %s before reading or writing', (tool) => {
    const map = createHeightmap(WORLD_SIZE);
    const before = map.cells.slice();
    const options = { tool, anchor: 'clicked', targetBand: FLOOR_BAND, spanBand: FLOOR_BAND } as const;
    for (const radius of [0, MAX_BRUSH_RADIUS + 1]) {
      expect(() => applySculpt(map, CENTRE, CENTRE, radius, DEFAULT_SCULPT_AMOUNT, options)).toThrow(RangeError);
    }
    for (const x of [-1, CENTRE + 0.5, Number.NaN]) {
      expect(() => applySculpt(map, x, CENTRE, RADIUS, DEFAULT_SCULPT_AMOUNT, options)).toThrow(RangeError);
    }
    expect(() => applySculpt(map, CENTRE, CENTRE, RADIUS, Number.NaN, options)).toThrow(RangeError);
    expect(map.cells).toEqual(before);
  });
});

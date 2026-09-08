import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  createHeightmap,
  drawnGroundHeight,
  drawnGroundHeightAtBand,
  createSeededRng,
  MAX_HEIGHT,
  setColumn,
  type Heightmap,
} from '../src/index.ts';

const WORLD_SIZE = 8;

const SAMPLE_STEP = 1 / 8;

const SUB_BEDROCK_BAND = Math.floor(BEDROCK_FLOOR / BAND_HEIGHT) - 1;

function world(): Heightmap {
  return createHeightmap(WORLD_SIZE);
}

function setHeight(map: Heightmap, x: number, y: number, h: number): void {
  setColumn(map, x, y, [{ floor: BEDROCK_FLOOR, ceiling: h }]);
}

function flatWorld(h: number): Heightmap {
  const map = world();
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) setHeight(map, x, y, h);
  }
  return map;
}

function roughWorld(): Heightmap {
  const map = world();
  const rng = createSeededRng(1234);
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      setHeight(map, x, y, Math.floor(rng.next() * (MAX_HEIGHT - BEDROCK_FLOOR)) + BEDROCK_FLOOR + 1);
    }
  }
  return map;
}

function forEachSample(visit: (x: number, y: number) => void): void {
  for (let y = 0; y < WORLD_SIZE; y += SAMPLE_STEP) {
    for (let x = 0; x < WORLD_SIZE; x += SAMPLE_STEP) visit(x, y);
  }
}

describe('drawnGroundHeight', () => {
  it('is deterministic across repeated calls', () => {
    const map = roughWorld();
    forEachSample((x, y) => {
      const first = drawnGroundHeight(map, x, y);
      expect(drawnGroundHeight(map, x, y)).toBe(first);
      expect(drawnGroundHeight(map, x, y)).toBe(first);
    });
  });

  it('returns the flat band exactly on a flat world', () => {
    for (const h of [0, 16, 48, 512]) {
      const map = flatWorld(h);
      forEachSample((x, y) => expect(drawnGroundHeight(map, x, y)).toBe(h));
    }
  });

  it('floors negative heights toward minus infinity', () => {
    for (const [h, expected] of [
      [-1, -16],
      [-8, -16],
      [-16, -16],
      [-17, -32],
      [-1520, -1520],
    ] as const) {
      const map = flatWorld(h);
      expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(expected);
    }
  });

  it('always returns a multiple of BAND_HEIGHT', () => {
    const map = roughWorld();
    forEachSample((x, y) => {
      expect(Number.isInteger(drawnGroundHeight(map, x, y) / BAND_HEIGHT)).toBe(true);
    });
  });

  it('clamps to the border instead of reading out of bounds', () => {
    const map = roughWorld();
    const corner = drawnGroundHeight(map, 0.125, 0.125);
    for (const [x, y] of [
      [-0.125, -0.125],
      [-5, -5],
      [-1000, -1000],
    ] as const) {
      expect(drawnGroundHeight(map, x, y)).toBe(corner);
    }
    const far = drawnGroundHeight(map, WORLD_SIZE - 0.125, WORLD_SIZE - 0.125);
    for (const [x, y] of [
      [WORLD_SIZE + 0.125, WORLD_SIZE + 0.125],
      [WORLD_SIZE + 5, WORLD_SIZE + 5],
      [1000, 1000],
    ] as const) {
      expect(drawnGroundHeight(map, x, y)).toBe(far);
    }
  });
});

describe('drawnGroundHeightAtBand', () => {
  it('matches drawnGroundHeight when no column is layered', () => {
    const map = roughWorld();
    for (const band of [-96, -32, 0, 4, 32, 64]) {
      forEachSample((x, y) => {
        expect(drawnGroundHeightAtBand(map, x, y, band)).toBe(drawnGroundHeight(map, x, y));
      });
    }
  });

  it('takes the ceiling under the span for a band inside a cave', () => {
    const map = flatWorld(64);
    setColumn(map, 4, 4, [
      { floor: BEDROCK_FLOOR, ceiling: 32 },
      { floor: 48, ceiling: 64 },
    ]);
    expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(64);
    expect(drawnGroundHeightAtBand(map, 4.5, 4.5, 2)).toBe(32);
    expect(drawnGroundHeightAtBand(map, 4.5, 4.5, 4)).toBe(64);
  });

  it('falls back off the blend when a corner sample is open', () => {
    const map = flatWorld(64);
    setColumn(map, 4, 4, [
      { floor: BEDROCK_FLOOR, ceiling: 32 },
      { floor: 48, ceiling: 64 },
    ]);
    const open = SUB_BEDROCK_BAND * BAND_HEIGHT;
    forEachSample((x, y) => {
      expect(drawnGroundHeightAtBand(map, x, y, SUB_BEDROCK_BAND)).toBe(open);
    });
  });
});

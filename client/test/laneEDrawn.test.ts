import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_BAND,
  DRAWN_SHORE_HEIGHT,
  bandLevelHeight,
  chunkIndex,
  drawnBandOfSample,
  drawnLevelThreshold,
  setColumn,
} from '@terrace/shared';
import {
  FIRST_LAND_PALETTE_INDEX,
  SEABED_PALETTE_INDEX,
  bandPaletteIndex,
} from '../src/terrain/bandColors.ts';
import {
  blockyCellCapY,
  chunkBandContourLoops,
  drawnBandCapY,
  levelPaletteHeight,
  planChunkCaps,
} from '../src/terrain/capEmission.ts';
import { CLIFF_PALETTE, TERRAIN_PALETTE } from '../src/terrain/bandColors.ts';
import { createTerrainMirror } from '../src/terrain/mirror.ts';

function receiveAll(mirror: ReturnType<typeof createTerrainMirror>): void {
  const perEdge = mirror.map.size / 16;
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      mirror.received.add(chunkIndex(mirror.map.size, cx, cy));
    }
  }
}

describe('lane E: drawn palette index', () => {
  it('colours dry heights by their drawn band, not their raw band', () => {
    // Heights 1..16 draw on band 0; 17..32 draw on band 1.
    for (let h = 1; h <= 16; h++) {
      expect(bandPaletteIndex(h)).toBe(FIRST_LAND_PALETTE_INDEX);
    }
    for (let h = 17; h <= 32; h++) {
      expect(bandPaletteIndex(h)).toBe(FIRST_LAND_PALETTE_INDEX + 1);
    }
    expect(bandPaletteIndex(BAND_HEIGHT + 1)).toBe(FIRST_LAND_PALETTE_INDEX + 1);
  });

  it('keeps water on raw depth stops', () => {
    expect(bandPaletteIndex(0)).toBe(SEABED_PALETTE_INDEX);
    expect(bandPaletteIndex(-1)).toBe(SEABED_PALETTE_INDEX + 1);
    expect(bandPaletteIndex(-BAND_HEIGHT)).toBe(SEABED_PALETTE_INDEX + 1);
  });

  it('starts band 0 at the drawn shore', () => {
    expect(levelPaletteHeight(0)).toBe(bandLevelHeight(0));
    expect(drawnBandOfSample(DRAWN_SHORE_HEIGHT)).toBe(0);
  });
});

describe('lane E: blocky fallback colours by cap Y', () => {
  it('caps height 15 on band 0 with band 0’s palette entry', () => {
    expect(blockyCellCapY(15)).toBe(drawnBandCapY(0));
    expect(bandPaletteIndex(levelPaletteHeight(drawnBandOfSample(15)))).toBe(
      FIRST_LAND_PALETTE_INDEX,
    );
  });
});

describe('lane E: band-0 contour source', () => {
  it('marches band 0 on the drawn shore threshold, not height 0', () => {
    expect(drawnLevelThreshold(0)).not.toBe(0);
    const mirror = createTerrainMirror(32);
    receiveAll(mirror);
    mirror.map.cells.fill(8);
    // A sea-level cell among band-1 ground: raw threshold 0 sees no contour
    // (every field sample is inside), the drawn threshold does.
    mirror.map.cells[4 * 32 + 4] = 0;
    const loops = chunkBandContourLoops(mirror, 0, 0, 0);
    expect(loops.length).toBeGreaterThan(0);
  });
});

describe('lane E: band-0 layered ceiling', () => {
  it('emits a ceiling for band 0 in a layered chunk', () => {
    const mirror = createTerrainMirror(32);
    receiveAll(mirror);
    mirror.map.cells.fill(0);
    // Upper span floors in band 0, not band -1: a band-0 overhang with a real
    // gap below it, so the column stays layered.
    setColumn(mirror.map, 4, 4, [
      { floorBand: BEDROCK_BAND, ceiling: -32 },
      { floorBand: 0, ceiling: BAND_HEIGHT },
    ]);
    const plan = planChunkCaps(mirror, 0, 0, {
      top: TERRAIN_PALETTE,
      cliff: CLIFF_PALETTE,
    });
    const at = plan.levels.findIndex((level) => level.sampleBand === 0);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(plan.levels[at]!.threshold).toBe(drawnLevelThreshold(0));
    expect(plan.ceilingsPerLevel[at]!.length).toBeGreaterThan(0);
  });
});

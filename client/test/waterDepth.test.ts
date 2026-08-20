import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, MIN_HEIGHT, SEA_LEVEL, type ChunkPayload } from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import {
  WATER_DEPTH_ALPHA_DEFAULT_BYTE,
  WATER_DEPTH_SATURATION_WORLD_UNITS,
  WATER_MAX_ALPHA,
  WATER_MIN_ALPHA,
  depthAlphaByte,
  depthToWaterAlpha,
  waterDepthWorldUnits,
  writeWaterDepthTexels,
} from '../src/terrain/waterDepth.ts';

/** 64 cells = 4×4 chunks: matches test/mirror.test.ts's own convention. */
const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

describe('waterDepthWorldUnits', () => {
  it('is zero at the waterline', () => {
    expect(waterDepthWorldUnits(SEA_LEVEL)).toBe(0);
  });

  it('is zero (clamped) for dry land', () => {
    expect(waterDepthWorldUnits(1)).toBe(0);
    expect(waterDepthWorldUnits(500)).toBe(0);
  });

  it('reaches the full world-unit depth at MIN_HEIGHT', () => {
    // MIN_HEIGHT is the world's floor (the bottom of the Deep Strata lava
    // band) — the deepest a water column can ever be asked to render.
    expect(waterDepthWorldUnits(MIN_HEIGHT)).toBeGreaterThan(
      WATER_DEPTH_SATURATION_WORLD_UNITS,
    );
  });
});

describe('depthToWaterAlpha', () => {
  it('is WATER_MIN_ALPHA at zero depth — clear at the waterline', () => {
    expect(depthToWaterAlpha(0)).toBe(WATER_MIN_ALPHA);
  });

  it('clamps negative depth to WATER_MIN_ALPHA (defensive, not an expected input)', () => {
    expect(depthToWaterAlpha(-5)).toBe(WATER_MIN_ALPHA);
  });

  it('reaches exactly WATER_MAX_ALPHA at the saturation depth', () => {
    expect(depthToWaterAlpha(WATER_DEPTH_SATURATION_WORLD_UNITS)).toBeCloseTo(
      WATER_MAX_ALPHA,
      10,
    );
  });

  it('does not climb past WATER_MAX_ALPHA beyond the saturation depth', () => {
    // The load-bearing behaviour: a lava-floor dig (MIN_HEIGHT) is far past
    // the ordinary sea column, and must ride the same ceiling as an ordinary
    // deep sea cell, not a deeper one — that ceiling is what lets a self-lit
    // palette entry still show through at the bottom of the world.
    const atSaturation = depthToWaterAlpha(WATER_DEPTH_SATURATION_WORLD_UNITS);
    const wayPastSaturation = depthToWaterAlpha(
      waterDepthWorldUnits(MIN_HEIGHT),
    );
    expect(wayPastSaturation).toBe(atSaturation);
    expect(wayPastSaturation).toBe(WATER_MAX_ALPHA);
  });

  it('is monotonically non-decreasing with depth up to and past saturation', () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      depthToWaterAlpha((i / 39) * WATER_DEPTH_SATURATION_WORLD_UNITS * 2),
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
  });

  it('the ceiling sits below the pre-fix flat opacity (0.62) it replaces', () => {
    // Regression pin for the actual bug: the old constant already rendered
    // fully opaque over the Deep Strata lava band (see water.ts's header), so
    // a ceiling that only matched it would leave the deep end exactly as
    // broken. It must be strictly lower.
    expect(WATER_MAX_ALPHA).toBeLessThan(0.62);
  });

  it('WATER_MIN_ALPHA is a thin, visible film — not fully transparent', () => {
    expect(WATER_MIN_ALPHA).toBeGreaterThan(0);
    expect(WATER_MIN_ALPHA).toBeLessThan(WATER_MAX_ALPHA);
  });
});

describe('depthAlphaByte / WATER_DEPTH_ALPHA_DEFAULT_BYTE', () => {
  it('quantises depthToWaterAlpha into a 0..255 byte', () => {
    expect(depthAlphaByte(0)).toBe(Math.round(WATER_MIN_ALPHA * 255));
    expect(depthAlphaByte(WATER_DEPTH_SATURATION_WORLD_UNITS)).toBe(
      Math.round(WATER_MAX_ALPHA * 255),
    );
  });

  it('the default fill byte matches zero depth, so an unwritten texel reads as shallow water, not a hole', () => {
    expect(WATER_DEPTH_ALPHA_DEFAULT_BYTE).toBe(depthAlphaByte(0));
    expect(WATER_DEPTH_ALPHA_DEFAULT_BYTE).toBeGreaterThan(0);
  });
});

describe('writeWaterDepthTexels', () => {
  it('writes only the cells inside the given dirty chunks', () => {
    const mirror = createTerrainMirror(WORLD);
    // Chunk (1,0): flat at MIN_HEIGHT — the deepest possible dig.
    // Chunk (0,0) is left untouched (default height 0, i.e. the waterline).
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, MIN_HEIGHT)],
    });

    const SENTINEL = 77; // recognisably not any real depth-alpha byte
    const out = new Uint8Array(WORLD * WORLD).fill(SENTINEL);
    writeWaterDepthTexels(out, WORLD, mirror, [/* chunk (1,0) */ 1]);

    const maxAlphaByte = Math.round(WATER_MAX_ALPHA * 255);
    // Inside the dirty chunk (cells CHUNK_SIZE..2*CHUNK_SIZE-1 on x): the
    // lava-floor depth saturates the curve.
    expect(out[0 * WORLD + CHUNK_SIZE]).toBe(maxAlphaByte);
    expect(out[(CHUNK_SIZE - 1) * WORLD + (2 * CHUNK_SIZE - 1)]).toBe(maxAlphaByte);
    // Outside the dirty set entirely: untouched.
    expect(out[0]).toBe(SENTINEL);
    expect(out[WORLD * WORLD - 1]).toBe(SENTINEL);
  });
});

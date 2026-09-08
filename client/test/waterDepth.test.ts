import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, MIN_HEIGHT, SEA_LEVEL, type ChunkPayload } from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import {
  bandFloorWaterDepthWorldUnits,
  WATER_DEEP_STRATA_ALPHA,
  WATER_DEPTH_ALPHA_DEFAULT_BYTE,
  WATER_DEPTH_FLOOR_WORLD_UNITS,
  WATER_DEPTH_SATURATION_WORLD_UNITS,
  WATER_MAX_ALPHA,
  WATER_MIN_ALPHA,
  WATER_SPECULAR_FACTOR_DEFAULT_BYTE,
  WATER_SPECULAR_FLOOR,
  depthAlphaByte,
  depthSpecularFactorByte,
  depthToSpecularFactor,
  depthToWaterAlpha,
  surfaceAlphaByte,
  waterDepthWorldUnits,
  WATER_CURVE_ALPHA_CHANNEL,
  WATER_CURVE_BYTES_PER_TEXEL,
  WATER_CURVE_SPECULAR_CHANNEL,
  createWaterCurveBuffer,
  writeWaterCurveTexels,
} from '../src/terrain/waterDepth.ts';

const WORLD = CHUNK_SIZE * 4;
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
    expect(waterDepthWorldUnits(MIN_HEIGHT)).toBeGreaterThan(
      WATER_DEPTH_SATURATION_WORLD_UNITS,
    );
  });

  it('reaches exactly WATER_DEPTH_FLOOR_WORLD_UNITS at MIN_HEIGHT (2026-08-20 amendment)', () => {
    expect(waterDepthWorldUnits(MIN_HEIGHT)).toBe(WATER_DEPTH_FLOOR_WORLD_UNITS);
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

  it('descends from WATER_MAX_ALPHA back down to WATER_DEEP_STRATA_ALPHA past the saturation depth', () => {
    const atSaturation = depthToWaterAlpha(WATER_DEPTH_SATURATION_WORLD_UNITS);
    const atFloor = depthToWaterAlpha(waterDepthWorldUnits(MIN_HEIGHT));
    expect(atSaturation).toBe(WATER_MAX_ALPHA);
    expect(atFloor).toBe(WATER_DEEP_STRATA_ALPHA);
    expect(atFloor).toBeLessThan(atSaturation);
  });

  it('holds flat at WATER_DEEP_STRATA_ALPHA for any depth at or beyond the world floor', () => {
    expect(depthToWaterAlpha(WATER_DEPTH_FLOOR_WORLD_UNITS)).toBe(WATER_DEEP_STRATA_ALPHA);
    expect(depthToWaterAlpha(WATER_DEPTH_FLOOR_WORLD_UNITS * 2)).toBe(WATER_DEEP_STRATA_ALPHA);
  });

  it('is monotonically non-decreasing with depth up to saturation — shallow behaviour unchanged', () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      depthToWaterAlpha((i / 39) * WATER_DEPTH_SATURATION_WORLD_UNITS),
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
  });

  it('is monotonically non-increasing with depth from saturation to the world floor', () => {
    const samples = Array.from({ length: 40 }, (_, i) => {
      const t = i / 39;
      const depth =
        WATER_DEPTH_SATURATION_WORLD_UNITS +
        t * (WATER_DEPTH_FLOOR_WORLD_UNITS - WATER_DEPTH_SATURATION_WORLD_UNITS);
      return depthToWaterAlpha(depth);
    });
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
    }
  });

  it('the ceiling sits below the pre-fix flat opacity (0.62) it replaces', () => {
    expect(WATER_MAX_ALPHA).toBeLessThan(0.62);
  });

  it('WATER_MIN_ALPHA is a thin, visible film — not fully transparent', () => {
    expect(WATER_MIN_ALPHA).toBeGreaterThan(0);
    expect(WATER_MIN_ALPHA).toBeLessThan(WATER_MAX_ALPHA);
  });

  it('WATER_DEEP_STRATA_ALPHA sits strictly between WATER_MIN_ALPHA and WATER_MAX_ALPHA', () => {
    expect(WATER_DEEP_STRATA_ALPHA).toBeGreaterThan(WATER_MIN_ALPHA);
    expect(WATER_DEEP_STRATA_ALPHA).toBeLessThan(WATER_MAX_ALPHA);
  });
});

describe('depthToSpecularFactor', () => {
  it('is 1 (full sheen) at zero depth', () => {
    expect(depthToSpecularFactor(0)).toBe(1);
  });

  it('clamps negative depth to 1 (defensive, not an expected input)', () => {
    expect(depthToSpecularFactor(-5)).toBe(1);
  });

  it('is exactly 1 (byte-identical to pre-fix) for every depth up to and including the sea-column floor', () => {
    const samples = [
      0,
      1,
      WATER_DEPTH_SATURATION_WORLD_UNITS / 2,
      WATER_DEPTH_SATURATION_WORLD_UNITS - 1e-9,
      WATER_DEPTH_SATURATION_WORLD_UNITS,
    ];
    for (const depth of samples) expect(depthToSpecularFactor(depth)).toBe(1);
  });

  it('reaches exactly WATER_SPECULAR_FLOOR at the world floor, not at the sea-column floor', () => {
    expect(depthToSpecularFactor(WATER_DEPTH_FLOOR_WORLD_UNITS)).toBeCloseTo(
      WATER_SPECULAR_FLOOR,
      10,
    );
    expect(depthToSpecularFactor(WATER_DEPTH_SATURATION_WORLD_UNITS)).not.toBeCloseTo(
      WATER_SPECULAR_FLOOR,
      2,
    );
  });

  it('holds at WATER_SPECULAR_FLOOR for every depth beyond the world floor', () => {
    expect(depthToSpecularFactor(waterDepthWorldUnits(MIN_HEIGHT))).toBe(WATER_SPECULAR_FLOOR);
    expect(depthToSpecularFactor(WATER_DEPTH_FLOOR_WORLD_UNITS * 2)).toBe(WATER_SPECULAR_FLOOR);
  });

  it('is monotonically non-increasing with depth up to and past the world floor', () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      depthToSpecularFactor((i / 39) * WATER_DEPTH_FLOOR_WORLD_UNITS * 2),
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
    }
  });

  it('WATER_SPECULAR_FLOOR is a small but non-zero floor', () => {
    expect(WATER_SPECULAR_FLOOR).toBeGreaterThan(0);
    expect(WATER_SPECULAR_FLOOR).toBeLessThan(1);
  });
});

describe('depthSpecularFactorByte / WATER_SPECULAR_FACTOR_DEFAULT_BYTE', () => {
  it('quantises depthToSpecularFactor into a 0..255 byte', () => {
    expect(depthSpecularFactorByte(0)).toBe(255);
    expect(depthSpecularFactorByte(WATER_DEPTH_SATURATION_WORLD_UNITS)).toBe(255);
    expect(depthSpecularFactorByte(WATER_DEPTH_FLOOR_WORLD_UNITS)).toBe(
      Math.round(WATER_SPECULAR_FLOOR * 255),
    );
  });

  it('the default fill byte matches zero depth, so an unwritten texel reads as full sheen, not pre-suppressed', () => {
    expect(WATER_SPECULAR_FACTOR_DEFAULT_BYTE).toBe(depthSpecularFactorByte(0));
    expect(WATER_SPECULAR_FACTOR_DEFAULT_BYTE).toBe(255);
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

function texel(x: number, y: number, channel: number): number {
  return (y * WORLD + x) * WATER_CURVE_BYTES_PER_TEXEL + channel;
}

describe('writeWaterCurveTexels', () => {
  it('writes only the cells inside the given dirty chunks', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, MIN_HEIGHT)],
    });

    const SENTINEL = 77;
    const out = new Uint8Array(WORLD * WORLD * WATER_CURVE_BYTES_PER_TEXEL).fill(SENTINEL);
    writeWaterCurveTexels(out, WORLD, mirror, [ 1]);

    const deepStrataAlphaByte = Math.round(WATER_DEEP_STRATA_ALPHA * 255);
    expect(out[texel(CHUNK_SIZE, 0, WATER_CURVE_ALPHA_CHANNEL)]).toBe(deepStrataAlphaByte);
    expect(
      out[texel(2 * CHUNK_SIZE - 1, CHUNK_SIZE - 1, WATER_CURVE_ALPHA_CHANNEL)],
    ).toBe(deepStrataAlphaByte);
    expect(out[texel(0, 0, WATER_CURVE_ALPHA_CHANNEL)]).toBe(SENTINEL);
    expect(out[texel(WORLD - 1, WORLD - 1, WATER_CURVE_ALPHA_CHANNEL)]).toBe(SENTINEL);
  });

  it('writes the specular-factor channel in the same pass', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, MIN_HEIGHT)],
    });

    const SENTINEL = 77;
    const out = new Uint8Array(WORLD * WORLD * WATER_CURVE_BYTES_PER_TEXEL).fill(SENTINEL);
    writeWaterCurveTexels(out, WORLD, mirror, [ 1]);

    const floorSpecularByte = Math.round(WATER_SPECULAR_FLOOR * 255);
    expect(out[texel(CHUNK_SIZE, 0, WATER_CURVE_SPECULAR_CHANNEL)]).toBe(floorSpecularByte);
    expect(
      out[texel(2 * CHUNK_SIZE - 1, CHUNK_SIZE - 1, WATER_CURVE_SPECULAR_CHANNEL)],
    ).toBe(floorSpecularByte);
    expect(out[texel(0, 0, WATER_CURVE_SPECULAR_CHANNEL)]).toBe(SENTINEL);
    expect(out[texel(WORLD - 1, WORLD - 1, WATER_CURVE_SPECULAR_CHANNEL)]).toBe(SENTINEL);
  });

  it('a never-written texel keeps the real default byte after a partial refresh, in every channel', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, MIN_HEIGHT)],
    });

    const out = createWaterCurveBuffer(WORLD);
    writeWaterCurveTexels(out, WORLD, mirror, [ 1]);

    const untouchedX = 2 * CHUNK_SIZE;
    expect(out[texel(untouchedX, 0, WATER_CURVE_ALPHA_CHANNEL)]).toBe(
      WATER_DEPTH_ALPHA_DEFAULT_BYTE,
    );
    expect(out[texel(untouchedX, 0, WATER_CURVE_ALPHA_CHANNEL)]).not.toBe(0);
    expect(out[texel(untouchedX, 0, WATER_CURVE_SPECULAR_CHANNEL)]).toBe(
      WATER_SPECULAR_FACTOR_DEFAULT_BYTE,
    );
    expect(out[texel(untouchedX, 0, WATER_CURVE_SPECULAR_CHANNEL)]).not.toBe(0);
  });
});

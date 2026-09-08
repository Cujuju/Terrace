import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEEP_STRATA_BANDS,
  SEA_COLUMN_BANDS,
  SEA_LEVEL,
  chunksPerEdge,
  quantizeToBand,
  seabedHeight,
} from '@terrace/shared';
import { HEIGHT_WORLD_SCALE, SEA_DEPTH_CUE_SPAN_BANDS } from '../config.ts';
import { type TerrainMirror } from './mirror.ts';

export const WATER_MIN_ALPHA = 0.1;

export const WATER_MAX_ALPHA = 0.55;

export const WATER_DEPTH_SATURATION_WORLD_UNITS =
  SEA_COLUMN_BANDS * BAND_HEIGHT * HEIGHT_WORLD_SCALE;

export const WATER_SHADE_SPAN_BANDS = SEA_DEPTH_CUE_SPAN_BANDS;

const WATER_ALPHA_SATURATION_BANDS = WATER_SHADE_SPAN_BANDS;
export const WATER_ALPHA_SATURATION_WORLD_UNITS =
  WATER_ALPHA_SATURATION_BANDS * BAND_HEIGHT * HEIGHT_WORLD_SCALE;

export const WATER_DEEP_STRATA_ALPHA = 0.35;

export const WATER_DEPTH_FLOOR_WORLD_UNITS =
  (SEA_COLUMN_BANDS + DEEP_STRATA_BANDS) * BAND_HEIGHT * HEIGHT_WORLD_SCALE;

export function waterDepthWorldUnits(height: number): number {
  return Math.max(0, SEA_LEVEL - height) * HEIGHT_WORLD_SCALE;
}

export function bandFloorWaterDepthWorldUnits(height: number): number {
  return waterDepthWorldUnits(quantizeToBand(height));
}

export function depthToWaterAlpha(depthWorldUnits: number): number {
  if (depthWorldUnits <= 0) return WATER_MIN_ALPHA;
  if (depthWorldUnits <= WATER_ALPHA_SATURATION_WORLD_UNITS) {
    const t = depthWorldUnits / WATER_ALPHA_SATURATION_WORLD_UNITS;
    return WATER_MIN_ALPHA + (WATER_MAX_ALPHA - WATER_MIN_ALPHA) * t;
  }
  if (depthWorldUnits <= WATER_DEPTH_SATURATION_WORLD_UNITS) return WATER_MAX_ALPHA;
  if (depthWorldUnits >= WATER_DEPTH_FLOOR_WORLD_UNITS) return WATER_DEEP_STRATA_ALPHA;
  const t =
    (depthWorldUnits - WATER_DEPTH_SATURATION_WORLD_UNITS) /
    (WATER_DEPTH_FLOOR_WORLD_UNITS - WATER_DEPTH_SATURATION_WORLD_UNITS);
  return WATER_MAX_ALPHA + (WATER_DEEP_STRATA_ALPHA - WATER_MAX_ALPHA) * t;
}

export const WATER_SPECULAR_FLOOR = 0.15;

export function depthToSpecularFactor(depthWorldUnits: number): number {
  if (depthWorldUnits <= WATER_DEPTH_SATURATION_WORLD_UNITS) return 1;
  if (depthWorldUnits >= WATER_DEPTH_FLOOR_WORLD_UNITS) return WATER_SPECULAR_FLOOR;
  const t =
    (depthWorldUnits - WATER_DEPTH_SATURATION_WORLD_UNITS) /
    (WATER_DEPTH_FLOOR_WORLD_UNITS - WATER_DEPTH_SATURATION_WORLD_UNITS);
  return 1 + (WATER_SPECULAR_FLOOR - 1) * t;
}

const WATER_DEPTH_ALPHA_BYTE_MAX = 255;

export function depthAlphaByte(depthWorldUnits: number): number {
  return Math.round(depthToWaterAlpha(depthWorldUnits) * WATER_DEPTH_ALPHA_BYTE_MAX);
}

export const WATER_DEPTH_ALPHA_DEFAULT_BYTE = depthAlphaByte(0);

export const WATER_DRY_LAND_ALPHA = 0;

export function surfaceAlphaByte(height: number): number {
  if (height > SEA_LEVEL) return Math.round(WATER_DRY_LAND_ALPHA * WATER_DEPTH_ALPHA_BYTE_MAX);
  return depthAlphaByte(bandFloorWaterDepthWorldUnits(height));
}

export const WATER_SHADE_SHALLOW = 1.15;

export const WATER_SHALLOW_TINT: readonly [number, number, number] = [1.8, 1.45, 1.0];
export const WATER_DEEP_TINT: readonly [number, number, number] = [0.16, 0.28, 0.52];

export const WATER_TRENCH_TINT: readonly [number, number, number] = [0.01, 0.03, 0.1];

export const WATER_SELF_LIGHT_RADIANCE = 0.4;

function tintLuminance(tint: readonly [number, number, number]): number {
  const [r, g, b] = tint;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const WATER_SHADE_FLOOR_MIX =
  (tintLuminance(WATER_DEEP_TINT) - tintLuminance(WATER_TRENCH_TINT)) /
  (tintLuminance(WATER_SHALLOW_TINT) - tintLuminance(WATER_TRENCH_TINT));

export function depthToShadeMix(depthWorldUnits: number): number {
  const bands = depthWorldUnits / (BAND_HEIGHT * HEIGHT_WORLD_SCALE);
  return Math.min(1, Math.max(0, 1 - bands / WATER_SHADE_SPAN_BANDS));
}

export function depthShadeMixByte(depthWorldUnits: number): number {
  return Math.round(depthToShadeMix(depthWorldUnits) * WATER_DEPTH_ALPHA_BYTE_MAX);
}

export const WATER_SHADE_MIX_DEFAULT_BYTE = depthShadeMixByte(0);

export function depthSpecularFactorByte(depthWorldUnits: number): number {
  return Math.round(depthToSpecularFactor(depthWorldUnits) * WATER_DEPTH_ALPHA_BYTE_MAX);
}

export const WATER_SPECULAR_FACTOR_DEFAULT_BYTE = depthSpecularFactorByte(0);

export const WATER_CURVE_BYTES_PER_TEXEL = 4;
export const WATER_CURVE_ALPHA_CHANNEL = 0;
export const WATER_CURVE_SPECULAR_CHANNEL = 1;
export const WATER_CURVE_SHADE_CHANNEL = 2;
export const WATER_CURVE_SPARE_CHANNEL = 3;
const WATER_CURVE_SPARE_BYTE = WATER_DEPTH_ALPHA_BYTE_MAX;

export function createWaterCurveBuffer(worldSize: number): Uint8Array {
  const buffer = new Uint8Array(worldSize * worldSize * WATER_CURVE_BYTES_PER_TEXEL);
  for (let texel = 0; texel < worldSize * worldSize; texel++) {
    const base = texel * WATER_CURVE_BYTES_PER_TEXEL;
    buffer[base + WATER_CURVE_ALPHA_CHANNEL] = WATER_DEPTH_ALPHA_DEFAULT_BYTE;
    buffer[base + WATER_CURVE_SPECULAR_CHANNEL] = WATER_SPECULAR_FACTOR_DEFAULT_BYTE;
    buffer[base + WATER_CURVE_SHADE_CHANNEL] = WATER_SHADE_MIX_DEFAULT_BYTE;
    buffer[base + WATER_CURVE_SPARE_CHANNEL] = WATER_CURVE_SPARE_BYTE;
  }
  return buffer;
}

export function writeWaterCurveTexels(
  out: Uint8Array,
  worldSize: number,
  mirror: TerrainMirror,
  dirtyChunks: Iterable<number>,
): void {
  const chunkCols = chunksPerEdge(worldSize);
  for (const chunkIdx of dirtyChunks) {
    const cx = chunkIdx % chunkCols;
    const cy = Math.floor(chunkIdx / chunkCols);
    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
      const row = y * worldSize;
      for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
        const height = seabedHeight(mirror.map, x, y);
        const depth = bandFloorWaterDepthWorldUnits(height);
        const base = (row + x) * WATER_CURVE_BYTES_PER_TEXEL;
        out[base + WATER_CURVE_ALPHA_CHANNEL] = surfaceAlphaByte(height);
        out[base + WATER_CURVE_SPECULAR_CHANNEL] = depthSpecularFactorByte(depth);
        out[base + WATER_CURVE_SHADE_CHANNEL] = depthShadeMixByte(depth);
      }
    }
  }
}

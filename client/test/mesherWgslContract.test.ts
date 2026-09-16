import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_BAND,
  DRAWN_GROUND_BAND_BIAS,
  OPEN_COLUMN_SAMPLE,
  drawnLevelThreshold,
} from '@terrace/shared';
import { SPAN_BAND_WGSL, buildMesherWgsl } from '../src/render/gpuMesher/mesherWgsl.ts';
import {
  SPAN_COUNT_SHIFT,
  SPAN_OFFSET_MASK,
  SPAN_PAIR_WORDS,
} from '../src/render/gpuMesher/terrainGpuInputs.ts';

/**
 * The band contract as the kernel must state it. Nothing else reads the shader,
 * so without this a one-character kernel edit ships green.
 */
const COVERAGE = 'return spanFloorBand(local, k) <= band && band <= spanCapBand(local, k);';
const CAP_BAND = 'return drawnBandOfSample(spanCeiling(local, k));';
const SHIFT_NOT_DIVIDE = 'let band = (h + BAND_BIAS) >> BAND_HEIGHT_SHIFT;';
const SHORE_EXCEPTION =
  'return select(band, -1, band == 0 && h + BAND_BIAS < SHORE_THRESHOLD);';
const SAMPLE_BELOW = 'if (spanCapBand(local, k) < band) { below = spanCeiling(local, k); }';

/** Reads `const NAME : type = value;` out of the emitted shader. */
function emittedConstant(source: string, name: string): number {
  const match = new RegExp(`^const ${name} : (?:i32|u32) = (-?\\d+)u?;$`, 'm').exec(source);
  expect(match, `${name} is not declared in the emitted shader`).not.toBeNull();
  return Number(match![1]);
}

describe('the shipped mesher WGSL', () => {
  it('carries the exported band-contract block verbatim', () => {
    expect(buildMesherWgsl()).toContain(SPAN_BAND_WGSL);
  });

  it('states coverage as floorBand <= band <= capBand', () => {
    expect(SPAN_BAND_WGSL).toContain(COVERAGE);
    expect(SPAN_BAND_WGSL).toContain(CAP_BAND);
    expect(SPAN_BAND_WGSL).toContain(SAMPLE_BELOW);
  });

  it('bands a sample by an arithmetic shift, with the shore exception', () => {
    expect(SPAN_BAND_WGSL).toContain(SHIFT_NOT_DIVIDE);
    expect(SPAN_BAND_WGSL).toContain(SHORE_EXCEPTION);
  });

  it('is generated from the same constants the TypeScript side uses', () => {
    const source = buildMesherWgsl();
    expect(emittedConstant(source, 'BAND_HEIGHT')).toBe(BAND_HEIGHT);
    expect(emittedConstant(source, 'BAND_HEIGHT_SHIFT')).toBe(Math.log2(BAND_HEIGHT));
    expect(emittedConstant(source, 'BAND_BIAS')).toBe(DRAWN_GROUND_BAND_BIAS);
    expect(emittedConstant(source, 'SHORE_THRESHOLD')).toBe(drawnLevelThreshold(0));
    expect(emittedConstant(source, 'BEDROCK_BAND')).toBe(BEDROCK_BAND);
    expect(emittedConstant(source, 'OPEN_COLUMN_SAMPLE')).toBe(OPEN_COLUMN_SAMPLE);
    expect(emittedConstant(source, 'SPAN_COUNT_SHIFT')).toBe(SPAN_COUNT_SHIFT);
    expect(emittedConstant(source, 'SPAN_OFFSET_MASK')).toBe(SPAN_OFFSET_MASK);
    expect(emittedConstant(source, 'SPAN_PAIR_WORDS')).toBe(SPAN_PAIR_WORDS);
  });
});

import { BAND_HEIGHT, MAX_HEIGHT, MIN_HEIGHT, SEA_LEVEL, bandOf } from '@terrace/shared';
import { BAND_WORLD_HEIGHT } from '../../config.ts';
import {
  SEABED_CAP_SINK,
  SEABED_RISER_BORDER_WORLD_HEIGHT,
} from '../../terrain/capEmission.ts';
import {
  CLIFF_PALETTE,
  TERRAIN_PALETTE,
  bandPaletteIndex,
  isEmissivePaletteIndex,
  isSeabedPaletteIndex,
  type Rgb,
} from '../../terrain/bandColors.ts';

/** Slot 0 holds band -BAND_LUT_OFFSET; the table spans every band a height can reach. */
export const BAND_LUT_OFFSET = 128;

export const BAND_LUT_SIZE = 256;

export const LUT_CAP_BASE = 0;
export const LUT_CLIFF_BASE = BAND_LUT_SIZE;
export const LUT_BORDER_BASE = 2 * BAND_LUT_SIZE;
/** Ceiling colour when the level is the chunk's lowest band, and when it is not. */
export const LUT_CEILING_LOWEST_BASE = 3 * BAND_LUT_SIZE;
export const LUT_CEILING_INNER_BASE = 4 * BAND_LUT_SIZE;
export const LUT_SHORE_CAP = 5 * BAND_LUT_SIZE;
export const LUT_SHORE_CLIFF = LUT_SHORE_CAP + 1;
export const LUT_VEC4_COUNT = LUT_SHORE_CLIFF + 1;

const LUT_COMPONENTS = 4;

/** Alpha byte the material reads as "self lit": 1 becomes 255 through pack4x8unorm. */
const SELF_LIT_ON = 1;
const SELF_LIT_OFF = 0;

/** Border slot alpha doubles as the rim flag, the CPU's `bordered` test. */
const BORDERED_ON = 1;
const BORDERED_OFF = 0;

export const SHORE_THRESHOLD = SEA_LEVEL + 1;

function capYOfBand(band: number): number {
  return band === 0 ? -SEABED_CAP_SINK : band * BAND_WORLD_HEIGHT;
}

function selfLitFor(paletteIndex: number): number {
  return isSeabedPaletteIndex(paletteIndex) ? SELF_LIT_ON : SELF_LIT_OFF;
}

function capSelfLitFor(paletteIndex: number): number {
  return isEmissivePaletteIndex(paletteIndex) ? SELF_LIT_ON : SELF_LIT_OFF;
}

function write(out: Float32Array, slot: number, color: Rgb, alpha: number): void {
  const at = slot * LUT_COMPONENTS;
  out[at] = color[0];
  out[at + 1] = color[1];
  out[at + 2] = color[2];
  out[at + 3] = alpha;
}

function ceilingSlot(band: number, isLowest: boolean): { color: Rgb; alpha: number } {
  const paletteIndex = bandPaletteIndex(band * BAND_HEIGHT);
  const undersideIndex = bandPaletteIndex((isLowest ? band : band - 1) * BAND_HEIGHT);
  const index = isSeabedPaletteIndex(undersideIndex) ? undersideIndex : paletteIndex;
  return { color: CLIFF_PALETTE[index]!, alpha: selfLitFor(index) };
}

/** Every colour decision makeLevels makes, resolved per band so the kernel only reads. */
export function buildBandLut(): Float32Array {
  const out = new Float32Array(LUT_VEC4_COUNT * LUT_COMPONENTS);
  const lowest = bandOf(MIN_HEIGHT) - 1;
  const highest = bandOf(MAX_HEIGHT) + 1;
  if (lowest < -BAND_LUT_OFFSET || highest >= BAND_LUT_SIZE - BAND_LUT_OFFSET) {
    throw new RangeError(`band range [${lowest}, ${highest}] escapes the ${BAND_LUT_SIZE}-slot LUT`);
  }

  for (let band = -BAND_LUT_OFFSET; band < BAND_LUT_SIZE - BAND_LUT_OFFSET; band++) {
    const slot = band + BAND_LUT_OFFSET;
    const paletteIndex = bandPaletteIndex(band * BAND_HEIGHT);
    const riserSelfLit = selfLitFor(paletteIndex);
    const bordered =
      isSeabedPaletteIndex(paletteIndex) &&
      capYOfBand(band) - capYOfBand(band - 1) > SEABED_RISER_BORDER_WORLD_HEIGHT;

    write(out, LUT_CAP_BASE + slot, TERRAIN_PALETTE[paletteIndex]!, capSelfLitFor(paletteIndex));
    write(out, LUT_CLIFF_BASE + slot, CLIFF_PALETTE[paletteIndex]!, riserSelfLit);
    write(
      out,
      LUT_BORDER_BASE + slot,
      TERRAIN_PALETTE[bandPaletteIndex((band - 1) * BAND_HEIGHT)]!,
      bordered ? BORDERED_ON : BORDERED_OFF,
    );

    const lowestCeiling = ceilingSlot(band, true);
    write(out, LUT_CEILING_LOWEST_BASE + slot, lowestCeiling.color, lowestCeiling.alpha);
    const innerCeiling = ceilingSlot(band, false);
    write(out, LUT_CEILING_INNER_BASE + slot, innerCeiling.color, innerCeiling.alpha);
  }

  const shoreIndex = bandPaletteIndex(SHORE_THRESHOLD);
  write(out, LUT_SHORE_CAP, TERRAIN_PALETTE[shoreIndex]!, capSelfLitFor(shoreIndex));
  write(out, LUT_SHORE_CLIFF, CLIFF_PALETTE[shoreIndex]!, selfLitFor(shoreIndex));
  return out;
}

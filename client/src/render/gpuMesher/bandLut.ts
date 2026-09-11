import { BAND_HEIGHT, MAX_HEIGHT, MIN_HEIGHT, SEA_LEVEL, bandOf } from '@terrace/shared';
import { BAND_WORLD_HEIGHT } from '../../config.ts';
import {
  SEABED_CAP_SINK,
  SEABED_RISER_BORDER_WORLD_HEIGHT,
  quantizeChannel,
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

/** vec4f: rgb plus the alpha byte the kernel packs as a flag. */
export const LUT_COMPONENTS = 4;

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

function write(out: Float64Array, slot: number, color: Rgb, alpha: number): void {
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

/** Every colour decision makeLevels makes, resolved per band. Exact palette floats: an
 *  f32 round trip before quantizing would shift a channel by a byte. */
function buildBandLutValues(): Float64Array {
  const out = new Float64Array(LUT_VEC4_COUNT * LUT_COMPONENTS);
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

    // The rim vertex takes the border slot whole, alpha included, so a bordered riser's
    // border alpha has to be the self-lit flag the cliff slot carries.
    if (bordered && riserSelfLit !== SELF_LIT_ON) {
      throw new RangeError(`band ${band} borders its riser but is not self lit`);
    }

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

/** The kernel's uniform copy. It reads only the border alpha, which is 0 or 1 either way. */
export function buildBandLut(): Float32Array {
  return Float32Array.from(buildBandLutValues());
}

/** The same table as bytes: what the material samples, and what a CPU vertex is matched
 *  against. `quantizeChannel` is the CPU mesher's own rule, so the bytes are identical. */
export function buildBandLutBytes(): Uint8Array {
  const values = buildBandLutValues();
  const bytes = new Uint8Array(values.length);
  for (let at = 0; at < values.length; at++) bytes[at] = quantizeChannel(values[at]!);
  return bytes;
}

const RED_SHIFT = 24;
const GREEN_SHIFT = 16;
const BLUE_SHIFT = 8;

/** One number per RGBA quadruple, so a byte quadruple can key a Map. */
export function packColorKey(r: number, g: number, b: number, a: number): number {
  return ((r << RED_SHIFT) | (g << GREEN_SHIFT) | (b << BLUE_SHIFT) | a) >>> 0;
}

/** Reverse of the table: the slot a CPU vertex's colour bytes came from. Slots that
 *  quantize to the same bytes decode to the same colour, so the lowest one wins. */
export function buildBandLutSlotByColor(): Map<number, number> {
  const bytes = buildBandLutBytes();
  const slots = new Map<number, number>();
  for (let slot = LUT_VEC4_COUNT - 1; slot >= 0; slot--) {
    const at = slot * LUT_COMPONENTS;
    slots.set(packColorKey(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!), slot);
  }
  return slots;
}

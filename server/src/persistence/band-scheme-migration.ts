import { bandLevelHeight, BEDROCK_BAND, MAX_HEIGHT, MIN_HEIGHT, spanCapBand, type Span } from '@terrace/shared';

const LEGACY_BAND_HEIGHT = 16;
const LEGACY_BIAS = 8;
const LEGACY_SHORE_HEIGHT = 1;
export const LEGACY_BEDROCK_BAND = -96;

export const LEGACY_TOP_BAND = 64;

export const LEGACY_BAND_SCHEME_VERSION = 2;

function legacyBandOfSample(h: number): number {
  const band = Math.floor((h + LEGACY_BIAS) / LEGACY_BAND_HEIGHT);
  return band === 0 && h + LEGACY_BIAS < LEGACY_SHORE_HEIGHT + LEGACY_BIAS ? -1 : band;
}

function clampHeight(h: number): number {
  return h > MAX_HEIGHT ? MAX_HEIGHT : h < MIN_HEIGHT ? MIN_HEIGHT : h;
}

/** Old scheme canonical level for rows planted by tests. */
export function legacyLevelHeight(band: number): number {
  return band === 0 ? LEGACY_SHORE_HEIGHT : band * LEGACY_BAND_HEIGHT;
}

/** Old height -> the new scheme's canonical level for the same drawn band. */
export function migrateHeight(h: number): number {
  return clampHeight(bandLevelHeight(legacyBandOfSample(h)));
}

export function migrateFloorBand(band: number): number {
  return band === LEGACY_BEDROCK_BAND ? BEDROCK_BAND : band;
}

/** Old span -> new scheme. A floor above the migrated cap drops to it. */
export function migrateSpan(floorBand: number, ceiling: number): Span {
  const migratedCeiling = migrateHeight(ceiling);
  const migratedFloor = migrateFloorBand(floorBand);
  const cap = spanCapBand({ floorBand: migratedFloor, ceiling: migratedCeiling });
  return { floorBand: migratedFloor > cap ? cap : migratedFloor, ceiling: migratedCeiling };
}

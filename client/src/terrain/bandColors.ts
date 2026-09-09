import {
  BAND_HEIGHT,
  DEEP_BASALT_BANDS,
  DEEP_BASALT_DEPTH,
  DEEP_LAVA_BANDS,
  DEEP_LAVA_DEPTH,
  DEEP_OBSIDIAN_BANDS,
  DEEP_OBSIDIAN_DEPTH,
  DEEP_STRATA_BANDS,
  LAND_RAMP_ANCHOR_COUNT,
  MAX_HEIGHT,
  SEA_COLUMN_BANDS,
  SEA_COLUMN_DEPTH,
  SEA_LEVEL,
  SNOW_LINE_HEIGHT as WORLD_SNOW_LINE_HEIGHT,
  bandOf,
  isWater,
} from '@terrace/shared';
import { SEA_DEPTH_CUE_FLOOR_HEIGHT } from '../config.ts';
import { ACTIVE_TERRAIN_GRADIENT, type GradientStop } from './terrainGradient.ts';

export type Rgb = readonly [r: number, g: number, b: number];

function rgb(hex: number): Rgb {
  return [((hex >> 16) & 0xff) / 0xff, ((hex >> 8) & 0xff) / 0xff, (hex & 0xff) / 0xff];
}

export const BLUE_SEABED_STOPS = SEA_COLUMN_BANDS + 1;

export const SEABED_DEPTH_STOPS = BLUE_SEABED_STOPS + DEEP_STRATA_BANDS;

export const FIRST_BASALT_STOP = BLUE_SEABED_STOPS;
export const FIRST_OBSIDIAN_STOP = FIRST_BASALT_STOP + DEEP_BASALT_BANDS;
export const FIRST_LAVA_STOP = FIRST_OBSIDIAN_STOP + DEEP_OBSIDIAN_BANDS;

export function isEmissivePaletteIndex(index: number): boolean {
  return index >= FIRST_LAVA_STOP && index < SEABED_DEPTH_STOPS;
}

export const SEABED_PALETTE_INDEX = 0;
export const FIRST_LAND_PALETTE_INDEX = SEABED_DEPTH_STOPS;

type ColorAnchor = readonly [height: number, color: Rgb];

function evenlySpaced(
  topHeight: number,
  bottomHeight: number,
  colors: readonly Rgb[],
): readonly ColorAnchor[] {
  if (colors.length === 1) return [[topHeight, colors[0]]];
  const gaps = colors.length - 1;
  return colors.map((color, i) => [
    topHeight + ((bottomHeight - topHeight) * i) / gaps,
    color,
  ]);
}

function sampleAnchors(anchors: readonly ColorAnchor[], height: number): Rgb {
  const last = anchors.length - 1;
  if (height >= anchors[0][0]) return anchors[0][1];
  if (height <= anchors[last][0]) return anchors[last][1];
  let upper = 0;
  while (anchors[upper + 1][0] > height) upper++;
  const [topHeight, topColor] = anchors[upper];
  const [bottomHeight, bottomColor] = anchors[upper + 1];
  const t = (topHeight - height) / (topHeight - bottomHeight);
  return [
    topColor[0] + (bottomColor[0] - topColor[0]) * t,
    topColor[1] + (bottomColor[1] - topColor[1]) * t,
    topColor[2] + (bottomColor[2] - topColor[2]) * t,
  ];
}

const OCEAN_SHELF_COLOR_INDEX = 2;

function stopColors(stops: readonly GradientStop[]): readonly Rgb[] {
  return stops.map((stop) => rgb(stop.hex));
}

const SEA_COLUMN_COLORS = stopColors(ACTIVE_TERRAIN_GRADIENT.seaColumn);

const SEA_DEPTH_CUE_COLORS = SEA_COLUMN_COLORS.slice(0, -1);

const COLUMN_FLOOR_COLOR = SEA_COLUMN_COLORS[SEA_COLUMN_COLORS.length - 1];
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function luminanceSpaced(
  topHeight: number,
  bottomHeight: number,
  colors: readonly Rgb[],
): readonly ColorAnchor[] {
  const top = luminance(colors[0]);
  const bottom = luminance(colors[colors.length - 1]);
  return colors.map((color) => [
    topHeight + ((bottomHeight - topHeight) * (top - luminance(color))) / (top - bottom),
    color,
  ]);
}

const BLUE_COLUMN_ANCHORS: readonly ColorAnchor[] = [
  ...luminanceSpaced(SEA_LEVEL, SEA_DEPTH_CUE_FLOOR_HEIGHT, SEA_DEPTH_CUE_COLORS),
  [-SEA_COLUMN_DEPTH, COLUMN_FLOOR_COLOR],
];

const CRUST_TOP = -SEA_COLUMN_DEPTH;
const BASALT_FLOOR = CRUST_TOP - DEEP_BASALT_DEPTH;
const OBSIDIAN_FLOOR = BASALT_FLOOR - DEEP_OBSIDIAN_DEPTH;
const LAVA_FLOOR = OBSIDIAN_FLOOR - DEEP_LAVA_DEPTH;

const BASALT_ANCHORS = evenlySpaced(
  CRUST_TOP,
  BASALT_FLOOR,
  stopColors(ACTIVE_TERRAIN_GRADIENT.basalt),
);

const OBSIDIAN_ANCHORS = evenlySpaced(
  BASALT_FLOOR,
  OBSIDIAN_FLOOR,
  stopColors(ACTIVE_TERRAIN_GRADIENT.obsidian),
);

const LAVA_ANCHORS = evenlySpaced(
  OBSIDIAN_FLOOR,
  LAVA_FLOOR,
  stopColors(ACTIVE_TERRAIN_GRADIENT.lava),
);

export const SNOW_LINE_HEIGHT = WORLD_SNOW_LINE_HEIGHT;

export const LAND_RAMP_BANDS = SNOW_LINE_HEIGHT / BAND_HEIGHT;

const LAND_RAMP_SHORELINE_UP: readonly Rgb[] = stopColors(ACTIVE_TERRAIN_GRADIENT.land);

if (LAND_RAMP_SHORELINE_UP.length !== LAND_RAMP_ANCHOR_COUNT) {
  throw new Error(
    `bandColors: gradient '${ACTIVE_TERRAIN_GRADIENT.name}' holds ` +
      `${LAND_RAMP_SHORELINE_UP.length} land stops but ` +
      `@terrace/shared's LAND_RAMP_ANCHOR_COUNT says ${LAND_RAMP_ANCHOR_COUNT}`,
  );
}

export const LAND_RAMP_ANCHORS = evenlySpaced(SNOW_LINE_HEIGHT, SEA_LEVEL, [
  ...LAND_RAMP_SHORELINE_UP,
].reverse());

const SEABED_REGIMES: readonly { stops: number; anchors: readonly ColorAnchor[] }[] = [
  { stops: BLUE_SEABED_STOPS, anchors: BLUE_COLUMN_ANCHORS },
  { stops: DEEP_BASALT_BANDS, anchors: BASALT_ANCHORS },
  { stops: DEEP_OBSIDIAN_BANDS, anchors: OBSIDIAN_ANCHORS },
  { stops: DEEP_LAVA_BANDS, anchors: LAVA_ANCHORS },
];

function buildPalette(): Rgb[] {
  const stops: Rgb[] = [];
  for (const regime of SEABED_REGIMES) {
    for (let i = 0; i < regime.stops; i++) {
      stops.push(sampleAnchors(regime.anchors, -stops.length * BAND_HEIGHT));
    }
  }
  for (let band = 0; band <= LAND_RAMP_BANDS; band++) {
    stops.push(sampleAnchors(LAND_RAMP_ANCHORS, band * BAND_HEIGHT));
  }
  return stops;
}

export const TERRAIN_PALETTE: readonly Rgb[] = buildPalette();

export const MIN_LAND_ANCHOR_LUMINANCE_GAP = 0.3;

export const LAST_PALETTE_INDEX = TERRAIN_PALETTE.length - 1;

export function bandPaletteIndex(height: number): number {
  if (isWater(height)) {
    const depth = 0 - bandOf(height);
    return depth >= SEABED_DEPTH_STOPS ? SEABED_DEPTH_STOPS - 1 : depth;
  }
  const index = FIRST_LAND_PALETTE_INDEX + bandOf(height);
  return index > LAST_PALETTE_INDEX ? LAST_PALETTE_INDEX : index;
}

export function bandColorOf(height: number): Rgb {
  return TERRAIN_PALETTE[bandPaletteIndex(height)];
}

export function isSeabedPaletteIndex(index: number): boolean {
  return index < SEABED_DEPTH_STOPS;
}

const CLIFF_ROCK_TINT: Rgb = rgb(ACTIVE_TERRAIN_GRADIENT.cliffRockTint.hex);

export const CLIFF_ROCK_TINT_MIX = 0.4;

export const CLIFF_FACE_DARKEN_FACTOR = 0.78;

export function cliffFaceColor(top: Rgb): Rgb {
  const mix = (channel: number, tint: number): number =>
    (channel * (1 - CLIFF_ROCK_TINT_MIX) + tint * CLIFF_ROCK_TINT_MIX) *
    CLIFF_FACE_DARKEN_FACTOR;
  return [
    mix(top[0], CLIFF_ROCK_TINT[0]),
    mix(top[1], CLIFF_ROCK_TINT[1]),
    mix(top[2], CLIFF_ROCK_TINT[2]),
  ];
}

export const SEABED_RISER_LIGHTEN_MIX = 0.16;

export function seabedRiserFaceColor(top: Rgb): Rgb {
  const lift = (channel: number): number =>
    channel + (1 - channel) * SEABED_RISER_LIGHTEN_MIX;
  return [lift(top[0]), lift(top[1]), lift(top[2])];
}

const SEABED_RIM_TINT: Rgb = rgb(ACTIVE_TERRAIN_GRADIENT.seabedRimTint.hex);

export const SEABED_RIM_TINT_MIX = 0.55;

export const SEABED_RIM_BRIGHTEN_FACTOR = 1.5;

export function seabedRimColor(top: Rgb): Rgb {
  const mix = (channel: number, tint: number): number => {
    const lifted =
      (channel * (1 - SEABED_RIM_TINT_MIX) + tint * SEABED_RIM_TINT_MIX) *
      SEABED_RIM_BRIGHTEN_FACTOR;
    return lifted > 1 ? 1 : lifted;
  };
  return [
    mix(top[0], SEABED_RIM_TINT[0]),
    mix(top[1], SEABED_RIM_TINT[1]),
    mix(top[2], SEABED_RIM_TINT[2]),
  ];
}

export const CLIFF_PALETTE: readonly Rgb[] = TERRAIN_PALETTE.map((top, index) =>
  isSeabedPaletteIndex(index) ? seabedRiserFaceColor(top) : cliffFaceColor(top),
);

export const RAMP_BAND_COUNT = LAST_PALETTE_INDEX - FIRST_LAND_PALETTE_INDEX;

export const MAX_BAND = bandOf(MAX_HEIGHT);

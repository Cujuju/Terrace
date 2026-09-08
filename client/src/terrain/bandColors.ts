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
const OCEAN_COLORS: readonly Rgb[] = [
  rgb(0x6a7f68),
  rgb(0x50705d),
  rgb(0x3a5b52),
  rgb(0x274347),
  rgb(0x1f3a44),
  rgb(0x183243),
  rgb(0x122a40),
  rgb(0x0d233c),
  rgb(0x0a1d37),
];
const ABYSS_COLORS: readonly Rgb[] = [
  OCEAN_COLORS[OCEAN_COLORS.length - 1],
  rgb(0x081931),
  rgb(0x07152b),
  rgb(0x061226),
  rgb(0x050f21),
  rgb(0x040d1d),
  rgb(0x040b19),
  rgb(0x030916),
  rgb(0x030813),
];
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
  ...luminanceSpaced(SEA_LEVEL, SEA_DEPTH_CUE_FLOOR_HEIGHT, [
    ...OCEAN_COLORS,
    ...ABYSS_COLORS.slice(1, -1),
  ]),
  [-SEA_COLUMN_DEPTH, ABYSS_COLORS[ABYSS_COLORS.length - 1]],
];

const CRUST_TOP = -SEA_COLUMN_DEPTH;
const BASALT_FLOOR = CRUST_TOP - DEEP_BASALT_DEPTH;
const OBSIDIAN_FLOOR = BASALT_FLOOR - DEEP_OBSIDIAN_DEPTH;
const LAVA_FLOOR = OBSIDIAN_FLOOR - DEEP_LAVA_DEPTH;

const BASALT_ANCHORS = evenlySpaced(CRUST_TOP, BASALT_FLOOR, [
  rgb(0x3a3b41),
  rgb(0x323338),
  rgb(0x2a2b2f),
  rgb(0x232427),
]);

const OBSIDIAN_ANCHORS = evenlySpaced(BASALT_FLOOR, OBSIDIAN_FLOOR, [
  rgb(0x1a1820),
  rgb(0x121017),
  rgb(0x0b0a10),
]);

const LAVA_ANCHORS = evenlySpaced(OBSIDIAN_FLOOR, LAVA_FLOOR, [rgb(0xf25c1a)]);

export const SNOW_LINE_HEIGHT = WORLD_SNOW_LINE_HEIGHT;

export const LAND_RAMP_BANDS = SNOW_LINE_HEIGHT / BAND_HEIGHT;

const LAND_RAMP_SHORELINE_UP: readonly Rgb[] = [
  rgb(0xd9c89a),
  rgb(0xc0a468),
  rgb(0x96774a),
  rgb(0x8fc25a),
  rgb(0x69a244),
  rgb(0x467a33),
  rgb(0x736f61),
  rgb(0x908c80),
  rgb(0xb3aea2),
  rgb(0xf2f4f6),
];

if (LAND_RAMP_SHORELINE_UP.length !== LAND_RAMP_ANCHOR_COUNT) {
  throw new Error(
    `bandColors: the land ramp holds ${LAND_RAMP_SHORELINE_UP.length} anchors but ` +
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

const CLIFF_ROCK_TINT: Rgb = rgb(0x6b5a49);

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

const SEABED_RIM_TINT: Rgb = rgb(0x9fd4c8);

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

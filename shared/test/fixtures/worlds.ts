import {
  applyPackedSpans,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  cellIndex,
  createHeightmap,
  createSeededRng,
  DRAWN_SHORE_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  NEIGHBOURHOOD_CELLS,
  quantizeToBand,
  SEA_LEVEL,
  type Heightmap,
} from '../../src/index.ts';
import { packedSpanPair } from '../support/goldenCorpus.ts';
import {
  PLAYED_WORLD_CELLS,
  PLAYED_WORLD_COLUMN_SPANS,
  PLAYED_WORLD_SIZE,
} from './playedWorld.ts';

export const GOLDEN_WORLD_SIZE = 64;

export type GoldenWorldName = 'genesis-noise' | 'arch' | 'terrace' | 'shoreline' | 'played';

export const GOLDEN_WORLD_NAMES: readonly GoldenWorldName[] = [
  'genesis-noise',
  'arch',
  'terrace',
  'shoreline',
  'played',
];

function setSpans(map: Heightmap, x: number, y: number, pairs: readonly (readonly number[])[]): void {
  applyPackedSpans(map, x, y, pairs.flat());
}

// --- genesis-like noise -----------------------------------------------------
// Ported from server/src/world/genesis.ts (read-only): lattice octaves,
// fixed-point band offsets, clamp. Dropped: island, trench, land-lift and
// basin-drop passes.

const GENESIS_FIXTURE_SEED = 0x7e_44_ac_e1;

const GENESIS_NOISE_OCTAVES: readonly {
  readonly spacingCells: number;
  readonly amplitudeDivisor: number;
}[] = [
  { spacingCells: NEIGHBOURHOOD_CELLS * 4, amplitudeDivisor: 1 },
  { spacingCells: NEIGHBOURHOOD_CELLS * 2, amplitudeDivisor: 2 },
  { spacingCells: NEIGHBOURHOOD_CELLS, amplitudeDivisor: 4 },
  { spacingCells: NEIGHBOURHOOD_CELLS / 2, amplitudeDivisor: 8 },
  { spacingCells: NEIGHBOURHOOD_CELLS / 4, amplitudeDivisor: 16 },
];

const GENESIS_NOISE_MIN_DEPTH_BELOW_SEA = 640;
const GENESIS_NOISE_MAX_HEIGHT_ABOVE_SEA = 256;
const GENESIS_NOISE_MIN_BAND_OFFSET = -(GENESIS_NOISE_MIN_DEPTH_BELOW_SEA / BAND_HEIGHT);
const GENESIS_NOISE_MAX_BAND_OFFSET = GENESIS_NOISE_MAX_HEIGHT_ABOVE_SEA / BAND_HEIGHT;

const GENESIS_ROUGHNESS_SKEW_EXPONENT = 1 / 2;

// Mirrors FRESH_SEABED_DEPTH_BELOW_SEA in server/src/world/genesis.ts.
const GENESIS_FIXTURE_SEABED_DEPTH_BELOW_SEA = 192;
const FRESH_SEABED_BANDS_BELOW_SEA = GENESIS_FIXTURE_SEABED_DEPTH_BELOW_SEA / BAND_HEIGHT;
const GENESIS_MIN_ROUGHNESS =
  FRESH_SEABED_BANDS_BELOW_SEA /
  ((GENESIS_NOISE_MAX_BAND_OFFSET - GENESIS_NOISE_MIN_BAND_OFFSET) / 2);

const GENESIS_BASELINE_CEILING_DIVISOR = 4;
const GENESIS_BASELINE_MIN_BAND_OFFSET = -FRESH_SEABED_BANDS_BELOW_SEA;
const GENESIS_BASELINE_MAX_BAND_OFFSET =
  GENESIS_NOISE_MAX_BAND_OFFSET / GENESIS_BASELINE_CEILING_DIVISOR;

const GENESIS_BAND_FIXED_POINT_ONE = 256;

// The fixture is a 64-cell world, far below the coarsest genesis lattice, so
// the octave spacings are divided down to keep real relief in frame.
const GENESIS_FIXTURE_SPACING_DIVISOR = 16;

interface NoiseOctave {
  readonly spacingCells: number;
  readonly bandOffsets: Int32Array;
  readonly cols: number;
}

function buildNoiseOctaves(size: number, rng: () => number): {
  readonly baselineBandOffset: number;
  readonly octaves: readonly NoiseOctave[];
} {
  const halfSpan = (GENESIS_NOISE_MAX_BAND_OFFSET - GENESIS_NOISE_MIN_BAND_OFFSET) / 2;
  const baselineSpan = GENESIS_BASELINE_MAX_BAND_OFFSET - GENESIS_BASELINE_MIN_BAND_OFFSET;
  const baselineBandOffset = Math.round(GENESIS_BASELINE_MIN_BAND_OFFSET + rng() * baselineSpan);
  const roughness =
    GENESIS_MIN_ROUGHNESS +
    (1 - GENESIS_MIN_ROUGHNESS) * Math.pow(rng(), GENESIS_ROUGHNESS_SKEW_EXPONENT);

  const octaves = GENESIS_NOISE_OCTAVES.map(({ spacingCells, amplitudeDivisor }) => {
    const spacing = Math.max(1, spacingCells / GENESIS_FIXTURE_SPACING_DIVISOR);
    const amplitude = (halfSpan * roughness) / amplitudeDivisor;
    const cols = Math.floor((size - 1) / spacing) + 2;
    const bandOffsets = new Int32Array(cols * cols);
    for (let j = 0; j < cols; j++) {
      const row = j * cols;
      for (let i = 0; i < cols; i++) {
        bandOffsets[row + i] = Math.round(
          (rng() * 2 - 1) * amplitude * GENESIS_BAND_FIXED_POINT_ONE,
        );
      }
    }
    return { spacingCells: spacing, bandOffsets, cols };
  });

  return { baselineBandOffset, octaves };
}

function octaveBandAt(octave: NoiseOctave, x: number, y: number): number {
  const { spacingCells: spacing, cols, bandOffsets: offsets } = octave;
  const gx = Math.floor(x / spacing);
  const gy = Math.floor(y / spacing);
  const fx = x - gx * spacing;
  const fy = y - gy * spacing;

  const topLeft = offsets[gy * cols + gx]!;
  const topRight = offsets[gy * cols + gx + 1]!;
  const bottomLeft = offsets[(gy + 1) * cols + gx]!;
  const bottomRight = offsets[(gy + 1) * cols + gx + 1]!;

  const top = topLeft * (spacing - fx) + topRight * fx;
  const bottom = bottomLeft * (spacing - fx) + bottomRight * fx;
  return Math.floor((top * (spacing - fy) + bottom * fy) / (spacing * spacing));
}

function clampHeight(h: number): number {
  return h > MAX_HEIGHT ? MAX_HEIGHT : h < MIN_HEIGHT ? MIN_HEIGHT : h;
}

function clampNoiseBand(bands: number): number {
  if (bands > GENESIS_NOISE_MAX_BAND_OFFSET) return GENESIS_NOISE_MAX_BAND_OFFSET;
  if (bands < GENESIS_NOISE_MIN_BAND_OFFSET) return GENESIS_NOISE_MIN_BAND_OFFSET;
  return bands;
}

function buildGenesisNoiseWorld(): Heightmap {
  const map = createHeightmap(GOLDEN_WORLD_SIZE);
  const { baselineBandOffset, octaves } = buildNoiseOctaves(
    GOLDEN_WORLD_SIZE,
    createSeededRng(GENESIS_FIXTURE_SEED).next,
  );
  for (let y = 0; y < GOLDEN_WORLD_SIZE; y++) {
    for (let x = 0; x < GOLDEN_WORLD_SIZE; x++) {
      let wanderFixed = 0;
      for (const octave of octaves) wanderFixed += octaveBandAt(octave, x, y);
      const bands = clampNoiseBand(
        baselineBandOffset + Math.floor(wanderFixed / GENESIS_BAND_FIXED_POINT_ONE),
      );
      map.cells[cellIndex(map, x, y)] = clampHeight(bands * BAND_HEIGHT);
    }
  }
  return map;
}

// --- carved arch ------------------------------------------------------------
// Ported from server/src/world/arch-fixture.ts (read-only), stamped onto a
// shelf instead of genesis terrain.

const MOUND_RADIUS_X_CELLS = 30;
const MOUND_RADIUS_Z_CELLS = 14;
const MOUND_CREST_BANDS = 9;
const MOUND_SHOULDER_BANDS = 8;
const MOUND_RIM_BANDS = 7;
const MOUND_CREST_EDGE_SQUARED = 0.5 * 0.5;
const MOUND_SHOULDER_EDGE_SQUARED = 0.8 * 0.8;
const MOUND_BASE_BANDS_ABOVE_SEA = 1;
const TUNNEL_OPENING_BANDS = 5;
const TUNNEL_HALF_WIDTH_CELLS = 6;
const ARCH_TUNNEL_OFFSET_CELLS = -14;
const CAVE_TUNNEL_OFFSET_CELLS = 14;
const CAVE_DEPTH_FRACTION = 2 / 3;

const ARCH_SHELF_BANDS_BELOW_SEA = 2;

function moundBandsAt(dx: number, dz: number): number {
  const nx = dx / MOUND_RADIUS_X_CELLS;
  const nz = dz / MOUND_RADIUS_Z_CELLS;
  const rSquared = nx * nx + nz * nz;
  if (rSquared > 1) return 0;
  if (rSquared <= MOUND_CREST_EDGE_SQUARED) return MOUND_CREST_BANDS;
  if (rSquared <= MOUND_SHOULDER_EDGE_SQUARED) return MOUND_SHOULDER_BANDS;
  return MOUND_RIM_BANDS;
}

function insideTunnel(dx: number, dz: number): boolean {
  if (Math.abs(dx - ARCH_TUNNEL_OFFSET_CELLS) <= TUNNEL_HALF_WIDTH_CELLS) return true;
  if (Math.abs(dx - CAVE_TUNNEL_OFFSET_CELLS) > TUNNEL_HALF_WIDTH_CELLS) return false;
  const caveEnd = -MOUND_RADIUS_Z_CELLS + 2 * MOUND_RADIUS_Z_CELLS * CAVE_DEPTH_FRACTION;
  return dz <= caveEnd;
}

function buildArchWorld(): Heightmap {
  const map = createHeightmap(GOLDEN_WORLD_SIZE);
  map.cells.fill(SEA_LEVEL - ARCH_SHELF_BANDS_BELOW_SEA * BAND_HEIGHT);

  const centre = Math.floor(GOLDEN_WORLD_SIZE / 2);
  const base = quantizeToBand(SEA_LEVEL + MOUND_BASE_BANDS_ABOVE_SEA * BAND_HEIGHT);

  for (let dz = -MOUND_RADIUS_Z_CELLS; dz <= MOUND_RADIUS_Z_CELLS; dz++) {
    for (let dx = -MOUND_RADIUS_X_CELLS; dx <= MOUND_RADIUS_X_CELLS; dx++) {
      const bands = moundBandsAt(dx, dz);
      if (bands === 0) continue;
      const x = centre + dx;
      const z = centre + dz;
      if (x < 0 || z < 0 || x >= map.size || z >= map.size) continue;

      const moundTop = base + bands * BAND_HEIGHT;
      const roofFloor = base + TUNNEL_OPENING_BANDS * BAND_HEIGHT;
      if (insideTunnel(dx, dz) && roofFloor < moundTop) {
        setSpans(map, x, z, [
          packedSpanPair(BEDROCK_FLOOR, base),
          packedSpanPair(roofFloor, moundTop),
        ]);
      } else {
        map.cells[cellIndex(map, x, z)] = moundTop;
      }
    }
  }
  return map;
}

// --- stacked terrace --------------------------------------------------------

const TERRACE_FLOOR_CELLS = 4;
const TERRACE_CEILING_CELLS = 4;
const TERRACE_CELLS_PER_STEP = 2;
const TERRACE_SLAB_LIFT_BANDS = 3;
const TERRACE_SLAB_Y_START = 20;
const TERRACE_SLAB_Y_END = 44;
const TERRACE_SLAB_X_START = 12;
const TERRACE_SLAB_X_END = 40;
const TERRACE_SLAB_X_STEP = 4;

/** A staircase between a MIN_HEIGHT trench and a MAX_HEIGHT plateau, with a stacked slab band. */
function buildTerraceWorld(): Heightmap {
  const map = createHeightmap(GOLDEN_WORLD_SIZE);
  const lastStair = GOLDEN_WORLD_SIZE - TERRACE_CEILING_CELLS;
  for (let y = 0; y < GOLDEN_WORLD_SIZE; y++) {
    for (let x = 0; x < GOLDEN_WORLD_SIZE; x++) {
      let height: number;
      if (x < TERRACE_FLOOR_CELLS) height = MIN_HEIGHT;
      else if (x >= lastStair) height = MAX_HEIGHT;
      else {
        const step = Math.floor((x - TERRACE_FLOOR_CELLS) / TERRACE_CELLS_PER_STEP);
        height = step * BAND_HEIGHT;
      }
      map.cells[cellIndex(map, x, y)] = height;
    }
  }

  for (let y = TERRACE_SLAB_Y_START; y < TERRACE_SLAB_Y_END; y++) {
    for (let x = TERRACE_SLAB_X_START; x < TERRACE_SLAB_X_END; x += TERRACE_SLAB_X_STEP) {
      const ground = map.cells[cellIndex(map, x, y)]!;
      const slabCeiling = ground + TERRACE_SLAB_LIFT_BANDS * BAND_HEIGHT;
      setSpans(map, x, y, [
        packedSpanPair(BEDROCK_FLOOR, ground),
        packedSpanPair(slabCeiling - BAND_HEIGHT + 1, slabCeiling),
      ]);
    }
  }
  return map;
}

// --- shoreline --------------------------------------------------------------

const SHORELINE_WATERLINE_CELL = 20;
const SHORELINE_RISE_PER_CELL = BAND_HEIGHT / 4;
const SHORELINE_DEEP_CELLS = 6;
const SHORELINE_DEEP_BANDS_BELOW_SEA = 12;
const SHORELINE_RIPPLE_PERIOD = 23;
const SHORELINE_RIPPLE_STRIDE = 7;
const SHORELINE_RIPPLE_BIAS = 11;

/** A ramp crossing the waterline, so the shore band and band -1 both appear. */
function buildShorelineWorld(): Heightmap {
  const map = createHeightmap(GOLDEN_WORLD_SIZE);
  for (let y = 0; y < GOLDEN_WORLD_SIZE; y++) {
    for (let x = 0; x < GOLDEN_WORLD_SIZE; x++) {
      const ripple = ((y * SHORELINE_RIPPLE_STRIDE) % SHORELINE_RIPPLE_PERIOD) - SHORELINE_RIPPLE_BIAS;
      const height =
        x < SHORELINE_DEEP_CELLS
          ? SEA_LEVEL - SHORELINE_DEEP_BANDS_BELOW_SEA * BAND_HEIGHT
          : (x - SHORELINE_WATERLINE_CELL) * SHORELINE_RISE_PER_CELL + ripple;
      map.cells[cellIndex(map, x, y)] = clampHeight(height);
    }
  }
  map.cells[cellIndex(map, SHORELINE_WATERLINE_CELL, 0)] = DRAWN_SHORE_HEIGHT;
  return map;
}

// --- played-world excerpt ---------------------------------------------------

function buildPlayedWorld(): Heightmap {
  const map = createHeightmap(PLAYED_WORLD_SIZE);
  map.cells.set(PLAYED_WORLD_CELLS);
  for (const [key, flat] of Object.entries(PLAYED_WORLD_COLUMN_SPANS)) {
    const index = Number(key);
    const x = index % PLAYED_WORLD_SIZE;
    const y = (index - x) / PLAYED_WORLD_SIZE;
    if (!applyPackedSpans(map, x, y, flat)) {
      throw new Error(`played-world excerpt cell ${index} does not parse as a column`);
    }
  }
  return map;
}

const BUILDERS: Readonly<Record<GoldenWorldName, () => Heightmap>> = {
  'genesis-noise': buildGenesisNoiseWorld,
  arch: buildArchWorld,
  terrace: buildTerraceWorld,
  shoreline: buildShorelineWorld,
  played: buildPlayedWorld,
};

export function buildGoldenWorld(name: GoldenWorldName): Heightmap {
  return BUILDERS[name]();
}

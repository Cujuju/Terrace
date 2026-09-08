import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  NEIGHBOURHOOD_CELLS,
  SEA_LEVEL,
  WORLD_UNIT_CELLS,
  cellsOverArea,
  createSeededRng,
  type Heightmap,
} from '@terrace/shared';
import { initialUnlockFootprint } from './initial-unlock.ts';

export const FRESH_SEABED_DEPTH_BELOW_SEA = 192;
export const FRESH_SEABED_BANDS_BELOW_SEA = FRESH_SEABED_DEPTH_BELOW_SEA / BAND_HEIGHT;

export const FRESH_SHELF_DEPTH_BELOW_SEA = FRESH_SEABED_DEPTH_BELOW_SEA / 3;
export const FRESH_SHELF_BANDS_BELOW_SEA = FRESH_SHELF_DEPTH_BELOW_SEA / BAND_HEIGHT;

function heightAtBandsBelowSea(bands: number): number {
  return SEA_LEVEL - bands * BAND_HEIGHT;
}

export const FRESH_SEABED_HEIGHT = heightAtBandsBelowSea(FRESH_SEABED_BANDS_BELOW_SEA);

export const FRESH_SHELF_HEIGHT = heightAtBandsBelowSea(FRESH_SHELF_BANDS_BELOW_SEA);

const GENESIS_TERRACE_WALL_CELLS_PER_BAND = BAND_HEIGHT / MAX_STEP;

function clampHeight(h: number): number {
  return h > MAX_HEIGHT ? MAX_HEIGHT : h < MIN_HEIGHT ? MIN_HEIGHT : h;
}

export function drawGenesisSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

function mulberry32Rng(seed: number): () => number {
  return createSeededRng(seed).next;
}

function genesisMix(a: number, b: number): number {
  let mixed = (Math.imul(a + 1, 0x27d4_eb2d) ^ Math.imul(b + 1, 0x9e37_79b9)) >>> 0;
  mixed = (mixed ^ (mixed >>> 15)) >>> 0;
  return Math.imul(mixed, 0x85eb_ca6b) >>> 0;
}

const GENESIS_COARSEST_LATTICE_SPACING_CELLS = NEIGHBOURHOOD_CELLS * 4;

const GENESIS_NOISE_OCTAVES: readonly {
  readonly spacingCells: number;
  readonly amplitudeDivisor: number;
}[] = [
  { spacingCells: GENESIS_COARSEST_LATTICE_SPACING_CELLS, amplitudeDivisor: 1 },
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

const GENESIS_MIN_ROUGHNESS =
  FRESH_SEABED_BANDS_BELOW_SEA /
  ((GENESIS_NOISE_MAX_BAND_OFFSET - GENESIS_NOISE_MIN_BAND_OFFSET) / 2);

const GENESIS_BASELINE_CEILING_DIVISOR = 4;
const GENESIS_BASELINE_MIN_BAND_OFFSET = -FRESH_SEABED_BANDS_BELOW_SEA;
const GENESIS_BASELINE_MAX_BAND_OFFSET =
  GENESIS_NOISE_MAX_BAND_OFFSET / GENESIS_BASELINE_CEILING_DIVISOR;

const GENESIS_BAND_FIXED_POINT_ONE = 256;

interface GenesisNoiseOctave {
  readonly spacingCells: number;
  readonly bandOffsets: Int32Array;
  readonly cols: number;
}

export interface GenesisNoiseField {
  readonly baselineBandOffset: number;
  readonly landLiftBands: number;
  readonly octaves: readonly GenesisNoiseOctave[];
}

function buildGenesisNoiseField(size: number, rng: () => number): GenesisNoiseField {
  const halfSpan = (GENESIS_NOISE_MAX_BAND_OFFSET - GENESIS_NOISE_MIN_BAND_OFFSET) / 2;
  const baselineSpan = GENESIS_BASELINE_MAX_BAND_OFFSET - GENESIS_BASELINE_MIN_BAND_OFFSET;
  const baselineBandOffset = Math.round(
    GENESIS_BASELINE_MIN_BAND_OFFSET + rng() * baselineSpan,
  );
  const roughness =
    GENESIS_MIN_ROUGHNESS +
    (1 - GENESIS_MIN_ROUGHNESS) * Math.pow(rng(), GENESIS_ROUGHNESS_SKEW_EXPONENT);

  const octaves = GENESIS_NOISE_OCTAVES.map(({ spacingCells, amplitudeDivisor }) => {
    const amplitude = (halfSpan * roughness) / amplitudeDivisor;
    const cols = Math.floor((size - 1) / spacingCells) + 2;
    const bandOffsets = new Int32Array(cols * cols);
    for (let j = 0; j < cols; j++) {
      const row = j * cols;
      for (let i = 0; i < cols; i++) {
        bandOffsets[row + i] = Math.round(
          (rng() * 2 - 1) * amplitude * GENESIS_BAND_FIXED_POINT_ONE,
        );
      }
    }
    return { spacingCells, bandOffsets, cols };
  });

  return { baselineBandOffset, landLiftBands: 0, octaves };
}

function octaveBandAt(octave: GenesisNoiseOctave, x: number, y: number): number {
  const spacing = octave.spacingCells;
  const cols = octave.cols;
  const offsets = octave.bandOffsets;

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

function genesisNoiseRawBandAt(field: GenesisNoiseField, x: number, y: number): number {
  let wanderFixed = 0;
  for (const octave of field.octaves) wanderFixed += octaveBandAt(octave, x, y);
  return (
    field.baselineBandOffset +
    field.landLiftBands +
    Math.floor(wanderFixed / GENESIS_BAND_FIXED_POINT_ONE)
  );
}

function genesisNoiseBandAt(field: GenesisNoiseField, x: number, y: number): number {
  return clampNoiseBand(genesisNoiseRawBandAt(field, x, y));
}

function clampNoiseBand(bands: number): number {
  if (bands > GENESIS_NOISE_MAX_BAND_OFFSET) return GENESIS_NOISE_MAX_BAND_OFFSET;
  if (bands < GENESIS_NOISE_MIN_BAND_OFFSET) return GENESIS_NOISE_MIN_BAND_OFFSET;
  return bands;
}

export const GENESIS_MIN_STARTER_ISLANDS = 2;

export const GENESIS_MIN_ISLAND_CELLS = (NEIGHBOURHOOD_CELLS / 2) * (NEIGHBOURHOOD_CELLS / 2);

export const GENESIS_MIN_STARTER_LAND_CELLS =
  GENESIS_MIN_STARTER_ISLANDS * GENESIS_MIN_ISLAND_CELLS;

const GENESIS_ISLAND_PEAK_BANDS =
  Math.ceil(
    Math.sqrt(GENESIS_MIN_ISLAND_CELLS / Math.PI) / GENESIS_TERRACE_WALL_CELLS_PER_BAND,
  ) + 1;

const GENESIS_ISLAND_PLATEAU_RADIUS_CELLS = 2 * WORLD_UNIT_CELLS;

const GENESIS_ISLAND_MAX_LIFT_BANDS =
  GENESIS_ISLAND_PEAK_BANDS - GENESIS_NOISE_MIN_BAND_OFFSET;

const GENESIS_ISLAND_REACH_CELLS =
  GENESIS_ISLAND_PLATEAU_RADIUS_CELLS +
  GENESIS_ISLAND_MAX_LIFT_BANDS * GENESIS_TERRACE_WALL_CELLS_PER_BAND;

export const GENESIS_ISLAND_MIN_LAND_CELLS =
  3 * (GENESIS_ISLAND_PEAK_BANDS * GENESIS_TERRACE_WALL_CELLS_PER_BAND) ** 2;

const GENESIS_ISLAND_SLOTS_PER_AXIS = 3;

export interface GenesisIsland {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly liftBands: number;
}

function islandLiftBandsAt(
  islands: readonly GenesisIsland[],
  x: number,
  y: number,
): number {
  let lift = 0;
  for (const island of islands) {
    const dx = x - island.anchorX;
    const dy = y - island.anchorY;
    if (dx > GENESIS_ISLAND_REACH_CELLS || dx < -GENESIS_ISLAND_REACH_CELLS) continue;
    if (dy > GENESIS_ISLAND_REACH_CELLS || dy < -GENESIS_ISLAND_REACH_CELLS) continue;

    const radius = Math.floor(Math.sqrt(dx * dx + dy * dy));
    const beyondPlateau = radius - GENESIS_ISLAND_PLATEAU_RADIUS_CELLS;
    const bands =
      island.liftBands -
      (beyondPlateau > 0 ? Math.floor(beyondPlateau / GENESIS_TERRACE_WALL_CELLS_PER_BAND) : 0);
    if (bands > lift) lift = bands;
  }
  return lift;
}

interface GenesisLandmass {
  readonly cells: number;
  readonly indices: number[];
}

function surveyStarterLandmasses(
  terrain: FreshGenesisTerrain,
  heights: Int16Array,
): GenesisLandmass[] {
  const { size, unlockMinCell: lo, unlockMaxCell: hi } = terrain;
  const span = hi - lo + 1;
  const visited = new Uint8Array(span * span);
  const landmasses: GenesisLandmass[] = [];
  const stack: number[] = [];

  const isLandAt = (local: number): boolean => {
    const ly = (local / span) | 0;
    const lx = local - ly * span;
    return heights[(lo + ly) * size + lo + lx]! > SEA_LEVEL;
  };

  for (let start = 0; start < visited.length; start++) {
    if (visited[start] === 1 || !isLandAt(start)) continue;

    const indices: number[] = [];
    visited[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const local = stack.pop()!;
      const ly = (local / span) | 0;
      const lx = local - ly * span;
      indices.push((lo + ly) * size + lo + lx);

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = lx + ox;
          const ny = ly + oy;
          if (nx < 0 || ny < 0 || nx >= span || ny >= span) continue;
          const neighbour = ny * span + nx;
          if (visited[neighbour] === 1 || !isLandAt(neighbour)) continue;
          visited[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
    landmasses.push({ cells: indices.length, indices });
  }

  return landmasses;
}

function genesisIslandSites(terrain: FreshGenesisTerrain, seed: number): GenesisIsland[] {
  const span = terrain.unlockMaxCell - terrain.unlockMinCell + 1;
  const inset = Math.min(
    GENESIS_ISLAND_PEAK_BANDS * GENESIS_TERRACE_WALL_CELLS_PER_BAND,
    Math.floor((span - 1) / 2),
  );
  const usable = span - 2 * inset;
  const pitch = Math.max(1, Math.floor(usable / GENESIS_ISLAND_SLOTS_PER_AXIS));

  const sites: { island: GenesisIsland; index: number; score: number }[] = [];
  for (let sy = 0; sy < GENESIS_ISLAND_SLOTS_PER_AXIS; sy++) {
    for (let sx = 0; sx < GENESIS_ISLAND_SLOTS_PER_AXIS; sx++) {
      const index = sy * GENESIS_ISLAND_SLOTS_PER_AXIS + sx;
      const anchorX = terrain.unlockMinCell + inset + sx * pitch + (pitch >> 1);
      const anchorY = terrain.unlockMinCell + inset + sy * pitch + (pitch >> 1);
      const ground = genesisNoiseBandAt(terrain.noise, anchorX, anchorY);
      const liftBands = Math.min(
        GENESIS_ISLAND_MAX_LIFT_BANDS,
        Math.max(1, GENESIS_ISLAND_PEAK_BANDS - ground),
      );
      sites.push({
        island: { anchorX, anchorY, liftBands },
        index,
        score: genesisMix(index, seed),
      });
    }
  }

  sites.sort(
    (a, b) => a.island.liftBands - b.island.liftBands || a.score - b.score || a.index - b.index,
  );
  return sites.map((site) => site.island);
}

export const GENESIS_MIN_LAND_PERCENT = 8;

function genesisMinLandCells(size: number): number {
  return Math.ceil((size * size * GENESIS_MIN_LAND_PERCENT) / 100);
}

function genesisLandLiftBands(raw: Int16Array, size: number): number {
  const floorBand = GENESIS_NOISE_MIN_BAND_OFFSET + GENESIS_BASELINE_MIN_BAND_OFFSET;
  const ceilingBand = GENESIS_NOISE_MAX_BAND_OFFSET - GENESIS_BASELINE_MIN_BAND_OFFSET;
  const buckets = new Int32Array(ceilingBand - floorBand + 1);
  for (let index = 0; index < raw.length; index++) {
    let bands = raw[index]!;
    if (bands < floorBand) bands = floorBand;
    else if (bands > ceilingBand) bands = ceilingBand;
    buckets[bands - floorBand] += 1;
  }

  const wanted = genesisMinLandCells(size);
  const maxLift = -floorBand;
  let land = 0;
  let lift = maxLift;
  for (let bands = ceilingBand; bands > floorBand; bands--) {
    land += buckets[bands - floorBand]!;
    if (land >= wanted) {
      lift = 1 - bands;
      break;
    }
  }
  if (lift < 0) lift = 0;

  return lift;
}

export const GENESIS_TRENCH_MIN_BASIN_CHUNKS = 9;

export const GENESIS_TRENCH_MIN_BASIN_CELLS =
  GENESIS_TRENCH_MIN_BASIN_CHUNKS * NEIGHBOURHOOD_CELLS * NEIGHBOURHOOD_CELLS;

export const GENESIS_TRENCH_FLOOR_DEPTH_BELOW_SEA = 512;
export const GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA =
  GENESIS_TRENCH_FLOOR_DEPTH_BELOW_SEA / BAND_HEIGHT;

export const GENESIS_TRENCH_QUALIFYING_BANDS_BELOW_SEA = Math.floor(
  (GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA * BAND_HEIGHT - MAX_STEP / 2) / BAND_HEIGHT,
);

export const GENESIS_TRENCH_QUALIFYING_HEIGHT = heightAtBandsBelowSea(
  GENESIS_TRENCH_QUALIFYING_BANDS_BELOW_SEA,
);

const GENESIS_TRENCH_HALF_LENGTH_CELLS = Math.round(
  Math.sqrt(GENESIS_TRENCH_MIN_BASIN_CELLS) / 2,
);

const GENESIS_TRENCH_SEGMENTS = 3;

const GENESIS_TRENCH_SEGMENT_CELLS =
  (2 * GENESIS_TRENCH_HALF_LENGTH_CELLS) / GENESIS_TRENCH_SEGMENTS;

const GENESIS_TRENCH_REACH_CELLS =
  GENESIS_TRENCH_HALF_LENGTH_CELLS +
  GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA * GENESIS_TERRACE_WALL_CELLS_PER_BAND;

export const GENESIS_EXTRA_TRENCH_MIN = 1;
export const GENESIS_EXTRA_TRENCH_MAX = 3;

const GENESIS_BASIN_SITE_SALT = 0x21;
const GENESIS_TRENCH_COUNT_SALT = 0x01;
const GENESIS_TRENCH_BASIN_SALT = 0x100;
const GENESIS_TRENCH_AXIS_SALT = 0x200;
const GENESIS_TRENCH_ANCHOR_SALT = 0x300;
const GENESIS_TRENCH_BEND_SALT = 0x400;

const GENESIS_GUARANTEE_TRENCH_ORDINAL = 0;

const GENESIS_TRENCH_AXES: readonly (readonly [number, number])[] = [
  [1, 0],
  [2, 1],
  [1, 1],
  [1, 2],
  [0, 1],
  [-1, 2],
  [-1, 1],
  [-2, 1],
];

export interface GenesisTrenchSegment {
  readonly axisIndex: number;
  readonly axisX: number;
  readonly axisY: number;
  readonly axisLengthSquared: number;
  readonly lengthScaled: number;
}

export interface GenesisTrench {
  readonly vertices: readonly { readonly x: number; readonly y: number }[];
  readonly segments: readonly GenesisTrenchSegment[];
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

interface GenesisOceanRegion {
  cells: number;
  extremeHeight: number;
  extremeScore: number;
  extremeIndex: number;
  anchorScores: Int32Array;
  anchorsBySalt: Int32Array;
}

function surveyGenesisOceanRegions(
  heights: Int16Array,
  size: number,
  seed: number,
): GenesisOceanRegion[] {
  const cellCount = size * size;
  const visited = new Uint8Array(cellCount);
  const regions: GenesisOceanRegion[] = [];
  const stack: number[] = [];

  for (let seedIndex = 0; seedIndex < cellCount; seedIndex++) {
    if (visited[seedIndex] === 1 || heights[seedIndex]! > FRESH_SEABED_HEIGHT) continue;

    const region: GenesisOceanRegion = {
      cells: 0,
      extremeHeight: Number.POSITIVE_INFINITY,
      extremeScore: Number.POSITIVE_INFINITY,
      extremeIndex: seedIndex,
      anchorScores: new Int32Array(GENESIS_EXTRA_TRENCH_MAX).fill(-1),
      anchorsBySalt: new Int32Array(GENESIS_EXTRA_TRENCH_MAX).fill(seedIndex),
    };
    visited[seedIndex] = 1;
    stack.push(seedIndex);

    while (stack.length > 0) {
      const index = stack.pop()!;
      const height = heights[index]!;
      region.cells++;

      const score = genesisMix(index, seed);
      if (
        height < region.extremeHeight ||
        (height === region.extremeHeight &&
          (score < region.extremeScore ||
            (score === region.extremeScore && index < region.extremeIndex)))
      ) {
        region.extremeHeight = height;
        region.extremeScore = score;
        region.extremeIndex = index;
      }

      for (let salt = 0; salt < GENESIS_EXTRA_TRENCH_MAX; salt++) {
        const salted = genesisMix(index, seed + GENESIS_TRENCH_ANCHOR_SALT + salt) >>> 1;
        const best = region.anchorScores[salt]!;
        if (
          best < 0 ||
          salted < best ||
          (salted === best && index < region.anchorsBySalt[salt]!)
        ) {
          region.anchorScores[salt] = salted;
          region.anchorsBySalt[salt] = index;
        }
      }

      const x = index % size;
      const y = (index - x) / size;
      if (x > 0) pushOceanNeighbour(heights, visited, stack, index - 1);
      if (x + 1 < size) pushOceanNeighbour(heights, visited, stack, index + 1);
      if (y > 0) pushOceanNeighbour(heights, visited, stack, index - size);
      if (y + 1 < size) pushOceanNeighbour(heights, visited, stack, index + size);
    }

    regions.push(region);
  }

  return regions;
}

function pushOceanNeighbour(
  heights: Int16Array,
  visited: Uint8Array,
  stack: number[],
  index: number,
): void {
  if (visited[index] === 1 || heights[index]! > FRESH_SEABED_HEIGHT) return;
  visited[index] = 1;
  stack.push(index);
}

function trenchAt(
  index: number,
  size: number,
  axisIndex: number,
  seed: number,
  trenchOrdinal: number,
): GenesisTrench {
  const anchorX = index % size;
  const anchorY = (index - anchorX) / size;

  const vertices: { x: number; y: number }[] = [{ x: anchorX, y: anchorY }];
  const segments: GenesisTrenchSegment[] = [];
  let nextAxisIndex = axisIndex;

  for (let i = 0; i < GENESIS_TRENCH_SEGMENTS; i++) {
    const [axisX, axisY] = GENESIS_TRENCH_AXES[nextAxisIndex]!;
    const axisLengthSquared = axisX * axisX + axisY * axisY;
    const steps = Math.floor(
      GENESIS_TRENCH_SEGMENT_CELLS / Math.sqrt(axisLengthSquared),
    );
    segments.push({
      axisIndex: nextAxisIndex,
      axisX,
      axisY,
      axisLengthSquared,
      lengthScaled: steps * axisLengthSquared,
    });

    const from = vertices[i]!;
    vertices.push({ x: from.x + axisX * steps, y: from.y + axisY * steps });

    const turn =
      genesisMix(seed, GENESIS_TRENCH_BEND_SALT + trenchOrdinal * GENESIS_TRENCH_SEGMENTS + i) & 1
        ? 1
        : -1;
    nextAxisIndex =
      (nextAxisIndex + turn + GENESIS_TRENCH_AXES.length) % GENESIS_TRENCH_AXES.length;
  }

  let minX = vertices[0]!.x;
  let maxX = minX;
  let minY = vertices[0]!.y;
  let maxY = minY;
  for (const vertex of vertices) {
    if (vertex.x < minX) minX = vertex.x;
    if (vertex.x > maxX) maxX = vertex.x;
    if (vertex.y < minY) minY = vertex.y;
    if (vertex.y > maxY) maxY = vertex.y;
  }

  return {
    vertices,
    segments,
    minX: minX - GENESIS_TRENCH_REACH_CELLS,
    maxX: maxX + GENESIS_TRENCH_REACH_CELLS,
    minY: minY - GENESIS_TRENCH_REACH_CELLS,
    maxY: maxY + GENESIS_TRENCH_REACH_CELLS,
  };
}

function planGenesisTrenches(
  heights: Int16Array,
  size: number,
  seed: number,
): GenesisTrench[] {
  const regions = surveyGenesisOceanRegions(heights, size, seed);

  let deepestLairSized: GenesisOceanRegion | null = null;
  let largest: GenesisOceanRegion | null = null;
  let alreadyQualifies = false;

  for (const region of regions) {
    if (
      largest === null ||
      region.cells > largest.cells ||
      (region.cells === largest.cells && region.extremeIndex < largest.extremeIndex)
    ) {
      largest = region;
    }

    if (region.cells < GENESIS_TRENCH_MIN_BASIN_CELLS) continue;
    if (region.extremeHeight <= GENESIS_TRENCH_QUALIFYING_HEIGHT) {
      alreadyQualifies = true;
      continue;
    }

    if (
      deepestLairSized === null ||
      region.extremeHeight < deepestLairSized.extremeHeight ||
      (region.extremeHeight === deepestLairSized.extremeHeight &&
        (region.cells > deepestLairSized.cells ||
          (region.cells === deepestLairSized.cells &&
            region.extremeIndex < deepestLairSized.extremeIndex)))
    ) {
      deepestLairSized = region;
    }
  }

  const trenches: GenesisTrench[] = [];
  if (!alreadyQualifies) {
    const chosen = deepestLairSized ?? largest;
    if (chosen !== null) {
      trenches.push(
        trenchAt(
          chosen.extremeIndex,
          size,
          genesisMix(seed, GENESIS_TRENCH_AXIS_SALT) % GENESIS_TRENCH_AXES.length,
          seed,
          GENESIS_GUARANTEE_TRENCH_ORDINAL,
        ),
      );
    }
  }

  if (regions.length > 0) {
    const candidates = regions
      .filter((region) => region.cells >= GENESIS_TRENCH_MIN_BASIN_CELLS)
      .sort((a, b) => b.cells - a.cells || a.extremeIndex - b.extremeIndex);
    const pool = candidates.length > 0 ? candidates : regions;

    const extras =
      GENESIS_EXTRA_TRENCH_MIN +
      (genesisMix(seed, GENESIS_TRENCH_COUNT_SALT) %
        (GENESIS_EXTRA_TRENCH_MAX - GENESIS_EXTRA_TRENCH_MIN + 1));

    for (let k = 0; k < extras; k++) {
      const region = pool[genesisMix(seed, GENESIS_TRENCH_BASIN_SALT + k) % pool.length]!;
      trenches.push(
        trenchAt(
          region.anchorsBySalt[k]!,
          size,
          genesisMix(seed, GENESIS_TRENCH_AXIS_SALT + 1 + k) % GENESIS_TRENCH_AXES.length,
          seed,
          GENESIS_GUARANTEE_TRENCH_ORDINAL + 1 + k,
        ),
      );
    }
  }

  return trenches;
}

function deepenedByTrenches(
  trenches: readonly GenesisTrench[],
  x: number,
  y: number,
  base: number,
): number {
  if (base > FRESH_SEABED_HEIGHT) return base;

  let height = base;
  for (const trench of trenches) {
    if (x < trench.minX || x > trench.maxX || y < trench.minY || y > trench.maxY) continue;

    let distance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < trench.segments.length; i++) {
      const segment = trench.segments[i]!;
      const start = trench.vertices[i]!;
      const dx = x - start.x;
      const dy = y - start.y;

      const along = dx * segment.axisX + dy * segment.axisY;
      const overhang =
        along < 0 ? -along : along > segment.lengthScaled ? along - segment.lengthScaled : 0;
      const across = dx * segment.axisY - dy * segment.axisX;
      const toSegment = Math.floor(
        Math.sqrt((overhang * overhang + across * across) / segment.axisLengthSquared),
      );
      if (toSegment < distance) distance = toSegment;
    }

    const bands =
      GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA -
      Math.floor(distance / GENESIS_TERRACE_WALL_CELLS_PER_BAND);
    if (bands <= 0) continue;

    const floor = clampHeight(heightAtBandsBelowSea(bands));
    if (floor < height) height = floor;
  }
  return height;
}

const GENESIS_BASIN_RADIUS_CELLS =
  Math.ceil(Math.sqrt(GENESIS_TRENCH_MIN_BASIN_CELLS / Math.PI)) +
  GENESIS_TERRACE_WALL_CELLS_PER_BAND;
const GENESIS_BASIN_DROP_BANDS =
  Math.ceil(GENESIS_BASIN_RADIUS_CELLS / GENESIS_TERRACE_WALL_CELLS_PER_BAND) +
  FRESH_SEABED_BANDS_BELOW_SEA +
  GENESIS_NOISE_MAX_BAND_OFFSET;

const GENESIS_BASIN_REACH_CELLS =
  GENESIS_BASIN_DROP_BANDS * GENESIS_TERRACE_WALL_CELLS_PER_BAND;

export interface GenesisBasin {
  readonly anchorX: number;
  readonly anchorY: number;
}

function basinDropBandsAt(
  basins: readonly GenesisBasin[],
  x: number,
  y: number,
): number {
  let drop = 0;
  for (const basin of basins) {
    const dx = x - basin.anchorX;
    const dy = y - basin.anchorY;
    if (dx > GENESIS_BASIN_REACH_CELLS || dx < -GENESIS_BASIN_REACH_CELLS) continue;
    if (dy > GENESIS_BASIN_REACH_CELLS || dy < -GENESIS_BASIN_REACH_CELLS) continue;

    const radius = Math.floor(Math.sqrt(dx * dx + dy * dy));
    const bands =
      GENESIS_BASIN_DROP_BANDS - Math.floor(radius / GENESIS_TERRACE_WALL_CELLS_PER_BAND);
    if (bands > drop) drop = bands;
  }
  return drop;
}

function hasLairSizedOcean(heights: Int16Array, size: number): boolean {
  const visited = new Uint8Array(heights.length);
  const stack: number[] = [];
  for (let start = 0; start < heights.length; start++) {
    if (visited[start] === 1 || heights[start]! > FRESH_SEABED_HEIGHT) continue;
    let cells = 0;
    visited[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop()!;
      cells++;
      const x = index % size;
      const y = (index - x) / size;
      if (x > 0) pushOceanNeighbour(heights, visited, stack, index - 1);
      if (x + 1 < size) pushOceanNeighbour(heights, visited, stack, index + 1);
      if (y > 0) pushOceanNeighbour(heights, visited, stack, index - size);
      if (y + 1 < size) pushOceanNeighbour(heights, visited, stack, index + size);
    }
    if (cells >= GENESIS_TRENCH_MIN_BASIN_CELLS) return true;
  }
  return false;
}

function genesisBasinSite(heights: Int16Array, size: number, seed: number): GenesisBasin {
  let bestIndex = 0;
  let bestHeight = Number.POSITIVE_INFINITY;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < heights.length; index++) {
    const height = heights[index]!;
    if (height > bestHeight) continue;
    const score = genesisMix(index, seed + GENESIS_BASIN_SITE_SALT);
    if (height < bestHeight || score < bestScore) {
      bestHeight = height;
      bestScore = score;
      bestIndex = index;
    }
  }
  const x = bestIndex % size;
  const y = (bestIndex - x) / size;
  return {
    anchorX: keepBasinInside(x, size),
    anchorY: keepBasinInside(y, size),
  };
}

function keepBasinInside(coordinate: number, size: number): number {
  if (size <= 2 * GENESIS_BASIN_RADIUS_CELLS) return size >> 1;
  if (coordinate < GENESIS_BASIN_RADIUS_CELLS) return GENESIS_BASIN_RADIUS_CELLS;
  const highest = size - 1 - GENESIS_BASIN_RADIUS_CELLS;
  return coordinate > highest ? highest : coordinate;
}

export interface FreshGenesisTerrain {
  readonly size: number;
  readonly unlockMinCell: number;
  readonly unlockMaxCell: number;
  readonly noise: GenesisNoiseField;
  readonly basins: readonly GenesisBasin[];
  readonly islands: readonly GenesisIsland[];
  readonly trenches: readonly GenesisTrench[];
}

export function freshGenesisHeightAt(
  terrain: FreshGenesisTerrain,
  x: number,
  y: number,
): number {
  const bands =
    clampNoiseBand(genesisNoiseRawBandAt(terrain.noise, x, y)) +
    islandLiftBandsAt(terrain.islands, x, y) -
    basinDropBandsAt(terrain.basins, x, y);
  return deepenedByTrenches(terrain.trenches, x, y, clampHeight(bands * BAND_HEIGHT));
}

function renderStarterNeighbourhood(terrain: FreshGenesisTerrain, into: Int16Array): void {
  const { size } = terrain;
  const lo = Math.max(0, terrain.unlockMinCell - GENESIS_ISLAND_REACH_CELLS);
  const hi = Math.min(size - 1, terrain.unlockMaxCell + GENESIS_ISLAND_REACH_CELLS);
  for (let y = lo; y <= hi; y++) {
    const row = y * size;
    for (let x = lo; x <= hi; x++) into[row + x] = freshGenesisHeightAt(terrain, x, y);
  }
}

export function buildFreshGenesisTerrain(size: number, seed: number): FreshGenesisTerrain {
  const { startChunk, spanChunks } = initialUnlockFootprint(size);
  const unlockMinCell = startChunk * CHUNK_SIZE;
  const rng = mulberry32Rng(seed);
  const drawn = buildGenesisNoiseField(size, rng);

  const raw = new Int16Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) raw[row + x] = genesisNoiseRawBandAt(drawn, x, y);
  }

  let landLiftBands = genesisLandLiftBands(raw, size);
  let basins: readonly GenesisBasin[] = [];
  let heights = renderNoiseAndBasins(raw, size, landLiftBands, basins);

  if (!hasLairSizedOcean(heights, size)) {
    basins = [genesisBasinSite(heights, size, seed)];
    heights = renderNoiseAndBasins(raw, size, landLiftBands, basins);

    const wanted = genesisMinLandCells(size);
    for (
      let round = 0;
      round < GENESIS_LAND_TOPUP_ROUNDS && countLand(heights) < wanted;
      round++
    ) {
      landLiftBands++;
      heights = renderNoiseAndBasins(raw, size, landLiftBands, basins);
    }
  }

  const bare: FreshGenesisTerrain = {
    size,
    unlockMinCell,
    unlockMaxCell: unlockMinCell + spanChunks * CHUNK_SIZE - 1,
    noise: { ...drawn, landLiftBands },
    basins,
    islands: [],
    trenches: [],
  };

  let islands: readonly GenesisIsland[] = [];
  let used = 0;
  const sites = genesisIslandSites(bare, seed);
  let raised: FreshGenesisTerrain = bare;
  while (starterIslandLandCells(raised, heights) < GENESIS_MIN_STARTER_LAND_CELLS) {
    if (used >= sites.length) break;
    islands = [...islands, sites[used++]!];
    raised = { ...bare, islands };
    renderStarterNeighbourhood(raised, heights);
  }

  return { ...raised, trenches: planGenesisTrenches(heights, size, seed) };
}

const GENESIS_LAND_TOPUP_ROUNDS = 4;

function renderNoiseAndBasins(
  raw: Int16Array,
  size: number,
  landLiftBands: number,
  basins: readonly GenesisBasin[],
): Int16Array {
  const heights = new Int16Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    const x = index % size;
    const y = (index - x) / size;
    const bands =
      clampNoiseBand(raw[index]! + landLiftBands) - basinDropBandsAt(basins, x, y);
    heights[index] = clampHeight(bands * BAND_HEIGHT);
  }
  return heights;
}

function countLand(heights: Int16Array): number {
  let land = 0;
  for (const height of heights) if (height > SEA_LEVEL) land++;
  return land;
}

function starterIslandLandCells(terrain: FreshGenesisTerrain, heights: Int16Array): number {
  let cells = 0;
  for (const mass of surveyStarterLandmasses(terrain, heights)) {
    if (mass.cells >= GENESIS_MIN_ISLAND_CELLS) cells += mass.cells;
  }
  return cells;
}

export function carveFallbackAbyss(map: Heightmap, size: number): number {
  let lowestIndex = 0;
  let lowest = MAX_HEIGHT;
  for (let index = 0; index < size * size; index++) {
    const height = map.cells[index]!;
    if (height < lowest) {
      lowest = height;
      lowestIndex = index;
    }
  }
  map.cells[lowestIndex] = FRESH_SEABED_HEIGHT;
  return FRESH_SEABED_HEIGHT;
}

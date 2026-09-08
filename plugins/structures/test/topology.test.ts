import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL } from '@terrace/shared';
import { structureKey } from '../protocol.ts';
import {
  GenerationSurvey,
  WALL_PHANTOM_DENOMINATOR,
  WALL_PHANTOM_NUMERATOR,
  scaledNeighborCount,
  stepGeneration,
  type LiveCellRecord,
} from '../server/life.ts';
import {
  computeLandmassLabels,
  computeLandmassLabelsFromBuildable,
  wrappedNeighborIndex,
  type LandmassBox,
  type LandmassLabels,
} from '../server/topology.ts';
import { isBuildableCell, type StructuresWorld } from '../server/suitability.ts';
import { worldWithTerrain } from './support/world.ts';

const NO_SKIP = -1;

const ONE_CHUNK_BUDGET = 1;

const LAND_BAND = 4;
const LAND_HEIGHT = LAND_BAND * BAND_HEIGHT;
const SEA_HEIGHT = SEA_LEVEL - BAND_HEIGHT;

function view(size: number, heightOf: (x: number, y: number) => number): StructuresWorld {
  const w = worldWithTerrain(size, heightOf);
  return {
    worldSize: w.size,
    chunksPerEdge: w.chunksPerEdge,
    heightAt: (x, y) => w.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => w.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => w.isCellUnlocked(x, y),
  };
}

function rectWorld(
  size: number,
  rects: ReadonlyArray<readonly [number, number, number, number]>,
): StructuresWorld {
  return view(size, (x, y) => {
    for (const [x0, y0, x1, y1] of rects) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return LAND_HEIGHT;
    }
    return SEA_HEIGHT;
  });
}

function unlockableWorld(size: number, locked: ReadonlySet<number>): StructuresWorld {
  const w = worldWithTerrain(size, () => LAND_HEIGHT);
  return {
    worldSize: w.size,
    chunksPerEdge: w.chunksPerEdge,
    heightAt: (x, y) => w.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => w.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => !locked.has(structureKey(x, y)) && w.isCellUnlocked(x, y),
  };
}

function boardOf(cells: ReadonlyArray<readonly [number, number]>): Map<number, LiveCellRecord> {
  const live = new Map<number, LiveCellRecord>();
  for (const [x, y] of cells) live.set(structureKey(x, y), { age: 0, tier: 0 });
  return live;
}

function agedBoardOf(
  cells: ReadonlyArray<readonly [number, number]>,
  age: number,
): Map<number, LiveCellRecord> {
  const live = new Map<number, LiveCellRecord>();
  for (const [x, y] of cells) live.set(structureKey(x, y), { age, tier: 0 });
  return live;
}

function buildableCells(world: StructuresWorld): Array<readonly [number, number]> {
  const cells: Array<readonly [number, number]> = [];
  for (let y = 0; y < world.worldSize; y++) {
    for (let x = 0; x < world.worldSize; x++) {
      if (isBuildableCell(world, x, y)) cells.push([x, y] as const);
    }
  }
  return cells;
}

describe('phantom wall neighbours (scaled neighbour arithmetic)', () => {
  const SIZE = 32;
  const PLATEAU: readonly [number, number, number, number] = [2, 2, 21, 21];

  it('counts a live neighbour as exactly one denominator unit', () => {
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    const live = boardOf([[11, 12], [13, 12]]);
    expect(scaledNeighborCount(live, labels, 12, 12)).toBe(2 * WALL_PHANTOM_DENOMINATOR);
  });

  it('counts a wall neighbour that delivers nobody as exactly one numerator unit', () => {
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    expect(isBuildableCell(world, 4, 4)).toBe(true);
    expect(isBuildableCell(world, 3, 4)).toBe(false);
    expect(scaledNeighborCount(new Map<number, LiveCellRecord>(), labels, 4, 4)).toBe(
      5 * WALL_PHANTOM_NUMERATOR,
    );
  });

  it('counts a live cell reached THROUGH a wrap as a full live neighbour, not a phantom', () => {
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    const live = boardOf([[19, 4]]);
    expect(scaledNeighborCount(live, labels, 4, 4)).toBe(
      WALL_PHANTOM_DENOMINATOR + 4 * WALL_PHANTOM_NUMERATOR,
    );
  });

  it('is D·live + N·wall on a landmass with no wrap targets', () => {
    const world = rectWorld(SIZE, [[8, 8, 12, 12]]);
    expect(buildableCells(world)).toEqual([[10, 10]]);
    const labels = computeLandmassLabels(world);
    const empty = new Map<number, LiveCellRecord>();
    expect(scaledNeighborCount(empty, labels, 10, 10)).toBe(8 * WALL_PHANTOM_NUMERATOR);
  });

  it('keeps the fraction a proper one — a wall is worth less than a live cell', () => {
    expect(WALL_PHANTOM_NUMERATOR).toBeGreaterThan(0);
    expect(WALL_PHANTOM_NUMERATOR).toBeLessThan(WALL_PHANTOM_DENOMINATOR);
  });

  it('leaves open-ground B3/S23 exactly as it was', () => {
    const world = rectWorld(48, [[4, 4, 35, 35]]);
    const blinker = boardOf([[19, 20], [20, 20], [21, 20]]);
    const next = stepGeneration(world, blinker).nextLive;
    expect(new Set(next.keys())).toEqual(
      new Set([structureKey(20, 19), structureKey(20, 20), structureKey(20, 21)]),
    );

    const block = boardOf([[20, 20], [21, 20], [20, 21], [21, 21]]);
    const afterBlock = stepGeneration(world, block).nextLive;
    expect(new Set(afterBlock.keys())).toEqual(new Set(block.keys()));
  });
});

describe('landmass labelling', () => {
  it('gives two separated plateaus two different labels, with their own boxes', () => {
    const world = rectWorld(48, [[2, 2, 13, 13], [30, 30, 41, 41]]);
    const labels = computeLandmassLabels(world);
    expect(labels.count).toBe(2);

    const a = labels.labelAt(6, 6);
    const b = labels.labelAt(35, 35);
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(a).not.toBe(b);

    const boxA = labels.boxes[a];
    const boxB = labels.boxes[b];
    expect(boxA.minX).toBeLessThan(boxB.minX);
    expect(boxA.maxX).toBeLessThan(boxB.minX);
    for (let y = boxA.minY; y <= boxA.maxY; y++) {
      for (let x = boxA.minX; x <= boxA.maxX; x++) {
        expect(labels.labelAt(x, y)).toBe(a);
        expect(isBuildableCell(world, x, y)).toBe(true);
      }
    }
  });

  it('labels water and out-of-bounds as no landmass at all', () => {
    const world = rectWorld(48, [[2, 2, 13, 13]]);
    const labels = computeLandmassLabels(world);
    expect(labels.labelAt(24, 24)).toBe(-1);
    expect(labels.labelAt(-1, 6)).toBe(-1);
    expect(labels.labelAt(48, 6)).toBe(-1);
    expect(labels.labelAt(6, -1)).toBe(-1);
  });

  it('is 8-connected: two cells touching only at a diagonal are ONE landmass', () => {
    const world = rectWorld(48, [[8, 8, 12, 12], [9, 9, 13, 13]]);
    expect(buildableCells(world)).toEqual([[10, 10], [11, 11]]);
    const labels = computeLandmassLabels(world);
    expect(labels.labelAt(10, 10)).toBe(0);
    expect(labels.labelAt(11, 11)).toBe(0);
    expect(labels.count).toBe(1);
    expect(labels.boxes[0]).toEqual({ minX: 10, maxX: 11, minY: 10, maxY: 11 });
  });

  it('is a pure function of the terrain: the same world labels identically twice', () => {
    const world = rectWorld(48, [[2, 2, 13, 13]]);
    const first = computeLandmassLabels(world);
    const second = computeLandmassLabels(world);
    expect(second).not.toBe(first);
    expect(second.count).toBe(first.count);
    for (let y = 0; y < world.worldSize; y++) {
      for (let x = 0; x < world.worldSize; x++) {
        expect(second.labelAt(x, y)).toBe(first.labelAt(x, y));
      }
    }
  });

  it('sees a cell that UNLOCKS between two generations, with no terrain diff', () => {
    const SIZE = 32;
    const locked = new Set<number>([structureKey(11, 11)]);
    const world = unlockableWorld(SIZE, locked);

    let live: ReadonlyMap<number, LiveCellRecord> = boardOf([[10, 10], [11, 10], [10, 11]]);

    const first = stepGeneration(world, live);
    expect(first.born).toEqual([]);
    live = first.nextLive;
    expect(live.size).toBe(3);

    locked.clear();

    const second = stepGeneration(world, live);
    expect(second.born).toEqual([{ x: 11, y: 11, tier: 0 }]);
  });
});

describe('per-landmass wrap', () => {
  const SIZE = 48;
  const PLATEAU: readonly [number, number, number, number] = [10, 10, 29, 29];

  function labelsAndBox() {
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    const box = labels.boxes[labels.labelAt(20, 20)];
    return { world, labels, box };
  }

  it('an in-landmass neighbour is returned directly, unwrapped', () => {
    const { labels } = labelsAndBox();
    const idx = wrappedNeighborIndex(labels, 20, 20, 1, 0);
    expect(idx).toBe(20 * SIZE + 21);
  });

  it('stepping east off the landmass re-enters at its WESTERN edge, same row', () => {
    const { labels, box } = labelsAndBox();
    const y = 20;
    const idx = wrappedNeighborIndex(labels, box.maxX, y, 1, 0);
    expect(idx).toBe(y * SIZE + box.minX);
    expect(box.minX).toBeGreaterThan(0);
  });

  it('stepping north off the landmass re-enters at its SOUTHERN edge, same column', () => {
    const { labels, box } = labelsAndBox();
    const x = 20;
    const idx = wrappedNeighborIndex(labels, x, box.minY, 0, -1);
    expect(idx).toBe(box.maxY * SIZE + x);
  });

  it('a diagonal step off a corner re-enters at the opposite corner', () => {
    const { labels, box } = labelsAndBox();
    const idx = wrappedNeighborIndex(labels, box.maxX, box.maxY, 1, 1);
    expect(idx).toBe(box.minY * SIZE + box.minX);
  });

  it('never returns the cell itself, and returns -1 when the landmass has no target', () => {
    const world = rectWorld(SIZE, [[8, 8, 12, 12]]);
    const labels = computeLandmassLabels(world);
    expect(wrappedNeighborIndex(labels, 10, 10, 1, 0)).toBe(-1);
    expect(wrappedNeighborIndex(labels, 10, 10, -1, -1)).toBe(-1);
  });

  it('returns -1 for a cell that is not on a landmass at all', () => {
    const { labels } = labelsAndBox();
    expect(wrappedNeighborIndex(labels, 0, 0, 1, 0)).toBe(-1);
  });
});

function stepClassic(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  buildable: ReadonlyArray<readonly [number, number]>,
): Map<number, LiveCellRecord> {
  const next = new Map<number, LiveCellRecord>();
  for (const [x, y] of buildable) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (live.has(structureKey(x + dx, y + dy))) n++;
      }
    }
    const key = structureKey(x, y);
    const current = live.get(key);
    if (current !== undefined ? n === 2 || n === 3 : n === 3) {
      next.set(key, { age: current === undefined ? 0 : current.age + 1, tier: 0 });
    }
  }
  return next;
}

describe('a lone plateau under the new topology', () => {
  const SIZE = 32;
  const ISLAND: readonly [number, number, number, number] = [10, 10, 21, 21];
  const GENERATIONS = 50;
  const SEED: ReadonlyArray<readonly [number, number]> = [
    [15, 14], [16, 14], [14, 15], [15, 15], [15, 16],
  ];

  it('dies out under hard-walled B3/S23 (the control)', () => {
    const world = rectWorld(SIZE, [ISLAND]);
    const buildable = buildableCells(world);
    let live: ReadonlyMap<number, LiveCellRecord> = boardOf(SEED);
    let died = false;
    for (let g = 0; g < GENERATIONS; g++) {
      live = stepClassic(world, live, buildable);
      if (live.size === 0) {
        died = true;
        break;
      }
    }
    expect(died).toBe(true);
  });

  it('stays alive for all 50 with phantom walls and per-landmass wrap', () => {
    const world = rectWorld(SIZE, [ISLAND]);
    let live: ReadonlyMap<number, LiveCellRecord> = boardOf(SEED);
    for (let g = 0; g < GENERATIONS; g++) {
      live = stepGeneration(world, live).nextLive;
      expect(live.size).toBeGreaterThan(0);
    }
    const buildable = buildableCells(world).length;
    expect(live.size).toBeLessThan(buildable);
  });
});

describe('the tier gate counts real live Moore neighbours, not phantoms', () => {
  const SIZE = 32;
  const PLATEAU: readonly [number, number, number, number] = [2, 2, 21, 21];
  const OLD_ENOUGH = 10;

  it('refuses a teepee with 2 live neighbours and 3 wall slots', () => {
    const world = rectWorld(SIZE, [PLATEAU]);
    const labels = computeLandmassLabels(world);
    const live = agedBoardOf([[4, 11], [4, 12], [4, 13]], OLD_ENOUGH);
    expect(scaledNeighborCount(live, labels, 4, 12)).toBe(
      2 * WALL_PHANTOM_DENOMINATOR + 3 * WALL_PHANTOM_NUMERATOR,
    );

    const outcome = stepGeneration(world, live);
    expect(outcome.upgraded).toEqual([]);
    expect(outcome.nextLive.get(structureKey(4, 12))!.tier).toBe(0);
  });

  it('advances a teepee with 3 live neighbours even though it is on a coastline', () => {
    const world = rectWorld(SIZE, [PLATEAU, [1, 10, 1, 14]]);
    expect(isBuildableCell(world, 3, 12)).toBe(true);
    expect(isBuildableCell(world, 3, 11)).toBe(false);
    expect(isBuildableCell(world, 3, 13)).toBe(false);

    const labels = computeLandmassLabels(world);
    const live = agedBoardOf([[4, 11], [4, 12], [4, 13], [5, 12]], OLD_ENOUGH);
    expect(scaledNeighborCount(live, labels, 4, 12)).toBe(
      3 * WALL_PHANTOM_DENOMINATOR + 2 * WALL_PHANTOM_NUMERATOR,
    );

    const outcome = stepGeneration(world, live);
    expect(outcome.upgraded).toContainEqual({ x: 4, y: 12, tier: 1 });
  });
});

const MOORE_STEPS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

function scanRowReference(
  labels: LandmassLabels,
  label: number,
  box: LandmassBox,
  y: number,
  step: number,
  selfIndex: number,
): number {
  const width = box.maxX - box.minX + 1;
  const start = step > 0 ? box.minX : box.maxX;
  for (let i = 0; i < width; i++) {
    const x = start + i * step;
    if (labels.labelAt(x, y) !== label) continue;
    const index = y * labels.worldSize + x;
    if (index === selfIndex) continue;
    return index;
  }
  return -1;
}

function scanColumnReference(
  labels: LandmassLabels,
  label: number,
  box: LandmassBox,
  x: number,
  step: number,
  selfIndex: number,
): number {
  const height = box.maxY - box.minY + 1;
  const start = step > 0 ? box.minY : box.maxY;
  for (let i = 0; i < height; i++) {
    const y = start + i * step;
    if (labels.labelAt(x, y) !== label) continue;
    const index = y * labels.worldSize + x;
    if (index === selfIndex) continue;
    return index;
  }
  return -1;
}

function scanDiagonalReference(
  labels: LandmassLabels,
  label: number,
  box: LandmassBox,
  stepX: number,
  stepY: number,
  selfIndex: number,
): number {
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const span = width < height ? width : height;
  const startX = stepX > 0 ? box.minX : box.maxX;
  const startY = stepY > 0 ? box.minY : box.maxY;
  for (let i = 0; i < span; i++) {
    const x = startX + i * stepX;
    const y = startY + i * stepY;
    if (labels.labelAt(x, y) !== label) continue;
    const index = y * labels.worldSize + x;
    if (index === selfIndex) continue;
    return index;
  }
  return -1;
}

function wrappedNeighborIndexReference(
  labels: LandmassLabels,
  x: number,
  y: number,
  dx: number,
  dy: number,
): number {
  const label = labels.labelAt(x, y);
  if (label < 0) return -1;

  const size = labels.worldSize;
  const nx = x + dx;
  const ny = y + dy;
  if (labels.labelAt(nx, ny) === label) return ny * size + nx;

  const box = labels.boxes[label]!;
  const selfIndex = y * size + x;

  if (dx !== 0 && ny >= box.minY && ny <= box.maxY) {
    const wrapped = scanRowReference(labels, label, box, ny, dx, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  if (dy !== 0 && nx >= box.minX && nx <= box.maxX) {
    const wrapped = scanColumnReference(labels, label, box, nx, dy, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  if (dx !== 0 && dy !== 0) {
    const wrapped = scanDiagonalReference(labels, label, box, dx, dy, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  return -1;
}

describe('the wrap lookup agrees with the inward scan it replaced', () => {
  const FIXTURES: ReadonlyArray<readonly [string, StructuresWorld]> = [
    ['one square plateau', rectWorld(32, [[2, 2, 21, 21]])],
    ['a diagonal isthmus', rectWorld(48, [[8, 8, 12, 12], [9, 9, 13, 13]])],
    ['two separate islands', rectWorld(48, [[2, 2, 13, 13], [30, 30, 43, 43]])],
    [
      'a comb',
      rectWorld(64, [
        [4, 4, 59, 12],
        [8, 12, 16, 40],
        [24, 12, 32, 40],
        [40, 12, 48, 40],
      ]),
    ],
    [
      'a ring',
      rectWorld(64, [
        [6, 6, 45, 14],
        [6, 6, 14, 45],
        [37, 6, 45, 45],
        [6, 37, 45, 45],
      ]),
    ],
    ['a one-cell-wide spit', rectWorld(32, [[10, 4, 14, 27]])],
  ];

  for (const [name, world] of FIXTURES) {
    it(`is identical on ${name}, for every cell and every step`, () => {
      const labels = computeLandmassLabels(world);
      const cells = buildableCells(world);
      expect(cells.length).toBeGreaterThan(0);
      for (const [x, y] of cells) {
        for (const [dx, dy] of MOORE_STEPS) {
          expect(wrappedNeighborIndex(labels, x, y, dx, dy)).toBe(
            wrappedNeighborIndexReference(labels, x, y, dx, dy),
          );
        }
      }
    });
  }
});

describe('labels built from the sweep bitmap', () => {
  const SIZE = 64;
  const ISLANDS: ReadonlyArray<readonly [number, number, number, number]> = [
    [2, 2, 21, 21],
    [30, 4, 45, 19],
    [8, 40, 15, 55],
  ];

  function buildableBitmap(world: StructuresWorld): Uint8Array {
    const bitmap = new Uint8Array(world.worldSize * world.worldSize);
    for (let y = 0; y < world.worldSize; y++) {
      for (let x = 0; x < world.worldSize; x++) {
        if (isBuildableCell(world, x, y)) bitmap[y * world.worldSize + x] = 1;
      }
    }
    return bitmap;
  }

  it('equals the labelling computed from the world for the same board', () => {
    const world = rectWorld(SIZE, ISLANDS);
    const fromWorld = computeLandmassLabels(world);
    const fromBitmap = computeLandmassLabelsFromBuildable(SIZE, buildableBitmap(world));

    expect(fromBitmap.worldSize).toBe(fromWorld.worldSize);
    expect(fromBitmap.count).toBe(fromWorld.count);
    expect(fromBitmap.count).toBe(ISLANDS.length);
    expect(fromBitmap.boxes).toEqual(fromWorld.boxes);

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        expect(fromBitmap.labelAt(x, y)).toBe(fromWorld.labelAt(x, y));
      }
    }

    for (let label = 0; label < fromWorld.count; label++) {
      for (let line = 0; line < SIZE; line++) {
        for (const step of [1, -1]) {
          const row = fromWorld.rowEntry(label, line, step, NO_SKIP);
          expect(fromBitmap.rowEntry(label, line, step, NO_SKIP)).toBe(row);
          expect(fromBitmap.rowEntry(label, line, step, row)).toBe(
            fromWorld.rowEntry(label, line, step, row),
          );
          const column = fromWorld.columnEntry(label, line, step, NO_SKIP);
          expect(fromBitmap.columnEntry(label, line, step, NO_SKIP)).toBe(column);
          expect(fromBitmap.columnEntry(label, line, step, column)).toBe(
            fromWorld.columnEntry(label, line, step, column),
          );
        }
      }
    }
  });

  it('costs one chunk on every tick of a warm sweep, the first tick included', () => {
    let surveys = 0;
    const base = rectWorld(SIZE, ISLANDS);
    const world: StructuresWorld = {
      ...base,
      isCellUnlocked: (x, y) => {
        surveys++;
        return base.isCellUnlocked(x, y);
      },
    };
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    const cellsPerSweep = SIZE * SIZE;
    const cellsPerChunk = CHUNK_SIZE * CHUNK_SIZE;
    const empty = new Map<number, LiveCellRecord>();

    const survey = new GenerationSurvey();
    let ticks = 0;
    let outcome = survey.advance(world, empty, ONE_CHUNK_BUDGET);
    while (outcome === null) {
      ticks++;
      outcome = survey.advance(world, empty, ONE_CHUNK_BUDGET);
    }
    ticks++;
    expect(ticks).toBe(totalChunks);
    expect(surveys).toBe(2 * cellsPerSweep);

    const beforeFirstTick = surveys;
    expect(survey.advance(world, empty, ONE_CHUNK_BUDGET)).toBeNull();
    expect(surveys - beforeFirstTick).toBe(cellsPerChunk);

    const beforeSecondTick = surveys;
    expect(survey.advance(world, empty, ONE_CHUNK_BUDGET)).toBeNull();
    expect(surveys - beforeSecondTick).toBe(cellsPerChunk);

    const afterFirstSweep = beforeFirstTick;
    let remaining = totalChunks - 2;
    while (remaining > 0) {
      survey.advance(world, empty, ONE_CHUNK_BUDGET);
      remaining--;
    }
    expect(surveys - afterFirstSweep).toBe(cellsPerSweep);
  });
});

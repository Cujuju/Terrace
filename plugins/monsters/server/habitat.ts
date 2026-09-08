import { BAND_HEIGHT, SEA_LEVEL, type FreshwaterMap } from '@terrace/shared';
import {
  HABITAT_BIT_SET,
  type HabitatIndex,
  type RegimeIndex,
  buildHabitatIndex,
  indexAnswers,
  repairableDirtyCellCap,
} from './habitat-index.ts';
import { hashToIndex } from './rng.ts';

export type HabitatRegimeId = 'water' | 'land';

export const HABITAT_INWARD_DOWNWARD = -1;
export const HABITAT_INWARD_UPWARD = 1;

export interface HabitatRegime {
  readonly id: HabitatRegimeId;
  readonly inward: -1 | 1;
  readonly thresholdBands: number;
}

export const DEEP_WATER_DEPTH_BELOW_SEA = 192;
export const DEEP_WATER_BANDS_BELOW_SEA = DEEP_WATER_DEPTH_BELOW_SEA / BAND_HEIGHT;

export const SNOW_LINE_HEIGHT_ABOVE_SEA = 576;
export const SNOW_LINE_BANDS_ABOVE_SEA = SNOW_LINE_HEIGHT_ABOVE_SEA / BAND_HEIGHT;

export const WATER_HABITAT: HabitatRegime = {
  id: 'water',
  inward: HABITAT_INWARD_DOWNWARD,
  thresholdBands: DEEP_WATER_BANDS_BELOW_SEA,
};

export const LAND_HABITAT: HabitatRegime = {
  id: 'land',
  inward: HABITAT_INWARD_UPWARD,
  thresholdBands: SNOW_LINE_BANDS_ABOVE_SEA,
};

export const HABITAT_REGIMES: readonly HabitatRegime[] = [WATER_HABITAT, LAND_HABITAT];

export function habitatById(id: HabitatRegimeId): HabitatRegime {
  return id === 'water' ? WATER_HABITAT : LAND_HABITAT;
}

const rangeCache = new Map<string, HabitatRegime>();

export function habitatRangeOf(regime: HabitatRegime, thresholdBands: number): HabitatRegime {
  const bands = Math.max(thresholdBands, regime.thresholdBands);
  if (bands === regime.thresholdBands) return regime;
  const key = `${regime.id}:${bands}`;
  const held = rangeCache.get(key);
  if (held !== undefined) return held;
  const range: HabitatRegime = {
    id: regime.id,
    inward: regime.inward,
    thresholdBands: bands,
  };
  rangeCache.set(key, range);
  return range;
}

export function habitatReachHeightUnits(regime: HabitatRegime, height: number): number {
  return regime.inward * (height - SEA_LEVEL);
}

export function habitatBoundaryHeight(regime: HabitatRegime, bands: number): number {
  return SEA_LEVEL + regime.inward * bands * BAND_HEIGHT;
}

export function reachesIntoHabitat(
  regime: HabitatRegime,
  height: number,
  bands: number,
): boolean {
  return habitatReachHeightUnits(regime, height) >= bands * BAND_HEIGHT;
}

export function isHabitatHeight(regime: HabitatRegime, height: number): boolean {
  return reachesIntoHabitat(regime, height, regime.thresholdBands);
}

export const DEEP_WATER_MAX_HEIGHT = habitatBoundaryHeight(
  WATER_HABITAT,
  DEEP_WATER_BANDS_BELOW_SEA,
);

export const SNOW_LINE_MIN_HEIGHT = habitatBoundaryHeight(
  LAND_HABITAT,
  SNOW_LINE_BANDS_ABOVE_SEA,
);

export function isDeepWaterHeight(height: number): boolean {
  return isHabitatHeight(WATER_HABITAT, height);
}

export function isSnowHeight(height: number): boolean {
  return isHabitatHeight(LAND_HABITAT, height);
}

export interface LairWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
  readonly freshwater?: FreshwaterMap;
  readonly chunksPerEdge?: number;
  isChunkUnlocked?(cx: number, cy: number): boolean;
}

export function isLairCell(
  regime: HabitatRegime,
  world: LairWorld,
  cellX: number,
  cellY: number,
): boolean {
  const x = Math.floor(cellX);
  const y = Math.floor(cellY);
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  return isHabitatHeight(regime, world.heightAt(x, y));
}

export const BODY_RIM_PROBE_COUNT = 8;

export const BODY_RIM_PROBE_OFFSETS: readonly (readonly [number, number])[] = Array.from(
  { length: BODY_RIM_PROBE_COUNT },
  (_unused, index) => {
    const angle = (index * 2 * Math.PI) / BODY_RIM_PROBE_COUNT;
    return [Math.cos(angle), Math.sin(angle)] as const;
  },
);

export function isLairPose(
  regime: HabitatRegime,
  world: LairWorld,
  centreX: number,
  centreY: number,
  radiusCells: number,
): boolean {
  if (!isLairCell(regime, world, centreX, centreY)) return false;
  if (radiusCells <= 0) return true;
  for (const [ux, uy] of BODY_RIM_PROBE_OFFSETS) {
    if (!isLairCell(regime, world, centreX + ux * radiusCells, centreY + uy * radiusCells)) {
      return false;
    }
  }
  return true;
}

export interface LairRegion {
  readonly cells: number;
  readonly x: number;
  readonly y: number;
  readonly extremeHeight: number;
  readonly fittingCells: readonly number[];
  readonly summonableCells: readonly number[];
  readonly summonCandidates: readonly (readonly number[])[];
}

export const SUMMON_CANDIDATE_SAMPLE_CELLS = 64;

const CANDIDATE_REGION_MIX = 0x9e3779b1;
const CANDIDATE_RULE_MIX = 0x85ebca6b;

function candidateReservoirDraw(seedIndex: number, ruleIndex: number, ordinal: number): number {
  const seed =
    (Math.imul(seedIndex, CANDIDATE_REGION_MIX) ^
      Math.imul(ruleIndex + 1, CANDIDATE_RULE_MIX) ^
      ordinal) |
    0;
  return hashToIndex(seed, ordinal + 1);
}

export interface LairFitRule {
  readonly radiusCells: number;
  readonly rangeBands: number;
  readonly minReachBands: number;
}

export const CELL_CENTRE_OFFSET = 0.5;

export interface LairSurvey {
  readonly regions: readonly LairRegion[];
  readonly occupiedRegionCells: readonly number[];
}

export const EMPTY_LAIR_SURVEY: LairSurvey = {
  regions: [],
  occupiedRegionCells: [],
};

interface SurveyComponent {
  id: number;
  seedIndex: number;
  region: LairRegion;
}

interface SurveyTable {
  readonly labels: Int32Array;
  readonly components: Map<number, SurveyComponent>;
  nextComponentId: number;
  regions: LairRegion[];
}

let tableIndex: HabitatIndex | null = null;
const tables = new Map<HabitatRegimeId, SurveyTable>();

let queue: Int32Array | null = null;

const UNLABELLED = -1;

function queueFor(cellCount: number): Int32Array {
  if (queue === null || queue.length !== cellCount) queue = new Int32Array(cellCount);
  return queue;
}

export function releaseSurveyScratch(): void {
  queue = null;
  tableIndex = null;
  tables.clear();
}

function isOwned(table: SurveyTable, cellIndex: number): boolean {
  const owner = table.labels[cellIndex]!;
  return owner !== UNLABELLED && table.components.has(owner);
}

const WALK_CLAIM_FRESH = -2;
const WALK_CLAIM_UNOWNED = -3;

function walkComponent(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
  queue: Int32Array,
  seedIndex: number,
  ownerId: number,
  claimFrom: number,
): { readonly minIndex: number; readonly region: LairRegion } {
  const size = index.size;
  const { heights } = index;
  const { habitat, fit, rules } = regimeIndex;
  const labels = table.labels;
  const claimFresh = claimFrom === WALK_CLAIM_FRESH;
  const claimUnowned = claimFrom === WALK_CLAIM_UNOWNED;

  let head = 0;
  let tail = 0;
  labels[seedIndex] = ownerId;
  queue[tail++] = seedIndex;

  let cells = 0;
  let minIndex = seedIndex;
  let extremeReach = Number.NEGATIVE_INFINITY;
  let extremeHeight = 0;
  let extremeX = seedIndex % size;
  let extremeY = (seedIndex - extremeX) / size;
  const fittingCells = rules.map(() => 0);
  const summonableCells = rules.map(() => 0);
  const summonCandidates: number[][] = rules.map(() => []);

  while (head < tail) {
    const cellIndex = queue[head++]!;
    const x = cellIndex % size;
    const y = (cellIndex - x) / size;
    cells++;
    if (cellIndex < minIndex) minIndex = cellIndex;

    const height = heights[cellIndex]!;
    const reach = habitatReachHeightUnits(regime, height);
    if (reach > extremeReach) {
      extremeReach = reach;
      extremeHeight = height;
      extremeX = x;
      extremeY = y;
    }

    for (let rule = 0; rule < rules.length; rule++) {
      if (fit[rule]![cellIndex] !== HABITAT_BIT_SET) continue;
      fittingCells[rule]!++;
      if (!reachesIntoHabitat(regime, height, rules[rule]!.minReachBands)) continue;
      const ordinal = summonableCells[rule]!;
      summonableCells[rule]!++;
      const reservoir = summonCandidates[rule]!;
      if (ordinal < SUMMON_CANDIDATE_SAMPLE_CELLS) {
        reservoir.push(cellIndex);
        continue;
      }
      const slot = candidateReservoirDraw(seedIndex, rule, ordinal);
      if (slot < SUMMON_CANDIDATE_SAMPLE_CELLS) reservoir[slot] = cellIndex;
    }

    if (x > 0) {
      const next = cellIndex - 1;
      if (
        claimFresh
          ? habitat[next] === HABITAT_BIT_SET && labels[next] === UNLABELLED
          : claimUnowned
            ? habitat[next] === HABITAT_BIT_SET && !isOwned(table, next)
            : labels[next] === claimFrom
      ) {
        labels[next] = ownerId;
        queue[tail++] = next;
      }
    }
    if (x + 1 < size) {
      const next = cellIndex + 1;
      if (
        claimFresh
          ? habitat[next] === HABITAT_BIT_SET && labels[next] === UNLABELLED
          : claimUnowned
            ? habitat[next] === HABITAT_BIT_SET && !isOwned(table, next)
            : labels[next] === claimFrom
      ) {
        labels[next] = ownerId;
        queue[tail++] = next;
      }
    }
    if (y > 0) {
      const next = cellIndex - size;
      if (
        claimFresh
          ? habitat[next] === HABITAT_BIT_SET && labels[next] === UNLABELLED
          : claimUnowned
            ? habitat[next] === HABITAT_BIT_SET && !isOwned(table, next)
            : labels[next] === claimFrom
      ) {
        labels[next] = ownerId;
        queue[tail++] = next;
      }
    }
    if (y + 1 < size) {
      const next = cellIndex + size;
      if (
        claimFresh
          ? habitat[next] === HABITAT_BIT_SET && labels[next] === UNLABELLED
          : claimUnowned
            ? habitat[next] === HABITAT_BIT_SET && !isOwned(table, next)
            : labels[next] === claimFrom
      ) {
        labels[next] = ownerId;
        queue[tail++] = next;
      }
    }
  }

  return {
    minIndex,
    region: {
      cells,
      x: extremeX,
      y: extremeY,
      extremeHeight,
      fittingCells,
      summonableCells,
      summonCandidates,
    },
  };
}

function remeasureFromSeed(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
  queue: Int32Array,
  minIndex: number,
  claimedId: number,
): { readonly id: number; readonly region: LairRegion } {
  const id = table.nextComponentId++;
  const walk = walkComponent(regime, index, regimeIndex, table, queue, minIndex, id, claimedId);
  return { id, region: walk.region };
}

const EMPTY_LAIR_REGION: LairRegion = {
  cells: 0,
  x: 0,
  y: 0,
  extremeHeight: 0,
  fittingCells: [],
  summonableCells: [],
  summonCandidates: [],
};

function rebuildTable(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
): void {
  const size = index.size;
  const { labels, components } = table;
  const cellQueue = queueFor(size * size);

  labels.fill(UNLABELLED);
  components.clear();
  table.nextComponentId = 0;

  const regions: LairRegion[] = [];
  for (let seedY = 0; seedY < size; seedY++) {
    for (let seedX = 0; seedX < size; seedX++) {
      const seedIndex = seedY * size + seedX;
      if (labels[seedIndex] !== UNLABELLED) continue;
      if (regimeIndex.habitat[seedIndex] !== HABITAT_BIT_SET) continue;

      const id = table.nextComponentId++;
      const walk = walkComponent(
        regime,
        index,
        regimeIndex,
        table,
        cellQueue,
        seedIndex,
        id,
        WALK_CLAIM_FRESH,
      );
      components.set(id, { id, seedIndex, region: walk.region });
      regions.push(walk.region);
    }
  }
  table.regions = regions;
}

function repairTable(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
  dirtyCells: readonly number[],
): void {
  const size = index.size;
  const cellCount = size * size;
  const { labels, components } = table;
  const habitat = regimeIndex.habitat;
  const cellQueue = queueFor(cellCount);

  for (const cell of dirtyCells) {
    if (cell < 0 || cell >= cellCount) continue;
    const owner = labels[cell]!;
    if (owner !== UNLABELLED) components.delete(owner);
    const x = cell % size;
    const y = (cell - x) / size;
    if (x > 0 && habitat[cell - 1] === HABITAT_BIT_SET) components.delete(labels[cell - 1]!);
    if (x + 1 < size && habitat[cell + 1] === HABITAT_BIT_SET) {
      components.delete(labels[cell + 1]!);
    }
    if (y > 0 && habitat[cell - size] === HABITAT_BIT_SET) {
      components.delete(labels[cell - size]!);
    }
    if (y + 1 < size && habitat[cell + size] === HABITAT_BIT_SET) {
      components.delete(labels[cell + size]!);
    }
  }

  for (const cell of dirtyCells) {
    if (cell < 0 || cell >= cellCount) continue;
    const x = cell % size;
    const y = (cell - x) / size;
    reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell);
    if (x > 0) reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell - 1);
    if (x + 1 < size) reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell + 1);
    if (y > 0) reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell - size);
    if (y + 1 < size) reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell + size);
  }

  const ordered = [...components.values()].sort((a, b) => a.seedIndex - b.seedIndex);
  table.regions = ordered.map((component) => component.region);
}

function reclaimFrom(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
  cellQueue: Int32Array,
  seedIndex: number,
): void {
  if (regimeIndex.habitat[seedIndex] !== HABITAT_BIT_SET) return;
  if (isOwned(table, seedIndex)) return;

  const claimedId = table.nextComponentId++;
  table.components.set(claimedId, {
    id: claimedId,
    seedIndex,
    region: EMPTY_LAIR_REGION,
  });
  const walk = walkComponent(
    regime,
    index,
    regimeIndex,
    table,
    cellQueue,
    seedIndex,
    claimedId,
    WALK_CLAIM_UNOWNED,
  );

  if (walk.minIndex === seedIndex) {
    table.components.set(claimedId, { id: claimedId, seedIndex, region: walk.region });
    return;
  }

  table.components.delete(claimedId);
  const measured = remeasureFromSeed(
    regime,
    index,
    regimeIndex,
    table,
    cellQueue,
    walk.minIndex,
    claimedId,
  );
  table.components.set(measured.id, {
    id: measured.id,
    seedIndex: walk.minIndex,
    region: measured.region,
  });
}

export function surveyLairs(
  regime: HabitatRegime,
  world: LairWorld,
  occupied: ReadonlyArray<{ readonly x: number; readonly y: number }> = [],
  fitRules: readonly LairFitRule[] = [],
  index?: HabitatIndex,
): LairSurvey {
  const size = world.worldSize;
  if (size <= 0) return EMPTY_LAIR_SURVEY;

  const view =
    index !== undefined && indexAnswers(index, world, regime, fitRules)
      ? index
      : buildHabitatIndex(world, [{ regime, fitRules }]);
  const regimeIndex = view.regimes.get(regime.id)!;

  const cellCount = size * size;
  if (tableIndex !== view) {
    tableIndex = view;
    tables.clear();
  }

  let table = tables.get(regime.id);
  if (table === undefined || table.labels.length !== cellCount) {
    table = {
      labels: new Int32Array(cellCount),
      components: new Map<number, SurveyComponent>(),
      nextComponentId: 0,
      regions: [],
    };
    tables.set(regime.id, table);
    rebuildTable(regime, view, regimeIndex, table);
    regimeIndex.dirtyCells.length = 0;
  } else {
    const dirtyCells = regimeIndex.dirtyCells;
    if (dirtyCells.length > repairableDirtyCellCap(cellCount)) {
      rebuildTable(regime, view, regimeIndex, table);
    } else if (dirtyCells.length > 0) {
      repairTable(regime, view, regimeIndex, table, dirtyCells);
    }
    dirtyCells.length = 0;
  }

  const labels = table.labels;
  const components = table.components;
  const occupiedRegionCells = occupied.map((position) => {
    const x = Math.floor(position.x);
    const y = Math.floor(position.y);
    if (x < 0 || y < 0 || x >= size || y >= size) return 0;
    const component = components.get(labels[y * size + x]!);
    return component === undefined ? 0 : component.region.cells;
  });

  return { regions: table.regions, occupiedRegionCells };
}

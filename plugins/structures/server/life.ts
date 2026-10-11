import { CHUNK_SIZE, isSettlingDay } from '@terrace/shared';
import {
  MAX_FOOTPRINT_RADIUS_CELLS,
  STRUCTURES_CAP,
  cellOfKey,
  footprintRadiusOfKind,
  hashStructureCell,
  structureKey,
  type StructureCell,
} from '../protocol.ts';
import {
  bandAt,
  categoryAt,
  chainStepOf,
  isLandmarkKind,
  landmarksFor,
  nextKindInChain,
  tierOfKind,
  type CategoryRule,
} from '../settlementRules.ts';
import { isBlessedStructureCell } from './blessings.ts';
import { isReadyToUpgrade } from './tiers.ts';
import { foundingKindAt, isBuildableCell, type StructuresWorld } from './suitability.ts';
import { hasNearbyFarmland } from './farmland.ts';
import {
  IncrementalLandmassLabeller,
  LABEL_UNITS_PER_BOARD_CELL,
  computeLandmassLabels,
  wrappedNeighborIndex,
  type LandmassLabels,
} from './topology.ts';
import {
  CAMP_GRADE_STEP,
  chainStepAt,
  hasBuildingWithinSeparation,
  surveyUpgradeLot,
} from './clearance.ts';
import type { StructuresRng } from './rng.ts';

export const CA_GENERATION_INTERVAL_SECONDS = 15;

export function shouldSeed(
  live: ReadonlyMap<number, LiveCellRecord>,
  day: number,
  lastSeedDay: number,
): boolean {
  if (live.size > 0) return false;
  if (!isSettlingDay(day)) return false;
  return day !== lastSeedDay;
}

export const CA_SEED_MAX_PLACEMENT_ATTEMPTS = 12;

export const CA_SEED_PATTERNS_PER_ARRIVAL = 5;

export const CA_SOUP_SIZE = 5;

export const CA_SOUP_FILL_PROBABILITY = 0.4;

export const CA_STIR_PROBABILITY_PER_GENERATION = 0.5;

export const CA_STIR_MIN_SPARKS = 1;

export const CA_STIR_MAX_SPARKS = 3;

export const CA_STIR_MAX_ANCHOR_ATTEMPTS = 8;

export interface LiveCellRecord {
  readonly age: number;
  readonly tier: number;
  /** Building kind (index into spawn-bands.json's buildings). */
  readonly kind: number;
}

const MOORE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

export const WALL_PHANTOM_NUMERATOR = 1;

export const WALL_PHANTOM_DENOMINATOR = 3;

export interface PhantomWallWeight {
  readonly numerator: number;
  readonly denominator: number;
}

export const WALL_PHANTOM_WEIGHT: PhantomWallWeight = {
  numerator: WALL_PHANTOM_NUMERATOR,
  denominator: WALL_PHANTOM_DENOMINATOR,
};

function survivesAt(scaled: number, denominator: number): boolean {
  return scaled >= 2 * denominator && scaled < 4 * denominator;
}

function bornAt(scaled: number, denominator: number): boolean {
  return scaled >= 3 * denominator && scaled < 4 * denominator;
}

function fedBornAt(scaled: number, denominator: number): boolean {
  return scaled >= 2 * denominator && scaled < 3 * denominator;
}

export function scaledNeighborCount(
  live: ReadonlyMap<number, LiveCellRecord>,
  labels: LandmassLabels,
  x: number,
  y: number,
  phantom: PhantomWallWeight = WALL_PHANTOM_WEIGHT,
): number {
  const size = labels.worldSize;
  let scaled = 0;
  for (const [ox, oy] of MOORE_OFFSETS) {
    const index = wrappedNeighborIndex(labels, x, y, ox, oy);
    if (index >= 0) {
      const ny = (index / size) | 0;
      const nx = index - ny * size;
      if (live.has(structureKey(nx, ny))) {
        scaled += phantom.denominator;
        continue;
      }
    }
    if (labels.labelAt(x + ox, y + oy) < 0) scaled += phantom.numerator;
  }
  return scaled;
}

function liveMooreNeighbors(
  live: ReadonlyMap<number, LiveCellRecord>,
  worldSize: number,
  x: number,
  y: number,
): number {
  let count = 0;
  for (const [ox, oy] of MOORE_OFFSETS) {
    const nx = x + ox;
    const ny = y + oy;
    if (nx < 0 || ny < 0 || nx >= worldSize || ny >= worldSize) continue;
    if (live.has(structureKey(nx, ny))) count++;
  }
  return count;
}

export interface GenerationOutcome {
  readonly nextLive: Map<number, LiveCellRecord>;
  readonly born: StructureCell[];
  readonly upgraded: StructureCell[];
  readonly died: Array<{ x: number; y: number }>;
}

export class GenerationSurvey {
  private readonly phantom: PhantomWallWeight;

  constructor(phantom: PhantomWallWeight = WALL_PHANTOM_WEIGHT) {
    this.phantom = phantom;
  }

  private cursor = 0;
  private readonly staged = new Map<number, LiveCellRecord>();
  private readonly demolishedThisSweep = new Set<number>();
  private board: ReadonlyMap<number, LiveCellRecord> | null = null;

  private labels: LandmassLabels | null = null;

  private readonly labeller = new IncrementalLandmassLabeller();

  private pendingLabels: LandmassLabels | null = null;

  private masks: [Uint8Array, Uint8Array] | null = null;
  private maskThisSweep = 0;

  evict(key: number): void {
    this.staged.delete(key);
    this.demolishedThisSweep.add(key);
  }

  /** Drops staged births whose footprint covers an edited cell; the next sweep re-judges that ground. */
  forgetStagedBirthsAt(x: number, y: number): void {
    for (let dy = -MAX_FOOTPRINT_RADIUS_CELLS; dy <= MAX_FOOTPRINT_RADIUS_CELLS; dy++) {
      for (let dx = -MAX_FOOTPRINT_RADIUS_CELLS; dx <= MAX_FOOTPRINT_RADIUS_CELLS; dx++) {
        const key = structureKey(x + dx, y + dy);
        const record = this.staged.get(key);
        if (record === undefined || this.board?.has(key) === true) continue;
        const radius = footprintRadiusOfKind(record.kind);
        if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;
        this.staged.delete(key);
      }
    }
  }

  private resetSweep(): void {
    this.cursor = 0;
    this.staged.clear();
    this.demolishedThisSweep.clear();
    this.board = null;
  }

  /**
   * Claims the ground an upgrade needs, absorbing what it may. False when the new building
   * would not fit (off band, water, reserved) or a peer stands in its way.
   */
  private claimUpgradeLot(
    world: StructuresWorld,
    live: ReadonlyMap<number, LiveCellRecord>,
    x: number,
    y: number,
    currentStep: number,
    nextKind: number,
  ): boolean {
    if (!isBuildableCell(world, x, y, footprintRadiusOfKind(nextKind))) return false;
    const onBoard = surveyUpgradeLot(live, world, x, y, currentStep, nextKind);
    const staged = surveyUpgradeLot(this.staged, world, x, y, currentStep, nextKind);
    if (onBoard.blocked || staged.blocked) return false;
    for (const key of [...onBoard.absorbed, ...staged.absorbed]) {
      this.staged.delete(key);
      this.demolishedThisSweep.add(key);
    }
    return true;
  }

  private hasLandmarkWithin(
    live: ReadonlyMap<number, LiveCellRecord>,
    x: number,
    y: number,
    kind: number,
    spacingCells: number,
  ): boolean {
    for (const board of [live, this.staged]) {
      for (const [key, record] of board) {
        if (record.kind !== kind) continue;
        const cell = cellOfKey(key);
        const dx = cell.x - x;
        const dy = cell.y - y;
        if (dx * dx + dy * dy < spacingCells * spacingCells) return true;
      }
    }
    return false;
  }

  /** A landmark this finished settlement may become: allowed on its band, none of its kind nearby. */
  private landmarkFor(
    world: StructuresWorld,
    live: ReadonlyMap<number, LiveCellRecord>,
    x: number,
    y: number,
    category: CategoryRule,
    current: LiveCellRecord,
  ): number | null {
    if (isLandmarkKind(current.kind)) return null;
    const eligible = landmarksFor(category, bandAt(world, x, y));
    if (eligible.length === 0) return null;
    const start = hashStructureCell(x, y) % eligible.length;
    for (let i = 0; i < eligible.length; i++) {
      const rule = eligible[(start + i) % eligible.length]!;
      if (!this.hasLandmarkWithin(live, x, y, rule.kind, rule.spacingCells)) return rule.kind;
    }
    return null;
  }

  private upgradeOf(
    world: StructuresWorld,
    live: ReadonlyMap<number, LiveCellRecord>,
    x: number,
    y: number,
    key: number,
    current: LiveCellRecord,
    age: number,
  ): LiveCellRecord | null {
    const category = categoryAt(world, x, y);
    if (category === null) return null;
    const neighbours = liveMooreNeighbors(live, world.worldSize, x, y);
    const step = chainStepOf(category, current.kind);
    if (!isReadyToUpgrade(age, step, neighbours, isBlessedStructureCell(key))) {
      return null;
    }
    const next = nextKindInChain(category, current.kind) ?? this.landmarkFor(world, live, x, y, category, current);
    if (next === null || !this.claimUpgradeLot(world, live, x, y, step, next)) return null;
    return { age, tier: tierOfKind(next), kind: next };
  }

  private scanChunk(
    world: StructuresWorld,
    live: ReadonlyMap<number, LiveCellRecord>,
    labels: LandmassLabels,
    buildable: Uint8Array,
    cx: number,
    cy: number,
  ): void {
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (let dy = 0; dy < CHUNK_SIZE; dy++) {
      const y = baseY + dy;
      for (let dx = 0; dx < CHUNK_SIZE; dx++) {
        const x = baseX + dx;

        const isBuildable = isBuildableCell(world, x, y);
        buildable[y * world.worldSize + x] = isBuildable ? 1 : 0;
        if (!isBuildable) continue;

        const key = structureKey(x, y);
        if (this.demolishedThisSweep.has(key)) continue;

        const current = live.get(key);
        const scaled = scaledNeighborCount(live, labels, x, y, this.phantom);
        const survives =
          current !== undefined &&
          (chainStepAt(world, x, y, current.kind) > CAMP_GRADE_STEP ||
            survivesAt(scaled, this.phantom.denominator));
        const fedBirth =
          current === undefined &&
          fedBornAt(scaled, this.phantom.denominator) &&
          hasNearbyFarmland(world, x, y);
        let birthed =
          current === undefined && (bornAt(scaled, this.phantom.denominator) || fedBirth);
        if (
          birthed &&
          (hasBuildingWithinSeparation(live, world, x, y) ||
            hasBuildingWithinSeparation(this.staged, world, x, y))
        ) {
          birthed = false;
        }
        if (!survives && !birthed) continue;

        if (current !== undefined) {
          const age = current.age + 1;
          const upgraded = this.upgradeOf(world, live, x, y, key, current, age);
          this.staged.set(key, upgraded ?? { age, tier: current.tier, kind: current.kind });
        } else {
          if (this.staged.size >= STRUCTURES_CAP) continue;
          const kind = foundingKindAt(world, x, y);
          if (kind === null) continue;
          this.staged.set(key, { age: 0, tier: tierOfKind(kind), kind });
        }
      }
    }
  }

  private spendOnLabelling(budget: number): number {
    if (!this.labeller.active) return budget;
    const finished = this.labeller.advance(budget);
    if (finished === null) return 0;
    this.pendingLabels = finished;
    return 0;
  }

  private installPendingLabels(): void {
    if (this.pendingLabels === null) return;
    this.labels = this.pendingLabels;
    this.pendingLabels = null;
  }

  advance(
    world: StructuresWorld,
    live: ReadonlyMap<number, LiveCellRecord>,
    chunkBudget: number,
  ): GenerationOutcome | null {
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    if (totalChunks <= 0) return null;

    let budget = Math.floor(chunkBudget);
    if (budget <= 0) return null;

    const cellCount = world.worldSize * world.worldSize;
    if (this.board === null) {
      this.board = new Map(live);
    }
    const board = this.board;
    if (this.masks === null || this.masks[0].length !== cellCount) {
      this.masks = [new Uint8Array(cellCount), new Uint8Array(cellCount)];
      this.maskThisSweep = 0;
      this.labeller.abandon();
      this.pendingLabels = null;
    }
    if (this.labels === null || this.labels.worldSize !== world.worldSize) {
      this.labels = computeLandmassLabels(world);
    }
    const labels = this.labels;
    const buildable = this.masks[this.maskThisSweep];

    const labelCredit = budget * CHUNK_SIZE * CHUNK_SIZE * LABEL_UNITS_PER_BOARD_CELL;
    const labelBudgetLeft = this.spendOnLabelling(labelCredit);

    while (budget > 0 && this.cursor < totalChunks) {
      this.scanChunk(
        world,
        board,
        labels,
        buildable,
        this.cursor % world.chunksPerEdge,
        Math.floor(this.cursor / world.chunksPerEdge),
      );
      this.cursor++;
      budget--;
    }
    if (this.cursor < totalChunks) return null;

    const carriedOntoClaimedGround: number[] = [];
    for (const [key, record] of live) {
      if (board.has(key) || this.staged.has(key)) continue;
      const cell = cellOfKey(key);
      if (hasBuildingWithinSeparation(this.staged, world, cell.x, cell.y, footprintRadiusOfKind(record.kind))) {
        carriedOntoClaimedGround.push(key);
        continue;
      }
      this.staged.set(key, record);
    }

    const born: StructureCell[] = [];
    const upgraded: StructureCell[] = [];
    const died: Array<{ x: number; y: number }> = [];

    for (const key of carriedOntoClaimedGround) {
      const cell = cellOfKey(key);
      died.push({ x: cell.x, y: cell.y });
    }

    for (const [key, record] of this.staged) {
      if (!board.has(key) && live.has(key)) continue;
      const previous = board.get(key);
      const cell = cellOfKey(key);
      if (previous === undefined) {
        born.push({ x: cell.x, y: cell.y, tier: record.tier, kind: record.kind });
      } else if (previous.kind !== record.kind) {
        upgraded.push({ x: cell.x, y: cell.y, tier: record.tier, kind: record.kind });
      }
    }
    for (const key of board.keys()) {
      if (this.staged.has(key)) continue;
      const cell = cellOfKey(key);
      died.push({ x: cell.x, y: cell.y });
    }

    this.installPendingLabels();
    if (!this.labeller.active) {
      this.labeller.begin(world.worldSize, buildable);
      this.maskThisSweep ^= 1;
    }
    this.spendOnLabelling(labelBudgetLeft);
    this.installPendingLabels();

    const nextLive = new Map(this.staged);
    this.resetSweep();
    return { nextLive, born, upgraded, died };
  }
}

export function stepGeneration(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  phantom: PhantomWallWeight = WALL_PHANTOM_WEIGHT,
): GenerationOutcome {
  const survey = new GenerationSurvey(phantom);
  const result = survey.advance(world, live, world.chunksPerEdge * world.chunksPerEdge);
  return result as GenerationOutcome;
}

export function generationChunksPerTick(world: StructuresWorld, dt: number): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerGeneration = Math.max(1, Math.round(CA_GENERATION_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerGeneration;
}

interface SeedPattern {
  readonly name: string;
  readonly cells: ReadonlyArray<readonly [number, number]>;
}

const CA_BLOCK: SeedPattern = { name: 'block', cells: [[0, 0], [1, 0], [0, 1], [1, 1]] };
const CA_BLINKER: SeedPattern = { name: 'blinker', cells: [[0, 0], [1, 0], [2, 0]] };
const CA_GLIDER: SeedPattern = { name: 'glider', cells: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]] };
const CA_R_PENTOMINO: SeedPattern = {
  name: 'r-pentomino',
  cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
};

export const CA_FIXED_SEED_PATTERNS: readonly SeedPattern[] = [
  CA_BLOCK,
  CA_BLINKER,
  CA_GLIDER,
  CA_R_PENTOMINO,
];

function randomSoupCells(rng: StructuresRng): ReadonlyArray<readonly [number, number]> {
  const cells: Array<readonly [number, number]> = [];
  const center = Math.floor(CA_SOUP_SIZE / 2);
  for (let dy = 0; dy < CA_SOUP_SIZE; dy++) {
    for (let dx = 0; dx < CA_SOUP_SIZE; dx++) {
      if (dx === center && dy === center) {
        cells.push([dx, dy]);
        continue;
      }
      if (rng.next() < CA_SOUP_FILL_PROBABILITY) cells.push([dx, dy]);
    }
  }
  return cells;
}

function choosePatternCells(rng: StructuresRng): ReadonlyArray<readonly [number, number]> {
  const choice = Math.floor(rng.next() * (CA_FIXED_SEED_PATTERNS.length + 1));
  if (choice < CA_FIXED_SEED_PATTERNS.length) return CA_FIXED_SEED_PATTERNS[choice].cells;
  return randomSoupCells(rng);
}

export function placePatternAt(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  anchorX: number,
  anchorY: number,
  patternCells: ReadonlyArray<readonly [number, number]>,
): StructureCell[] | null {
  const placed: StructureCell[] = [];
  for (const [dx, dy] of patternCells) {
    const x = anchorX + dx;
    const y = anchorY + dy;
    if (live.has(structureKey(x, y)) || !isBuildableCell(world, x, y)) return null;
    if (hasBuildingWithinSeparation(live, world, x, y)) return null;
    const kind = foundingKindAt(world, x, y);
    if (kind === null) return null;
    placed.push({ x, y, tier: tierOfKind(kind), kind });
  }
  return placed;
}

function chunkIndexOfCell(world: StructuresWorld, x: number, y: number): number {
  return Math.floor(y / CHUNK_SIZE) * world.chunksPerEdge + Math.floor(x / CHUNK_SIZE);
}

function chunkHasBuildableCell(world: StructuresWorld, cx: number, cy: number): boolean {
  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  for (let dy = 0; dy < CHUNK_SIZE; dy++) {
    for (let dx = 0; dx < CHUNK_SIZE; dx++) {
      if (isBuildableCell(world, baseX + dx, baseY + dy)) return true;
    }
  }
  return false;
}

export function attemptSeed(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  rng: StructuresRng,
): StructureCell[] | null {
  const unlocked: number[] = [];
  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      if (world.isChunkUnlocked(cx, cy) && chunkHasBuildableCell(world, cx, cy)) {
        unlocked.push(cy * world.chunksPerEdge + cx);
      }
    }
  }
  if (unlocked.length === 0) return null;

  const occupied = new Set<number>();
  for (const key of live.keys()) {
    const cell = cellOfKey(key);
    occupied.add(chunkIndexOfCell(world, cell.x, cell.y));
  }
  const settlementFree = unlocked.filter((idx) => !occupied.has(idx));
  const pool = settlementFree.length > 0 ? settlementFree : unlocked;

  const planted: StructureCell[] = [];
  const claimed = new Map<number, LiveCellRecord>(live);
  const usedChunks = new Set<number>();

  for (let pattern = 0; pattern < CA_SEED_PATTERNS_PER_ARRIVAL; pattern++) {
    const available = pool.filter((idx) => !usedChunks.has(idx));
    if (available.length === 0) break;

    for (let attempt = 0; attempt < CA_SEED_MAX_PLACEMENT_ATTEMPTS; attempt++) {
      const patternCells = choosePatternCells(rng);
      if (claimed.size + patternCells.length > STRUCTURES_CAP) break;
      let maxDx = 0;
      let maxDy = 0;
      for (const [dx, dy] of patternCells) {
        if (dx > maxDx) maxDx = dx;
        if (dy > maxDy) maxDy = dy;
      }
      if (world.worldSize <= maxDx || world.worldSize <= maxDy) continue;

      const chunkIdx = available[Math.floor(rng.next() * available.length)]!;
      const baseX = (chunkIdx % world.chunksPerEdge) * CHUNK_SIZE;
      const baseY = Math.floor(chunkIdx / world.chunksPerEdge) * CHUNK_SIZE;
      const anchorX = Math.min(baseX + Math.floor(rng.next() * CHUNK_SIZE), world.worldSize - 1 - maxDx);
      const anchorY = Math.min(baseY + Math.floor(rng.next() * CHUNK_SIZE), world.worldSize - 1 - maxDy);

      const placed = placePatternAt(world, claimed, anchorX, anchorY, patternCells);
      if (placed === null) continue;

      for (const cell of placed) claimed.set(structureKey(cell.x, cell.y), { age: 0, tier: cell.tier, kind: cell.kind });
      planted.push(...placed);
      usedChunks.add(chunkIdx);
      break;
    }
  }

  return planted.length > 0 ? planted : null;
}

export function attemptStir(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  rng: StructuresRng,
): StructureCell[] | null {
  if (live.size === 0) return null;

  const capRoom = STRUCTURES_CAP - live.size;
  if (capRoom <= 0) return null;

  const sortedKeys = Array.from(live.keys()).sort((a, b) => a - b);
  const startIndex = Math.floor(rng.next() * sortedKeys.length);

  let candidates: Array<readonly [number, number, number]> = [];
  const anchorAttempts = Math.min(CA_STIR_MAX_ANCHOR_ATTEMPTS, sortedKeys.length);
  for (let attempt = 0; attempt < anchorAttempts; attempt++) {
    const anchor = cellOfKey(sortedKeys[(startIndex + attempt) % sortedKeys.length]);
    candidates = [];
    for (const [ox, oy] of MOORE_OFFSETS) {
      const nx = anchor.x + ox;
      const ny = anchor.y + oy;
      if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
      if (live.has(structureKey(nx, ny))) continue;
      if (!isBuildableCell(world, nx, ny)) continue;
      if (hasBuildingWithinSeparation(live, world, nx, ny)) continue;
      const kind = foundingKindAt(world, nx, ny);
      if (kind === null) continue;
      candidates.push([nx, ny, kind]);
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return null;

  const sparkRoll = CA_STIR_MIN_SPARKS + Math.floor(rng.next() * (CA_STIR_MAX_SPARKS - CA_STIR_MIN_SPARKS + 1));
  const sparkCount = Math.min(sparkRoll, candidates.length, capRoom);

  const pool = candidates.slice();
  const sparks: StructureCell[] = [];
  for (let i = 0; i < sparkCount; i++) {
    const pickIndex = Math.floor(rng.next() * pool.length);
    const [x, y, kind] = pool[pickIndex];
    pool.splice(pickIndex, 1);
    sparks.push({ x, y, tier: tierOfKind(kind), kind });
  }
  return sparks;
}

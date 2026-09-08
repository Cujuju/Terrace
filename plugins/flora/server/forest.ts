import {
  CHUNK_SIZE,
  WORLD_UNIT_CELLS,
  cellsAcross,
  cellsOverArea,
  createSeededRng,
} from '@terrace/shared';
import { FLORA_TREE_CAP, treeCellOf, treeKey, type TreeCell } from '../protocol.ts';
import { isGreenBand, isPlantableCell, type FloraWorld } from './bands.ts';
import type { StabilityMap } from './stability.ts';

export const FLORA_SURVEY_INTERVAL_SECONDS = 5;

export const FLORA_CELLS_PER_TREE = cellsOverArea(4);

export const FLORA_MIN_TREE_SPACING_CELLS = cellsAcross(1.5);

export const FLORA_MEAN_SPROUT_WAIT_SECONDS = 30;

export const FLORA_MAX_SPROUTS_PER_SURVEY = 48;

export const FLORA_RNG_DEFAULT_SEED = 0x5eed10ca;

export interface FloraRng {
  next(): number;
  state(): number;
}

export function createFloraRng(seed: number): FloraRng {
  return createSeededRng(seed);
}

export function treeTargetFor(stableGreenCells: number): number {
  const wanted = Math.floor(stableGreenCells / FLORA_CELLS_PER_TREE);
  return wanted > FLORA_TREE_CAP ? FLORA_TREE_CAP : wanted;
}

export function sproutCount(deficit: number, rng: FloraRng): number {
  if (deficit <= 0) return 0;
  const expected = deficit * (FLORA_SURVEY_INTERVAL_SECONDS / FLORA_MEAN_SPROUT_WAIT_SECONDS);
  const whole = Math.floor(expected);
  const drawn = whole + (rng.next() < expected - whole ? 1 : 0);
  return Math.min(drawn, FLORA_MAX_SPROUTS_PER_SURVEY, deficit);
}

export interface SurveyResult {
  readonly grown: readonly TreeCell[];
  readonly felled: readonly TreeCell[];
}

const EMPTY_SURVEY: SurveyResult = { grown: [], felled: [] };

export type OccupancyPredicate = (x: number, y: number) => boolean;
const NEVER_OCCUPIED: OccupancyPredicate = () => false;

export type BarredGround = (x: number, y: number) => boolean;

export class Forest {
  private readonly standing = new Set<number>();

  private cursor = 0;
  private sweepArea = 0;
  private sweepSeen = 0;
  private readonly candidates: number[] = [];

  get count(): number {
    return this.standing.size;
  }

  has(x: number, y: number): boolean {
    return this.standing.has(treeKey(x, y));
  }

  cells(): TreeCell[] {
    return Array.from(this.standing, treeCellOf);
  }

  plant(x: number, y: number): boolean {
    const key = treeKey(x, y);
    if (this.standing.has(key)) return false;
    if (this.standing.size >= FLORA_TREE_CAP) return false;
    this.standing.add(key);
    return true;
  }

  fell(x: number, y: number): boolean {
    return this.standing.delete(treeKey(x, y));
  }

  replaceAll(cells: Iterable<TreeCell>): void {
    this.standing.clear();
    for (const cell of cells) {
      if (this.standing.size >= FLORA_TREE_CAP) break;
      this.standing.add(treeKey(cell.x, cell.y));
    }
    this.resetSweep();
  }

  private isCrowded(x: number, y: number): boolean {
    const reach = FLORA_MIN_TREE_SPACING_CELLS - 1;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (this.standing.has(treeKey(x + dx, y + dy))) return true;
      }
    }
    return false;
  }

  private cull(world: FloraWorld, isOccupied: OccupancyPredicate): TreeCell[] {
    const felled: TreeCell[] = [];
    for (const key of this.standing) {
      const cell = treeCellOf(key);
      if (isPlantableCell(world, cell.x, cell.y) && !isOccupied(cell.x, cell.y)) continue;
      felled.push(cell);
    }
    for (const cell of felled) this.standing.delete(treeKey(cell.x, cell.y));
    return felled;
  }

  private resetSweep(): void {
    this.cursor = 0;
    this.sweepArea = 0;
    this.sweepSeen = 0;
    this.candidates.length = 0;
  }

  private scanChunk(
    world: FloraWorld,
    stability: StabilityMap,
    nowSeconds: number,
    rng: FloraRng,
    cx: number,
    cy: number,
    isOccupied: OccupancyPredicate,
    isBarred: BarredGround,
  ): void {
    if (!world.isChunkUnlocked(cx, cy)) return;

    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (let dy = 0; dy < CHUNK_SIZE; dy++) {
      const y = baseY + dy;
      for (let dx = 0; dx < CHUNK_SIZE; dx++) {
        const x = baseX + dx;
        if (!isGreenBand(world.heightAt(x, y))) continue;
        if (!stability.isStable(x, y, nowSeconds)) continue;
        if (isOccupied(x, y)) continue;

        this.sweepArea++;
        const key = treeKey(x, y);
        if (this.standing.has(key)) continue;
        if (isBarred(x, y)) continue;

        this.sweepSeen++;
        if (this.candidates.length < FLORA_MAX_SPROUTS_PER_SURVEY) {
          this.candidates.push(key);
          continue;
        }
        const slot = Math.floor(rng.next() * this.sweepSeen);
        if (slot < FLORA_MAX_SPROUTS_PER_SURVEY) this.candidates[slot] = key;
      }
    }
  }

  private grow(
    world: FloraWorld,
    stability: StabilityMap,
    nowSeconds: number,
    rng: FloraRng,
    isBarred: BarredGround,
  ): TreeCell[] {
    const deficit = treeTargetFor(this.sweepArea) - this.standing.size;
    let quota = sproutCount(deficit, rng);
    if (quota <= 0) return [];

    const grown: TreeCell[] = [];
    for (const key of this.candidates) {
      if (quota <= 0) break;
      const cell = treeCellOf(key);
      if (!isPlantableCell(world, cell.x, cell.y)) continue;
      if (!stability.isStable(cell.x, cell.y, nowSeconds)) continue;
      if (isBarred(cell.x, cell.y)) continue;
      if (this.isCrowded(cell.x, cell.y)) continue;
      if (!this.plant(cell.x, cell.y)) continue;
      grown.push(cell);
      quota--;
    }

    return grown;
  }

  advanceSurvey(
    world: FloraWorld,
    stability: StabilityMap,
    nowSeconds: number,
    rng: FloraRng,
    chunkBudget: number,
    isOccupied: OccupancyPredicate = NEVER_OCCUPIED,
    isBarred: BarredGround = isOccupied,
  ): SurveyResult {
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    if (totalChunks <= 0) return EMPTY_SURVEY;

    let budget = Math.floor(chunkBudget);
    if (budget <= 0) return EMPTY_SURVEY;

    while (budget > 0 && this.cursor < totalChunks) {
      this.scanChunk(
        world,
        stability,
        nowSeconds,
        rng,
        this.cursor % world.chunksPerEdge,
        Math.floor(this.cursor / world.chunksPerEdge),
        isOccupied,
        isBarred,
      );
      this.cursor++;
      budget--;
    }

    if (this.cursor < totalChunks) return EMPTY_SURVEY;

    const felled = this.cull(world, isOccupied);
    const grown = this.grow(world, stability, nowSeconds, rng, isBarred);
    this.resetSweep();

    return grown.length === 0 && felled.length === 0 ? EMPTY_SURVEY : { grown, felled };
  }

  survey(
    world: FloraWorld,
    stability: StabilityMap,
    nowSeconds: number,
    rng: FloraRng,
    isOccupied: OccupancyPredicate = NEVER_OCCUPIED,
    isBarred: BarredGround = isOccupied,
  ): SurveyResult {
    return this.advanceSurvey(
      world,
      stability,
      nowSeconds,
      rng,
      world.chunksPerEdge * world.chunksPerEdge,
      isOccupied,
      isBarred,
    );
  }
}

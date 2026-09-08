import { CHUNK_SIZE } from '@terrace/shared';
import {
  CROP_PLOT_TREAD_RING_CELLS,
  FLORA_CROP_CAP,
  cropCellOf,
  cropKey,
  type CropCell,
} from '../protocol.ts';
import { isFarmlandPlot, type FarmlandWorld } from '@terrace/shared';
import type { BarredGround } from './forest.ts';

export const CROP_SURVEY_INTERVAL_SECONDS = 5;

export interface CropSurveyResult {
  readonly sprouted: readonly CropCell[];
  readonly withered: readonly CropCell[];
}

const EMPTY_RESULT: CropSurveyResult = { sprouted: [], withered: [] };

export class CropField {
  private readonly standing = new Set<number>();

  private cursor = 0;
  private readonly staged = new Set<number>();

  get count(): number {
    return this.standing.size;
  }

  has(x: number, y: number): boolean {
    return this.standing.has(cropKey(x, y));
  }

  cells(): CropCell[] {
    return Array.from(this.standing, cropCellOf);
  }

  clear(): void {
    this.standing.clear();
    this.resetSweep();
  }

  private wither(x: number, y: number): boolean {
    return this.standing.delete(cropKey(x, y));
  }

  reactToEdit(x: number, y: number): CropCell | null {
    return this.wither(x, y) ? { x, y } : null;
  }

  private resetSweep(): void {
    this.cursor = 0;
    this.staged.clear();
  }

  private scanChunk(
    world: FarmlandWorld,
    isBarred: BarredGround,
    cx: number,
    cy: number,
  ): void {
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (let dy = 0; dy < CHUNK_SIZE; dy++) {
      const y = baseY + dy;
      for (let dx = 0; dx < CHUNK_SIZE; dx++) {
        const x = baseX + dx;

        if (isBarred(x, y)) continue;
        if (!isFarmlandPlot(world, x, y, CROP_PLOT_TREAD_RING_CELLS)) continue;
        if (this.staged.size >= FLORA_CROP_CAP) continue;
        this.staged.add(cropKey(x, y));
      }
    }
  }

  advance(
    world: FarmlandWorld & { readonly chunksPerEdge: number; isChunkUnlocked(cx: number, cy: number): boolean },
    isBarred: BarredGround,
    chunkBudget: number,
  ): CropSurveyResult | null {
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    if (totalChunks <= 0) return null;

    let budget = Math.floor(chunkBudget);
    if (budget <= 0) return null;

    while (budget > 0 && this.cursor < totalChunks) {
      const cx = this.cursor % world.chunksPerEdge;
      const cy = Math.floor(this.cursor / world.chunksPerEdge);
      if (world.isChunkUnlocked(cx, cy)) this.scanChunk(world, isBarred, cx, cy);
      this.cursor++;
      budget--;
    }
    if (this.cursor < totalChunks) return null;

    for (const key of this.staged) {
      const cell = cropCellOf(key);
      if (isBarred(cell.x, cell.y)) this.staged.delete(key);
    }

    const sprouted: CropCell[] = [];
    const withered: CropCell[] = [];
    for (const key of this.staged) {
      if (!this.standing.has(key)) sprouted.push(cropCellOf(key));
    }
    for (const key of this.standing) {
      if (!this.staged.has(key)) withered.push(cropCellOf(key));
    }

    this.standing.clear();
    for (const key of this.staged) this.standing.add(key);
    this.resetSweep();

    return sprouted.length === 0 && withered.length === 0 ? EMPTY_RESULT : { sprouted, withered };
  }

  survey(
    world: FarmlandWorld & { readonly chunksPerEdge: number; isChunkUnlocked(cx: number, cy: number): boolean },
    isBarred: BarredGround,
  ): CropSurveyResult {
    return this.advance(world, isBarred, world.chunksPerEdge * world.chunksPerEdge) ?? EMPTY_RESULT;
  }
}

export function cropSurveyChunksPerTick(
  world: { readonly chunksPerEdge: number },
  dt: number,
): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerSurvey = Math.max(1, Math.round(CROP_SURVEY_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerSurvey;
}

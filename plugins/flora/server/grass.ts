import { CHUNK_SIZE } from '@terrace/shared';
import {
  FLORA_GRASS_CAP,
  grassCellOf,
  grassCoversCell,
  grassKey,
  type GrassCell,
} from '../protocol.ts';
import { isGreenBand, type FloraWorld } from './bands.ts';
import type { BarredGround } from './forest.ts';

export const GRASS_SURVEY_INTERVAL_SECONDS = 5;

export interface GrassSurveyResult {
  readonly sprouted: readonly GrassCell[];
  readonly withered: readonly GrassCell[];
}

const EMPTY_RESULT: GrassSurveyResult = { sprouted: [], withered: [] };

export type GrassWorld = FloraWorld & {
  readonly chunksPerEdge: number;
  isChunkUnlocked(cx: number, cy: number): boolean;
};

export function isMeadowCell(
  world: FloraWorld,
  isBarred: BarredGround,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  if (isBarred(x, y)) return false;
  return isGreenBand(world.heightAt(x, y));
}

export class GrassField {
  private readonly standing = new Set<number>();

  private cursor = 0;
  private readonly staged = new Set<number>();

  get count(): number {
    return this.standing.size;
  }

  has(x: number, y: number): boolean {
    return this.standing.has(grassKey(x, y));
  }

  cells(): GrassCell[] {
    return Array.from(this.standing, grassCellOf);
  }

  clear(): void {
    this.standing.clear();
    this.resetSweep();
  }

  reactToEdit(x: number, y: number): GrassCell | null {
    if (!this.standing.delete(grassKey(x, y))) return null;
    return { x, y };
  }

  private resetSweep(): void {
    this.cursor = 0;
    this.staged.clear();
  }

  private scanChunk(
    world: GrassWorld,
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

        if (!grassCoversCell(x, y)) continue;
        if (!isMeadowCell(world, isBarred, x, y)) continue;
        if (this.staged.size >= FLORA_GRASS_CAP) continue;
        this.staged.add(grassKey(x, y));
      }
    }
  }

  advance(
    world: GrassWorld,
    isBarred: BarredGround,
    chunkBudget: number,
  ): GrassSurveyResult | null {
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
      const cell = grassCellOf(key);
      if (isBarred(cell.x, cell.y)) this.staged.delete(key);
    }

    const sprouted: GrassCell[] = [];
    const withered: GrassCell[] = [];
    for (const key of this.staged) {
      if (!this.standing.has(key)) sprouted.push(grassCellOf(key));
    }
    for (const key of this.standing) {
      if (!this.staged.has(key)) withered.push(grassCellOf(key));
    }

    this.standing.clear();
    for (const key of this.staged) this.standing.add(key);
    this.resetSweep();

    return sprouted.length === 0 && withered.length === 0 ? EMPTY_RESULT : { sprouted, withered };
  }

  survey(
    world: GrassWorld,
    isBarred: BarredGround,
  ): GrassSurveyResult {
    return (
      this.advance(world, isBarred, world.chunksPerEdge * world.chunksPerEdge) ??
      EMPTY_RESULT
    );
  }
}

export function grassSurveyChunksPerTick(
  world: { readonly chunksPerEdge: number },
  dt: number,
): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerSurvey = Math.max(1, Math.round(GRASS_SURVEY_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerSurvey;
}

import { CHUNK_SIZE, isWater } from '@terrace/shared';
import {
  FLORA_FRINGE_CAP,
  FRINGE_REED_SHORE_RADIUS_CELLS,
  fringeCellOf,
  fringeCoversCell,
  fringeKey,
  type FringeCell,
  type FringeSpecies,
} from '../protocol.ts';
import { fringeSpeciesForHeight, type FloraWorld } from './bands.ts';
import type { BarredGround } from './forest.ts';

export const FRINGE_SURVEY_INTERVAL_SECONDS = 5;

export interface FringePlant {
  readonly cell: FringeCell;
  readonly species: FringeSpecies;
}

export interface FringeSurveyResult {
  readonly sprouted: readonly FringePlant[];
  readonly withered: readonly FringeCell[];
}

const EMPTY_RESULT: FringeSurveyResult = { sprouted: [], withered: [] };

export type FringeWorld = FloraWorld;

function hasWaterWithinShoreRadius(world: FringeWorld, x: number, y: number): boolean {
  const radius = FRINGE_REED_SHORE_RADIUS_CELLS;
  for (let dy = -radius; dy <= radius; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= world.worldSize) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= world.worldSize) continue;
      if (isWater(world.heightAt(nx, ny))) return true;
    }
  }
  return false;
}

export function fringeGrowthAt(
  world: FringeWorld,
  x: number,
  y: number,
): FringeSpecies | null {
  const species = fringeSpeciesForHeight(world.heightAt(x, y));
  if (species === null) return null;
  if (!fringeCoversCell(x, y, species)) return null;
  if (species === 'reed' && !hasWaterWithinShoreRadius(world, x, y)) return null;
  return species;
}

export class FringeField {
  private readonly standing = new Map<number, FringeSpecies>();

  private cursor = 0;
  private readonly staged = new Map<number, FringeSpecies>();

  get count(): number {
    return this.standing.size;
  }

  has(x: number, y: number): boolean {
    return this.standing.has(fringeKey(x, y));
  }

  speciesAt(x: number, y: number): FringeSpecies | null {
    return this.standing.get(fringeKey(x, y)) ?? null;
  }

  plants(): FringePlant[] {
    return Array.from(this.standing, ([key, species]) => ({ cell: fringeCellOf(key), species }));
  }

  cells(): FringeCell[] {
    return Array.from(this.standing.keys(), fringeCellOf);
  }

  clear(): void {
    this.standing.clear();
    this.resetSweep();
  }

  reactToEdit(x: number, y: number): FringeCell | null {
    if (!this.standing.delete(fringeKey(x, y))) return null;
    return { x, y };
  }

  private resetSweep(): void {
    this.cursor = 0;
    this.staged.clear();
  }

  private scanChunk(
    world: FringeWorld,
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
        const species = fringeGrowthAt(world, x, y);
        if (species === null) continue;
        if (this.staged.size >= FLORA_FRINGE_CAP) continue;
        this.staged.set(fringeKey(x, y), species);
      }
    }
  }

  advance(
    world: FringeWorld,
    isBarred: BarredGround,
    chunkBudget: number,
  ): FringeSurveyResult | null {
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

    for (const key of this.staged.keys()) {
      const cell = fringeCellOf(key);
      if (isBarred(cell.x, cell.y)) this.staged.delete(key);
    }

    const sprouted: FringePlant[] = [];
    const withered: FringeCell[] = [];
    for (const [key, species] of this.staged) {
      if (this.standing.get(key) !== species) sprouted.push({ cell: fringeCellOf(key), species });
    }
    for (const key of this.standing.keys()) {
      if (!this.staged.has(key)) withered.push(fringeCellOf(key));
    }

    this.standing.clear();
    for (const [key, species] of this.staged) this.standing.set(key, species);
    this.resetSweep();

    return sprouted.length === 0 && withered.length === 0 ? EMPTY_RESULT : { sprouted, withered };
  }

  survey(world: FringeWorld, isBarred: BarredGround): FringeSurveyResult {
    return (
      this.advance(world, isBarred, world.chunksPerEdge * world.chunksPerEdge) ?? EMPTY_RESULT
    );
  }
}

export function fringeSurveyChunksPerTick(
  world: { readonly chunksPerEdge: number },
  dt: number,
): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerSurvey = Math.max(1, Math.round(FRINGE_SURVEY_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerSurvey;
}

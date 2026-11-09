import { DRAWN_GROUND_CELL_CENTRE, chunkIndexOfCell, drawnSampleCellIndex } from '@terrace/shared';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import { treeCellOf, treeKey } from '../protocol.ts';

export type GroundContext = Pick<ClientPluginCtx, 'drawnGroundYAt' | 'worldSize'>;
type GroundResolver = (ctx: GroundContext, x: number, y: number) => number | null;

const groundAt: GroundResolver = (ctx, x, y) => ctx.drawnGroundYAt(x, y);

interface GroundEntry {
  readonly chunks: ReadonlySet<number>;
  readonly height: number | null;
}

export class FloraGroundChanges {
  private readonly entries = new Map<number, GroundEntry>();
  private readonly cellsByChunk = new Map<number, Set<number>>();

  private readonly resolveGround: GroundResolver;
  constructor(resolveGround: GroundResolver = groundAt) {
    this.resolveGround = resolveGround;
  }

  clear(): void {
    this.entries.clear();
    this.cellsByChunk.clear();
  }

  delete(key: number): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    for (const chunk of entry.chunks) {
      const cells = this.cellsByChunk.get(chunk)!;
      cells.delete(key);
      if (cells.size === 0) this.cellsByChunk.delete(chunk);
    }
    this.entries.delete(key);
  }

  sample(ctx: GroundContext, x: number, y: number): number | null {
    const key = treeKey(x, y);
    const size = ctx.worldSize();
    const clamp = (cell: number): number => Math.max(0, Math.min(size - 1, cell));
    const chunks = new Set<number>();
    const height = this.resolveGround({
      worldSize: () => size,
      drawnGroundYAt: (sx, sy) => {
        const x0 = drawnSampleCellIndex(sx + DRAWN_GROUND_CELL_CENTRE);
        const y0 = drawnSampleCellIndex(sy + DRAWN_GROUND_CELL_CENTRE);
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            chunks.add(chunkIndexOfCell(size, clamp(x0 + dx), clamp(y0 + dy)));
          }
        }
        return ctx.drawnGroundYAt(sx, sy);
      },
    }, x, y);
    this.delete(key);
    for (const chunk of chunks) {
      let cells = this.cellsByChunk.get(chunk);
      if (cells === undefined) {
        cells = new Set();
        this.cellsByChunk.set(chunk, cells);
      }
      cells.add(key);
    }
    this.entries.set(key, { chunks, height });
    return height;
  }

  heightAt(x: number, y: number): number | null {
    return this.entries.get(treeKey(x, y))?.height ?? null;
  }

  invalidate(ctx: GroundContext, dirty: ReadonlySet<number>): number[] {
    const affected = new Set<number>();
    for (const chunk of dirty) {
      const cells = this.cellsByChunk.get(chunk);
      if (cells === undefined) continue;
      for (const key of cells) affected.add(key);
    }
    const changed: number[] = [];
    for (const key of affected) {
      const cell = treeCellOf(key);
      const previous = this.entries.get(key)!.height;
      if (this.sample(ctx, cell.x, cell.y) !== previous) changed.push(key);
    }
    return changed;
  }
}

import { chunkIndexOfCell, drawnSampleCellIndex } from '@terrace/shared';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import { treeCellOf, treeKey } from '../protocol.ts';

type GroundContext = Pick<ClientPluginCtx, 'drawnGroundYAt' | 'worldSize'>;
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
  private readonly radius: number;

  constructor(resolveGround: GroundResolver = groundAt, radius = 0) {
    this.resolveGround = resolveGround;
    this.radius = radius;
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
    const height = this.resolveGround(ctx, x, y);
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.set(key, { chunks: previous.chunks, height });
      return height;
    }
    const size = ctx.worldSize();
    const clamp = (cell: number): number => Math.max(0, Math.min(size - 1, cell));
    const x0 = drawnSampleCellIndex(x - this.radius);
    const y0 = drawnSampleCellIndex(y - this.radius);
    const x1 = drawnSampleCellIndex(x + this.radius) + 1;
    const y1 = drawnSampleCellIndex(y + this.radius) + 1;
    const chunks = new Set<number>();
    for (let sampleY = y0; sampleY <= y1; sampleY++) {
      for (let sampleX = x0; sampleX <= x1; sampleX++) {
        chunks.add(chunkIndexOfCell(size, clamp(sampleX), clamp(sampleY)));
      }
    }
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

  invalidate(ctx: GroundContext, dirty: ReadonlySet<number>, pending: Set<number>): void {
    const checked = new Set<number>();
    for (const chunk of dirty) {
      const cells = this.cellsByChunk.get(chunk);
      if (cells === undefined) continue;
      for (const key of cells) {
        if (checked.has(key)) continue;
        checked.add(key);
        const cell = treeCellOf(key);
        if (this.resolveGround(ctx, cell.x, cell.y) !== this.entries.get(key)!.height) {
          pending.add(key);
        }
      }
    }
  }
}

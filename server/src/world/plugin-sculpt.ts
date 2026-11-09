import { applySculpt, type CellDiff, type Heightmap, type SculptOptions } from '@terrace/shared';
import type { PluginSculptResult, PluginSculptStep } from '../plugins/types.ts';

function sameCell(source: Heightmap, target: Heightmap, index: number): boolean {
  if (source.cells[index] !== target.cells[index]) return false;
  const a = source.columnSpans.get(index);
  const b = target.columnSpans.get(index);
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function copyCell(source: Heightmap, target: Heightmap, cell: CellDiff): void {
  const index = cell.y * source.size + cell.x;
  target.cells[index] = source.cells[index]!;
  const spans = source.columnSpans.get(index);
  if (spans === undefined) target.columnSpans.delete(index);
  else target.columnSpans.set(index, spans.slice());
}

/** Reuses a full clone; authoritative diffs synchronize it without copying the world per edit. */
export class PluginSculptPreview {
  private scratch: Heightmap | null = null;
  private computing = false;
  private readonly map: Heightmap;

  constructor(map: Heightmap) {
    this.map = map;
  }

  reset(): void {
    this.scratch = null;
  }

  synchronize(diff: readonly CellDiff[]): void {
    if (this.scratch === null) return;
    for (const cell of diff) copyCell(this.map, this.scratch, cell);
  }

  applyBatch(
    steps: readonly PluginSculptStep[],
    options: SculptOptions,
    refusalAt: (x: number, y: number) => 'locked' | 'forbidden' | null,
  ): PluginSculptResult {
    if (this.computing) throw new Error('a plugin sculpt permission cannot start another sculpt');
    this.computing = true;
    try {
      if (steps.length === 0) return { ok: true, cells: [] };
      const scratch = this.scratch ??= {
        size: this.map.size,
        cells: this.map.cells.slice(),
        columnSpans: new Map([...this.map.columnSpans].map(([index, spans]) => [index, spans.slice()] as const)),
      };
      const writes = new Map<number, CellDiff>();
      for (const step of steps) {
        const diff = applySculpt(scratch, step.x, step.y, step.radius, step.amount, options);
        for (const cell of diff) writes.set(cell.y * this.map.size + cell.x, cell);
        for (const { x, y } of diff) {
          const reason = refusalAt(x, y);
          if (reason !== null) {
            for (const cell of writes.values()) copyCell(this.map, scratch, cell);
            return { ok: false, reason, cell: { x, y } };
          }
        }
      }
      const diff = [...writes].sort(([a], [b]) => a - b)
        .filter(([index]) => !sameCell(scratch, this.map, index)).map(([, cell]) => cell);
      for (const cell of diff) copyCell(scratch, this.map, cell);
      return { ok: true, cells: diff };
    } catch (error) {
      // A failed computation may have partially written scratch, never authoritative terrain.
      this.reset();
      throw error;
    } finally {
      this.computing = false;
    }
  }
}

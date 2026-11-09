import { treeCellOf, treeKey, type TreeCell } from '../protocol.ts';
import { FloraGroundChanges, type GroundContext } from './groundChanges.ts';
import type { GroundLookup } from './placement.ts';

interface PlacementResult<Placement> {
  readonly placements: Placement[];
  readonly pendingCells: number[];
}

interface PlantModels<Placement> {
  apply(placements: readonly Placement[]): void;
  applyDelta(placements: readonly Placement[], removed: readonly TreeCell[]): void;
}

export class GroundedPlants<Cell extends TreeCell, Placement> {
  private readonly standing = new Map<number, Cell>();

  private readonly models: PlantModels<Placement>;
  private readonly place: (cells: Iterable<Cell>, groundAt: GroundLookup) => PlacementResult<Placement>;
  private readonly ground: FloraGroundChanges;

  constructor(
    models: PlantModels<Placement>,
    place: (cells: Iterable<Cell>, groundAt: GroundLookup) => PlacementResult<Placement>,
    ground = new FloraGroundChanges(),
  ) {
    this.models = models;
    this.place = place;
    this.ground = ground;
  }

  get cells(): ReadonlyMap<number, Cell> {
    return this.standing;
  }

  readonly heightAt = (x: number, y: number): number | null => this.ground.heightAt(x, y);

  replace(ctx: GroundContext, cells: Iterable<Cell>): void {
    this.standing.clear();
    this.ground.clear();
    for (const cell of cells) this.standing.set(treeKey(cell.x, cell.y), cell);
    this.models.apply(this.place(this.standing.values(), (x, y) => this.ground.sample(ctx, x, y)).placements);
  }

  change(ctx: GroundContext, added: readonly Cell[], removed: readonly TreeCell[]): void {
    if (added.length === 0 && removed.length === 0) return;
    for (const cell of removed) {
      const key = treeKey(cell.x, cell.y);
      this.standing.delete(key);
      this.ground.delete(key);
    }
    const updated = new Map<number, Cell>();
    for (const cell of added) {
      const key = treeKey(cell.x, cell.y);
      this.standing.set(key, cell);
      updated.set(key, cell);
    }
    const result = this.place(updated.values(), (x, y) => this.ground.sample(ctx, x, y));
    this.models.applyDelta(result.placements, [...removed, ...result.pendingCells.map(treeCellOf)]);
  }

  terrainChanged(ctx: GroundContext, dirty: ReadonlySet<number>): void {
    const changed = this.ground.invalidate(ctx, dirty);
    if (changed.length === 0) return;
    const cells = changed.map((key) => this.standing.get(key)!);
    const result = this.place(cells, this.heightAt);
    this.models.applyDelta(result.placements, result.pendingCells.map(treeCellOf));
  }

  clear(): void {
    this.standing.clear();
    this.ground.clear();
    this.models.apply([]);
  }
}

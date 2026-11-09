import { CHUNK_SIZE, CELL_WORLD_SIZE, DRAWN_GROUND_CELL_CENTRE, isFarmlandPlot } from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import { CROP_PLOT_TREAD_RING_CELLS, treeKey, type TreeCell } from '../protocol.ts';
import { CropField } from '../server/crops.ts';
import { cropPlacementsFor } from '../client/cropPlacement.ts';
import type { CropPlacement } from '../client/cropModels.ts';
import { FloraGroundChanges, type GroundContext } from '../client/groundChanges.ts';
import { GroundedPlants } from '../client/groundedPlants.ts';
import { TRUNK_BOTTOM_RADIUS, type TreePlacement } from '../client/models.ts';
import { placementsFor, supportedTreeGroundAt } from '../client/placement.ts';
import { treeVariation } from '../protocol.ts';

function recordingModels<Placement>() {
  const replacements: Array<readonly Placement[]> = [];
  const changes: Array<{ placed: readonly Placement[]; removed: readonly TreeCell[] }> = [];
  return {
    replacements,
    changes,
    apply(placed: readonly Placement[]): void { replacements.push(placed); },
    applyDelta(placed: readonly Placement[], removed: readonly TreeCell[]): void {
      changes.push({ placed, removed });
    },
  };
}

describe('flora grounding dependencies', () => {
  it('retries only affected support once, then forgets removed and reset plants', () => {
    const models = recordingModels<CropPlacement>();
    const plants = new GroundedPlants(models, cropPlacementsFor);
    const edgeCell = { x: CHUNK_SIZE - 1, y: CHUNK_SIZE - 1 };
    const farCell = { x: CHUNK_SIZE * 2 + 4, y: CHUNK_SIZE * 2 + 4 };
    let height: number | null = null;
    let reads = 0;
    const ctx: GroundContext = {
      worldSize: () => CHUNK_SIZE * 4,
      drawnGroundYAt: (x) => { reads++; return x === edgeCell.x ? height : 2; },
    };
    plants.replace(ctx, [edgeCell, farCell]);
    expect(models.replacements[0]).toHaveLength(1);
    reads = 0;
    plants.terrainChanged(ctx, new Set([15]));
    expect(reads).toBe(0);
    expect(models.changes).toHaveLength(0);

    height = 2;
    plants.terrainChanged(ctx, new Set([1]));
    expect(reads).toBe(1);
    expect(models.changes).toHaveLength(1);
    expect(models.changes[0]?.placed[0]).toMatchObject({ cellX: edgeCell.x, cellY: edgeCell.y });

    reads = 0;
    plants.terrainChanged(ctx, new Set([0, 1, 4, 5]));
    expect(reads).toBe(1);
    expect(models.changes).toHaveLength(1);
    height = null;
    plants.terrainChanged(ctx, new Set([0]));
    expect(models.changes[1]).toEqual({ placed: [], removed: [edgeCell] });

    plants.change(ctx, [], [edgeCell]);
    reads = 0;
    plants.terrainChanged(ctx, new Set([0, 1, 4, 5]));
    expect(reads).toBe(0);
    plants.clear();
    plants.terrainChanged(ctx, new Set([10]));
    expect(reads).toBe(0);
    expect(plants.cells.size).toBe(0);
  });

  it('samples only a delta and reuses the resolved tree support for placement', () => {
    const models = recordingModels<TreePlacement>();
    const ground = new FloraGroundChanges((ctx, x, y) =>
      supportedTreeGroundAt(ctx.drawnGroundYAt, x, y, ctx.worldSize()),
    );
    const plants = new GroundedPlants(models, placementsFor, ground);
    let height = 2;
    let reads = 0;
    const ctx: GroundContext = {
      worldSize: () => CHUNK_SIZE * 8,
      drawnGroundYAt: () => { reads++; return height; },
    };
    plants.replace(ctx, [{ x: 20, y: 20 }, { x: 80, y: 80 }]);
    reads = 0;
    plants.change(ctx, [{ x: 40, y: 40 }], []);
    expect(reads).toBe(5);
    expect(models.replacements).toHaveLength(1);
    height = 3;
    reads = 0;
    plants.terrainChanged(ctx, new Set([9]));
    expect(reads).toBe(5);
    expect(models.changes[1]?.placed).toHaveLength(1);
    expect(models.changes[1]?.placed[0]).toMatchObject({ cellX: 20, cellY: 20, groundY: 3 });
    expect(plants.heightAt(20, 20)).toBe(3);
  });

  it('updates dependencies when a previously blocked support probe becomes available', () => {
    let known = false;
    let reads = 0;
    const ground = new FloraGroundChanges((ctx, x, y) => {
      const first = ctx.drawnGroundYAt(x, y);
      return first === null ? null : ctx.drawnGroundYAt(x + CHUNK_SIZE, y);
    });
    const ctx: GroundContext = {
      worldSize: () => CHUNK_SIZE * 4,
      drawnGroundYAt: () => { reads++; return known ? 2 : null; },
    };
    ground.sample(ctx, 4, 4);
    known = true;
    expect(ground.invalidate(ctx, new Set([0]))).toEqual([treeKey(4, 4)]);
    reads = 0;
    ground.invalidate(ctx, new Set([1]));
    expect(reads).toBe(2);
  });
});

describe('tree support at rendered world edges', () => {
  it('admits trunks inside edge cells and rejects trunks extending beyond either side', () => {
    const size = CHUNK_SIZE * 4;
    for (const cell of [{ x: 20, y: 0 }, { x: 0, y: 20 }, { x: 20, y: size - 1 }, { x: size - 1, y: 20 }]) {
      const radius = TRUNK_BOTTOM_RADIUS * treeVariation(cell.x, cell.y).scale / CELL_WORLD_SIZE;
      const expected = radius <= DRAWN_GROUND_CELL_CENTRE ? 2 : null;
      expect(supportedTreeGroundAt(() => 2, cell.x, cell.y, size)).toBe(expected);
    }
    expect(supportedTreeGroundAt(() => 2, -1, 20, size)).toBeNull();
    expect(supportedTreeGroundAt(() => 2, size, 20, size)).toBeNull();
    expect(supportedTreeGroundAt((x) => x < 20 ? 1 : 2, 20, 20, size)).toBeNull();
  });
});

describe('crop sweep commit', () => {
  it('revalidates full neighbor eligibility before committing staged plots', () => {
    const size = CHUNK_SIZE * 2;
    let changed = false;
    const world = {
      worldSize: size,
      chunksPerEdge: size / CHUNK_SIZE,
      isCellUnlocked: () => true,
      isChunkUnlocked: () => true,
      heightAt: (x: number, y: number) => x === 0 ? -16 : changed && x === 3 && y === 5 ? 64 : 48,
    };
    const field = new CropField();
    expect(isFarmlandPlot(world, 2, 5, CROP_PLOT_TREAD_RING_CELLS)).toBe(true);
    field.advance(world, () => false, 1);
    changed = true;
    field.reactToEdit(3, 5);
    expect(isFarmlandPlot(world, 2, 5, CROP_PLOT_TREAD_RING_CELLS)).toBe(false);
    const result = field.advance(world, () => false, 3);
    expect(field.has(2, 5)).toBe(false);
    expect(result?.sprouted).not.toContainEqual({ x: 2, y: 5 });
  });
});

import { CELL_WORLD_SIZE, CHUNK_SIZE, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';
import { Raycaster, Vector3, type Intersection, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { createTerrainMirror } from '../src/terrain/mirror.ts';
import { pickPointedCellByRay, worldPointToCell } from '../src/terrain/picking.ts';
import { FLORA_PINE_MIN_HEIGHT, treeKey } from '../../plugins/flora/protocol.ts';
import { createFloraModels, type TreePlacement } from '../../plugins/flora/client/models.ts';
import { cropOccupancy, treeOccupancy } from '../../plugins/flora/client/occupancy.ts';
import { placementsFor } from '../../plugins/flora/client/placement.ts';

describe('flora picking ownership', () => {
  it('returns a pine anchor when either picking path hits its crown over another cell', () => {
    const size = CHUNK_SIZE * 4;
    const tree = { x: 20, y: 20 };
    const groundY = FLORA_PINE_MIN_HEIGHT * MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;
    const mirror = createTerrainMirror(size);
    mirror.map.cells.fill(FLORA_PINE_MIN_HEIGHT);
    for (let i = 0; i < (size / CHUNK_SIZE) ** 2; i++) mirror.received.add(i);
    const origin = new Vector3((tree.x + 1) * CELL_WORLD_SIZE, groundY + 5, tree.y * CELL_WORLD_SIZE);
    const direction = new Vector3(0, -1, 0);
    const occupied = treeOccupancy(new Map([[treeKey(tree.x, tree.y), tree]]), () => groundY);
    const pointed = pickPointedCellByRay(mirror, origin, direction, [occupied]);
    expect(pointed).toMatchObject(tree);
    expect(pointed?.distance).toBeGreaterThan(0);

    const models = createFloraModels();
    try {
      models.apply(placementsFor([tree], () => groundY).placements);
      models.root.updateMatrixWorld(true);
      const hit = new Raycaster(origin, direction).intersectObject(models.root, true)[0]!;
      expect(hit.object.name).toBe('flora:pines');
      expect(worldPointToCell(hit.point.x, hit.point.z, size)).toEqual({ x: 21, y: 20 });
      expect(models.cellOfHit(hit)).toEqual(tree);
    } finally {
      models.dispose();
    }
  });

  it('does not merge separate crowns into an occupied gap, and chooses the first intersected owner', () => {
    const low = { x: 20, y: 20 }, high = { x: 21, y: 20 };
    const cells = new Map([low, high].map((cell) => [treeKey(cell.x, cell.y), cell]));
    const groundAt = (x: number) => x === high.x ? 4 : 0;
    const trees = treeOccupancy(cells, groundAt);
    const crops = cropOccupancy(cells, groundAt, { horizontal: CELL_WORLD_SIZE, up: 1, down: 0 });
    const chord = {
      fromX: 20.5 * CELL_WORLD_SIZE, toX: 20.5 * CELL_WORLD_SIZE,
      fromZ: 20 * CELL_WORLD_SIZE, toZ: 20 * CELL_WORLD_SIZE,
      fromY: 3.5, toY: 3,
    };
    expect(trees(20, 20, chord)).toBeNull();
    expect(crops(20, 20, chord)).toBeNull();
    const column = trees(20, 20, { ...chord, fromY: 8, toY: -1 });
    expect(column?.cell).toEqual(high);
    expect(column!.loY).toBeGreaterThanOrEqual(4);
  });

  it('keeps exact-hit anchors correct after slot compaction, kind changes and reset', () => {
    const models = createFloraModels();
    const placement = (x: number, kind: TreePlacement['kind']): TreePlacement => ({
      x, z: 0, cellX: x, cellY: 0, kind, groundY: 0, scale: 1, yaw: 0,
    });
    const hit = (object: Object3D, instanceId: number): Intersection => ({
      object, instanceId, distance: 0, point: new Vector3(),
    });
    try {
      models.apply([placement(0, 'conifer'), placement(1, 'pine'), placement(2, 'pine')]);
      models.applyDelta([], [{ x: 1, y: 0 }]);
      const pine = models.root.getObjectByName('flora:pines')!;
      expect(models.cellOfHit(hit(pine, 0))).toEqual({ x: 2, y: 0 });
      expect(models.cellOfHit(hit(pine, 1))).toBeNull();
      models.applyDelta([placement(2, 'broadleaf')], []);
      expect(models.cellOfHit(hit(pine, 0))).toBeNull();
      const broadleaf = models.root.getObjectByName('flora:broadleaves')!;
      expect(models.cellOfHit(hit(broadleaf, 0))).toEqual({ x: 2, y: 0 });
      models.apply([]);
      expect(models.cellOfHit(hit(broadleaf, 0))).toBeNull();
    } finally {
      models.dispose();
    }
  });

});

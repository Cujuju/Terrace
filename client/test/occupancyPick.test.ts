import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../src/config.ts';
import { createTerrainMirror } from '../src/terrain/mirror.ts';
import { pickPointedCellByRay, type CellOccupancy } from '../src/terrain/picking.ts';

describe('occupied terrain picking', () => {
  it('uses the nearest contributing column independently of registration order', () => {
    const mirror = createTerrainMirror(CHUNK_SIZE);
    mirror.received.add(0);
    const hit = pickPointedCellByRay(mirror,
      { x: CELL_WORLD_SIZE * 4, y: 4, z: CELL_WORLD_SIZE * 8 }, { x: 0, y: -1, z: 0 },
      [() => ({ loY: 0, hiY: 1, cell: { x: 7, y: 8 } }),
        () => ({ loY: 2, hiY: 3, cell: { x: 9, y: 8 } })]);
    expect(hit).toEqual({ x: 9, y: 8, distance: 1 });
  });

  it('returns the contributing owner cell and passes ray-consistent XYZ chord endpoints', () => {
    const size = CHUNK_SIZE * 4;
    const mirror = createTerrainMirror(size);
    for (let i = 0; i < (size / CHUNK_SIZE) ** 2; i++) mirror.received.add(i);
    const origin = { x: CELL_WORLD_SIZE, y: 4, z: CELL_WORLD_SIZE * 8 };
    const direction = { x: 1, y: -0.1, z: 0 };
    const owner = { x: 7, y: 8 };
    let chordsChecked = 0;
    const occupancy: CellOccupancy = (x, y, chord) => {
      expect(chord.fromY).toBeCloseTo(origin.y + (chord.fromX - origin.x) * direction.y);
      expect(chord.toY).toBeCloseTo(origin.y + (chord.toX - origin.x) * direction.y);
      chordsChecked++;
      return x === 4 && y === 8 ? { loY: 1, hiY: 5, cell: owner } : null;
    };
    const hit = pickPointedCellByRay(mirror, origin, direction, [occupancy]);
    expect(chordsChecked).toBeGreaterThan(0);
    expect(hit).toMatchObject(owner);
    expect(hit!.distance).toBeGreaterThan(0);
  });

  it('retains marched-cell ownership for existing occupancies without an owner', () => {
    const mirror = createTerrainMirror(CHUNK_SIZE);
    mirror.received.add(0);
    const hit = pickPointedCellByRay(mirror,
      { x: CELL_WORLD_SIZE * 4, y: 4, z: CELL_WORLD_SIZE * 8 }, { x: 0, y: -1, z: 0 },
      [() => ({ loY: 1, hiY: 3 })]);
    expect(hit).toEqual({ x: 4, y: 8, distance: 1 });
  });
});

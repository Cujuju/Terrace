import { describe, expect, it } from 'vitest';
import { Group, Mesh, type BufferAttribute } from 'three';
import { BAND_HEIGHT, cellIndex, chunksPerEdge, computeRiverNetwork } from '@terrace/shared';
import { createRiverRig, WATER_TILE_FRAME_BUDGET_MS } from '../src/render/riverRig.ts';
import { flattenRiverNetwork } from '../src/render/water/riverSurface.ts';
import { createTerrainMirror } from '../src/terrain/mirror.ts';

const WORLD = 64;
const SUMMIT = BAND_HEIGHT * 20;
const DROP_PER_CELL = BAND_HEIGHT * 5;
const CLOCK_STEP_MS = 0.4;
const MAX_TILES_PER_FRAME = Math.ceil(WATER_TILE_FRAME_BUDGET_MS / CLOCK_STEP_MS);
const FRAME_LIMIT = 200;

function coneMirror() {
  const mirror = createTerrainMirror(WORLD);
  const cx = WORLD / 2;
  for (let y = 0; y < WORLD; y++) {
    for (let x = 0; x < WORLD; x++) {
      const r = Math.max(Math.abs(x - cx), Math.abs(y - cx));
      mirror.map.cells[cellIndex(mirror.map, x, y)] = Math.max(0, SUMMIT - r * DROP_PER_CELL);
    }
  }
  const chunkCount = chunksPerEdge(WORLD) ** 2;
  for (let c = 0; c < chunkCount; c++) mirror.received.add(c);
  return mirror;
}

function rigOn(mirror: ReturnType<typeof coneMirror>, now: () => number) {
  const parent = new Group();
  let frame: ((dt: number) => void) | null = null;
  const rig = createRiverRig(parent, (h) => ((frame = h), () => {}), {
    networkSource: { compute: () => flattenRiverNetwork(mirror.map, computeRiverNetwork(mirror.map)), dispose: () => {} },
    now,
  });
  const water = parent.children.find((c): c is Mesh => c instanceof Mesh)!;
  const triangles = (): string[] => {
    const pos = water.geometry.getAttribute('position') as BufferAttribute;
    const live = water.geometry.drawRange.count;
    const out: string[] = [];
    for (let v = 0; v < live; v += 3) {
      out.push(Array.from(pos.array.subarray(v * 3, v * 3 + 9), (n) => n.toFixed(4)).join(','));
    }
    return out.sort();
  };
  return { rig, pump: () => frame!(1 / 60), triangles };
}

const frozenClock = () => 0;

describe('the water-tile drain', () => {
  it('never marches more tiles than the budget allows, and always one', () => {
    const mirror = coneMirror();
    let calls = 0;
    const { rig, pump } = rigOn(mirror, () => ++calls * CLOCK_STEP_MS);
    rig.forceRefresh(mirror);
    const tilesPerFrame: number[] = [];
    for (let f = 0; f < FRAME_LIMIT; f++) {
      calls = 0;
      pump();
      if (calls === 0) break;
      tilesPerFrame.push(calls - 1);
    }
    expect(tilesPerFrame.length).toBeGreaterThan(1);
    for (const tiles of tilesPerFrame) {
      expect(tiles).toBeGreaterThanOrEqual(1);
      expect(tiles).toBeLessThanOrEqual(MAX_TILES_PER_FRAME);
    }
  });

  it('ends with the same triangles as an unbudgeted rebuild', () => {
    const mirror = coneMirror();
    let calls = 0;
    const budgeted = rigOn(mirror, () => ++calls * CLOCK_STEP_MS);
    const whole = rigOn(mirror, frozenClock);
    budgeted.rig.forceRefresh(mirror);
    whole.rig.forceRefresh(mirror);
    for (let f = 0; f < FRAME_LIMIT; f++) {
      budgeted.pump();
      whole.pump();
    }
    expect(budgeted.triangles().length).toBeGreaterThan(0);
    expect(budgeted.triangles()).toEqual(whole.triangles());
  });

  it('carries undrained tiles into the next rebuild', () => {
    const mirror = coneMirror();
    let calls = 0;
    const budgeted = rigOn(mirror, () => ++calls * CLOCK_STEP_MS);
    const whole = rigOn(mirror, frozenClock);
    budgeted.rig.forceRefresh(mirror);
    budgeted.pump();
    budgeted.rig.forceRefresh(mirror);
    whole.rig.forceRefresh(mirror);
    for (let f = 0; f < FRAME_LIMIT; f++) {
      budgeted.pump();
      whole.pump();
    }
    expect(budgeted.triangles()).toEqual(whole.triangles());
  });
});

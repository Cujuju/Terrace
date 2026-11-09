import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHeightmap, createChunkMask, unlockChunk, chunkIndex, CHUNK_SIZE } from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { World } from '../../../server/src/world/world.ts';
import { asLoadedPluginExporting } from '../../../server/test/support/harness.ts';
import * as structures from '../../structures/server/index.ts';
import * as boats from '../server/index.ts';
import { livingBoats, villageCount } from '../server/fleet.ts';
import { BOAT_REBUILD_SECONDS } from '../protocol.ts';

const WORLD_SIZE = 128;
const SHORE_X = 50;
const HOME = { x: 39, y: 38 };
const TICK_SECONDS = 0.1;
let host: PluginHost | null = null;

function open(boatsSlice?: unknown, structuresEnabled = true): PluginHost {
  const map = createHeightmap(WORLD_SIZE);
  const mask = createChunkMask(WORLD_SIZE);
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) map.cells[y * WORLD_SIZE + x] = x < SHORE_X ? 96 : -100;
  }
  for (let cy = 0; cy < WORLD_SIZE / CHUNK_SIZE; cy++) {
    for (let cx = 0; cx < WORLD_SIZE / CHUNK_SIZE; cx++) unlockChunk(mask, chunkIndex(WORLD_SIZE, cx, cy));
  }
  const world = World.restore(WORLD_SIZE, map.cells, mask, undefined, 'Boat bootstrap fixture');
  const session = new PluginHost(world, [
    asLoadedPluginExporting(boats.plugin, boats),
    asLoadedPluginExporting(structures.plugin, structures),
  ], new Set(structuresEnabled ? ['boats', 'structures'] : ['boats']));
  host = session;
  session.restorePersistence({
    structures: { v: 4, data: {
      version: 4, rngState: 1, generation: 100, lastSeedDay: 0,
      live: [{ ...HOME, age: 100, tier: 10, building: 'durands' }],
    } },
    ...(boatsSlice === undefined ? {} : { boats: { v: 1, data: boatsSlice } }),
  });
  session.worldCreate();
  return session;
}

function restoredBoat(id: number, homeX = HOME.x) {
  return { id, homeX, homeY: HOME.y, x: 65, y: 38, heading: 0, fighting: false };
}

beforeEach(() => { boats.resetBoatsState(); structures.resetStructuresState(); });
afterEach(() => { host?.closeWorld(); host?.revokeApis(); host = null; });

describe('shipyard bootstrap through the enabled sibling', () => {
  it('launches for a restored mature village without another upgrade event', () => {
    const session = open();
    for (let tick = 0; tick <= BOAT_REBUILD_SECONDS / TICK_SECONDS; tick++) session.tick(TICK_SECONDS);
    expect(structures.standingStructures()[0]?.building).toBe('durands');
    expect(villageCount()).toBe(1);
    expect(livingBoats()).toHaveLength(1);
  });

  it('reconciles missed village deaths and keeps a surviving boat identity', () => {
    const session = open({
      villages: [HOME, { x: 40, y: HOME.y }].map((cell) => ({ ...cell, rebuildSeconds: 0 })),
      boats: [restoredBoat(1), restoredBoat(2, 40)], nextBoatId: 3,
    });
    session.tick(TICK_SECONDS);
    expect(villageCount()).toBe(1);
    expect(livingBoats().map((boat) => boat.id)).toEqual([1]);
  });

  it('preserves saved villages when structures is disabled', () => {
    const session = open({
      villages: [{ ...HOME, rebuildSeconds: 0 }], boats: [restoredBoat(1)], nextBoatId: 2,
    }, false);
    session.tick(TICK_SECONDS);
    expect(villageCount()).toBe(1);
    expect(livingBoats().map((boat) => boat.id)).toEqual([1]);
  });
});

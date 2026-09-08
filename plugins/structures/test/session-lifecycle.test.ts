import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT } from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
  worldWithSibling,
} from '../../../server/test/support/harness.ts';
import type { Player } from '../../../server/src/player.ts';
import {
  bridgedStructures,
  loadStructuresBridge,
  resetStructuresBridge,
} from '../../flora/server/structures-bridge.ts';
import { STRUCTURES_CHANGES_MESSAGE, STRUCTURES_PLUGIN_NAME, structureKey } from '../protocol.ts';
import {
  STRUCTURES_MODEL_LIFE,
  STRUCTURES_MODEL_POPULOUS,
  setGrowthModel,
  type BoardCellRecord,
  type GrowthModel,
  type GrowthStepResult,
} from '../server/growth-model.ts';
import { CA_GENERATION_INTERVAL_SECONDS } from '../server/life.ts';
import { saveStructures } from '../server/persistence.ts';
import { createStructuresRng } from '../server/rng.ts';
import type { StructuresWorld } from '../server/suitability.ts';
import * as structuresExports from '../server/index.ts';
import {
  plugin as structuresPlugin,
  currentLive,
  foundStructure,
  resetStructuresState,
  setStructuresModel,
  standingStructures,
} from '../server/index.ts';
import { worldWithTerrain } from './support/world.ts';

const WORLD_SIZE = 64;
const OPEN_BAND = 4;
const DT = 0.1;
const CHANGES_WIRE_TYPE = `${STRUCTURES_PLUGIN_NAME}:${STRUCTURES_CHANGES_MESSAGE}`;
const OPEN_TERRAIN = (): number => OPEN_BAND * BAND_HEIGHT;
const RESTORED_HOUSE = { x: 20, y: 20 } as const;
const GHOST_HOUSE = { x: 30, y: 30 } as const;
const RESTORED_GENERATION = 5;
const SLICE_RNG_SEED = 1;
const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

interface Session {
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

function sliceWithOneHouse(): unknown {
  const board = new Map<number, BoardCellRecord>([
    [structureKey(RESTORED_HOUSE.x, RESTORED_HOUSE.y), { age: 3, tier: 1 }],
  ]);
  return saveStructures(board, RESTORED_GENERATION, createStructuresRng(SLICE_RNG_SEED), -1);
}

function openOn(world: World, enabled: boolean, restore?: unknown): Session {
  const sink = new RecordingSink();
  world.setSink(sink);
  const host = new PluginHost(
    world,
    [structuresPlugin].map(asLoadedPlugin),
    new Set(enabled ? [STRUCTURES_PLUGIN_NAME] : []),
  );
  if (restore !== undefined) host.restorePersistence({ [STRUCTURES_PLUGIN_NAME]: restore });
  host.worldCreate();
  if (!world.players().some((player) => player.id === PLAYER.id)) {
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
  }
  host.playerJoined(PLAYER);
  return { host, sink };
}

function closeOn(session: Session): void {
  session.host.closeWorld();
  session.host.revokeApis();
}

function advance(session: Session, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) session.host.tick(DT);
}

function asStructuresWorld(world: World): StructuresWorld {
  return {
    worldSize: world.size,
    chunksPerEdge: world.chunksPerEdge,
    heightAt: (x, y) => world.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => world.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
  };
}

function countingModel(): GrowthModel & { readonly calls: number[] } {
  const calls: number[] = [];
  return {
    name: 'counting',
    step(_world, live): GrowthStepResult {
      calls.push(live.size);
      return { nextLive: new Map(live), born: [], upgraded: [], died: [], emitted: [] };
    },
    calls,
  };
}

describe('a closed world leaves nothing behind in this plugin', () => {
  beforeEach(() => {
    resetStructuresState();
    resetStructuresBridge();
    setGrowthModel(null);
    setStructuresModel(STRUCTURES_MODEL_LIFE);
  });

  afterEach(() => {
    resetStructuresBridge();
    setGrowthModel(null);
    setStructuresModel(STRUCTURES_MODEL_LIFE);
  });

  it('answers a sibling’s bridge with an empty board once the world it was disabled in reopens', () => {
    const world = worldWithTerrain(WORLD_SIZE, OPEN_TERRAIN);

    const running = openOn(world, true, sliceWithOneHouse());
    expect(standingStructures()).toHaveLength(1);
    closeOn(running);

    const withoutStructures = openOn(world, false, sliceWithOneHouse());

    loadStructuresBridge(worldWithSibling(STRUCTURES_PLUGIN_NAME, structuresExports));
    expect(bridgedStructures()).toEqual([]);

    closeOn(withoutStructures);
  });

  it('does not broadcast a founding made while it was disabled', () => {
    const world = worldWithTerrain(WORLD_SIZE, OPEN_TERRAIN);
    closeOn(openOn(world, true, sliceWithOneHouse()));

    const withoutStructures = openOn(world, false, sliceWithOneHouse());
    expect(foundStructure(asStructuresWorld(world), GHOST_HOUSE.x, GHOST_HOUSE.y)).toBe(true);
    closeOn(withoutStructures);

    const running = openOn(world, true, sliceWithOneHouse());
    running.sink.clear();
    running.host.tick(DT);

    expect(running.sink.ofType(CHANGES_WIRE_TYPE)).toEqual([]);
    expect(currentLive().has(structureKey(GHOST_HOUSE.x, GHOST_HOUSE.y))).toBe(false);
    closeOn(running);
  });

  it('does not step a generation on the first tick after a reopen', () => {
    setStructuresModel(STRUCTURES_MODEL_POPULOUS);
    const model = countingModel();
    setGrowthModel(model);

    const world = worldWithTerrain(WORLD_SIZE, OPEN_TERRAIN);
    const first = openOn(world, true, sliceWithOneHouse());
    advance(first, CA_GENERATION_INTERVAL_SECONDS * 2.5);
    expect(model.calls).toHaveLength(2);
    closeOn(first);

    const second = openOn(world, true, sliceWithOneHouse());
    second.host.tick(DT);
    expect(model.calls).toHaveLength(2);

    advance(second, CA_GENERATION_INTERVAL_SECONDS);
    expect(model.calls).toHaveLength(3);
    closeOn(second);
  });
});

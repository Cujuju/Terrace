// WHAT THIS PLUGIN'S MODULE MAY CARRY FROM ONE SESSION INTO THE NEXT — the
// contract behind plan §2.3 Phase S0 (docs/plans/plugin-hot-unload.md §1.9).
//
// Plugin modules outlive worlds. A reopen (a plugin toggle, a rollback, an
// operator loading another world) builds a NEW host over the SAME modules, and
// a plugin that is disabled for the next session does not even get an
// onWorldCreate to reset itself in. Meanwhile flora, pilgrims and temples hold
// this module directly — their bridges resolve its URL once and keep asking it
// questions — so anything left standing here is answered to them as though it
// were still in the world.
//
// THE FLORA BRIDGE IS IMPORTED HERE, and this is the one place in this suite
// where a sibling plugin's code is allowed in (monsters' client.test.ts holds
// the same licence for the same reason): the subject IS the cross-plugin
// contract, and asserting it against a hand-written stand-in would assert
// something other than what ships.

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
/** Open, flat, buildable ground everywhere — the board's own walls are not the subject. */
const OPEN_TERRAIN = (): number => OPEN_BAND * BAND_HEIGHT;
/** A house in the restored snapshot, and a second cell a sibling founds later. */
const RESTORED_HOUSE = { x: 20, y: 20 } as const;
const GHOST_HOUSE = { x: 30, y: 30 } as const;
/** Generations the restored slice claims — arbitrary, and preserved across a reopen. */
const RESTORED_GENERATION = 5;
/** Seed for the slice's RNG state; any fixed value keeps the restore deterministic. */
const SLICE_RNG_SEED = 1;
/** Somebody has to be looking: every send in this plugin is per recipient. */
const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

interface Session {
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/** The slice a snapshot would hold for a world with one standing house. */
function sliceWithOneHouse(): unknown {
  const board = new Map<number, BoardCellRecord>([
    [structureKey(RESTORED_HOUSE.x, RESTORED_HOUSE.y), { age: 3, tier: 1 }],
  ]);
  return saveStructures(board, RESTORED_GENERATION, createStructuresRng(SLICE_RNG_SEED), -1);
}

/**
 * Opens a session over `world` the way `openSession` does — restore first,
 * then worldCreate — with structures either enabled for it or merely installed.
 */
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
  // A recipient with the whole board unlocked, added on the first open and
  // carried by the World across every reopen — a plugin whose every send is
  // filtered per player broadcasts nothing at all into an empty world, which
  // would make "nothing was broadcast" pass for the wrong reason.
  if (!world.players().some((player) => player.id === PLAYER.id)) {
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
  }
  host.playerJoined(PLAYER);
  return { host, sink };
}

/** Closes it the way `closeSession` does: tell the plugins, then revoke their views. */
function closeOn(session: Session): void {
  session.host.closeWorld();
  session.host.revokeApis();
}

function advance(session: Session, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) session.host.tick(DT);
}

/** A sibling's view of the world, as pilgrims hands its own WorldApi across. */
function asStructuresWorld(world: World): StructuresWorld {
  return {
    worldSize: world.size,
    chunksPerEdge: world.chunksPerEdge,
    heightAt: (x, y) => world.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => world.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
  };
}

/** A model that counts the generations it was asked to run. */
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

    // Reopened with structures switched off: its slice rides through as a
    // dormant one and its onWorldCreate never runs, so the ONLY thing that can
    // have emptied the board is the close hook.
    const withoutStructures = openOn(world, false, sliceWithOneHouse());

    // flora's real bridge, pointed at this module rather than re-importing it,
    // so the identity it duck-types is the very module the host just closed.
    loadStructuresBridge(worldWithSibling(STRUCTURES_PLUGIN_NAME, structuresExports));
    expect(bridgedStructures()).toEqual([]);

    closeOn(withoutStructures);
  });

  it('does not broadcast a founding made while it was disabled', () => {
    const world = worldWithTerrain(WORLD_SIZE, OPEN_TERRAIN);
    closeOn(openOn(world, true, sliceWithOneHouse()));

    // A sibling founds a house through the pilgrims-facing surface while this
    // plugin is not in the session — the reach Phase 2 closes, and which this
    // phase only has to make harmless.
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

    // The clock pair is reset TOGETHER: were only the mark zeroed, the
    // accumulated sim seconds would clear the interval gate immediately and
    // this first tick would step a generation the cadence never earned.
    const second = openOn(world, true, sliceWithOneHouse());
    second.host.tick(DT);
    expect(model.calls).toHaveLength(2);

    // ...and the cadence itself is intact: the next interval still steps.
    advance(second, CA_GENERATION_INTERVAL_SECONDS);
    expect(model.calls).toHaveLength(3);
    closeOn(second);
  });
});

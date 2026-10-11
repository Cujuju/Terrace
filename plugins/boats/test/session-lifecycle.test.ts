import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  asLoadedPlugin,
  asLoadedPluginExporting,
  worldWithSibling,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import { FIRE_PLUGIN_NAME } from '../../fire/protocol.ts';
import * as fireExports from '../../fire/server/index.ts';
import { plugin as firePlugin, resetFireState } from '../../fire/server/index.ts';
import { entityFuelSources, clearEntityFuelRegistry } from '../../fire/server/entityFuel.ts';
import { BOATS_PLUGIN_NAME } from '../protocol.ts';
import { plugin as boatsPlugin, resetBoatsState } from '../server/index.ts';
import { resetFireBridge } from '../server/fire-bridge.ts';
import { livingBoats, restoreFleet } from '../server/fleet.ts';

const WORLD_SIZE = 64;
const UNLOCKED_CHUNKS: ReadonlyArray<readonly [number, number]> = [[0, 0]];
const SEEDED_BOAT = {
  id: 1,
  homeX: 10,
  homeY: 10,
  x: 12,
  y: 12,
  heading: 0,
  fighting: false,
} as const;
const SEEDED_NEXT_BOAT_ID = 2;

function flatWorld(): World {
  return worldWithUnlockedChunks(WORLD_SIZE, UNLOCKED_CHUNKS);
}

function openOn(world: World, enabled: readonly string[]): PluginHost {
  const host = new PluginHost(
    world,
    [asLoadedPluginExporting(firePlugin, fireExports), asLoadedPlugin(boatsPlugin)],
    new Set(enabled),
  );
  host.worldCreate();
  return host;
}

function closeOn(host: PluginHost): void {
  host.closeWorld();
  host.revokeApis();
}

function sourceNames(): string[] {
  return entityFuelSources().map((source) => source.name);
}

function offeredAsFuel(): string[] {
  const offered: string[] = [];
  for (const source of entityFuelSources()) {
    if (source.flammable === undefined) continue;
    for (const individual of source.flammable()) offered.push(individual.sourceName);
  }
  return offered;
}

function seedFleet(): void {
  restoreFleet({ villages: [], boats: [SEEDED_BOAT], nextBoatId: SEEDED_NEXT_BOAT_ID });
}

describe('a closed world leaves nothing of this plugin in fire', () => {
  beforeEach(() => {
    resetBoatsState();
    resetFireBridge();
    resetFireState();
    clearEntityFuelRegistry();
  });

  afterEach(() => {
    resetBoatsState();
    resetFireBridge();
    resetFireState();
    clearEntityFuelRegistry();
  });

  it('withdraws its fuel source when the world closes', () => {
    const world = flatWorld();
    const session = openOn(world, [FIRE_PLUGIN_NAME, BOATS_PLUGIN_NAME]);
    expect(sourceNames()).toContain(BOATS_PLUGIN_NAME);

    closeOn(session);

    expect(sourceNames()).not.toContain(BOATS_PLUGIN_NAME);
  });

  it('withdraws it even when fire’s own close hook never runs', () => {
    const world = flatWorld();
    const session = openOn(world, [FIRE_PLUGIN_NAME, BOATS_PLUGIN_NAME]);
    expect(sourceNames()).toContain(BOATS_PLUGIN_NAME);

    boatsPlugin.onWorldClose?.(worldWithSibling(FIRE_PLUGIN_NAME, fireExports));

    expect(sourceNames()).not.toContain(BOATS_PLUGIN_NAME);

    closeOn(session);
  });

  it('offers fire nothing once the world reopens without it', () => {
    const world = flatWorld();
    const running = openOn(world, [FIRE_PLUGIN_NAME, BOATS_PLUGIN_NAME]);
    seedFleet();
    expect(livingBoats()).toHaveLength(1);
    closeOn(running);

    const withoutBoats = openOn(world, [FIRE_PLUGIN_NAME]);

    expect(offeredAsFuel()).toEqual([]);

    closeOn(withoutBoats);
  });

  it('sails none of the last world’s fleet in a brand-new one', () => {
    const worldA = flatWorld();
    const sessionA = openOn(worldA, [FIRE_PLUGIN_NAME, BOATS_PLUGIN_NAME]);
    seedFleet();
    expect(livingBoats()).toHaveLength(1);
    closeOn(sessionA);

    const sessionB = openOn(flatWorld(), [FIRE_PLUGIN_NAME, BOATS_PLUGIN_NAME]);

    expect(livingBoats()).toEqual([]);
    expect(offeredAsFuel()).toEqual([]);

    closeOn(sessionB);
  });
});

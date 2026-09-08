import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newStillness } from '@terrace/shared';
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
import { WILDLIFE_PLUGIN_NAME } from '../protocol.ts';
import { plugin as wildlifePlugin, resetWildlifeState } from '../server/index.ts';
import { resetFireBridge } from '../server/fire-bridge.ts';
import { livingEntities, replacePopulation, type WildlifeEntity } from '../server/population.ts';

const WORLD_SIZE = 64;
const UNLOCKED_CHUNKS: ReadonlyArray<readonly [number, number]> = [[0, 0]];
const SEEDED_CREATURE: WildlifeEntity = {
  ...newStillness(0, 0),
  id: 1,
  species: 'grazer',
  schoolId: 1,
  size: 'medium',
  idle: false,
  huntTargetId: null,
  huntSecondsRemaining: 0,
  huntRestSecondsRemaining: 0,
  climb: null,
  x: 12,
  y: 12,
  heading: 0,
  fleeSecondsRemaining: 0,
};
const SEEDED_NEXT_ID = 2;
const SEEDED_NEXT_SCHOOL = 2;

function flatWorld(): World {
  return worldWithUnlockedChunks(WORLD_SIZE, UNLOCKED_CHUNKS);
}

function openOn(world: World, enabled: readonly string[]): PluginHost {
  const host = new PluginHost(
    world,
    [asLoadedPluginExporting(firePlugin, fireExports), asLoadedPlugin(wildlifePlugin)],
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

function seedPopulation(): void {
  replacePopulation([SEEDED_CREATURE], SEEDED_NEXT_ID, SEEDED_NEXT_SCHOOL);
}

describe('a closed world leaves nothing of this plugin in fire', () => {
  beforeEach(() => {
    resetWildlifeState();
    resetFireBridge();
    resetFireState();
    clearEntityFuelRegistry();
  });

  afterEach(() => {
    resetWildlifeState();
    resetFireBridge();
    resetFireState();
    clearEntityFuelRegistry();
  });

  it('withdraws its fuel source when the world closes — through the host, and through its own hook alone', () => {
    const closedByHost = openOn(flatWorld(), [FIRE_PLUGIN_NAME, WILDLIFE_PLUGIN_NAME]);
    expect(sourceNames()).toContain(WILDLIFE_PLUGIN_NAME);

    closeOn(closedByHost);

    expect(sourceNames()).not.toContain(WILDLIFE_PLUGIN_NAME);

    const session = openOn(flatWorld(), [FIRE_PLUGIN_NAME, WILDLIFE_PLUGIN_NAME]);
    expect(sourceNames()).toContain(WILDLIFE_PLUGIN_NAME);

    wildlifePlugin.onWorldClose?.(worldWithSibling(FIRE_PLUGIN_NAME, fireExports));

    expect(sourceNames()).not.toContain(WILDLIFE_PLUGIN_NAME);

    closeOn(session);
  });

  it('offers fire nothing once the world reopens without it', () => {
    const world = flatWorld();
    const running = openOn(world, [FIRE_PLUGIN_NAME, WILDLIFE_PLUGIN_NAME]);
    seedPopulation();
    expect(livingEntities()).toHaveLength(1);
    closeOn(running);

    const withoutWildlife = openOn(world, [FIRE_PLUGIN_NAME]);

    expect(offeredAsFuel()).toEqual([]);

    closeOn(withoutWildlife);
  });

  it('grazes none of the last world’s creatures in a brand-new one', () => {
    const worldA = flatWorld();
    const sessionA = openOn(worldA, [FIRE_PLUGIN_NAME, WILDLIFE_PLUGIN_NAME]);
    seedPopulation();
    expect(livingEntities()).toHaveLength(1);
    closeOn(sessionA);

    const sessionB = openOn(flatWorld(), [FIRE_PLUGIN_NAME, WILDLIFE_PLUGIN_NAME]);

    expect(livingEntities()).toEqual([]);
    expect(offeredAsFuel()).toEqual([]);

    closeOn(sessionB);
  });
});

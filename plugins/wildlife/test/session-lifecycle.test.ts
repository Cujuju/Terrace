// WHAT THIS PLUGIN LEAVES BEHIND IN A SIBLING WHEN ITS WORLD CLOSES — the
// push-direction half of the contract structures' session-lifecycle.test.ts
// states for the pull direction (issue #208).
//
// Plugin modules outlive worlds. A reopen — a plugin toggle, a rollback, an
// operator switching to another world — builds a NEW host over the SAME
// modules, and a plugin that is not enabled for the next session never gets an
// onWorldCreate to reset itself in. This plugin does not merely hold state
// across that boundary: it has HANDED A CALLBACK TO FIRE, and fire asks that
// callback every spread step for as long as anything in the world is burning.
// So a population left standing here is offered as fuel to a world nothing of
// it ever grazed.
//
// FIRE IS IMPORTED HERE, and this is the one place in this suite where a
// sibling plugin's code is allowed in (structures' session-lifecycle.test.ts
// holds the same licence for the same reason): the subject IS the cross-plugin
// contract, and asserting it against a hand-written stand-in would assert
// something other than what ships.

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
import { WILDLIFE_PLUGIN_NAME } from '../protocol.ts';
import { plugin as wildlifePlugin, resetWildlifeState } from '../server/index.ts';
import { resetFireBridge } from '../server/fire-bridge.ts';
import { livingEntities, replacePopulation, type WildlifeEntity } from '../server/population.ts';

/** Small enough to build instantly; nothing here reads the terrain. */
const WORLD_SIZE = 64;
/** One unlocked chunk is enough for a world to be a world. */
const UNLOCKED_CHUNKS: ReadonlyArray<readonly [number, number]> = [[0, 0]];
/** The creature the previous world had alive, seeded straight into the population. */
const SEEDED_CREATURE: WildlifeEntity = {
  id: 1,
  species: 'grazer',
  schoolId: 1,
  size: 'medium',
  idle: false,
  x: 12,
  y: 12,
  heading: 0,
  fleeSecondsRemaining: 0,
};
/** One past the seeded creature's id and school, as a restore would carry. */
const SEEDED_NEXT_ID = 2;
const SEEDED_NEXT_SCHOOL = 2;

function flatWorld(): World {
  return worldWithUnlockedChunks(WORLD_SIZE, UNLOCKED_CHUNKS);
}

/**
 * Opens a session over `world` the way `openSession` does, with fire and
 * wildlife INSTALLED and exactly `enabled` participating. No persistence is
 * restored: a brand-new world's genesis slices are deliberately empty
 * (server/src/world/session.ts's createWorldFile), which is the wider trigger
 * this suite exists for.
 */
function openOn(world: World, enabled: readonly string[]): PluginHost {
  const host = new PluginHost(
    world,
    [asLoadedPluginExporting(firePlugin, fireExports), asLoadedPlugin(wildlifePlugin)],
    new Set(enabled),
  );
  host.worldCreate();
  return host;
}

/** Closes it the way `releaseSession` does: tell the plugins, then revoke. */
function closeOn(host: PluginHost): void {
  host.closeWorld();
  host.revokeApis();
}

function sourceNames(): string[] {
  return entityFuelSources().map((source) => source.name);
}

/**
 * Everything fire's spread sweep would be offered this step — the public
 * equivalent of spread.ts's private `flammableNow()`, over the very registry
 * that function reads.
 */
function offeredAsFuel(): string[] {
  const offered: string[] = [];
  for (const source of entityFuelSources()) {
    if (source.flammable === undefined) continue;
    for (const individual of source.flammable()) offered.push(individual.sourceName);
  }
  return offered;
}

/** Seeds the population a previous world had alive. */
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

  it('withdraws its fuel source when the world closes', () => {
    const world = flatWorld();
    const session = openOn(world, [FIRE_PLUGIN_NAME, WILDLIFE_PLUGIN_NAME]);
    expect(sourceNames()).toContain(WILDLIFE_PLUGIN_NAME);

    closeOn(session);

    expect(sourceNames()).not.toContain(WILDLIFE_PLUGIN_NAME);
  });

  it('withdraws it even when fire’s own close hook never runs', () => {
    const world = flatWorld();
    const session = openOn(world, [FIRE_PLUGIN_NAME, WILDLIFE_PLUGIN_NAME]);
    expect(sourceNames()).toContain(WILDLIFE_PLUGIN_NAME);

    // This plugin's close hook ALONE: fire is never told the world is closing,
    // so the registry can only have been emptied by the bridge that filled it.
    // Both halves are deliberate — fire clearing its own registries is what
    // covers a registrant that never withdraws, and this is what covers the day
    // that half is refactored, or a fire that is not installed at all.
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

    // Reopened with wildlife switched off: its onWorldCreate never runs, so the
    // ONLY thing that can have emptied fire's registry is the close path.
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

    // A DIFFERENT world, wildlife still enabled, and no slice to restore — the
    // switch that needs no operator toggle at all.
    const sessionB = openOn(flatWorld(), [FIRE_PLUGIN_NAME, WILDLIFE_PLUGIN_NAME]);

    expect(livingEntities()).toEqual([]);
    expect(offeredAsFuel()).toEqual([]);

    closeOn(sessionB);
  });
});

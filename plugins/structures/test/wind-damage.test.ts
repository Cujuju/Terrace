import { beforeEach, describe, expect, it } from 'vitest';
import { bandLevelHeight } from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { asLoadedPlugin } from '../../../server/test/support/harness.ts';
import { structureKey } from '../protocol.ts';
import { plugin, currentLive, resetStructuresState } from '../server/index.ts';
import { worldWithTerrain } from './support/world.ts';

const ANCHOR = { x: 20, y: 20 };
const RADIUS_CELLS = 10;
const CERTAIN_CAMP_DEMOLITION_SECONDS = 100;

function boot(): PluginHost {
  const world = worldWithTerrain(64, () => bandLevelHeight(10));
  const host = new PluginHost(world, [asLoadedPlugin(plugin)]);
  host.restorePersistence({ structures: { version: 4, live: [{ ...ANCHOR, building: 'camp', tier: 0, age: 0 }] } });
  host.worldCreate();
  return host;
}

function damage(): object {
  return { stormId: 1, ...ANCHOR, radius: RADIUS_CELLS, eyeRadius: RADIUS_CELLS / 2,
    intensity: 1, durationSeconds: CERTAIN_CAMP_DEMOLITION_SECONDS, cells: [], windFalloff: 'eyewall' };
}

describe('wind damage profiles', () => {
  beforeEach(resetStructuresState);

  it('demolishes a structure under the tornado centre despite an untrusted payload profile', () => {
    const host = boot();
    host.notifyWorldEvent('tornado:damage', damage());
    expect(currentLive().has(structureKey(ANCHOR.x, ANCHOR.y))).toBe(false);
    host.closeWorld();
  });

  it('keeps the same structure inside the cyclone eye', () => {
    const host = boot();
    host.notifyWorldEvent('cyclone:damage', damage());
    expect(currentLive().has(structureKey(ANCHOR.x, ANCHOR.y))).toBe(true);
    host.closeWorld();
  });
});

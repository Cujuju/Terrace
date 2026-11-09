import { afterEach, describe, expect, it } from 'vitest';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { plugin, resetBoatsState } from '../server/index.ts';
import { livingBoats, restoreFleet } from '../server/fleet.ts';
import {
  BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND,
  CYCLONE_DAMAGE_EVENT_NAME,
  TORNADO_DAMAGE_EVENT_NAME,
} from '../server/cyclone-event.ts';

const BOAT_AT = 200;
const STORM_RADIUS = 20;
const DURATION_SECONDS = 1;
const world = {
  worldSize: 512, heightAt: () => -100, isCellUnlocked: () => true, sibling: () => null,
} as unknown as WorldApi;

function displacement(event: string, advertisedProfile: string): number {
  resetBoatsState();
  restoreFleet({ villages: [], nextBoatId: 2, boats: [{
    id: 1, homeX: BOAT_AT, homeY: BOAT_AT, x: BOAT_AT, y: BOAT_AT,
    heading: 0, fighting: false,
  }] });
  plugin.onWorldEvent?.(world, event, {
    stormId: 1, x: BOAT_AT - STORM_RADIUS / 2, y: BOAT_AT,
    radius: STORM_RADIUS, eyeRadius: 0, intensity: 1, durationSeconds: DURATION_SECONDS,
    cells: [], windFalloff: advertisedProfile,
  });
  // The event carries elapsed wind time; zero movement time isolates its impulse.
  plugin.onTick?.(world, 0);
  return livingBoats()[0]!.y - BOAT_AT;
}

afterEach(resetBoatsState);

describe('boat storm wind adapters', () => {
  it('uses quadratic tornado wind and ignores a payload claiming an eyewall', () => {
    expect(displacement(TORNADO_DAMAGE_EVENT_NAME, 'eyewall')).toBeCloseTo(
      BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND * DURATION_SECONDS * 0.75,
    );
  });

  it('retains cyclone eyewall wind and ignores a payload claiming quadratic wind', () => {
    expect(displacement(CYCLONE_DAMAGE_EVENT_NAME, 'quadratic')).toBeCloseTo(
      BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND * DURATION_SECONDS * 0.5,
    );
  });
});

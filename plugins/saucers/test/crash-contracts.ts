import assert from 'node:assert/strict';
import {
  BAND_HEIGHT, bandLevelHeight, CHUNK_SIZE, createChunkMask,
  createHeightmap, createSeededRng, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS,
} from '@terrace/shared';
import { World } from '../../../server/src/world/world.ts';
import { createWorldApi } from '../../../server/src/plugins/world-api.ts';
import { applyCrash } from '../server/crash.ts';
import { crashCellAt } from '../server/site.ts';
import { crashWriteAllowed, isClearOfSettlements } from '../server/structures-bridge.ts';
import {
  advanceEncounter, encounterCrashes, encounterSaucers, forceEncounterNear,
  hasEncounter, refreshEncounterTerrain,
} from '../server/encounter.ts';
import { CRASH_CRATER_DEPTH_BANDS, CRASH_CRATER_RADIUS_CELLS, CRASH_FIRE_RING_OFFSETS } from '../protocol.ts';
import { buildingsBridge, CENTRE, encounterFixture, isolated, MAX_ENCOUNTER_TICKS, TICK_SECONDS, WORLD_SIZE } from './support.ts';

export function protectedFootprints(): void {
  isolated(() => {
    const camp = { x: 108, y: 100, footprintRadiusCells: 2 };
    buildingsBridge([camp]);
    assert.equal(isClearOfSettlements(100, 100), false);
    buildingsBridge([{ x: 112, y: 112, footprintRadiusCells: 8 }]);
    assert.equal(isClearOfSettlements(100, 100), false, 'square footprint corner must be protected');
    buildingsBridge([camp]);
    const canWrite = crashWriteAllowed();
    assert.equal(canWrite(106, 98), false);
    assert.equal(canWrite(105, 98), true);

    const cells = createHeightmap(WORLD_SIZE).cells;
    cells.fill(bandLevelHeight(3));
    const mask = createChunkMask(WORLD_SIZE);
    mask.fill(255);
    const world = World.restore(WORLD_SIZE, cells, mask, 50, 'Crater audit');
    const view = createWorldApi(world, {
      notifyTerrainChanged() {}, notifyChunkUnlockedForToken() {}, notifyWorldEvent() {},
    }, 'saucers');
    const before = world.heightsForPersistence().slice();
    assert.deepEqual(view.api.sculpt(100, 100, CRASH_CRATER_RADIUS_CELLS,
      -CRASH_CRATER_DEPTH_BANDS * BAND_HEIGHT, canWrite), []);
    assert.deepEqual(world.heightsForPersistence(), before, 'rejected crater must be atomic');

    const fixture = encounterFixture();
    const target = crashCellAt(fixture.world, 80, 100);
    assert(target);
    let guarded = false;
    fixture.world.sculpt = (_x, _y, _r, _amount, predicate) => {
      assert(predicate);
      assert.equal(predicate(camp.x, camp.y), false);
      guarded = true;
    };
    assert(applyCrash(fixture.world, target));
    assert(guarded, 'production impact must pass the footprint guard to the host');
    assert.equal(applyCrash(fixture.world, { ...target, x: 100 }), null,
      'a town built after target selection must stop the impact');
    view.revoke();
  });
}

export function currentCrashSurface(): void {
  isolated(() => {
    const fixture = encounterFixture();
    const landTarget = crashCellAt(fixture.world, CENTRE.x, CENTRE.y);
    assert(landTarget);
    fixture.setHeight(-9 * BAND_HEIGHT);
    const deep = applyCrash(fixture.world, landTarget);
    assert(deep?.water);
    assert.equal(deep.depthBands, 9);
    assert.equal(deep.groundY, 0);
    assert.equal(fixture.sculpts.length, 0);
    assert.equal(fixture.ignitions.length, 0);
    fixture.setHeight(-2 * BAND_HEIGHT);
    const shallow = applyCrash(fixture.world, landTarget);
    assert(shallow?.water);
    assert.equal(fixture.sculpts.length, 1);
    assert.equal(fixture.ignitions.length, 0);
    fixture.setHeight(40);
    assert.equal(applyCrash(fixture.world, shallow)?.water, false);
    assert.equal(fixture.sculpts.length, 2);
    assert.equal(fixture.ignitions.length, CRASH_FIRE_RING_OFFSETS.length);
  });

  isolated(() => {
    const fixture = encounterFixture();
    Math.random = createSeededRng(CHUNK_SIZE).next;
    assert(forceEncounterNear(fixture.world, 'dogfight', CENTRE));
    fixture.setHeight(-9 * BAND_HEIGHT);
    const seen = new Set<number>();
    for (let tick = 0; tick < MAX_ENCOUNTER_TICKS && hasEncounter(); tick++) {
      advanceEncounter(fixture.world, TICK_SECONDS);
      for (const crash of encounterCrashes()) {
        seen.add(crash.id);
        assert.equal(crash.water, true, 'wire classification must use the impact-time surface');
      }
    }
    assert(seen.size > 0);
    assert.equal(fixture.sculpts.length, 0);
    assert.equal(fixture.ignitions.length, 0);
  });

  isolated(() => {
    const fixture = encounterFixture();
    assert(forceEncounterNear(fixture.world, 'dogfight', CENTRE));
    let diving = false;
    for (let tick = 0; tick < MAX_ENCOUNTER_TICKS && hasEncounter(); tick++) {
      advanceEncounter(fixture.world, TICK_SECONDS);
      if (encounterSaucers().some((s) => s.phase === 'resolve' && s.hp === 0)) {
        diving = true;
        break;
      }
    }
    assert(diving);
    fixture.setHeight(MAX_HEIGHT);
    assert(refreshEncounterTerrain(fixture.world, [{ ...CENTRE, h: MAX_HEIGHT }]));
    const descentStepsPerTick = 10;
    for (let step = 0; step < MAX_ENCOUNTER_TICKS * descentStepsPerTick && hasEncounter(); step++) {
      advanceEncounter(fixture.world, TICK_SECONDS / descentStepsPerTick);
      assert(encounterSaucers().filter((s) => s.phase === 'resolve').every((s) =>
        s.alt >= MAX_RELIEF_WORLD_UNITS), 'an in-progress dive must follow a newly raised impact surface');
    }
    assert.equal(hasEncounter(), false);
  });
}

import assert from 'node:assert/strict';
import { createSeededRng, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, type CellDiff } from '@terrace/shared';
import {
  advanceEncounter, encounterBolts, encounterSaucers, forceEncounterNear,
  hasEncounter, refreshEncounterTerrain, resetEncounter,
} from '../server/encounter.ts';
import { resetEncounterSeeds } from '../server/rng.ts';
import {
  ALTITUDE_TIER_WORLD_UNITS, APPROACH_SECONDS, CLIMB_WORLD_UNITS,
  LASER_BOLT_RETAIN_SECONDS, MAX_SAUCERS_PER_ENCOUNTER, SAUCER_DIAMETER_CELLS,
} from '../protocol.ts';
import { CENTRE, encounterFixture, isolated, LAND_HEIGHT, MAX_ENCOUNTER_TICKS, TICK_SECONDS } from './support.ts';

export function projectileResolution(): void {
  isolated(() => {
    const { world } = encounterFixture();
    assert(forceEncounterNear(world, 'dogfight', CENTRE));
    let checked = false;
    for (let tick = 0; tick < MAX_ENCOUNTER_TICKS && hasEncounter(); tick++) {
      advanceEncounter(world, TICK_SECONDS);
      const saucers = encounterSaucers();
      if (!saucers.length || !saucers.every((s) => s.phase === 'resolve')) continue;
      const before = encounterBolts().find((b) => b.age + TICK_SECONDS < LASER_BOLT_RETAIN_SECONDS);
      if (!before) continue;
      advanceEncounter(world, TICK_SECONDS);
      const after = encounterBolts().find((b) =>
        b.from === before.from && b.to === before.to && b.x === before.x && b.y === before.y);
      assert(after);
      assert(Math.abs(after.age - before.age - TICK_SECONDS) < Number.EPSILON * 4);
      for (let step = 0; step <= Math.ceil(LASER_BOLT_RETAIN_SECONDS / TICK_SECONDS); step++) {
        advanceEncounter(world, TICK_SECONDS);
      }
      assert.equal(encounterBolts().length, 0, 'resolution must expire retained projectiles');
      checked = true;
      break;
    }
    assert(checked, 'fixture must exercise an in-flight projectile at faction resolution');
  });
}

export function continuousFlight(): void {
  isolated(() => {
    const { world } = encounterFixture();
    const plateau = { x: 248, y: 218, radius: 2 };
    world.heightAt = (x, y) => Math.abs(x - plateau.x) <= plateau.radius &&
      Math.abs(y - plateau.y) <= plateau.radius ? MAX_HEIGHT : LAND_HEIGHT;
    const started = forceEncounterNear(world, 'dogfight', CENTRE);
    assert(started);
    for (let tick = 0; tick < APPROACH_SECONDS / TICK_SECONDS; tick++) advanceEncounter(world, TICK_SECONDS);
    const saucers = encounterSaucers().filter((s) => s.phase === 'dogfight');
    assert(saucers.some((s) => Math.abs(s.x - plateau.x) < 1 && Math.abs(s.y - plateau.y) < 1));
    assert(saucers.every((s) => s.alt > MAX_RELIEF_WORLD_UNITS));
    const cruiseFloor = started.site.altitude -
      ((MAX_SAUCERS_PER_ENCOUNTER - 1) * ALTITUDE_TIER_WORLD_UNITS) / 2 - CLIMB_WORLD_UNITS;
    let descending = false;
    for (let tick = 0; tick < MAX_ENCOUNTER_TICKS && hasEncounter(); tick++) {
      const previous = new Map(encounterSaucers().map((saucer) => [saucer.id, saucer]));
      advanceEncounter(world, TICK_SECONDS);
      for (const saucer of encounterSaucers()) {
        const before = previous.get(saucer.id);
        if (saucer.phase === 'resolve' && before && saucer.alt < before.alt) {
          assert(Math.hypot(saucer.x - before.x, saucer.y - before.y) < Number.EPSILON * CENTRE.x,
            'wire segments must descend vertically instead of interpolating across the flight-path corner');
        }
        if (saucer.phase !== 'resolve' || saucer.alt >= cruiseFloor) continue;
        descending = true;
        assert(started.site.crashCells.some((cell) =>
          Math.hypot(cell.x - saucer.x, cell.y - saucer.y) < Number.EPSILON * CENTRE.x),
        'a descending saucer must reach its impact column before leaving the certified cruise corridor');
      }
    }
    assert(descending);
  });

  for (const kind of ['dogfight', 'flyby'] as const) isolated(() => {
    const { world } = encounterFixture();
    assert(forceEncounterNear(world, kind, CENTRE));
    advanceEncounter(world, 1);
    const from = encounterSaucers()[0]!;
    advanceEncounter(world, TICK_SECONDS);
    const to = encounterSaucers()[0]!;
    const peak = { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) };
    assert(Math.hypot(to.x - from.x, to.y - from.y) > SAUCER_DIAMETER_CELLS);
    resetEncounter(); resetEncounterSeeds(); Math.random = createSeededRng(12345).next;
    world.heightAt = (x, y) => x === peak.x && y === peak.y ? MAX_HEIGHT : LAND_HEIGHT;
    assert(forceEncounterNear(world, kind, CENTRE));
    advanceEncounter(world, 1);
    assert(encounterSaucers().every((s) => s.alt > MAX_RELIEF_WORLD_UNITS),
      `${kind} must clear terrain between successive poses`);
  });

  isolated(() => {
    const { world } = encounterFixture();
    assert(forceEncounterNear(world, 'dogfight', CENTRE));
    const before = encounterSaucers()[0]!;
    world.heightAt = () => MAX_HEIGHT;
    const diff: CellDiff[] = [{ x: CENTRE.x, y: CENTRE.y, h: MAX_HEIGHT }];
    assert(refreshEncounterTerrain(world, diff));
    assert(encounterSaucers()[0]!.alt > before.alt);
    advanceEncounter(world, TICK_SECONDS);
    assert(encounterSaucers().every((s) => s.alt > MAX_RELIEF_WORLD_UNITS));
  });
}

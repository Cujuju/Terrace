// boats — the fight, the roster, and the two event contracts.
//
// The centrepiece is "the fight is the arithmetic protocol.ts claims": four
// constants are only meaningful in relation to each other, and the design
// sentence they encode ("it takes a full fishing fleet to drive off a kraken")
// is a property of that relation, not of any one of them. Retuning one without
// the others must fail HERE rather than silently making krakens invincible or
// free.

import { beforeEach, describe, expect, it } from 'vitest';
import { SEA_LEVEL } from '@terrace/shared';
import {
  BOATS_PER_VILLAGE,
  BOAT_ENGAGEMENT_RANGE_CELLS,
  BOAT_REBUILD_SECONDS,
  BOAT_WOUNDS_PER_SECOND,
  KRAKEN_ROUT_WOUNDS,
  KRAKEN_SINKS_BOAT_EVERY_SECONDS,
  KRAKEN_WOUND_HEAL_PER_SECOND,
  VILLAGE_MIN_TIER,
  VILLAGE_PATROL_RANGE_CELLS,
} from '../protocol.ts';
import {
  advanceFleet,
  currentKrakenWounds,
  fleetSnapshot,
  forgetVillage,
  isSailable,
  livingBoats,
  rememberVillage,
  resetFleet,
  restoreFleet,
  villageCount,
  type BoatWorld,
} from '../server/fleet.ts';
import { parseMonsterSightings, parseVillageChanges } from '../server/events.ts';
import { loadBoats, saveBoats } from '../server/persistence.ts';

const WORLD_SIZE = 128;
const DRY_LAND = 500;
const OPEN_SEA = SEA_LEVEL - 100;
const TICK_DT = 0.1;

/** Ocean everywhere except the cells `land` names. */
function seaWorld(land: ReadonlyArray<readonly [number, number]>): BoatWorld {
  const dry = new Set(land.map(([x, y]) => `${x},${y}`));
  return {
    worldSize: WORLD_SIZE,
    heightAt: (x, y) => (dry.has(`${x},${y}`) ? DRY_LAND : OPEN_SEA),
    isCellUnlocked: () => true,
  };
}

/** A village on a one-cell island, so exactly one launch cell exists. */
const VILLAGE_X = 40;
const VILLAGE_Y = 40;
function coastWorld(): BoatWorld {
  return seaWorld([[VILLAGE_X, VILLAGE_Y]]);
}

/** Runs peacetime until the village is at full strength. */
function buildFullFleet(world: BoatWorld): void {
  rememberVillage(VILLAGE_X, VILLAGE_Y);
  const ticks = Math.ceil((BOAT_REBUILD_SECONDS * BOATS_PER_VILLAGE + 1) / TICK_DT);
  for (let n = 0; n < ticks; n++) advanceFleet(world, null, TICK_DT);
}

beforeEach(() => {
  resetFleet();
});

describe('the fight is the arithmetic protocol.ts claims', () => {
  /**
   * Fights a kraken parked within engagement range of the village and reports
   * how it went. The kraken never moves: this is a test of the attrition
   * numbers, and a moving target would fold steering into the measurement.
   */
  function fightToTheEnd(startingBoats: number): {
    routed: boolean;
    seconds: number;
    survivors: number;
  } {
    const world = coastWorld();
    buildFullFleet(world);
    // Trim to the fleet under test, so 1 and 2 boats are the same code path as 3.
    const trimmed = livingBoats().slice(0, startingBoats);
    restoreFleet({
      villages: [{ x: VILLAGE_X, y: VILLAGE_Y, rebuildSeconds: 0 }],
      boats: trimmed,
      nextBoatId: 99,
    });

    const kraken = { x: VILLAGE_X + BOAT_ENGAGEMENT_RANGE_CELLS - 1, y: VILLAGE_Y };
    let seconds = 0;
    // Long enough for any outcome; a fleet is wiped by 36 s and a rout lands
    // at 24 s, so 120 s only runs on for a bug.
    for (let n = 0; n < 1200; n++) {
      const outcome = advanceFleet(world, kraken, TICK_DT);
      seconds += TICK_DT;
      if (outcome.routed) return { routed: true, seconds, survivors: livingBoats().length };
      if (livingBoats().length === 0) return { routed: false, seconds, survivors: 0 };
    }
    return { routed: false, seconds, survivors: livingBoats().length };
  }

  it('a full fleet routs it, at the predicted time, with one boat left', () => {
    const result = fightToTheEnd(BOATS_PER_VILLAGE);
    expect(result.routed).toBe(true);
    // 12 s at three boats (36 wounds) + 9 s at two (18) = 54 at t = 21 s —
    // three seconds clear of the next sinking, so the survivor count is a
    // design fact rather than a floating-point tie-break.
    expect(result.seconds).toBeGreaterThan(20.5);
    expect(result.seconds).toBeLessThan(21.5);
    expect(result.survivors).toBe(BOATS_PER_VILLAGE - 1);
  });

  it('a fleet one boat short is wiped out instead', () => {
    const result = fightToTheEnd(BOATS_PER_VILLAGE - 1);
    expect(result.routed).toBe(false);
    expect(result.survivors).toBe(0);
  });

  it('a single boat is wiped out having barely scratched it', () => {
    const result = fightToTheEnd(1);
    expect(result.routed).toBe(false);
    expect(result.survivors).toBe(0);
  });

  it('the constants still encode "a full fleet, and not one boat less"', () => {
    // THE RELATION, asserted directly rather than only through the sim above,
    // so a retune is caught even if the sim were to change shape. Wounds a
    // fleet of N delivers before it is wiped: sum over k = N..1 of
    // k * KRAKEN_SINKS_BOAT_EVERY_SECONDS * BOAT_WOUNDS_PER_SECOND.
    const deliveredBy = (fleet: number): number => {
      let total = 0;
      for (let k = fleet; k >= 1; k--) {
        total += k * KRAKEN_SINKS_BOAT_EVERY_SECONDS * BOAT_WOUNDS_PER_SECOND;
      }
      return total;
    };
    expect(deliveredBy(BOATS_PER_VILLAGE)).toBeGreaterThan(KRAKEN_ROUT_WOUNDS);
    expect(deliveredBy(BOATS_PER_VILLAGE - 1)).toBeLessThan(KRAKEN_ROUT_WOUNDS);

    // STRICTLY INSIDE, not merely between: a bar sitting exactly on a sinking
    // instant makes the outcome a tie-break between two accumulators, decided
    // by floating-point drift rather than design. Walk the fight phase by
    // phase and check the crossing is not one.
    let wounds = 0;
    let seconds = 0;
    let afloat = BOATS_PER_VILLAGE;
    while (wounds < KRAKEN_ROUT_WOUNDS && afloat > 0) {
      const rate = afloat * BOAT_WOUNDS_PER_SECOND;
      const needed = (KRAKEN_ROUT_WOUNDS - wounds) / rate;
      if (needed <= KRAKEN_SINKS_BOAT_EVERY_SECONDS) {
        seconds += needed;
        wounds = KRAKEN_ROUT_WOUNDS;
        break;
      }
      seconds += KRAKEN_SINKS_BOAT_EVERY_SECONDS;
      wounds += rate * KRAKEN_SINKS_BOAT_EVERY_SECONDS;
      afloat--;
    }
    expect(wounds).toBe(KRAKEN_ROUT_WOUNDS);
    expect(seconds % KRAKEN_SINKS_BOAT_EVERY_SECONDS).not.toBe(0);
  });

  it('heals faster than one boat can wound, so a lone picket never wins', () => {
    // Without this inequality every number above is decorative: one boat
    // parked at range would rout a kraken given long enough.
    expect(KRAKEN_WOUND_HEAL_PER_SECOND).toBeGreaterThan(BOAT_WOUNDS_PER_SECOND);
  });

  it('sheds wounds once the last boat disengages', () => {
    const world = coastWorld();
    buildFullFleet(world);
    const kraken = { x: VILLAGE_X + BOAT_ENGAGEMENT_RANGE_CELLS - 1, y: VILLAGE_Y };
    for (let n = 0; n < 50; n++) advanceFleet(world, kraken, TICK_DT);
    const wounded = currentKrakenWounds();
    expect(wounded).toBeGreaterThan(0);

    for (let n = 0; n < 50; n++) advanceFleet(world, null, TICK_DT);
    expect(currentKrakenWounds()).toBeLessThan(wounded);
  });
});

describe('villages and their shipyards', () => {
  it('builds up to a full fleet and then stops', () => {
    const world = coastWorld();
    buildFullFleet(world);
    expect(livingBoats()).toHaveLength(BOATS_PER_VILLAGE);

    for (let n = 0; n < 2000; n++) advanceFleet(world, null, TICK_DT);
    expect(livingBoats()).toHaveLength(BOATS_PER_VILLAGE);
  });

  it('builds one boat per rebuild interval, not a stockpiled burst', () => {
    const world = coastWorld();
    rememberVillage(VILLAGE_X, VILLAGE_Y);
    const oneInterval = Math.ceil(BOAT_REBUILD_SECONDS / TICK_DT);
    for (let n = 0; n < oneInterval; n++) advanceFleet(world, null, TICK_DT);
    expect(livingBoats()).toHaveLength(1);
    for (let n = 0; n < oneInterval; n++) advanceFleet(world, null, TICK_DT);
    expect(livingBoats()).toHaveLength(2);
  });

  it('an inland village keeps no boats at all', () => {
    // How "coastal" is decided without structures emitting anything new: a
    // settlement with no wet 4-neighbour has nowhere to launch from.
    const world = seaWorld([
      [VILLAGE_X, VILLAGE_Y],
      [VILLAGE_X + 1, VILLAGE_Y],
      [VILLAGE_X - 1, VILLAGE_Y],
      [VILLAGE_X, VILLAGE_Y + 1],
      [VILLAGE_X, VILLAGE_Y - 1],
    ]);
    rememberVillage(VILLAGE_X, VILLAGE_Y);
    for (let n = 0; n < 2000; n++) advanceFleet(world, null, TICK_DT);
    expect(livingBoats()).toHaveLength(0);
  });

  it('scuttles the boats of a village that is demolished', () => {
    const world = coastWorld();
    buildFullFleet(world);
    expect(livingBoats().length).toBeGreaterThan(0);
    forgetVillage(VILLAGE_X, VILLAGE_Y);
    expect(villageCount()).toBe(0);
    expect(livingBoats()).toHaveLength(0);
  });

  it('ignores a kraken outside its own patrol range', () => {
    const world = coastWorld();
    buildFullFleet(world);
    const faraway = { x: VILLAGE_X + VILLAGE_PATROL_RANGE_CELLS + 5, y: VILLAGE_Y };
    for (let n = 0; n < 300; n++) advanceFleet(world, faraway, TICK_DT);
    expect(livingBoats().every((boat) => !boat.fighting)).toBe(true);
    expect(currentKrakenWounds()).toBe(0);
  });
});

describe('boats stay on the water', () => {
  it('never steps onto land on its way to a fight', () => {
    // A reef between the village and the kraken. The boat must go around it;
    // what is asserted is only that it is never ON it.
    const reef: Array<readonly [number, number]> = [[VILLAGE_X, VILLAGE_Y]];
    for (let dy = -3; dy <= 3; dy++) reef.push([VILLAGE_X + 6, VILLAGE_Y + dy]);
    const world = seaWorld(reef);
    buildFullFleet(world);

    const kraken = { x: VILLAGE_X + 12, y: VILLAGE_Y };
    for (let n = 0; n < 600; n++) {
      advanceFleet(world, kraken, TICK_DT);
      for (const boat of livingBoats()) {
        expect(isSailable(world, boat.x, boat.y)).toBe(true);
      }
    }
  });

  it('will not launch into locked ocean', () => {
    const world: BoatWorld = {
      worldSize: WORLD_SIZE,
      heightAt: (x, y) => (x === VILLAGE_X && y === VILLAGE_Y ? DRY_LAND : OPEN_SEA),
      isCellUnlocked: () => false,
    };
    rememberVillage(VILLAGE_X, VILLAGE_Y);
    for (let n = 0; n < 2000; n++) advanceFleet(world, null, TICK_DT);
    expect(livingBoats()).toHaveLength(0);
  });
});

describe('the structures:changes contract', () => {
  it('takes settlements that reached a boat-keeping tier', () => {
    const parsed = parseVillageChanges({
      cause: 'generation',
      seeded: [],
      upgraded: [
        { x: 1, y: 2, tier: VILLAGE_MIN_TIER },
        { x: 3, y: 4, tier: VILLAGE_MIN_TIER - 1 },
      ],
      died: [{ x: 5, y: 6 }],
    });
    expect(parsed?.gained).toEqual([{ x: 1, y: 2 }]);
    expect(parsed?.lost).toEqual([{ x: 5, y: 6 }]);
  });

  it('accepts the sculpt-cause payload, which carries no upgraded list', () => {
    const parsed = parseVillageChanges({ cause: 'sculpt', died: [{ x: 7, y: 8 }] });
    expect(parsed?.gained).toEqual([]);
    expect(parsed?.lost).toEqual([{ x: 7, y: 8 }]);
  });

  it('rejects a malformed payload whole rather than half-reading it', () => {
    expect(parseVillageChanges(null)).toBeNull();
    expect(parseVillageChanges({ upgraded: [{ x: 1 }] })).toBeNull();
    expect(parseVillageChanges({ upgraded: [{ x: 1, y: 2, tier: 'high' }] })).toBeNull();
    expect(parseVillageChanges({ died: [{ x: 1.5, y: 2 }] })).toBeNull();
  });
});

describe('the monsters:positions contract', () => {
  it('reads sightings', () => {
    expect(parseMonsterSightings({ monsters: [{ kind: 'kraken', x: 1.5, y: 2.5 }] })).toEqual([
      { kind: 'kraken', x: 1.5, y: 2.5 },
    ]);
  });

  it('keeps kinds it does not know, rather than failing on them', () => {
    // An emitter that grew a fourth kind must not break a consumer that only
    // cares about one of them.
    const parsed = parseMonsterSightings({ monsters: [{ kind: 'wyrm', x: 0, y: 0 }] });
    expect(parsed).toHaveLength(1);
  });

  it('rejects malformed payloads', () => {
    expect(parseMonsterSightings({})).toBeNull();
    expect(parseMonsterSightings({ monsters: [{ kind: 'kraken', x: 'near' }] })).toBeNull();
    expect(parseMonsterSightings({ monsters: [{ x: 1, y: 2 }] })).toBeNull();
  });
});

describe('persistence', () => {
  it('round-trips villages and the fleet', () => {
    const world = coastWorld();
    buildFullFleet(world);
    const before = fleetSnapshot();

    const blob = JSON.parse(JSON.stringify(saveBoats())) as unknown;
    resetFleet();
    expect(livingBoats()).toHaveLength(0);
    loadBoats(blob);

    const after = fleetSnapshot();
    expect(after.villages).toEqual(before.villages);
    expect(after.boats.map((b) => b.id)).toEqual(before.boats.map((b) => b.id));
    expect(after.nextBoatId).toBe(before.nextBoatId);
  });

  it('does not carry a fight across a restart', () => {
    const world = coastWorld();
    buildFullFleet(world);
    const kraken = { x: VILLAGE_X + BOAT_ENGAGEMENT_RANGE_CELLS - 1, y: VILLAGE_Y };
    for (let n = 0; n < 100; n++) advanceFleet(world, kraken, TICK_DT);
    expect(currentKrakenWounds()).toBeGreaterThan(0);

    const blob = JSON.parse(JSON.stringify(saveBoats())) as unknown;
    resetFleet();
    loadBoats(blob);
    // A rebooted world re-summons or restores a WHOLE kraken; carrying wounds
    // over would let a restart rout a fresh one.
    expect(currentKrakenWounds()).toBe(0);
    expect(livingBoats().every((boat) => !boat.fighting)).toBe(true);
  });

  it('discards a corrupt blob whole', () => {
    const world = coastWorld();
    buildFullFleet(world);
    const good = fleetSnapshot();
    loadBoats({ villages: [{ x: 1 }], boats: [], nextBoatId: 1 });
    expect(fleetSnapshot().villages).toEqual(good.villages);
  });
});

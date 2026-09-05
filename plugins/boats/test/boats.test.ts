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
  COASTAL_SEARCH_RADIUS_CELLS,
  KRAKEN_ROUT_WOUNDS,
  KRAKEN_SINKS_BOAT_EVERY_SECONDS,
  KRAKEN_WOUND_HEAL_PER_SECOND,
  VILLAGE_MIN_TIER,
  VILLAGE_PATROL_RANGE_CELLS,
} from '../protocol.ts';
import {
  BOAT_PERSONAL_SPACE_CELLS,
  advanceFleet,
  currentKrakenWounds,
  fleetSnapshot,
  forgetVillage,
  isSailable,
  launchCell,
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
   *
   * THE FLEET STARTS AT STATION (2026-09-03), already inside engagement range,
   * for the same reason the kraken never moves: this measures attrition, not
   * transit. Until boats had hulls the sail-in was free — every boat launched
   * on one point berth a cell inside the circle and pivoted to face the fight
   * — so the pinned times held by accident. A hull berths a few cells out
   * facing out of harbour and takes seconds to come about, and those seconds
   * are steering, which is precisely what this fixture excludes.
   */
  function fightToTheEnd(startingBoats: number): {
    routed: boolean;
    seconds: number;
    survivors: number;
  } {
    const world = coastWorld();
    buildFullFleet(world);
    const kraken = { x: VILLAGE_X + BOAT_ENGAGEMENT_RANGE_CELLS - 1, y: VILLAGE_Y };
    // Trim to the fleet under test, so 1 and 2 boats are the same code path as 3,
    // and moor each on the station circle south of the kraken, one boat length
    // apart along the arc, facing it — the pose a fleet holds at the fight's edge.
    const stationed = livingBoats()
      .slice(0, startingBoats)
      .map((boat, rank) => {
        const bearing = Math.PI / 2 + rank * (2 * BOAT_PERSONAL_SPACE_CELLS * 2) / BOAT_ENGAGEMENT_RANGE_CELLS;
        const x = kraken.x + Math.cos(bearing) * (BOAT_ENGAGEMENT_RANGE_CELLS - 1);
        const y = kraken.y + Math.sin(bearing) * (BOAT_ENGAGEMENT_RANGE_CELLS - 1);
        return { ...boat, x, y, heading: bearing + Math.PI };
      });
    restoreFleet({
      villages: [{ x: VILLAGE_X, y: VILLAGE_Y, rebuildSeconds: 0 }],
      boats: stationed,
      nextBoatId: 99,
    });

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
    // Genuinely inland: dry ground across the WHOLE coastal search disc, not
    // merely at the settlement's own four neighbours. That weaker fixture is
    // what let the adjacency bug below ship green.
    const land: Array<readonly [number, number]> = [];
    const reach = COASTAL_SEARCH_RADIUS_CELLS;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) land.push([VILLAGE_X + dx, VILLAGE_Y + dy]);
    }
    const world = seaWorld(land);
    rememberVillage(VILLAGE_X, VILLAGE_Y);
    for (let n = 0; n < 2000; n++) advanceFleet(world, null, TICK_DT);
    expect(livingBoats()).toHaveLength(0);
  });

  it('sends boats from a village whose water is several cells away', () => {
    // THE REGRESSION (owner, 2026-08-20: "How come I don't see any boats
    // spawning"). launchCell used to require a wet 4-NEIGHBOUR. Settlements sit
    // on buildable ground, which the shoreline itself rarely is, so measured
    // against the live world that test called all seven tier-1 settlements
    // inland — including one the structures plugin had already given a harbour
    // and skiffs to, whose water was three cells south. Not one boat was ever
    // built.
    //
    // This fixture is that settlement: dry ground for two cells in every
    // direction, open sea beyond, so the nearest water is three cells off and
    // NO 4-neighbour is wet.
    const land: Array<readonly [number, number]> = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) land.push([VILLAGE_X + dx, VILLAGE_Y + dy]);
    }
    const world = seaWorld(land);

    expect(isSailable(world, VILLAGE_X + 1, VILLAGE_Y)).toBe(false);
    expect(launchCell(world, { x: VILLAGE_X, y: VILLAGE_Y, rebuildSeconds: 0 })).not.toBeNull();

    rememberVillage(VILLAGE_X, VILLAGE_Y);
    const ticks = Math.ceil((BOAT_REBUILD_SECONDS + 1) / TICK_DT);
    for (let n = 0; n < ticks; n++) advanceFleet(world, null, TICK_DT);
    expect(livingBoats()).toHaveLength(1);
  });

  it('needs more than a single puddle to count as coastal', () => {
    // COASTAL_MIN_WATER_CELLS, restated from structures: one stray wet cell in
    // the disc is a pond, not a coastline.
    const land: Array<readonly [number, number]> = [];
    const reach = COASTAL_SEARCH_RADIUS_CELLS;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        // One cell left wet, everything else in the disc dry.
        if (dx === 2 && dy === 0) continue;
        land.push([VILLAGE_X + dx, VILLAGE_Y + dy]);
      }
    }
    const world = seaWorld(land);
    expect(launchCell(world, { x: VILLAGE_X, y: VILLAGE_Y, rebuildSeconds: 0 })).toBeNull();
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

describe('a fleet is a fleet, not a stack (owner, 2026-08-20)', () => {
  /**
   * Every boat is dispatched to the same kraken and told to hold at the same
   * BOAT_ENGAGEMENT_RANGE_CELLS, so before separation existed they converged on
   * one point of one circle and turned in place together — "they just kind of
   * spin on top of each other". These pin both halves of the fix: they spread,
   * and spreading does not cost them the fight.
   */
  function engagedFleet(): { world: BoatWorld; kraken: { x: number; y: number } } {
    const world = coastWorld();
    buildFullFleet(world);
    const kraken = { x: VILLAGE_X + BOAT_ENGAGEMENT_RANGE_CELLS - 1, y: VILLAGE_Y };
    return { world, kraken };
  }

  it('spreads boats holding the same station instead of stacking them', () => {
    const { world, kraken } = engagedFleet();
    // Every boat launches from its OWN berth (launchBerth, 2026-08-24 — owner:
    // boats were "spawning on top of each other"), so a fleet is already spread
    // the instant it is built rather than only after it has sorted itself out.
    const start = livingBoats().map((boat) => ({ x: boat.x, y: boat.y }));
    expect(new Set(start.map((p) => `${p.x},${p.y}`)).size).toBe(start.length);

    // Ten seconds of station-keeping, with nothing sinking (the kraken sinks a
    // boat every KRAKEN_SINKS_BOAT_EVERY_SECONDS, so keep the window short).
    for (let n = 0; n < 50; n++) advanceFleet(world, kraken, TICK_DT);

    const boats = livingBoats();
    expect(boats.length).toBeGreaterThan(1);
    for (let i = 0; i < boats.length; i++) {
      for (let j = i + 1; j < boats.length; j++) {
        const gap = Math.hypot(boats[i].x - boats[j].x, boats[i].y - boats[j].y);
        expect(gap).toBeGreaterThan(BOAT_PERSONAL_SPACE_CELLS);
      }
    }
  });

  it('keeps every spread boat inside engagement range — it shuffles ALONG the station circle', () => {
    // The reason `makeRoom` rotates about the goal rather than backing away
    // from the crowd: a boat pushed radially outward would stop fighting, and
    // protocol.ts's rout arithmetic counts whole seconds of engagement.
    const { world, kraken } = engagedFleet();
    // ENGAGEMENT IS NOW SOMETHING A BOAT ARRIVES AT, not something it starts
    // in: since boats launch from separate berths (launchBerth) the outer ones
    // begin a cell or so beyond BOAT_ENGAGEMENT_RANGE_CELLS and sail in. So the
    // property under test is the one makeRoom actually owes — once a boat is
    // engaged, shuffling never puts it back out — rather than "every boat is
    // engaged on tick one", which was an artefact of the shared launch cell.
    //
    // THE WINDOW IS 11 SECONDS, not 5 (2026-09-05): berths now stand off the
    // shore by BERTH_STANDOFF_CELLS so the skiffs keep the inshore strip, and a
    // boat berthed on the far side of the village starts ~29 cells from a
    // kraken it must close to 20 — a coming-about plus four seconds of sailing.
    // Still short of KRAKEN_SINKS_BOAT_EVERY_SECONDS, so nothing sinks and the
    // count below still compares like with like.
    const everEngaged = new Set<number>();
    for (let n = 0; n < 110; n++) {
      advanceFleet(world, kraken, TICK_DT);
      for (const boat of livingBoats()) {
        if (boat.fighting) everEngaged.add(boat.id);
        if (!everEngaged.has(boat.id)) continue;
        expect(Math.hypot(boat.x - kraken.x, boat.y - kraken.y)).toBeLessThanOrEqual(
          BOAT_ENGAGEMENT_RANGE_CELLS,
        );
        expect(boat.fighting).toBe(true);
      }
    }
    // The fleet did close: the property above is vacuous if nobody ever engaged.
    expect(everEngaged.size).toBe(livingBoats().length);
  });

  it('never shuffles a boat onto dry land', () => {
    // A shuffling boat goes through the same sailable test as a sailing one.
    const { world, kraken } = engagedFleet();
    for (let n = 0; n < 200; n++) {
      advanceFleet(world, kraken, TICK_DT);
      for (const boat of livingBoats()) expect(isSailable(world, boat.x, boat.y)).toBe(true);
    }
  });
});

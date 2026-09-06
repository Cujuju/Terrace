// squadrons — the assembly contract, tested against the contract and not
// against the callsites.
//
// ../server/squadrons.ts is deliberately pure of the world: every terrain
// question it has goes through `SquadronNavigator`. That is what lets these
// tests state the contract as properties of a hand-built roster — sizes,
// spread, determinism, recall, muster — with no heightmap, no hull law and no
// route pool anywhere in the file. The one thing NOT tested here is what a leg
// is, because "reachable open water on a bearing" is ../server/fleet.ts's
// answer under the hull law, and ../test/boats.test.ts is where hull law is
// asserted.

import { beforeEach, describe, expect, it } from 'vitest';
import { BOATS_PER_VILLAGE, VILLAGE_PATROL_RANGE_CELLS } from '../protocol.ts';
import {
  EXPLORERS_PER_VILLAGE,
  HOME_GUARD_BOATS_PER_VILLAGE,
  SQUADRON_HOME_SPREAD_CELLS,
  SQUADRON_MAX_SHIPS,
  SQUADRON_MIN_SHIPS,
  SQUADRON_MUSTER_RADIUS_CELLS,
  SQUADRON_MUSTER_TIMEOUT_SECONDS,
  advanceSquadrons,
  resetSquadrons,
  squadronCount,
  squadronMembers,
  squadronOf,
  type SquadronBoat,
  type SquadronNavigator,
  type SquadronWaypoint,
} from '../server/squadrons.ts';

const TICK_DT = 0.1;

/** A leg's end, far enough out that no roster below is ever standing on it. */
const LEG_END: SquadronWaypoint = { x: 10_000, y: 10_000 };

/**
 * A navigator that always answers: every village moors at its own cell, and
 * every bearing affords a leg. Terrain refusal is fleet.ts's business; these
 * tests are about what the state machine does with the answers.
 */
function openSea(): SquadronNavigator {
  return {
    rendezvousFor: (homeX, homeY) => ({ x: homeX, y: homeY }),
    isInHarbour: () => true,
    legFrom: () => LEG_END,
  };
}

/** A navigator whose villages have no water at all. */
function landlocked(): SquadronNavigator {
  return { rendezvousFor: () => null, isInHarbour: () => true, legFrom: () => null };
}

/** A navigator that musters but can never draw a leg. */
function noWayOut(): SquadronNavigator {
  return {
    rendezvousFor: (homeX, homeY) => ({ x: homeX, y: homeY }),
    isInHarbour: () => true,
    legFrom: () => null,
  };
}

let nextId = 1;

/**
 * `EXPLORERS_PER_VILLAGE` boats for each village, sitting on their own home
 * cell — which is where `openSea`'s rendezvous is, so a roster built this way
 * is mustered from the first tick unless a test moves someone.
 */
function explorersFor(villages: ReadonlyArray<readonly [number, number]>): SquadronBoat[] {
  const roster: SquadronBoat[] = [];
  for (const [homeX, homeY] of villages) {
    for (let n = 0; n < EXPLORERS_PER_VILLAGE; n++) {
      roster.push({ id: nextId++, x: homeX, y: homeY, homeX, homeY });
    }
  }
  return roster;
}

/** A row of villages one cell apart — well inside SQUADRON_HOME_SPREAD_CELLS. */
function neighbouringVillages(count: number): Array<readonly [number, number]> {
  return Array.from({ length: count }, (_unused, n) => [100 + n, 100] as const);
}

/**
 * A row of villages far enough apart that a ship lying at its OWN mooring is
 * outside the FLAGSHIP's muster radius — which is the only arrangement in
 * which mustering is observable at all. Still well inside the home spread, so
 * one squadron may still be crewed from them.
 */
function spreadVillages(count: number): Array<readonly [number, number]> {
  const spacing = Math.ceil(SQUADRON_MUSTER_RADIUS_CELLS) * 3;
  expect(spacing * (count - 1)).toBeLessThan(SQUADRON_HOME_SPREAD_CELLS);
  return Array.from({ length: count }, (_unused, n) => [100 + n * spacing, 100] as const);
}

/** Every ship of every squadron, as one flat list of boat ids. */
function allSquadronMembers(): number[] {
  const ids: number[] = [];
  for (let id = 1; id <= nextId; id++) {
    const members = squadronMembers(id);
    if (members.length > 0) ids.push(...members);
  }
  return ids;
}

beforeEach(() => {
  resetSquadrons();
  nextId = 1;
});

describe('the home guard leaves something to explore', () => {
  it('frees at least SQUADRON_MIN_SHIPS from a handful of villages', () => {
    // The arithmetic HOME_GUARD_BOATS_PER_VILLAGE is chosen against: a
    // squadron must be crewable from villages close enough together to share
    // one recall. If a future edit raised the guard to BOATS_PER_VILLAGE this
    // fails here rather than by silently never forming a squadron.
    expect(EXPLORERS_PER_VILLAGE).toBe(BOATS_PER_VILLAGE - HOME_GUARD_BOATS_PER_VILLAGE);
    expect(EXPLORERS_PER_VILLAGE).toBeGreaterThan(0);
    const villagesNeeded = Math.ceil(SQUADRON_MAX_SHIPS / EXPLORERS_PER_VILLAGE);
    expect(villagesNeeded * EXPLORERS_PER_VILLAGE).toBeGreaterThanOrEqual(SQUADRON_MAX_SHIPS);
  });

  it('crews a full squadron from villages inside one recall range', () => {
    // Every ship of a squadron must be answerable to the same kraken, so the
    // villages a full squadron takes must fit inside SQUADRON_HOME_SPREAD_CELLS.
    expect(SQUADRON_HOME_SPREAD_CELLS).toBe(VILLAGE_PATROL_RANGE_CELLS);
  });
});

describe('assembly', () => {
  it('forms nothing from fewer ships than a squadron takes', () => {
    const roster = explorersFor(neighbouringVillages(1));
    expect(roster.length).toBeLessThan(SQUADRON_MIN_SHIPS);
    const goals = advanceSquadrons(roster, openSea(), TICK_DT);
    expect(squadronCount()).toBe(0);
    expect(goals.size).toBe(0);
  });

  it('never forms a squadron outside three to seven ships', () => {
    // Twelve villages: enough that several squadrons form and the last run is
    // a short one, which is the case a greedy chunker gets wrong.
    const roster = explorersFor(neighbouringVillages(12));
    advanceSquadrons(roster, openSea(), TICK_DT);
    expect(squadronCount()).toBeGreaterThan(0);
    for (let id = 1; id <= nextId; id++) {
      const members = squadronMembers(id);
      if (members.length === 0) continue;
      expect(members.length).toBeGreaterThanOrEqual(SQUADRON_MIN_SHIPS);
      expect(members.length).toBeLessThanOrEqual(SQUADRON_MAX_SHIPS);
    }
  });

  it('never puts one ship in two squadrons', () => {
    const roster = explorersFor(neighbouringVillages(12));
    advanceSquadrons(roster, openSea(), TICK_DT);
    const members = allSquadronMembers();
    expect(new Set(members).size).toBe(members.length);
  });

  it('crews a squadron only from homes inside the spread', () => {
    // Two clusters a full spread and more apart: no squadron may straddle them.
    const far = SQUADRON_HOME_SPREAD_CELLS * 4;
    const homes = [
      ...neighbouringVillages(4),
      ...neighbouringVillages(4).map(([x, y]) => [x + far, y] as const),
    ];
    const roster = explorersFor(homes);
    const homeOf = new Map(roster.map((boat) => [boat.id, boat]));
    advanceSquadrons(roster, openSea(), TICK_DT);
    for (let id = 1; id <= nextId; id++) {
      const members = squadronMembers(id);
      if (members.length === 0) continue;
      const flagship = homeOf.get(members[0]);
      expect(flagship).toBeDefined();
      for (const boatId of members) {
        const ship = homeOf.get(boatId);
        expect(ship).toBeDefined();
        const dx = ship!.homeX - flagship!.homeX;
        const dy = ship!.homeY - flagship!.homeY;
        expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThanOrEqual(SQUADRON_HOME_SPREAD_CELLS);
      }
    }
  });

  it('forms nothing when no village has water to muster on', () => {
    const roster = explorersFor(neighbouringVillages(12));
    advanceSquadrons(roster, landlocked(), TICK_DT);
    expect(squadronCount()).toBe(0);
  });

  it('assembles the same fleet twice from the same roster', () => {
    const roster = explorersFor(neighbouringVillages(12));
    advanceSquadrons(roster, openSea(), TICK_DT);
    const first = roster.map((boat) => squadronMembers(squadronOf(boat.id) ?? 0).join(','));
    resetSquadrons();
    advanceSquadrons(roster, openSea(), TICK_DT);
    const second = roster.map((boat) => squadronMembers(squadronOf(boat.id) ?? 0).join(','));
    expect(second).toEqual(first);
  });

  it('assembles the same fleet whatever order the roster arrives in', () => {
    // The ordering contract is the Z-order key over HOME cells, not the order
    // the fleet happens to hold its boats in.
    const roster = explorersFor(neighbouringVillages(12));
    advanceSquadrons(roster, openSea(), TICK_DT);
    const crews = new Set<string>();
    for (let id = 1; id <= nextId; id++) {
      const members = squadronMembers(id);
      if (members.length > 0) crews.add([...members].sort((a, b) => a - b).join(','));
    }
    resetSquadrons();
    advanceSquadrons([...roster].reverse(), openSea(), TICK_DT);
    const reversed = new Set<string>();
    for (let id = 1; id <= nextId; id++) {
      const members = squadronMembers(id);
      if (members.length > 0) reversed.add([...members].sort((a, b) => a - b).join(','));
    }
    expect(reversed).toEqual(crews);
  });
});

describe('mustering', () => {
  it('holds the rendezvous until every ship is on it', () => {
    // Ships lying at their OWN moorings, villages far enough apart that they
    // are not yet at the flagship's. The squadron forms, and steers for the
    // rendezvous rather than for a leg.
    const roster = explorersFor(spreadVillages(4));
    const goals = advanceSquadrons(roster, openSea(), TICK_DT);
    expect(squadronCount()).toBeGreaterThan(0);
    const sailing = roster.filter((boat) => squadronOf(boat.id) !== null);
    expect(sailing.length).toBeGreaterThanOrEqual(SQUADRON_MIN_SHIPS);
    for (const boat of sailing) {
      const goal = goals.get(boat.id);
      expect(goal).toBeDefined();
      expect(goal).not.toEqual(LEG_END);
    }
  });

  it('sails once every ship is on the rendezvous', () => {
    const roster = explorersFor(neighbouringVillages(4));
    const goals = advanceSquadrons(roster, openSea(), TICK_DT);
    const sailing = roster.filter((boat) => squadronOf(boat.id) !== null);
    expect(sailing.length).toBeGreaterThanOrEqual(SQUADRON_MIN_SHIPS);
    for (const boat of sailing) expect(goals.get(boat.id)).toEqual(LEG_END);
  });

  it('gives every ship of a squadron the same waypoint', () => {
    const roster = explorersFor(neighbouringVillages(12));
    const goals = advanceSquadrons(roster, openSea(), TICK_DT);
    for (let id = 1; id <= nextId; id++) {
      const members = squadronMembers(id);
      if (members.length === 0) continue;
      const first = goals.get(members[0]);
      for (const boatId of members) expect(goals.get(boatId)).toEqual(first);
    }
  });

  it('sails without a straggler once the muster times out', () => {
    // Every ship sits at its own mooring and never moves, so only the ones
    // homed at the flagship's own village ever reach the rendezvous. The
    // squadron must eventually sail without the rest rather than wait forever.
    const roster = explorersFor(spreadVillages(4));
    advanceSquadrons(roster, openSea(), TICK_DT);
    expect(squadronCount()).toBe(1);
    const crew = [...squadronMembers(1)];
    const rendezvous = openSea().rendezvousFor(
      roster.find((boat) => boat.id === crew[0])!.homeX,
      roster.find((boat) => boat.id === crew[0])!.homeY,
    )!;
    const stragglers = crew.filter((boatId) => {
      const ship = roster.find((boat) => boat.id === boatId)!;
      const dx = ship.x - rendezvous.x;
      const dy = ship.y - rendezvous.y;
      return Math.sqrt(dx * dx + dy * dy) > SQUADRON_MUSTER_RADIUS_CELLS;
    });
    expect(stragglers.length).toBeGreaterThan(0);

    const ticks = Math.ceil(SQUADRON_MUSTER_TIMEOUT_SECONDS / TICK_DT) + 1;
    let goals = new Map<number, SquadronWaypoint>();
    for (let n = 0; n < ticks; n++) goals = advanceSquadrons(roster, openSea(), TICK_DT);

    const sailed = squadronMembers(1);
    if (sailed.length > 0) {
      // The original squadron sailed: it is at sea, still at strength, and
      // carries none of the ships that never came.
      expect(sailed.length).toBeGreaterThanOrEqual(SQUADRON_MIN_SHIPS);
      for (const boatId of stragglers) expect(sailed).not.toContain(boatId);
      expect(goals.get(sailed[0])).toEqual(LEG_END);
    } else {
      // Or it went under strength and dissolved, which is the other legal
      // outcome — never a squadron held at anchor for the life of the world.
      expect(squadronMembers(1)).toHaveLength(0);
    }
  });

  it('holds the rendezvous rather than sailing nowhere when no leg draws', () => {
    const roster = explorersFor(neighbouringVillages(4));
    const goals = advanceSquadrons(roster, noWayOut(), TICK_DT);
    for (const boat of roster) {
      const goal = goals.get(boat.id);
      if (goal === undefined) continue;
      expect(goal).not.toEqual(LEG_END);
    }
  });
});

describe('recall dissolves rather than tops up', () => {
  it('drops a ship the fleet has taken back', () => {
    const roster = explorersFor(neighbouringVillages(12));
    advanceSquadrons(roster, openSea(), TICK_DT);
    const recalled = roster.find((boat) => squadronOf(boat.id) !== null);
    expect(recalled).toBeDefined();
    const remaining = roster.filter((boat) => boat.id !== recalled!.id);
    advanceSquadrons(remaining, openSea(), TICK_DT);
    expect(squadronOf(recalled!.id)).toBeNull();
    expect(allSquadronMembers()).not.toContain(recalled!.id);
  });

  it('dissolves a squadron taken under strength and releases every survivor', () => {
    // One cluster only, so exactly one squadron forms and its crew is known.
    const roster = explorersFor(neighbouringVillages(2));
    expect(roster.length).toBe(SQUADRON_MIN_SHIPS + 1);
    advanceSquadrons(roster, openSea(), TICK_DT);
    expect(squadronCount()).toBe(1);
    const crew = [...squadronMembers(1)];
    // Take back enough that the squadron cannot sail.
    const left = roster.filter((boat) => !crew.slice(0, 2).includes(boat.id));
    advanceSquadrons(left, openSea(), TICK_DT);
    for (const boatId of crew) expect(squadronOf(boatId)).toBeNull();
  });

  it('never leaves a ship pointing at a squadron that is gone', () => {
    const roster = explorersFor(neighbouringVillages(12));
    advanceSquadrons(roster, openSea(), TICK_DT);
    advanceSquadrons([], openSea(), TICK_DT);
    expect(squadronCount()).toBe(0);
    for (const boat of roster) expect(squadronOf(boat.id)).toBeNull();
  });
});

describe('cruising', () => {
  it('draws a fresh leg once the flagship arrives on the last one', () => {
    const roster = explorersFor(neighbouringVillages(4));
    advanceSquadrons(roster, openSea(), TICK_DT);
    const squadronId = roster.map((boat) => squadronOf(boat.id)).find((id) => id !== null);
    expect(squadronId).toBeDefined();
    const flagshipId = squadronMembers(squadronId!)[0];

    // A navigator that hands out a different leg each time it is asked, so
    // "the leg changed" is observable.
    let drawn = 0;
    const legs: SquadronWaypoint[] = [
      { x: 20_000, y: 0 },
      { x: 30_000, y: 0 },
    ];
    const wandering: SquadronNavigator = {
      rendezvousFor: (homeX, homeY) => ({ x: homeX, y: homeY }),
      isInHarbour: () => true,
      legFrom: () => legs[Math.min(drawn++, legs.length - 1)],
    };
    resetSquadrons();
    let goals = advanceSquadrons(roster, wandering, TICK_DT);
    const first = goals.get(flagshipId);
    expect(first).toEqual(legs[0]);

    // Put the flagship on its leg; every other ship stays behind.
    const arrived = roster.map((boat) =>
      boat.id === flagshipId ? { ...boat, x: legs[0].x, y: legs[0].y } : boat,
    );
    goals = advanceSquadrons(arrived, wandering, TICK_DT);
    expect(goals.get(flagshipId)).toEqual(legs[1]);
    // And the ships astern are sent to the same new leg, not left on the old.
    for (const boatId of squadronMembers(squadronId!)) {
      expect(goals.get(boatId)).toEqual(legs[1]);
    }
  });

  it('holds the leg it is on when no fresh one draws', () => {
    const roster = explorersFor(neighbouringVillages(4));
    let goals = advanceSquadrons(roster, openSea(), TICK_DT);
    const squadronId = roster.map((boat) => squadronOf(boat.id)).find((id) => id !== null);
    const flagshipId = squadronMembers(squadronId!)[0];
    expect(goals.get(flagshipId)).toEqual(LEG_END);

    const barred: SquadronNavigator = {
      rendezvousFor: (homeX, homeY) => ({ x: homeX, y: homeY }),
      isInHarbour: () => true,
      legFrom: () => null,
    };
    const arrived = roster.map((boat) =>
      boat.id === flagshipId ? { ...boat, x: LEG_END.x, y: LEG_END.y } : boat,
    );
    goals = advanceSquadrons(arrived, barred, TICK_DT);
    expect(goals.get(flagshipId)).toEqual(LEG_END);
  });
});

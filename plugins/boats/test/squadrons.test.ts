import { beforeEach, describe, expect, it } from 'vitest';
import { BOATS_PER_VILLAGE, VILLAGE_PATROL_RANGE_CELLS } from '../protocol.ts';
import {
  EXPLORERS_PER_VILLAGE,
  HOME_GUARD_BOATS_PER_VILLAGE,
  SQUADRON_FORMATION_SPREAD_CELLS,
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

const LEG_END: SquadronWaypoint = { x: 10_000, y: 10_000 };

function openSea(): SquadronNavigator {
  return {
    legFrom: () => LEG_END,
  };
}

function noWayOut(): SquadronNavigator {
  return { legFrom: () => null };
}

let nextId = 1;

function explorersFor(villages: ReadonlyArray<readonly [number, number]>): SquadronBoat[] {
  const roster: SquadronBoat[] = [];
  for (const [homeX, homeY] of villages) {
    for (let n = 0; n < EXPLORERS_PER_VILLAGE; n++) {
      roster.push({ id: nextId++, x: homeX, y: homeY, homeX, homeY });
    }
  }
  return roster;
}

function neighbouringVillages(count: number): Array<readonly [number, number]> {
  return Array.from({ length: count }, (_unused, n) => [100 + n, 100] as const);
}

function spreadVillages(count: number): Array<readonly [number, number]> {
  const spacing = Math.ceil(SQUADRON_MUSTER_RADIUS_CELLS) * 3;
  expect(spacing * (count - 1)).toBeLessThan(SQUADRON_FORMATION_SPREAD_CELLS);
  return Array.from({ length: count }, (_unused, n) => [100 + n * spacing, 100] as const);
}

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
    expect(EXPLORERS_PER_VILLAGE).toBe(BOATS_PER_VILLAGE - HOME_GUARD_BOATS_PER_VILLAGE);
    expect(EXPLORERS_PER_VILLAGE).toBeGreaterThan(0);
    const villagesNeeded = Math.ceil(SQUADRON_MAX_SHIPS / EXPLORERS_PER_VILLAGE);
    expect(villagesNeeded * EXPLORERS_PER_VILLAGE).toBeGreaterThanOrEqual(SQUADRON_MAX_SHIPS);
  });

  it('crews a fleet from boats inside one formation range', () => {
    expect(SQUADRON_FORMATION_SPREAD_CELLS).toBe(VILLAGE_PATROL_RANGE_CELLS);
  });
});

describe('assembly', () => {
  it('forms nothing from a lone boat', () => {
    const solo: SquadronBoat[] = [
      { id: nextId++, x: 100, y: 100, homeX: 100, homeY: 100 },
    ];
    const goals = advanceSquadrons(solo, openSea(), TICK_DT);
    expect(squadronCount()).toBe(0);
    expect(goals.size).toBe(0);
  });

  it('crews the smallest fleet from a pair', () => {
    const pair: SquadronBoat[] = [
      { id: nextId++, x: 100, y: 100, homeX: 100, homeY: 100 },
      { id: nextId++, x: 101, y: 100, homeX: 101, homeY: 100 },
    ];
    expect(pair.length).toBe(SQUADRON_MIN_SHIPS);
    advanceSquadrons(pair, openSea(), TICK_DT);
    expect(squadronCount()).toBe(1);
    expect(squadronOf(pair[0].id)).toBe(squadronOf(pair[1].id));
  });

  it('never forms a fleet outside two to five ships', () => {
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

  it('puts every boat in a fleet, with no singleton left behind', () => {
    const roster = explorersFor(neighbouringVillages(7));
    advanceSquadrons(roster, openSea(), TICK_DT);
    for (const boat of roster) expect(squadronOf(boat.id)).not.toBeNull();
  });

  it('attaches a loner to the nearest fleet', () => {
    const roster = explorersFor(neighbouringVillages(4));
    const loner: SquadronBoat = {
      id: nextId++,
      x: 100 + SQUADRON_FORMATION_SPREAD_CELLS * 10,
      y: 100,
      homeX: 100,
      homeY: 100,
    };
    advanceSquadrons([...roster, loner], openSea(), TICK_DT);
    expect(squadronOf(loner.id)).not.toBeNull();
    expect(squadronMembers(squadronOf(loner.id)!)).toContain(loner.id);
  });

  it('never puts one ship in two fleets', () => {
    const roster = explorersFor(neighbouringVillages(12));
    advanceSquadrons(roster, openSea(), TICK_DT);
    const members = allSquadronMembers();
    expect(new Set(members).size).toBe(members.length);
  });

  it('crews nearby boats together but never mixes distant clusters', () => {
    const far = SQUADRON_FORMATION_SPREAD_CELLS * 4;
    const homes = [
      ...neighbouringVillages(4),
      ...neighbouringVillages(4).map(([x, y]) => [x + far, y] as const),
    ];
    const roster = explorersFor(homes);
    const clusterOf = new Map(roster.map((boat) => [boat.id, boat.homeX < 100 + far / 2 ? 0 : 1]));
    advanceSquadrons(roster, openSea(), TICK_DT);
    for (let id = 1; id <= nextId; id++) {
      const members = squadronMembers(id);
      if (members.length === 0) continue;
      const clusters = new Set(members.map((boatId) => clusterOf.get(boatId)));
      expect(clusters.size).toBe(1);
    }
  });

  it('forms fleets wherever boats gather, not only in harbour', () => {
    const roster = explorersFor(neighbouringVillages(4)).map((boat) => ({
      ...boat,
      x: boat.x + 1000,
      y: boat.y - 500,
    }));
    advanceSquadrons(roster, openSea(), TICK_DT);
    expect(squadronCount()).toBeGreaterThan(0);
    for (const boat of roster) expect(squadronOf(boat.id)).not.toBeNull();
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

  it('gives every ship of a fleet the same waypoint', () => {
    const roster = explorersFor(neighbouringVillages(12));
    const goals = advanceSquadrons(roster, openSea(), TICK_DT);
    for (let id = 1; id <= nextId; id++) {
      const members = squadronMembers(id);
      if (members.length === 0) continue;
      const first = goals.get(members[0]);
      for (const boatId of members) expect(goals.get(boatId)).toEqual(first);
    }
  });

  it('sails with the whole crew once the muster times out; stragglers chase', () => {
    const roster = explorersFor(spreadVillages(4));
    advanceSquadrons(roster, openSea(), TICK_DT);
    expect(squadronCount()).toBeGreaterThanOrEqual(1);
    const crew = [...squadronMembers(1)];
    const flagship = roster.find((boat) => boat.id === crew[0])!;
    const stragglers = crew.filter((boatId) => {
      const ship = roster.find((boat) => boat.id === boatId)!;
      const dx = ship.x - flagship.x;
      const dy = ship.y - flagship.y;
      return Math.sqrt(dx * dx + dy * dy) > SQUADRON_MUSTER_RADIUS_CELLS;
    });
    expect(stragglers.length).toBeGreaterThan(0);

    const ticks = Math.ceil(SQUADRON_MUSTER_TIMEOUT_SECONDS / TICK_DT) + 1;
    let goals = new Map<number, SquadronWaypoint>();
    for (let n = 0; n < ticks; n++) goals = advanceSquadrons(roster, openSea(), TICK_DT);

    // Nobody is kicked: the fleet sails and the stragglers chase the same leg.
    const sailed = squadronMembers(1);
    expect(sailed.length).toBe(crew.length);
    for (const boatId of stragglers) expect(sailed).toContain(boatId);
    expect(goals.get(sailed[0])).toEqual(LEG_END);
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

describe('pruning dissolves rather than tops up', () => {
  it('drops a ship that is gone', () => {
    const roster = explorersFor(neighbouringVillages(12));
    advanceSquadrons(roster, openSea(), TICK_DT);
    const gone = roster.find((boat) => squadronOf(boat.id) !== null);
    expect(gone).toBeDefined();
    const remaining = roster.filter((boat) => boat.id !== gone!.id);
    advanceSquadrons(remaining, openSea(), TICK_DT);
    expect(squadronOf(gone!.id)).toBeNull();
    expect(allSquadronMembers()).not.toContain(gone!.id);
  });

  it('dissolves a fleet taken under strength and releases every survivor', () => {
    const roster = explorersFor(neighbouringVillages(2));
    expect(roster.length).toBe(2 * EXPLORERS_PER_VILLAGE);
    advanceSquadrons(roster, openSea(), TICK_DT);
    expect(squadronCount()).toBeGreaterThanOrEqual(1);
    const crew = [...squadronMembers(1)];
    // Leave one survivor: too few to crew, and nothing to attach to.
    const survivors = crew.slice(-1);
    const left = roster.filter((boat) => survivors.includes(boat.id));
    advanceSquadrons(left, openSea(), TICK_DT);
    expect(squadronCount()).toBe(0);
    for (const boatId of crew) expect(squadronOf(boatId)).toBeNull();
  });

  it('never leaves a ship pointing at a fleet that is gone', () => {
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

    let drawn = 0;
    const legs: SquadronWaypoint[] = [
      { x: 20_000, y: 0 },
      { x: 30_000, y: 0 },
    ];
    const wandering: SquadronNavigator = {
      legFrom: () => legs[Math.min(drawn++, legs.length - 1)],
    };
    resetSquadrons();
    let goals = advanceSquadrons(roster, wandering, TICK_DT);
    const first = goals.get(flagshipId);
    expect(first).toEqual(legs[0]);

    const arrived = roster.map((boat) =>
      boat.id === flagshipId ? { ...boat, x: legs[0].x, y: legs[0].y } : boat,
    );
    goals = advanceSquadrons(arrived, wandering, TICK_DT);
    expect(goals.get(flagshipId)).toEqual(legs[1]);
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
      legFrom: () => null,
    };
    const arrived = roster.map((boat) =>
      boat.id === flagshipId ? { ...boat, x: LEG_END.x, y: LEG_END.y } : boat,
    );
    goals = advanceSquadrons(arrived, barred, TICK_DT);
    expect(goals.get(flagshipId)).toEqual(LEG_END);
  });
});

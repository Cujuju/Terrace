import { cellsAcross } from '@terrace/shared';
import { BOATS_PER_VILLAGE, VILLAGE_PATROL_RANGE_CELLS } from '../protocol.ts';

export const HOME_GUARD_BOATS_PER_VILLAGE = 1;

export const EXPLORERS_PER_VILLAGE = BOATS_PER_VILLAGE - HOME_GUARD_BOATS_PER_VILLAGE;

export const SQUADRON_MIN_SHIPS = 3;

export const SQUADRON_MAX_SHIPS = 7;

export const SQUADRON_HOME_SPREAD_CELLS = VILLAGE_PATROL_RANGE_CELLS;

const BOAT_PERSONAL_SPACE_WORLD_UNITS = 0.5;
export const SQUADRON_MUSTER_RADIUS_CELLS =
  2 * cellsAcross(BOAT_PERSONAL_SPACE_WORLD_UNITS) * Math.sqrt(SQUADRON_MAX_SHIPS);

export const SQUADRON_MUSTER_TIMEOUT_SECONDS = 60;

export const SQUADRON_LEG_LENGTH_CELLS = 2 * VILLAGE_PATROL_RANGE_CELLS;

export const SQUADRON_LEG_MIN_LENGTH_CELLS = VILLAGE_PATROL_RANGE_CELLS;

export const SQUADRON_WAYPOINT_ATTEMPTS = 8;

export interface SquadronWaypoint {
  readonly x: number;
  readonly y: number;
}

export interface SquadronBoat {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly homeX: number;
  readonly homeY: number;
}

export interface SquadronNavigator {
  rendezvousFor(homeX: number, homeY: number): SquadronWaypoint | null;
  isInHarbour(homeX: number, homeY: number, x: number, y: number): boolean;
  legFrom(
    fromX: number,
    fromY: number,
    seed: number,
    attempt: number,
  ): SquadronWaypoint | null;
}

type SquadronPhase = 'mustering' | 'cruising';

interface Squadron {
  readonly id: number;
  members: number[];
  readonly rendezvous: SquadronWaypoint;
  phase: SquadronPhase;
  musteringSeconds: number;
  leg: SquadronWaypoint | null;
  legsSailed: number;
  legSeedStep: number;
}

const squadrons = new Map<number, Squadron>();
const squadronOfBoat = new Map<number, number>();
let nextSquadronId = 1;

export function resetSquadrons(): void {
  squadrons.clear();
  squadronOfBoat.clear();
  nextSquadronId = 1;
}

export function squadronOf(boatId: number): number | null {
  return squadronOfBoat.get(boatId) ?? null;
}

export function squadronCount(): number {
  return squadrons.size;
}

export function squadronMembers(squadronId: number): readonly number[] {
  return squadrons.get(squadronId)?.members ?? [];
}

export function hashCell(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

const ZORDER_BITS_PER_AXIS = 16;

export function zOrderKey(x: number, y: number): number {
  const mask = (1 << ZORDER_BITS_PER_AXIS) - 1;
  const cx = x & mask;
  const cy = y & mask;
  let key = 0;
  for (let bit = 0; bit < ZORDER_BITS_PER_AXIS; bit++) {
    key += ((cx >>> bit) & 1) * Math.pow(2, 2 * bit);
    key += ((cy >>> bit) & 1) * Math.pow(2, 2 * bit + 1);
  }
  return key;
}

function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function targetSizeFor(homeX: number, homeY: number): number {
  const span = SQUADRON_MAX_SHIPS - SQUADRON_MIN_SHIPS + 1;
  return SQUADRON_MIN_SHIPS + (hashCell(homeX, homeY) % span);
}

function pruneSquadrons(candidates: ReadonlySet<number>): void {
  for (const [id, squadron] of squadrons) {
    squadron.members = squadron.members.filter((boatId) => candidates.has(boatId));
    if (squadron.members.length >= SQUADRON_MIN_SHIPS) continue;
    for (const boatId of squadron.members) squadronOfBoat.delete(boatId);
    squadrons.delete(id);
  }
  for (const [boatId, squadronId] of squadronOfBoat) {
    if (!squadrons.has(squadronId) || !candidates.has(boatId)) {
      squadronOfBoat.delete(boatId);
    }
  }
}

function formSquadrons(
  candidates: readonly SquadronBoat[],
  nav: SquadronNavigator,
): void {
  const unassigned = candidates.filter((boat) => {
    if (squadronOfBoat.has(boat.id)) return false;
    if (nav.rendezvousFor(boat.homeX, boat.homeY) === null) return false;
    return nav.isInHarbour(boat.homeX, boat.homeY, boat.x, boat.y);
  });
  const ordered = [...unassigned].sort((a, b) => {
    const ka = zOrderKey(a.homeX, a.homeY);
    const kb = zOrderKey(b.homeX, b.homeY);
    return ka === kb ? a.id - b.id : ka - kb;
  });

  let index = 0;
  while (index < ordered.length) {
    const flagship = ordered[index];
    const rendezvous = nav.rendezvousFor(flagship.homeX, flagship.homeY);
    if (rendezvous === null) {
      index++;
      continue;
    }
    const wanted = targetSizeFor(flagship.homeX, flagship.homeY);
    const spread = SQUADRON_HOME_SPREAD_CELLS * SQUADRON_HOME_SPREAD_CELLS;
    const crew: number[] = [];
    let scan = index;
    while (scan < ordered.length && crew.length < wanted) {
      const ship = ordered[scan];
      const near =
        distanceSquared(ship.homeX, ship.homeY, flagship.homeX, flagship.homeY) <= spread;
      if (!near) break;
      crew.push(ship.id);
      scan++;
    }
    if (crew.length < SQUADRON_MIN_SHIPS) {
      index++;
      continue;
    }
    const id = nextSquadronId++;
    squadrons.set(id, {
      id,
      members: crew,
      rendezvous,
      phase: 'mustering',
      musteringSeconds: 0,
      leg: null,
      legsSailed: 0,
      legSeedStep: 0,
    });
    for (const boatId of crew) squadronOfBoat.set(boatId, id);
    index = scan;
  }
}

function advanceSquadron(
  squadron: Squadron,
  positions: ReadonlyMap<number, SquadronBoat>,
  flagshipHome: SquadronBoat,
  nav: SquadronNavigator,
  dt: number,
): SquadronWaypoint | null {
  const musterRadius = SQUADRON_MUSTER_RADIUS_CELLS * SQUADRON_MUSTER_RADIUS_CELLS;

  if (squadron.phase === 'mustering') {
    squadron.musteringSeconds += dt;
    const gathered = squadron.members.filter((boatId) => {
      const ship = positions.get(boatId);
      return (
        ship !== undefined &&
        distanceSquared(ship.x, ship.y, squadron.rendezvous.x, squadron.rendezvous.y) <=
          musterRadius
      );
    });
    const timedOut = squadron.musteringSeconds >= SQUADRON_MUSTER_TIMEOUT_SECONDS;
    const complete = gathered.length === squadron.members.length;
    if (timedOut && !complete && gathered.length < SQUADRON_MIN_SHIPS) return null;
    if (!complete && !timedOut) {
      return squadron.rendezvous;
    }
    if (timedOut && !complete) {
      for (const boatId of squadron.members) {
        if (!gathered.includes(boatId)) squadronOfBoat.delete(boatId);
      }
      squadron.members = gathered;
    }
    const leg = planLeg(squadron, squadron.rendezvous, flagshipHome, nav);
    if (leg === null) return squadron.rendezvous;
    squadron.leg = leg;
    squadron.phase = 'cruising';
    return leg;
  }

  const flagship = positions.get(squadron.members[0]);
  const leg = squadron.leg;
  if (leg === null) {
    squadron.phase = 'mustering';
    squadron.musteringSeconds = 0;
    return squadron.rendezvous;
  }
  const arrived =
    flagship !== undefined &&
    distanceSquared(flagship.x, flagship.y, leg.x, leg.y) <= musterRadius;
  if (!arrived) return leg;
  squadron.legsSailed++;
  const next = planLeg(squadron, { x: flagship.x, y: flagship.y }, flagshipHome, nav);
  if (next === null) return leg;
  squadron.leg = next;
  return next;
}

function planLeg(
  squadron: Squadron,
  from: SquadronWaypoint,
  flagshipHome: SquadronBoat,
  nav: SquadronNavigator,
): SquadronWaypoint | null {
  const seed = hashCell(
    flagshipHome.homeX + squadron.legSeedStep,
    flagshipHome.homeY - squadron.legSeedStep,
  );
  squadron.legSeedStep++;
  for (let attempt = 0; attempt < SQUADRON_WAYPOINT_ATTEMPTS; attempt++) {
    const leg = nav.legFrom(from.x, from.y, seed, attempt);
    if (leg !== null) return leg;
  }
  return null;
}

export function advanceSquadrons(
  candidates: readonly SquadronBoat[],
  nav: SquadronNavigator,
  dt: number,
): Map<number, SquadronWaypoint> {
  const byId = new Map<number, SquadronBoat>();
  for (const boat of candidates) byId.set(boat.id, boat);

  pruneSquadrons(new Set(byId.keys()));
  formSquadrons(candidates, nav);

  const goals = new Map<number, SquadronWaypoint>();
  for (const squadron of squadrons.values()) {
    const flagship = byId.get(squadron.members[0]);
    if (flagship === undefined) continue;
    const waypoint = advanceSquadron(squadron, byId, flagship, nav, dt);
    if (waypoint === null) {
      for (const boatId of squadron.members) squadronOfBoat.delete(boatId);
      squadrons.delete(squadron.id);
      continue;
    }
    for (const boatId of squadron.members) goals.set(boatId, waypoint);
  }
  return goals;
}

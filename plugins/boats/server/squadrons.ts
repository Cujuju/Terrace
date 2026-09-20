import { cellsAcross } from '@terrace/shared';
import { BOATS_PER_VILLAGE, VILLAGE_PATROL_RANGE_CELLS } from '../protocol.ts';

export const HOME_GUARD_BOATS_PER_VILLAGE = 0;

export const EXPLORERS_PER_VILLAGE = BOATS_PER_VILLAGE - HOME_GUARD_BOATS_PER_VILLAGE;

export const SQUADRON_MIN_SHIPS = 2;

export const SQUADRON_MAX_SHIPS = 5;

/** Boats within this range of each other (current positions, not homes)
 * crew into the same squadron. Every boat joins a fleet: stragglers with
 * no neighbours attach to the nearest crew. */
export const SQUADRON_FORMATION_SPREAD_CELLS = VILLAGE_PATROL_RANGE_CELLS;

const BOAT_PERSONAL_SPACE_WORLD_UNITS = 0.5;
export const SQUADRON_MUSTER_RADIUS_CELLS =
  2 * cellsAcross(BOAT_PERSONAL_SPACE_WORLD_UNITS) * Math.sqrt(SQUADRON_MAX_SHIPS);

export const SQUADRON_MUSTER_TIMEOUT_SECONDS = 60;

/** Cruising legs stay short: sail one, arrive, draw the next. Map-spanning
 * legs outrun the hulls chasing them and flip faster than boats converge. */
export const SQUADRON_LEG_LENGTH_CELLS = Math.floor(VILLAGE_PATROL_RANGE_CELLS / 4);

/** Shortest leg before the spoke search gives up and the fleet holds. Kept
 * well above the muster/arrival radius so a drawn leg always means travel. */
export const SQUADRON_LEG_MIN_LENGTH_CELLS = Math.floor(VILLAGE_PATROL_RANGE_CELLS / 8);

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
  legFrom(
    fromX: number,
    fromY: number,
    seed: number,
    attempt: number,
  ): SquadronWaypoint | null;
}

export type SquadronPhase = 'mustering' | 'cruising';

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

export interface SquadronFormationStats {
  /** Boats considered for affiliation this tick. */
  readonly candidates: number;
  /** Crews currently live. */
  readonly crews: number;
  /** Boats currently affiliated into crews. */
  readonly affiliated: number;
  /** Candidates in no crew (only when no crew exists to join). */
  readonly unaffiliated: number;
}

let lastFormation: SquadronFormationStats = {
  candidates: 0,
  crews: 0,
  affiliated: 0,
  unaffiliated: 0,
};

export function formationStats(): SquadronFormationStats {
  return lastFormation;
}

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

export function squadronIds(): readonly number[] {
  return [...squadrons.keys()].sort((a, b) => a - b);
}

export function squadronPhase(squadronId: number): SquadronPhase | null {
  return squadrons.get(squadronId)?.phase ?? null;
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

/** Split n boats into crews of SQUADRON_MIN_SHIPS..SQUADRON_MAX_SHIPS.
 * Balanced (never strands a singleton) for every n >= MIN. */
function chunkSizes(n: number): number[] {
  const groups = Math.max(1, Math.ceil(n / SQUADRON_MAX_SHIPS));
  const base = Math.floor(n / groups);
  const extra = n % groups;
  const sizes: number[] = [];
  for (let g = 0; g < groups; g++) sizes.push(base + (g < extra ? 1 : 0));
  return sizes;
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

function formSquadrons(candidates: readonly SquadronBoat[]): void {
  const byId = new Map<number, SquadronBoat>();
  for (const boat of candidates) byId.set(boat.id, boat);
  const unassigned = candidates.filter((boat) => !squadronOfBoat.has(boat.id));
  // z-order of CURRENT positions: nearby boats crew together, and the
  // grouping is independent of roster order.
  const ordered = [...unassigned].sort((a, b) => {
    const ka = zOrderKey(Math.floor(a.x), Math.floor(a.y));
    const kb = zOrderKey(Math.floor(b.x), Math.floor(b.y));
    return ka === kb ? a.id - b.id : ka - kb;
  });

  // Connected components by formation spread (union-find, deterministic).
  const spreadSquared =
    SQUADRON_FORMATION_SPREAD_CELLS * SQUADRON_FORMATION_SPREAD_CELLS;
  const parent = ordered.map((_boat, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const dx = ordered[i].x - ordered[j].x;
      const dy = ordered[i].y - ordered[j].y;
      if (dx * dx + dy * dy <= spreadSquared) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[rj] = ri;
      }
    }
  }
  const components = new Map<number, number[]>();
  for (let i = 0; i < ordered.length; i++) {
    const root = find(i);
    const group = components.get(root);
    if (group === undefined) components.set(root, [i]);
    else group.push(i);
  }
  // Deterministic crew order: by earliest member in z-order.
  const batches = [...components.values()].sort((a, b) => a[0] - b[0]);

  const createCrew = (memberIds: number[]): void => {
    const flagship = byId.get(memberIds[0]);
    if (flagship === undefined) return;
    const id = nextSquadronId++;
    squadrons.set(id, {
      id,
      members: memberIds,
      rendezvous: { x: flagship.x, y: flagship.y },
      phase: 'mustering',
      musteringSeconds: 0,
      leg: null,
      legsSailed: 0,
      legSeedStep: 0,
    });
    for (const boatId of memberIds) squadronOfBoat.set(boatId, id);
  };

  const strays: SquadronBoat[] = [];
  for (const batch of batches) {
    if (batch.length < SQUADRON_MIN_SHIPS) {
      for (const index of batch) strays.push(ordered[index]);
      continue;
    }
    let cursor = 0;
    for (const size of chunkSizes(batch.length)) {
      const memberIds: number[] = [];
      for (let n = 0; n < size; n++) memberIds.push(ordered[batch[cursor++]].id);
      createCrew(memberIds);
    }
  }
  // Every boat joins a fleet: loners attach to the nearest crew with room,
  // or the nearest crew outright when all are full.
  for (const stray of strays) {
    let bestId: number | null = null;
    let bestFullId: number | null = null;
    let bestSquared = Infinity;
    let bestFullSquared = Infinity;
    for (const squadronId of squadronIds()) {
      const members = squadrons.get(squadronId)?.members;
      if (members === undefined || members.length === 0) continue;
      const flagship = byId.get(members[0]);
      if (flagship === undefined) continue;
      const dx = stray.x - flagship.x;
      const dy = stray.y - flagship.y;
      const squared = dx * dx + dy * dy;
      if (squared < bestFullSquared) {
        bestFullSquared = squared;
        bestFullId = squadronId;
      }
      if (members.length < SQUADRON_MAX_SHIPS && squared < bestSquared) {
        bestSquared = squared;
        bestId = squadronId;
      }
    }
    const join = bestId ?? bestFullId;
    if (join === null) continue;
    squadrons.get(join)?.members.push(stray.id);
    squadronOfBoat.set(stray.id, join);
  }
  lastFormation = {
    candidates: candidates.length,
    crews: squadrons.size,
    affiliated: squadronOfBoat.size,
    unaffiliated: candidates.filter((boat) => !squadronOfBoat.has(boat.id)).length,
  };
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
    if (!complete && !timedOut) {
      return squadron.rendezvous;
    }
    // Complete or timed out: sail with the whole crew. Stragglers chase
    // the moving fleet; only a below-strength crew dissolves.
    if (squadron.members.length < SQUADRON_MIN_SHIPS) return null;
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

/** Abandon a cruising squadron's leg and plan the next spoke. Null when not
 * cruising or no spoke lands. Used when the flagship is chronically routeless. */
export function replanSquadronLeg(
  squadronId: number,
  from: SquadronWaypoint,
  flagshipHome: SquadronBoat,
  nav: SquadronNavigator,
): SquadronWaypoint | null {
  const squadron = squadrons.get(squadronId);
  if (squadron === undefined || squadron.phase !== 'cruising') return null;
  const leg = planLeg(squadron, from, flagshipHome, nav);
  if (leg === null) return null;
  squadron.leg = leg;
  return leg;
}

export function advanceSquadrons(
  candidates: readonly SquadronBoat[],
  nav: SquadronNavigator,
  dt: number,
): Map<number, SquadronWaypoint> {
  const byId = new Map<number, SquadronBoat>();
  for (const boat of candidates) byId.set(boat.id, boat);

  pruneSquadrons(new Set(byId.keys()));
  formSquadrons(candidates);

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

// The fleet: villages that keep boats, boats that sail, and the fight.
//
// Everything here is a pure function of the world and this module's own state
// — no wall clock, no wire, no three — which is what lets the tests assert the
// fight arithmetic directly against a hand-built world, exactly the way
// plugins/monsters/server/habitat.ts and lurk.ts are testable.
//
// THE STEERING CONTRACT is monsters' own, restated rather than imported (see
// protocol.ts on why nothing crosses a plugin boundary by import): a boat only
// ever commits to a step whose DESTINATION is water, so shorelines are walls
// rather than places it can be pushed through. A boat that cannot find any
// watery heading holds position; it never beaches and never needs rescuing.

import { isWater } from '@terrace/shared';
import {
  BOATS_PER_VILLAGE,
  BOAT_ENGAGEMENT_RANGE_CELLS,
  BOAT_REBUILD_SECONDS,
  BOAT_SPEED_CELLS_PER_SECOND,
  BOAT_WOUNDS_PER_SECOND,
  KRAKEN_ROUT_WOUNDS,
  KRAKEN_SINKS_BOAT_EVERY_SECONDS,
  KRAKEN_WOUND_HEAL_PER_SECOND,
  VILLAGE_PATROL_RANGE_CELLS,
  roundBroadcastPosition,
  type BoatState,
} from '../protocol.ts';

/** The slice of the server's WorldApi this plugin reads. */
export interface BoatWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

/** A coastal settlement that keeps boats. */
export interface Village {
  readonly x: number;
  readonly y: number;
  /**
   * Seconds of build progress toward the next replacement boat. Only advances
   * while the village is short of BOATS_PER_VILLAGE.
   */
  rebuildSeconds: number;
}

export interface Boat {
  readonly id: number;
  /** Home village cell — where it idles, and what bounds its patrol. */
  readonly homeX: number;
  readonly homeY: number;
  x: number;
  y: number;
  heading: number;
  fighting: boolean;
}

/** Where the fight is, this tick. */
export interface KrakenTarget {
  readonly x: number;
  readonly y: number;
}

const TWO_PI = Math.PI * 2;

/** Candidate headings tried when the way ahead is not water. Monsters' sweep. */
const AVOID_TURN_ATTEMPTS = 8;
const AVOID_TURN_STEP_RADIANS = Math.PI / 4;

/**
 * How far ahead a boat checks, in cells. One second of its own travel — far
 * enough to turn before it arrives, short enough that it can still work its way
 * along a ragged coast rather than refusing every heading near one.
 */
const BOAT_LOOKAHEAD_SECONDS = 1;

// ── state ────────────────────────────────────────────────────────────────────

const villages = new Map<string, Village>();
let boats: Boat[] = [];
let nextBoatId = 1;
/** Wounds on the kraken currently being fought. Shed while nothing engages. */
let krakenWounds = 0;
/** Seconds since the kraken last sank a boat. */
let sinceLastSinking = 0;

const villageKey = (x: number, y: number): string => `${x},${y}`;

export function resetFleet(): void {
  villages.clear();
  boats = [];
  nextBoatId = 1;
  krakenWounds = 0;
  sinceLastSinking = 0;
}

export function livingBoats(): readonly Boat[] {
  return boats;
}
export function villageCount(): number {
  return villages.size;
}
export function currentKrakenWounds(): number {
  return krakenWounds;
}
export function nextBoatIdValue(): number {
  return nextBoatId;
}

/** Adds a village, or leaves an existing one untouched (re-upgrades are common). */
export function rememberVillage(x: number, y: number): void {
  const key = villageKey(x, y);
  if (villages.has(key)) return;
  villages.set(key, { x, y, rebuildSeconds: 0 });
}

/**
 * Forgets a village and scuttles the boats that called it home.
 *
 * A boat outliving its village would be a boat with no rebuild source and no
 * home to idle at — it would sail on forever, and the roster would leak one
 * entry per demolished settlement for the life of the world.
 */
export function forgetVillage(x: number, y: number): void {
  if (!villages.delete(villageKey(x, y))) return;
  boats = boats.filter((boat) => boat.homeX !== x || boat.homeY !== y);
}

// ── water ────────────────────────────────────────────────────────────────────

/**
 * Is this cell open water a boat may occupy? Three conditions, matching the
 * shape of monsters' isLairCell: inside the world, inside unlocked territory,
 * and wet. UNLOCKED matters for the same reason it does there — a boat only
 * ever exists in territory clients can already see, so the broadcast reveals
 * nothing about locked ocean.
 */
export function isSailable(world: BoatWorld, cellX: number, cellY: number): boolean {
  const x = Math.floor(cellX);
  const y = Math.floor(cellY);
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  return isWater(world.heightAt(x, y));
}

/**
 * The water cell a village launches from: the nearest sailable 4-neighbour of
 * the settlement itself.
 *
 * A settlement stands on land, so its own cell is never sailable; a village
 * with no wet neighbour is INLAND and keeps no boats at all, which is how
 * "coastal" is decided without a second event from structures or a notion of
 * coastline this plugin would have to maintain. Null means inland.
 */
export function launchCell(world: BoatWorld, village: Village): KrakenTarget | null {
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const x = village.x + dx!;
    const y = village.y + dy!;
    if (isSailable(world, x, y)) return { x, y };
  }
  return null;
}

function normalizeAngle(radians: number): number {
  const wrapped = radians % TWO_PI;
  if (wrapped > Math.PI) return wrapped - TWO_PI;
  if (wrapped <= -Math.PI) return wrapped + TWO_PI;
  return wrapped;
}

/**
 * Picks a heading whose look-ahead cell is sailable, preferring `desired` and
 * then the smallest deviation from it. Null when boxed in on all eight
 * candidates — the caller then holds position.
 */
export function steerToWater(
  world: BoatWorld,
  boat: Boat,
  desired: number,
  lookahead: number,
): number | null {
  for (let attempt = 0; attempt < AVOID_TURN_ATTEMPTS; attempt++) {
    const step = Math.ceil(attempt / 2) * AVOID_TURN_STEP_RADIANS;
    const heading = desired + (attempt % 2 === 1 ? step : -step);
    if (isSailable(world, boat.x + Math.cos(heading) * lookahead, boat.y + Math.sin(heading) * lookahead)) {
      return normalizeAngle(heading);
    }
  }
  return null;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * Builds replacement boats. A village short of its fleet accumulates build
 * time and launches one boat per BOAT_REBUILD_SECONDS; a village at strength
 * banks nothing, so a long peace does not stockpile a burst of boats.
 */
export function advanceShipyards(world: BoatWorld, dt: number): void {
  for (const village of villages.values()) {
    const afloat = boats.filter((b) => b.homeX === village.x && b.homeY === village.y).length;
    if (afloat >= BOATS_PER_VILLAGE) {
      village.rebuildSeconds = 0;
      continue;
    }
    const launch = launchCell(world, village);
    // Inland, or its water is gone (a player filled the bay in): no progress,
    // and no partial build banked against the day the sea comes back.
    if (launch === null) {
      village.rebuildSeconds = 0;
      continue;
    }
    village.rebuildSeconds += dt;
    if (village.rebuildSeconds < BOAT_REBUILD_SECONDS) continue;
    village.rebuildSeconds -= BOAT_REBUILD_SECONDS;
    boats.push({
      id: nextBoatId++,
      homeX: village.x,
      homeY: village.y,
      x: launch.x,
      y: launch.y,
      heading: 0,
      fighting: false,
    });
  }
}

/**
 * The kraken this boat should sail at, or null to go home.
 *
 * A boat answers only krakens inside VILLAGE_PATROL_RANGE_CELLS OF ITS HOME —
 * not of itself — so a fleet cannot be walked across the ocean one engagement
 * at a time by a kraken that keeps retreating.
 */
function targetFor(boat: Boat, kraken: KrakenTarget | null): KrakenTarget | null {
  if (kraken === null) return null;
  if (distance(boat.homeX, boat.homeY, kraken.x, kraken.y) > VILLAGE_PATROL_RANGE_CELLS) {
    return null;
  }
  return kraken;
}

// ── the fight ────────────────────────────────────────────────────────────────

/** What one tick of the fight did, for the caller to act on. */
export interface FleetOutcome {
  /** True on the tick the kraken's wounds reached KRAKEN_ROUT_WOUNDS. */
  readonly routed: boolean;
  /** Boats sunk this tick — ids, for the caller's own bookkeeping. */
  readonly sunk: readonly number[];
}

const NOTHING_HAPPENED: FleetOutcome = { routed: false, sunk: [] };

/**
 * Advances every boat by `dt`, and the fight with them.
 *
 * ORDER MATTERS, and it is the same order monsters' own tick keeps: move
 * first, then resolve what the new positions mean. A boat that closes into
 * range this tick starts fighting this tick rather than next, which is what
 * keeps the arithmetic in protocol.ts's KRAKEN_ROUT_WOUNDS honest — it counts
 * whole seconds of engagement, and a half-tick of accounting slop at each end
 * would make the fleet-size thresholds approximate rather than exact.
 */
export function advanceFleet(
  world: BoatWorld,
  kraken: KrakenTarget | null,
  dt: number,
): FleetOutcome {
  advanceShipyards(world, dt);

  let engaged = 0;
  for (const boat of boats) {
    const target = targetFor(boat, kraken);
    const goalX = target?.x ?? boat.homeX;
    const goalY = target?.y ?? boat.homeY;
    const range = distance(boat.x, boat.y, goalX, goalY);

    boat.fighting = target !== null && range <= BOAT_ENGAGEMENT_RANGE_CELLS;
    if (boat.fighting) engaged++;

    // Holding station: at the fight's edge, or home. Still points at its goal,
    // so a fighting boat faces what it is fighting.
    const holdAt = target === null ? 0 : BOAT_ENGAGEMENT_RANGE_CELLS;
    if (range <= holdAt) {
      if (range > 0) boat.heading = Math.atan2(goalY - boat.y, goalX - boat.x);
      continue;
    }

    const desired = Math.atan2(goalY - boat.y, goalX - boat.x);
    const steered = steerToWater(world, boat, desired, BOAT_SPEED_CELLS_PER_SECOND * BOAT_LOOKAHEAD_SECONDS);
    if (steered === null) continue;
    boat.heading = steered;

    // Never overshoot the goal: a boat one tick's travel from its station
    // stops on it rather than sailing past and turning back forever.
    const step = Math.min(BOAT_SPEED_CELLS_PER_SECOND * dt, range - holdAt);
    const nextX = boat.x + Math.cos(steered) * step;
    const nextY = boat.y + Math.sin(steered) * step;
    // Belt and suspenders, monsters' own: the look-ahead cleared a cell a
    // second away, which says nothing about the cells in between.
    if (!isSailable(world, nextX, nextY)) continue;
    boat.x = nextX;
    boat.y = nextY;
  }

  if (kraken === null || engaged === 0) {
    // Nothing is fighting it: the wounds close. Faster than one boat can
    // inflict, so a lone picket can never win by attrition — see
    // KRAKEN_WOUND_HEAL_PER_SECOND.
    krakenWounds = Math.max(0, krakenWounds - KRAKEN_WOUND_HEAL_PER_SECOND * dt);
    sinceLastSinking = 0;
    return NOTHING_HAPPENED;
  }

  krakenWounds += engaged * BOAT_WOUNDS_PER_SECOND * dt;

  const sunk: number[] = [];
  sinceLastSinking += dt;
  while (sinceLastSinking >= KRAKEN_SINKS_BOAT_EVERY_SECONDS) {
    sinceLastSinking -= KRAKEN_SINKS_BOAT_EVERY_SECONDS;
    // The kraken takes the boat closest to it — the one that pressed hardest.
    let victim: Boat | null = null;
    let victimRange = Infinity;
    for (const boat of boats) {
      if (!boat.fighting) continue;
      const range = distance(boat.x, boat.y, kraken.x, kraken.y);
      if (range < victimRange) {
        victimRange = range;
        victim = boat;
      }
    }
    if (victim === null) break;
    sunk.push(victim.id);
    boats = boats.filter((boat) => boat !== victim);
  }

  if (krakenWounds >= KRAKEN_ROUT_WOUNDS) {
    // Routed. The wound pool resets with it: the NEXT kraken arrives whole,
    // whatever this one suffered.
    krakenWounds = 0;
    sinceLastSinking = 0;
    return { routed: true, sunk };
  }
  return { routed: false, sunk };
}

/** The afloat fleet, in wire shape. */
export function boatStates(): BoatState[] {
  return boats.map((boat) => ({
    id: boat.id,
    // Rounded on the way OUT only: the sim keeps full precision, and the wire
    // carries the hundredth of a cell a camera can actually resolve.
    x: roundBroadcastPosition(boat.x),
    y: roundBroadcastPosition(boat.y),
    heading: roundBroadcastPosition(boat.heading),
    fighting: boat.fighting,
  }));
}

// ── persistence seams ────────────────────────────────────────────────────────

export function fleetSnapshot(): {
  villages: Village[];
  boats: Boat[];
  nextBoatId: number;
} {
  return { villages: [...villages.values()], boats: [...boats], nextBoatId };
}

/**
 * Restores a saved fleet.
 *
 * THE WOUND POOL IS DELIBERATELY NOT SAVED. It describes a fight in progress
 * against a particular animal, and a server restart ends that fight — the
 * kraken is re-summoned or restored by its own plugin with no memory of having
 * been hurt, so carrying wounds across would let a reboot rout a fresh one.
 */
export function restoreFleet(saved: {
  villages: readonly Village[];
  boats: readonly Boat[];
  nextBoatId: number;
}): void {
  resetFleet();
  for (const village of saved.villages) {
    villages.set(villageKey(village.x, village.y), { ...village });
  }
  boats = saved.boats.map((boat) => ({ ...boat }));
  nextBoatId = saved.nextBoatId;
}

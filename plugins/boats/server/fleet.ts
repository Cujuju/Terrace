// The fleet: villages that keep boats, boats that sail, and the fight.
//
// Everything here is a pure function of the world and this module's own state
// — no wall clock, no wire, no three — which is what lets the tests assert the
// fight arithmetic directly against a hand-built world, exactly the way
// plugins/monsters/server/habitat.ts and lurk.ts are testable.
//
// THE STEERING CONTRACT now comes from `shared/` (steering.ts's
// `steerAvoiding`), not from a restatement of monsters' copy of it. The rule a
// boat needs is unchanged — only ever commit to a step whose DESTINATION is
// water, so shorelines are walls rather than places it can be pushed through,
// and a boat that finds no watery heading holds position rather than beaching
// — but two things it did NOT have come with the shared version:
//
//   - OTHER BOATS ARE OBSTACLES (owner, 2026-08-20: "they just kind of spin on
//     top of each other"). Every boat in a fleet is sent to the same kraken and
//     told to hold station at the same BOAT_ENGAGEMENT_RANGE_CELLS, so with no
//     mutual awareness they all converged on one point of one circle and
//     rotated there as the kraken drifted. That is not a fleet, it is a stack.
//   - "Anywhere in the water" is now a PROFILE (OPEN_WATER_PROFILE), so what a
//     hull may cross is stated in the same vocabulary as what a yeti or a
//     pilgrim may cross, rather than as this file's own isWater() call.
//
// The plugin-boundary rule is untouched: `shared/` is not another plugin.

import {
  OPEN_WATER_PROFILE,
  WORLD_UNIT_CELLS,
  cellsAcross,
  isWalkableCell as sharedIsWalkableCell,
  nearestWithinReach,
  normalizeAngle,
  steerWithShorteningProbe,
  turnToward,
  type Occupant,
} from '@terrace/shared';
import {
  severityAt,
  tangentialWindAt,
  type ParsedStormDamage,
} from '../../../server/src/plugins/kit/rotatingStormDamage.ts';
import {
  BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND,
  BOAT_WIND_PUSH_STEP_CELLS,
} from './cyclone-event.ts';
import {
  BOATS_PER_VILLAGE,
  BOAT_ENGAGEMENT_RANGE_CELLS,
  BOAT_REBUILD_SECONDS,
  BOAT_SPEED_CELLS_PER_SECOND,
  BOAT_WOUNDS_PER_SECOND,
  COASTAL_MIN_WATER_CELLS,
  COASTAL_SEARCH_RADIUS_CELLS,
  KRAKEN_ROUT_WOUNDS,
  KRAKEN_SINKS_BOAT_EVERY_SECONDS,
  KRAKEN_WOUND_HEAL_PER_SECOND,
  VILLAGE_PATROL_RANGE_CELLS,
  roundBroadcastCell,
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

/**
 * A boat's personal space, in cells — half a WORLD UNIT, converted.
 *
 * 0.5 — the hull's own half-length. HULL_LENGTH is 0.9 world units
 * (plugins/boats/client/models.ts) and the oars reach a little wider than the
 * beam, so half of 0.9 rounded up is the radius that circumscribes the rowed
 * silhouette. It is a HULL measurement, which is why it is stated against the
 * world unit the hull is modelled in rather than against the sampling grid.
 * Two boats therefore keep 1.0 world unit between centres: hulls clear,
 * oars clear, and a fleet at station reads as a line of boats rather than one
 * boat drawn several times. MEASURED HERE rather than imported for the reason
 * this plugin measures the kraken's footprint here too — a server sim does not
 * reach into a client model file, and the failure mode of drift is boats
 * sitting a little closer than intended, never a crash.
 */
export const BOAT_PERSONAL_SPACE_CELLS = cellsAcross(0.5);

/**
 * How far ahead a boat checks, in cells. One second of its own travel — far
 * enough to turn before it arrives, short enough that it can still work its way
 * along a ragged coast rather than refusing every heading near one.
 */
const BOAT_LOOKAHEAD_SECONDS = 1;

/**
 * The hull's own length, in cells — 0.9 WORLD UNITS, converted.
 *
 * Restated from HULL_LENGTH in plugins/boats/client/models.ts for the same
 * reason BOAT_PERSONAL_SPACE_CELLS above restates half of it: a server sim does
 * not reach into a client model file. It is the length the turning circle below
 * is measured in, so the boat that comes about on the screen is the boat the sim
 * turned — and the failure mode of drift is a slightly wider or tighter arc,
 * never a crash.
 */
const BOAT_HULL_LENGTH_CELLS = cellsAcross(0.9);

/**
 * The tightest arc a boat will turn through, as a multiple of its own hull
 * length — the radius of its turning circle.
 *
 * ROOT CAUSE THIS FIXES (owner, 2026-08-24: implement boats "like you did
 * whales"). Nothing bounded a boat's heading: `advanceFleet` wrote whatever the
 * sweep returned straight onto `boat.heading`, so a hull that found its way
 * blocked snapped through 45° or 180° between two ticks and set off in the new
 * direction from a standing start. A rowed boat cannot do that; it has to carry
 * its way through the turn.
 *
 * 2 HULL LENGTHS, against wildlife's half a body length for a fish or a whale
 * (its TURN_RADIUS_BODY_LENGTHS), and the difference is the point: a fish
 * pivots on its own centre and a boat does not. At 2 the circle is 1.8 world
 * units across the water and a full 180° takes about six seconds at cruise —
 * slow enough to read as a boat coming about, fast enough that a fleet still
 * forms up on a drifting kraken inside one engagement.
 */
const BOAT_TURN_RADIUS_HULL_LENGTHS = 2;

/**
 * How fast a boat may swing its heading, radians per second: its speed divided
 * by the radius of its turning circle.
 *
 * A CONSTANT here where wildlife needs a function of the animal
 * (maxTurnRadiansPerSecondOf), because both inputs are constants for this
 * plugin — every boat is the same hull at the same cruise. Derived rather than
 * typed out, so cutting BOAT_SPEED_CELLS_PER_SECOND widens the arc the hull
 * traces instead of silently tightening it.
 */
const BOAT_TURN_RADIANS_PER_SECOND =
  BOAT_SPEED_CELLS_PER_SECOND / (BOAT_TURN_RADIUS_HULL_LENGTHS * BOAT_HULL_LENGTH_CELLS);

// ── state ────────────────────────────────────────────────────────────────────

const villages = new Map<string, Village>();
let boats: Boat[] = [];
let nextBoatId = 1;

/**
 * How often a village re-walks its coastal disc when nothing has told it to.
 *
 * THE CACHE BELOW IS INVALIDATED BY EVENTS — a sculpt near the village, a
 * chunk joining the unlocked union — and this is the belt to those suspenders.
 * The union mask can also move without any hook firing (a joining token's
 * starter square, server/src/world/initial-unlock.ts's seedChunkForToken,
 * mutates the union silently), and a village that stayed wrongly INLAND on
 * that path would never launch a boat again for the life of the world.
 *
 * BOAT_REBUILD_SECONDS, because that is the scale the answer is used at: a
 * village that becomes coastal still has to spend a whole rebuild before a
 * hull exists, so a survey no staler than one rebuild cannot be the thing that
 * delays a fleet.
 */
const COASTAL_RESURVEY_SECONDS = BOAT_REBUILD_SECONDS;

/**
 * A village's DERIVED shipyard state — everything `advanceShipyards` used to
 * recompute from scratch every tick.
 *
 * SEPARATE FROM `Village` because Village is the PERSISTED fact (./persistence.
 * ts validates exactly its three fields) and none of this belongs in a save
 * file: it is all rederivable from the terrain and the fleet, and a stale copy
 * restored from disk would be worse than no copy at all.
 */
interface Shipyard {
  /**
   * The cached answer from `launchCell` — null for INLAND. Meaningful only
   * while `surveyedSeconds` is a number; see `surveyedLaunch`.
   */
  launch: KrakenTarget | null;
  /** Seconds since the disc was last walked, or null when it never has been. */
  surveyedSeconds: number | null;
  /** Boats homed here, retallied once per tick from the fleet. */
  afloat: number;
}

/**
 * Parallel to `villages`, same keys. Kept as its own map rather than as fields
 * on Village so the persisted shape cannot drift into carrying a cache.
 */
const shipyards = new Map<string, Shipyard>();

/** A village with no survey yet — the state every new or restored one starts in. */
function unsurveyedShipyard(): Shipyard {
  return { launch: null, surveyedSeconds: null, afloat: 0 };
}

/**
 * Throws away every cached coastal survey.
 *
 * Called when something has changed that could turn an inland village coastal
 * or the reverse, and that is CHEAPER TO ASSUME WORLD-WIDE than to localise: a
 * chunk unlock moves the unlocked-territory half of `isSailable` and arrives a
 * handful of times per session, so re-walking every village's disc once is a
 * millisecond against the bookkeeping of working out whose disc the chunk
 * touched.
 */
export function resurveyAllShipyards(): void {
  for (const shipyard of shipyards.values()) shipyard.surveyedSeconds = null;
}

/**
 * Throws away the cached survey of every village whose coastal disc contains a
 * changed cell — the terrain half of `isSailable` moving.
 *
 * The diff is reduced to ITS BOUNDING BOX first, so the cost is O(diff) +
 * O(villages) rather than the product: a brush stamp is one contiguous blob,
 * and a village whose disc misses the blob's box misses every cell in it.
 */
export function resurveyShipyardsNear(diff: readonly { readonly x: number; readonly y: number }[]): void {
  if (diff.length === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cell of diff) {
    if (cell.x < minX) minX = cell.x;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.y > maxY) maxY = cell.y;
  }

  for (const [key, village] of villages) {
    const shipyard = shipyards.get(key);
    if (shipyard === undefined) continue;
    if (village.x + COASTAL_SEARCH_RADIUS_CELLS < minX) continue;
    if (village.x - COASTAL_SEARCH_RADIUS_CELLS > maxX) continue;
    if (village.y + COASTAL_SEARCH_RADIUS_CELLS < minY) continue;
    if (village.y - COASTAL_SEARCH_RADIUS_CELLS > maxY) continue;
    shipyard.surveyedSeconds = null;
  }
}
/** Wounds on the kraken currently being fought. Shed while nothing engages. */
let krakenWounds = 0;
/** Seconds since the kraken last sank a boat. */
let sinceLastSinking = 0;

/**
 * A wind-damage event this fleet has not been pushed by yet, or null.
 *
 * A QUEUE OF ONE, AND NOT A PER-TICK LATCH — the opposite of how the kraken
 * position is held (../server/index.ts's `krakenThisTick`), and the difference
 * is what the two things ARE. A kraken position is a STANDING FACT that is
 * re-announced every tick, so dropping it at the end of a tick is how "the
 * kraken left" reads. A damage event is a DISCRETE quantum of storm — it
 * arrives once a second and carries the seconds it accounts for — so it must be
 * applied exactly once. Clearing it unapplied would silently drop most of a
 * hurricane, and holding it across ticks would apply the same second of wind
 * ten times over.
 *
 * WHY IT IS HELD AT ALL, rather than pushing the boats from inside the event
 * handler. The host fans an emit out synchronously, inside the emitting
 * plugin's own onTick (server/src/plugins/host.ts's emit fan-out), and plugins
 * tick in LOAD ORDER — which is alphabetical by directory, so `boats` has
 * already advanced its whole fleet by the time `cyclone` emits. Pushing from
 * the handler would therefore move hulls in the middle of another plugin's
 * tick, after this one's own step, separation and station-keeping had all
 * been resolved against the old positions: a boat could be shoved onto a
 * berth another boat had just been given. Held here and consumed at the top of
 * advanceFleet, the push is simply where the fleet starts its next frame.
 *
 * ONE PENDING EVENT, NOT A LIST. Damage arrives at 1 Hz per storm and ticks run
 * at 10 Hz, so a second event before the first is consumed means the tick loop
 * has stalled for a whole second — in which case replaying a backlog of wind
 * onto a fleet in one frame is the wrong recovery. The newest event is kept,
 * because it describes where the storm IS.
 */
let pendingWind: ParsedStormDamage | null = null;

const villageKey = (x: number, y: number): string => `${x},${y}`;

export function resetFleet(): void {
  villages.clear();
  shipyards.clear();
  boats = [];
  nextBoatId = 1;
  krakenWounds = 0;
  sinceLastSinking = 0;
  pendingWind = null;
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
  shipyards.set(key, unsurveyedShipyard());
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
  shipyards.delete(villageKey(x, y));
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
  if (!world.isCellUnlocked(x, y)) return false;
  // Bounds, ground class and everything else terrain has to say: shared's one
  // predicate over OPEN_WATER_PROFILE, so "water a hull may cross" is decided
  // in the same place as "water a kraken may swim" rather than beside it.
  return sharedIsWalkableCell(world, OPEN_WATER_PROFILE, x, y);
}

/**
 * Offsets of the coastal search disc, excluding the centre — built once at
 * module load. The TIGHT disc `dx² + dy² < r·(r−1)`, which is the shape
 * structures' own site survey uses and the shape shared's brush footprint
 * uses; matching it is what keeps "has a harbour" and "sends boats" the same
 * set of settlements.
 */
const COASTAL_DISC: ReadonlyArray<readonly [number, number]> = (() => {
  const threshold = COASTAL_SEARCH_RADIUS_CELLS * (COASTAL_SEARCH_RADIUS_CELLS - 1);
  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -COASTAL_SEARCH_RADIUS_CELLS; dy <= COASTAL_SEARCH_RADIUS_CELLS; dy++) {
    for (let dx = -COASTAL_SEARCH_RADIUS_CELLS; dx <= COASTAL_SEARCH_RADIUS_CELLS; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (dx * dx + dy * dy < threshold) offsets.push([dx, dy]);
    }
  }
  // NEAREST FIRST, so the launch cell below is the closest water without a
  // second pass — and so a village's boats always put out from the same side
  // of it, which is what makes a fleet look like it belongs to that harbour.
  offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
  return offsets;
})();

/**
 * The water cell a village launches from, or null if it is INLAND.
 *
 * Coastal means what structures means by it: at least COASTAL_MIN_WATER_CELLS
 * sailable cells inside the COASTAL_SEARCH_RADIUS_CELLS disc — see that
 * constant's comment for why this is not an adjacency test, and what happened
 * when it was. The launch cell is the nearest of them.
 *
 * A settlement stands on buildable ground, so its own cell is never sailable
 * and the centre is not in the disc.
 */
export function launchCell(world: BoatWorld, village: Village): KrakenTarget | null {
  let nearest: KrakenTarget | null = null;
  let found = 0;
  for (const [dx, dy] of COASTAL_DISC) {
    const x = village.x + dx;
    const y = village.y + dy;
    if (!isSailable(world, x, y)) continue;
    found++;
    // COASTAL_DISC is sorted nearest-first, so the first hit is the closest.
    if (nearest === null) nearest = { x, y };
    // Stop as soon as the bar is met: the remaining cells cannot change the
    // answer, and this runs per village per tick.
    if (found >= COASTAL_MIN_WATER_CELLS) return nearest;
  }
  return null;
}

/**
 * Picks a heading whose look-ahead cell is open water and inside unlocked
 * territory — preferring `desired` and then the smallest deviation from it.
 * Null when boxed in on every candidate, and the caller then holds position.
 *
 * A THIN ADAPTER over shared's `steerWithShorteningProbe` (shared/src/
 * steering.ts), which owns the sweep AND the ladder of shortening probes it is
 * run down. The one thing this plugin still says for itself is the
 * unlocked-territory rule, passed as the `permits` hook: a boat only ever
 * exists in territory clients can already see, which is a fog-of-war fact
 * rather than a terrain one and has no business in `shared/`.
 *
 * THE LADDER IS THE FIX FOR "CONSTANTLY GETTING STUCK" (owner, 2026-08-24).
 * A boat probes a full second of travel ahead, and a bay, a strait or a river
 * mouth is routinely narrower than that: every one of the eight candidates
 * failed at the full probe, the pre-ladder code returned null, and the caller
 * held position — forever, because nothing about the situation changed on the
 * next tick either. The shortest rung probes exactly one tick's travel, which
 * is the same distance the destination re-check in `advanceFleet` judges, so a
 * boat now holds still only when there is genuinely no water one step away in
 * any direction. Read the rungs and their reasoning at the shared function.
 *
 * WHAT IT RETURNS IS A DIRECTION TO WANT, not the heading the boat adopts:
 * `advanceFleet` turns toward it at BOAT_TURN_RADIANS_PER_SECOND.
 *
 * NO SEPARATION HERE, DELIBERATELY, AND IT IS A DIVISION OF LABOUR RATHER THAN
 * AN OMISSION (2026-08-21). This fleet keeps clear of itself in exactly one
 * place — `makeRoom` — and that function's whole design is that it moves a
 * boat TANGENTIALLY, rotating about the goal so the range to it is preserved
 * exactly (see its doc comment: a radial nudge pushes a boat out of
 * BOAT_ENGAGEMENT_RANGE_CELLS, and protocol.ts's rout arithmetic counts whole
 * seconds of engagement). Sailing is the opposite motion: it is the RADIAL
 * one, the closing of range, and a crowd-avoidance term inside it can only
 * express itself by bending that radius — which is the very thing makeRoom
 * exists to avoid. Measured when the two were briefly both live: boats settled
 * at 5.03 cells against a 5.00 station and stopped counting as engaged, and
 * the fleet no longer routed the kraken at the predicted time.
 *
 * So: closing on a station is this function's job and it ignores other boats;
 * holding one is makeRoom's job and it ignores everything else. The named cost
 * is that two boats converging on the same kraken from different villages may
 * pass through one another on the way — a second or two of overlap on open sea,
 * resolved by makeRoom the moment either arrives.
 */
export function steerToWater(
  world: BoatWorld,
  boat: Boat,
  desired: number,
  lookahead: number,
  stepCells: number,
): number | null {
  return steerWithShorteningProbe(world, OPEN_WATER_PROFILE, boat, desired, lookahead, {
    stepCells,
    permits: (x, y) => world.isCellUnlocked(Math.floor(x), Math.floor(y)),
  });
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * The nearest sailable cell to `village` that no boat is already sitting in, or
 * null when every one of them is taken.
 *
 * THE OTHER HALF OF "SPAWNING ON TOP OF EACH OTHER" (owner, 2026-08-24).
 * `makeRoom` has kept a fighting fleet from stacking since 2026-08-21, but
 * nothing looked at the fleet on the way IN: every boat of a village was placed
 * on the single cell `launchCell` names, so BOATS_PER_VILLAGE hulls were drawn
 * through one another for as long as it took them to sort themselves out — and
 * a village at strength in peacetime never even sorts, because a boat at home
 * has arrived and only shuffles when crowded. Separation at spawn is cheaper
 * and more honest than separation-by-recovery: the boats are simply never
 * placed on top of each other in the first place.
 *
 * Scans the same COASTAL_DISC in the same nearest-first order as `launchCell`,
 * so a village's boats still put out from the same side of it — just from
 * adjacent berths rather than from one.
 *
 * `occupied` is the live fleet, not a start-of-tick snapshot: two villages
 * sharing a bay may both launch on the same tick, and the second must see the
 * first one's new boat.
 */
export function launchBerth(
  world: BoatWorld,
  village: Village,
  occupied: readonly Occupant[],
): KrakenTarget | null {
  for (const [dx, dy] of COASTAL_DISC) {
    const x = village.x + dx;
    const y = village.y + dy;
    if (!isSailable(world, x, y)) continue;
    // The cell CENTRE is what the boat is placed on, and it is what the
    // clearance is measured from — the same point `makeRoom` will keep clear
    // from the next tick onward.
    if (!isClearOfFleet(x, y, occupied)) continue;
    return { x, y };
  }
  return null;
}

/** Is (x, y) outside every boat's personal space? `launchBerth`'s one test. */
function isClearOfFleet(x: number, y: number, occupied: readonly Occupant[]): boolean {
  for (const berth of occupied) {
    const clearance = BOAT_PERSONAL_SPACE_CELLS + berth.radiusCells;
    const dx = x - berth.x;
    const dy = y - berth.y;
    if (dx * dx + dy * dy < clearance * clearance) return false;
  }
  return true;
}

/** Every living boat as an `Occupant` — the fleet, as something to keep clear of. */
function fleetBerths(): Occupant[] {
  return boats.map((boat) => ({
    x: boat.x,
    y: boat.y,
    radiusCells: BOAT_PERSONAL_SPACE_CELLS,
  }));
}

/**
 * Counts each village's boats, once, from one pass over the fleet.
 *
 * REDERIVED RATHER THAN MAINTAINED. An incrementing counter would have to be
 * decremented on every path a boat leaves by — sunk, burned, scuttled with its
 * village — and one missed path is a village that never rebuilds again. This
 * costs O(boats) for the whole tick where the old `boats.filter(...)` cost
 * O(villages x boats) and allocated an array per village.
 */
function tallyFleetHomes(): void {
  for (const shipyard of shipyards.values()) shipyard.afloat = 0;
  for (const boat of boats) {
    const shipyard = shipyards.get(villageKey(boat.homeX, boat.homeY));
    if (shipyard !== undefined) shipyard.afloat++;
  }
}

/**
 * This village's launch cell, from the cache when the cache is still good.
 *
 * A SURVEY IS RE-WALKED only when something could have changed its answer:
 * never taken, invalidated by a sculpt in its disc or by a chunk unlock (see
 * `resurveyShipyardsNear` / `resurveyAllShipyards`), or older than
 * COASTAL_RESURVEY_SECONDS. Between those it is a field read.
 */
function surveyedLaunch(
  world: BoatWorld,
  village: Village,
  shipyard: Shipyard,
  dt: number,
): KrakenTarget | null {
  if (shipyard.surveyedSeconds !== null) {
    shipyard.surveyedSeconds += dt;
    if (shipyard.surveyedSeconds < COASTAL_RESURVEY_SECONDS) return shipyard.launch;
  }
  shipyard.launch = launchCell(world, village);
  shipyard.surveyedSeconds = 0;
  return shipyard.launch;
}

/**
 * Builds replacement boats. A village short of its fleet accumulates build
 * time and launches one boat per BOAT_REBUILD_SECONDS; a village at strength
 * banks nothing, so a long peace does not stockpile a burst of boats.
 */
export function advanceShipyards(world: BoatWorld, dt: number): void {
  tallyFleetHomes();

  for (const [key, village] of villages) {
    const shipyard = shipyards.get(key);
    if (shipyard === undefined) continue;

    if (shipyard.afloat >= BOATS_PER_VILLAGE) {
      village.rebuildSeconds = 0;
      continue;
    }
    // THE CACHED SURVEY, not a fresh disc walk. `launchCell` early-returns only
    // once it has found COASTAL_MIN_WATER_CELLS, so an INLAND village used to
    // walk all of COASTAL_DISC — every tick, forever, producing nothing.
    const launch = surveyedLaunch(world, village, shipyard, dt);
    // Inland, or its water is gone (a player filled the bay in): no progress,
    // and no partial build banked against the day the sea comes back.
    if (launch === null) {
      village.rebuildSeconds = 0;
      continue;
    }
    village.rebuildSeconds += dt;
    if (village.rebuildSeconds < BOAT_REBUILD_SECONDS) continue;

    const berth = launchBerth(world, village, fleetBerths());
    // The harbour is full: every water cell within the coastal disc has a boat
    // in it. The finished build STAYS BANKED (no subtraction, no reset) and the
    // boat slides down the ways on the first tick a berth clears — which is a
    // second or two later, as soon as the fleet ahead of it puts out. Launching
    // anyway is what put two hulls on one cell.
    if (berth === null) continue;

    village.rebuildSeconds -= BOAT_REBUILD_SECONDS;
    shipyard.afloat++;
    boats.push({
      id: nextBoatId++,
      homeX: village.x,
      homeY: village.y,
      x: berth.x,
      y: berth.y,
      // Facing OUT of the harbour — away from the village that built it. A boat
      // now has a turning circle (BOAT_TURN_RADIANS_PER_SECOND), so the heading
      // it is launched with is one it has to sail out of; a flat 0 pointed a
      // third of every fleet at its own beach for the first few seconds.
      heading: Math.atan2(berth.y - village.y, berth.x - village.x),
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
 * The range below which a station has no direction — a boat sitting on its
 * goal rather than on a circle around one, which is what "holding at home"
 * is. Under it, `makeRoom` cannot shuffle AROUND anything and pushes straight
 * away from the crowd instead.
 *
 * One personal space (0.5 cells): inside that, the goal is closer than the
 * nearest boat may legally be, so there is no arc left to slide along.
 */
const STATION_MIN_RANGE_CELLS = BOAT_PERSONAL_SPACE_CELLS;

/**
 * Eases a station-keeping boat off a berth another boat already has.
 *
 * THIS IS WHERE THE FLEET USED TO STACK. Every boat is given the same goal and
 * the same hold radius, so "hold station" put all of them on one circle with
 * nothing to stop them occupying the same point of it — and then each turned
 * in place to face the drifting kraken, which is the owner's "they just kind
 * of spin on top of each other". Holding STATION is not holding POSITION.
 *
 * IT SHUFFLES ALONG THE STATION CIRCLE, NOT AWAY FROM THE GOAL, and that is
 * the whole design of it. The obvious move — step directly away from whoever
 * is crowding you — pushes a boat radially outward, straight out of
 * BOAT_ENGAGEMENT_RANGE_CELLS, so a fleet that made room would stop fighting;
 * the fight arithmetic in protocol.ts counts whole seconds of engagement, and
 * boats drifting in and out of range would make those numbers approximate
 * rather than exact. Rotating about the goal instead preserves the range
 * EXACTLY (it is a rotation, not a tangent step, so there is no outward creep
 * to accumulate) and turns a stack into an arc of boats around the beast —
 * which is also what a fleet engaging something would actually do.
 *
 * `heading` is deliberately left alone: a fighting boat faces what it is
 * fighting, which is what the caller set one line earlier. A boat sidling
 * along its station while still facing the kraken is right.
 *
 * Does NOTHING when the berth is already clear, so a fleet that has settled
 * into a line stays still rather than jittering — station-keeping is the state
 * a fighting fleet spends most of its time in.
 */
function makeRoom(
  world: BoatWorld,
  boat: Boat,
  goalX: number,
  goalY: number,
  berths: readonly Occupant[],
  index: number,
  dt: number,
): void {
  const crowded = nearestCrowder(boat, berths, index);
  if (crowded === null) return;
  const crowder = crowded.berth;
  // WHICH OF THE PAIR GIVES WAY, when the two are stacked so exactly that
  // "away" has no direction. Decided by comparing the two INDICES, not by this
  // boat's own index parity: parity gives every even-indexed boat the same
  // answer, so a third boat on the same spot picks the same side as the first
  // and the two of them stay welded together for good. Comparing the pair is a
  // strict total order, so the two always pick opposite sides and separate on
  // the next tick — and it is deterministic, which a random jitter would not be.
  const yieldsRight = index < crowded.index;

  const step = BOAT_SPEED_CELLS_PER_SECOND * dt;
  const range = distance(boat.x, boat.y, goalX, goalY);

  if (range < STATION_MIN_RANGE_CELLS) {
    // No circle to slide along (see STATION_MIN_RANGE_CELLS): shove apart.
    // Two boats at EXACTLY one point have no "away" — the one case atan2
    // cannot answer — so they take opposite fixed bearings off their own index
    // parity, which is deterministic and breaks the tie in a single tick.
    const awayX = boat.x - crowder.x;
    const awayY = boat.y - crowder.y;
    const bearing =
      awayX === 0 && awayY === 0 ? (yieldsRight ? 0 : Math.PI) : Math.atan2(awayY, awayX);
    moveIfSailable(world, boat, boat.x + Math.cos(bearing) * step, boat.y + Math.sin(bearing) * step);
    return;
  }

  // Arc length → angle, so the boat travels one ordinary tick's distance along
  // its own station circle rather than one tick's worth of ANGLE (which would
  // move a close-in boat slowly and a far-out one at a sprint).
  const turn = step / range;
  const fromGoal = Math.atan2(boat.y - goalY, boat.x - goalX);
  // Slide the way that opens the gap: whichever of the two arcs leaves the
  // crowder behind. A crowder at the SAME bearing offers no such arc — rarer
  // since boats stopped launching from one shared cell (`launchBerth`), but
  // still reachable whenever two boats converge on one station from opposite
  // sides — so the pair-order tie-break above is what breaks that case.
  const crowderFromGoal = Math.atan2(crowder.y - goalY, crowder.x - goalX);
  const separation = normalizeAngle(fromGoal - crowderFromGoal);
  const direction = separation === 0 ? (yieldsRight ? 1 : -1) : Math.sign(separation);

  for (const sign of [direction, -direction]) {
    const angle = fromGoal + sign * turn;
    if (moveIfSailable(world, boat, goalX + Math.cos(angle) * range, goalY + Math.sin(angle) * range)) {
      return;
    }
  }
  // Both arcs blocked by the coast: hold, and let the crowd sort itself out on
  // a later tick as the goal moves.
}

/**
 * The closest boat inside `boat`'s personal space, with its index, or null when
 * the berth is clear. The index is what lets `makeRoom` break a dead-even tie
 * on pair order — see `yieldsRight` there.
 */
function nearestCrowder(
  boat: Boat,
  berths: readonly Occupant[],
  index: number,
): { berth: Occupant; index: number } | null {
  let nearest: { berth: Occupant; index: number } | null = null;
  let nearestDistanceSq = Infinity;
  for (let other = 0; other < berths.length; other++) {
    if (other === index) continue;
    const dx = boat.x - berths[other].x;
    const dy = boat.y - berths[other].y;
    const distanceSq = dx * dx + dy * dy;
    const clearance = BOAT_PERSONAL_SPACE_CELLS + berths[other].radiusCells;
    if (distanceSq >= clearance * clearance) continue;
    if (distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = { berth: berths[other], index: other };
    }
  }
  return nearest;
}

/**
 * Records the wind a cyclone announced, to be applied at the top of the next
 * frame — see `pendingWind` for why it is not applied here.
 */
export function noteStormWind(damage: ParsedStormDamage): void {
  pendingWind = damage;
}

/**
 * Carries every boat inside the storm's disc along its tangential wind, and
 * clears the pending event.
 *
 * THE WHOLE FLEET IS TESTED, not the event's `cells` sample: the roster IS the
 * index, bounded by BOATS_PER_VILLAGE per settlement, so answering exactly
 * costs one distance test per hull per second of storm. The kit's own note on
 * that sample ("a SAMPLE for consumers with no spatial index") is what makes
 * this the intended reading rather than a shortcut.
 *
 * NO RANDOMNESS AT ALL — the displacement is a function of the boat's position
 * and the event, so two runs from the same seed push the same hulls the same
 * distance. This plugin has no generator of its own to reach for, and reaching
 * for Math.random would be the one thing that made a fleet's history
 * unreproducible.
 *
 * WALKED A CELL AT A TIME AND STOPPED AT THE FIRST WALL (see
 * BOAT_WIND_PUSH_STEP_CELLS), so a boat driven onto a coast fetches up against
 * it rather than through it. A boat with no water to be pushed into simply does
 * not move, which is a hull holding its ground against the wind — not an error.
 */
function applyStormWind(world: BoatWorld): void {
  const wind = pendingWind;
  pendingWind = null;
  if (wind === null) return;

  for (const boat of boats) {
    const severity = severityAt(wind, boat.x, boat.y);
    if (severity <= 0) continue;
    const direction = tangentialWindAt(wind, boat.x, boat.y);
    // Null only at the eye's exact centre, which is inside the calm middle
    // anyway — severity is already zero there, so this is unreachable in
    // practice and cheap to be right about.
    if (direction === null) continue;

    const distance = severity * wind.durationSeconds * BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND;
    let travelled = 0;
    while (travelled < distance) {
      const hop = Math.min(BOAT_WIND_PUSH_STEP_CELLS, distance - travelled);
      if (!moveIfSailable(world, boat, boat.x + direction.x * hop, boat.y + direction.y * hop)) {
        break;
      }
      travelled += hop;
    }
  }
}

/** Commits a position only if a hull may actually be there. */
function moveIfSailable(world: BoatWorld, boat: Boat, x: number, y: number): boolean {
  if (!isSailable(world, x, y)) return false;
  boat.x = x;
  boat.y = y;
  return true;
}

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

  // THE STORM MOVES THE FLEET BEFORE THE FLEET MOVES ITSELF (issue #299). It is
  // first because the push is where each hull ACTUALLY IS when this frame
  // starts — a boat is carried by the wind and then rows from wherever that
  // left it. Doing it after the sail step would mean every station-keeping and
  // separation decision below was made about a position the boat was about to
  // be shoved off, and a fleet at station would spend the whole storm giving
  // way to berths the wind had already emptied.
  applyStormWind(world);

  // Start-of-tick berth snapshot, so every boat gives way to where the others
  // WERE rather than to where the ones already moved this tick now are — the
  // same order-independence the walker sims keep (pilgrims/server/
  // pilgrimage.ts's own note). Parallel to `boats`, so self-exclusion below is
  // an index test rather than a position test.
  const berths: readonly Occupant[] = fleetBerths();

  let engaged = 0;
  for (let index = 0; index < boats.length; index++) {
    const boat = boats[index];
    const target = targetFor(boat, kraken);
    const goalX = target?.x ?? boat.homeX;
    const goalY = target?.y ?? boat.homeY;
    const range = distance(boat.x, boat.y, goalX, goalY);

    boat.fighting = target !== null && range <= BOAT_ENGAGEMENT_RANGE_CELLS;
    if (boat.fighting) engaged++;

    // Holding station: at the fight's edge, or home. Still points at its goal,
    // so a fighting boat faces what it is fighting.
    //
    // THIS IS WHERE THE FLEET USED TO PILE UP. Every boat is given the same
    // goal and the same hold radius, so "hold" put all of them on one circle
    // with nothing to stop them occupying the same arc of it, all turning in
    // place together as the kraken drifted — the owner's "they just kind of
    // spin on top of each other". Holding station is not the same as holding
    // POSITION: a boat whose berth is taken warps off it just far enough to be
    // its own boat, and does it by the same rules it sails by (open water
    // only, unlocked only, smallest turn first), so the line that forms is a
    // line of boats at the fight's edge rather than a stack.
    const holdAt = target === null ? 0 : BOAT_ENGAGEMENT_RANGE_CELLS;
    if (range <= holdAt) {
      // Comes ROUND to face its goal at its own turning circle rather than
      // snapping to it (2026-08-24). A station-keeping boat is the one a player
      // watches longest — it is stopped, at the edge of a fight, with a kraken
      // drifting in front of it — so a heading that teleported here read as a
      // hull spinning on the spot even though the boat was where it belonged.
      if (range > 0) {
        const faceGoal = Math.atan2(goalY - boat.y, goalX - boat.x);
        boat.heading = turnToward(boat.heading, faceGoal, BOAT_TURN_RADIANS_PER_SECOND, dt);
      }
      makeRoom(world, boat, goalX, goalY, berths, index, dt);
      continue;
    }

    const desired = Math.atan2(goalY - boat.y, goalX - boat.x);
    // Never overshoot the goal: a boat one tick's travel from its station
    // stops on it rather than sailing past and turning back forever. Hoisted
    // ABOVE the steer (2026-08-21) because it is also the distance separation
    // is tested at (shared's `SteerOptions.stepCells`) — a boat easing onto
    // its station must be judged against the short step it is really taking,
    // not against a full tick of travel it is not.
    const step = Math.min(BOAT_SPEED_CELLS_PER_SECOND * dt, range - holdAt);
    const wanted = steerToWater(
      world,
      boat,
      desired,
      BOAT_SPEED_CELLS_PER_SECOND * BOAT_LOOKAHEAD_SECONDS,
      step,
    );
    if (wanted === null) continue;

    // THE TURNING CIRCLE (owner, 2026-08-24: boats like the whales). `wanted`
    // is a DIRECTION, freely up to 180° off; what the boat adopts is its
    // current heading turned toward that direction by at most one tick's worth
    // of BOAT_TURN_RADIANS_PER_SECOND. Nothing overrides it — a boat with no
    // in-arc water holds still rather than pivoting, so it has to sail the arc
    // to come about.
    const steered = turnToward(boat.heading, wanted, BOAT_TURN_RADIANS_PER_SECOND, dt);

    const nextX = boat.x + Math.cos(steered) * step;
    const nextY = boat.y + Math.sin(steered) * step;
    // Belt and suspenders, monsters' own: the look-ahead cleared a cell a
    // second away, which says nothing about the cells in between — and the
    // heading actually sailed is the turn-limited one, which the sweep never
    // tested.
    if (!isSailable(world, nextX, nextY)) {
      // BLOCKED, AND THE TURN IS COMMITTED ANYWAY. This is the one place boats
      // deliberately part company with wildlife's advanceEntity, which commits
      // heading and position together and holds both when a step is vetoed.
      // Committing both together DEADLOCKS a turn-limited mover: a boat lying a
      // fraction of a cell off a beach with its bow toward it can only leave by
      // turning, its turn is bounded to one tick's arc, and that first tick's
      // arc still points at the beach — so the step is vetoed, the heading is
      // rolled back with it, and the next tick is identical. Forever. That is
      // the owner's "constantly getting stuck" in its purest form, and the
      // shortening probe alone does not cure it: the ladder finds open water
      // perfectly well, the hull just cannot swing round to it.
      //
      // A boat that cannot make way can still work its bow round — an oar
      // backed against the water is exactly how a beached boat gets off. It is
      // the SAME turning circle either way (BOAT_TURN_RADIANS_PER_SECOND), so
      // what this shows is a hull taking a second or two to come about and then
      // pulling away, never a hull snapping to a new heading: the pivot the
      // owner objected to was an instant one.
      boat.heading = steered;
      continue;
    }
    boat.heading = steered;
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
/**
 * How close a boat must be to a cell for that cell's fire to be ON it, in cells.
 *
 * Its own personal space rather than half a cell: a hull is 0.9 world units of
 * timber (BOAT_PERSONAL_SPACE_CELLS's note) and a torch put to any part of it
 * has hit the boat. Answering "half a cell" here would mean a player aiming at
 * a hull that plainly spans several cells missed most of it.
 */
const FIRE_REACH_CELLS = BOAT_PERSONAL_SPACE_CELLS;

/**
 * The boat lying over this cell, or null — the NEAREST hull within reach, and
 * how far away it is.
 *
 * NEAREST, NOT FIRST, and the rule is `nearestWithinReach`'s rather than this
 * file's (bug, owner-observed 2026-08-24: "the boat burns, and then the boat
 * keeps sailing"). FIRE_REACH_CELLS is a whole hull's reach, so two boats
 * manoeuvring near each other are both candidates for the same torch, and
 * first-match handed the fire to whichever was LAUNCHED EARLIER — the player
 * watched the boat beside their target burn down while their own sailed on.
 *
 * The distance goes back to the caller because fire arbitrates between sources
 * with it: a boat at the edge of its two-cell reach must not outrank a peep
 * standing dead centre on the cell (plugins/fire/server/entityFuel.ts).
 */
export function burnableBoatAt(x: number, y: number): { id: number; distanceCells: number } | null {
  const nearest = nearestWithinReach(boats, x, y, FIRE_REACH_CELLS, (boat) => boat);
  return nearest === null
    ? null
    : { id: nearest.item.id, distanceCells: nearest.distanceCells };
}

/**
 * Every boat afloat, for fire's SPREAD sweep — id, where it is, and how much
 * hull there is around that point.
 *
 * A GENERATOR OVER THE LIVE ARRAY, not a copy: this is asked once per spread
 * step for as long as anything in the world is burning, and `boatStates()` —
 * the other way to enumerate the fleet — allocates an array and rounds every
 * coordinate for the wire, neither of which spread wants.
 *
 * The radius is FIRE_REACH_CELLS, the same half-hull a torch answers for: "how
 * much boat is there around this point" is one fact, and letting spread and the
 * torch disagree about it is how a boat becomes easier to light by accident
 * than on purpose.
 */
export function* flammableBoats(): Generator<{
  id: number;
  x: number;
  y: number;
  radiusCells: number;
}> {
  for (const boat of boats) {
    yield { id: boat.id, x: boat.x, y: boat.y, radiusCells: FIRE_REACH_CELLS };
  }
}

/** Where this boat is now, in fractional cell space — null once it is gone. */
export function boatPosition(id: number): { x: number; y: number } | null {
  const boat = boats.find((candidate) => candidate.id === id);
  return boat === undefined ? null : { x: boat.x, y: boat.y };
}

/**
 * Burns these to the waterline. Returns how many were actually afloat.
 *
 * THE SAME LOSS AS A KRAKEN TAKING ONE — the boat leaves the fleet and its home
 * village is then short, so the ordinary shipyard machinery
 * (advanceShipyards) lays down a replacement on the ordinary timer. A burned
 * boat and a sunk one are the same fact about a village: it has one fewer boat.
 */
export function burnBoats(ids: readonly number[]): number {
  const doomed = new Set(ids);
  const before = boats.length;
  boats = boats.filter((boat) => !doomed.has(boat.id));
  return before - boats.length;
}

/**
 * `worldSize` bounds the rounded position to the map (shared's
 * roundBroadcastCell): a boat legally moored within half a quantum of the far
 * shore rounds to `worldSize`, and the host's visibility filter turns every
 * broadcast position back into a chunk index and throws on an off-map one
 * (issue #180). It bounds the WIRE FORM only — the sim's boat never moves.
 */
export function boatStates(worldSize: number): BoatState[] {
  return boats.map((boat) => ({
    id: boat.id,
    // Rounded on the way OUT only: the sim keeps full precision, and the wire
    // carries the hundredth of a cell a camera can actually resolve.
    x: roundBroadcastCell(boat.x, worldSize),
    y: roundBroadcastCell(boat.y, worldSize),
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
    const key = villageKey(village.x, village.y);
    villages.set(key, { ...village });
    // NOT restored, rederived: a survey describes terrain and unlocked
    // territory at the moment it was taken, and a snapshot may be a world
    // older than either.
    shipyards.set(key, unsurveyedShipyard());
  }
  boats = saved.boats.map((boat) => ({ ...boat }));
  nextBoatId = saved.nextBoatId;
}

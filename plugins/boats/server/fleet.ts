// The fleet: villages that keep boats, boats that sail, and the fight.
//
// Everything here is a pure function of the world and this module's own state
// — no wall clock, no wire, no three — which is what lets the tests assert the
// fight arithmetic directly against a hand-built world, exactly the way
// plugins/monsters/server/habitat.ts and lurk.ts are testable.
//
// THE STEERING CONTRACT now comes from `shared/` (pathing.ts's `findRoute`
// and steering.ts's `followRoute`), not from this file's own sweep. A boat is
// a hull with a turning circle, not a dimensionless point: it plans a route
// through water deep enough to float it (HULL_PROFILE over an eroded sampler),
// follows that route at BOAT_TURN_RADIANS_PER_SECOND while aiming far enough
// ahead to trace a smooth arc (BOAT_AIM_AHEAD_CELLS), and holds a station
// SLOT — its own assigned point on the station circle — rather than the
// circle itself. The rule a boat needs is unchanged — only ever commit to a
// step whose DESTINATION a hull may occupy, so shorelines are walls rather
// than places it can be pushed through, and a boat that finds no watery
// heading holds position rather than beaching — but three things it did NOT
// have come with the shared version:
//
//   - A HULL, not a point: every position write goes through `isHullPose`
//     (centre, bow, stern, both beams on navigable water), so a hull can no
//     longer centre on a cell whose seabed is above its own keel.
//   - OTHER BOATS ARE OBSTACLES (owner, 2026-08-20: "they just kind of spin on
//     top of each other"). Every boat in a fleet is sent to the same kraken
//     and each is given its OWN slot on the station circle, so separation
//     bends a boat around its neighbours without ever bending its range to
//     the fight — which is what broke the rout arithmetic when the two were
//     briefly both live (5.03 cells against a 5.00 station).
//   - "Anywhere in the water" is now a PROFILE (HULL_PROFILE), so what a
//     hull may cross is stated in the same vocabulary as what a yeti or a
//     pilgrim may cross, rather than as this file's own isWater() call.
//
// A boat never turns in place: the only heading write on a hull carries
// `followRoute`'s own commit, which turns only by moving. A boat at its slot
// holds position facing whatever heading it arrived on.
//
// The plugin-boundary rule is untouched: `shared/` is not another plugin.

import {
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  OPEN_WATER_PROFILE,
  WORLD_UNIT_CELLS,
  cellsAcross,
  createRouteBudget,
  findRoute,
  followRoute,
  isWalkableCell as sharedIsWalkableCell,
  navigableWaterProfile,
  nearestWithinReach,
  normalizeAngle,
  withClearance,
  withoutSelf,
  type Occupant,
  type RouteBudget,
  type RouteCell,
  type TerrainSampler,
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
export const BOAT_TURN_RADIANS_PER_SECOND =
  BOAT_SPEED_CELLS_PER_SECOND / (BOAT_TURN_RADIUS_HULL_LENGTHS * BOAT_HULL_LENGTH_CELLS);

// ── the hull: draft, clearance, and the pose predicate ───────────────────────

/**
 * The hull's modelled depth, in world units — HULL_DEPTH in
 * plugins/boats/client/models.ts.
 *
 * Restated for the same reason BOAT_HULL_LENGTH_CELLS restates HULL_LENGTH
 * above: a server sim does not reach into a client model file, and the
 * failure mode of drift is a fleet floating a unit too high or too low,
 * never a crash.
 */
const BOAT_HULL_DEPTH = 0.2;

/**
 * How much of that depth sits below the waterline, as a fraction — the 0.55
 * in BOAT_WATERLINE_LIFT (models.ts:113). Same restatement justification as
 * BOAT_HULL_DEPTH.
 */
const BOAT_WATERLINE_BITE = 0.55;

/**
 * How far below the waterline the keel reaches, in HEIGHT UNITS — the draft
 * HULL_PROFILE refuses to float over.
 *
 * 0.2 × 0.55 = 0.11 world units of keel, and a height unit is
 * MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT = 16/1024 world units, so the keel
 * needs 0.11 × 1024 / 16 = 7.04 height units of water under it — floored to
 * the integer domain the determinism contract asks for. Derived, never typed.
 */
export const BOAT_DRAFT_HEIGHT_UNITS = Math.floor(
  ((BOAT_HULL_DEPTH * BOAT_WATERLINE_BITE) * MAX_HEIGHT) / MAX_RELIEF_WORLD_UNITS,
);

/**
 * Water deep enough to float this hull: OPEN_WATER_PROFILE with the ceiling
 * the draft buys. A hull may centre only where the seabed sits at least its
 * keel below the surface, so shoals a point-boat crossed freely now route
 * around — planner, follower and pose test all read this one profile.
 */
export const HULL_PROFILE = navigableWaterProfile(BOAT_DRAFT_HEIGHT_UNITS);

/**
 * The hull's modelled beam, in world units — HULL_BEAM in
 * plugins/boats/client/models.ts:52. Restated on the usual justification: a
 * server sim does not reach into a client model file.
 */
const BOAT_HULL_BEAM = 0.34;

/**
 * Lateral half-extent of the rowed hull, in cells — ceil(0.17 × 4) = 1 at
 * today's numbers, derived not typed. The eroded sampler below is built with
 * this radius, so the beam is already dilated into the water the planner sees
 * and the pose predicate only has to account for the hull's LENGTH explicitly.
 */
export const BOAT_BEAM_CLEARANCE_CELLS = Math.ceil((BOAT_HULL_BEAM / 2) * WORLD_UNIT_CELLS);

/**
 * Is this a pose a hull may occupy — centre, bow, stern and both midships
 * beam points all on navigable water inside unlocked territory?
 *
 * THE PATTERN IS MONSTERS' `isLairPose` (plugins/monsters/server/habitat.ts):
 * a centre test plus the body's extent, because a centre-only test lets the
 * ends hang over a shore. The boats version is HEADING-RELATIVE where the
 * monsters one is radial, and the difference is the bodies: a kraken is a
 * crown of arms animated by yaw alone, so its swept footprint is a disc, but
 * a hull is 3.6 cells long and 1.36 across — the same pose is legal bow-on to
 * a channel and illegal across it, and a yaw-independent disc would have to
 * refuse both.
 *
 * `world` answers the fog-of-war half (unlocked territory) and `eroded` the
 * terrain half: the eroded sampler already dilates land by the beam, so the
 * five probes read the water the planner planned on and the two cannot
 * disagree about a wall. Half-length is BOAT_HULL_LENGTH_CELLS / 2, the
 * constant already in this file.
 */
export function isHullPose(
  world: BoatWorld,
  eroded: TerrainSampler,
  x: number,
  y: number,
  heading: number,
): boolean {
  const halfLength = BOAT_HULL_LENGTH_CELLS / 2;
  const halfBeam = (BOAT_HULL_BEAM / 2) * WORLD_UNIT_CELLS;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const probes: ReadonlyArray<readonly [number, number]> = [
    [x, y],
    [x + cos * halfLength, y + sin * halfLength],
    [x - cos * halfLength, y - sin * halfLength],
    [x - sin * halfBeam, y + cos * halfBeam],
    [x + sin * halfBeam, y - cos * halfBeam],
  ];
  for (const [probeX, probeY] of probes) {
    if (!world.isCellUnlocked(Math.floor(probeX), Math.floor(probeY))) return false;
    if (!sharedIsWalkableCell(eroded, HULL_PROFILE, probeX, probeY)) return false;
  }
  return true;
}

// ── stations, slots, and voyages ─────────────────────────────────────────────

/**
 * How many ticks of travel inside the engagement circle a station keeps.
 *
 * The station radius is BOAT_ENGAGEMENT_RANGE_CELLS minus this many ticks of
 * the boat's own travel, derived from `dt` at call time because `dt` is the
 * only tick rate this plugin ever sees. One tick: the measured failure it
 * closes was boats settling at 5.03 cells against a 5.00 station and dropping
 * out of engagement, so a margin of a whole step means arrival jitter and
 * separation nudges smaller than one step can never push an engaged boat out
 * of range.
 */
const STATION_MARGIN_TICKS = 1;

/**
 * The radius of the station circle this tick, in cells — engagement range
 * less STATION_MARGIN_TICKS of travel. A function of `dt`, not a constant,
 * for the reason STATION_MARGIN_TICKS states.
 */
export function boatStationRadiusCells(dt: number): number {
  return BOAT_ENGAGEMENT_RANGE_CELLS - BOAT_SPEED_CELLS_PER_SECOND * dt * STATION_MARGIN_TICKS;
}

/**
 * Angular spacing of station slots on a circle of this radius, in radians —
 * SLOT_SPACING_RADIANS. Arc length THREE personal spaces.
 *
 * Three, not two, although two is exactly clear — measured: exactly clear
 * keeps every arrival step vetoed. A boat stepping 0.36 cells toward a
 * neighbour exactly 4.0 away lands at 3.64 < 4.0, so the sweep vetoes the
 * step and deflects ±135°; the turn limit takes 47 ticks to honour that,
 * by which time the goal pulls it back — a permanent limit cycle in which
 * no boat ever seats (every voyage prog=false forever, routes replan every
 * 8 s, the fleet orbits its own slots). Three personal spaces leaves a full
 * step of working margin, so a seated neighbour is scenery, not an obstacle.
 */
function slotSpacingRadians(stationRadiusCells: number): number {
  return (3 * BOAT_PERSONAL_SPACE_CELLS) / stationRadiusCells;
}

/**
 * How many slots fit on the station circle — SLOT_COUNT, floor(2π / spacing).
 * At today's numbers (station ≈ 19.64 cells, spacing ≈ 0.305 rad) that is 20:
 * still several times the largest fleet, so a boat that cannot be seated is a
 * boat whose kraken is parked against a coast, not a fleet that outgrew its
 * circle.
 */
function slotCountFor(stationRadiusCells: number): number {
  return Math.max(1, Math.floor((2 * Math.PI) / slotSpacingRadians(stationRadiusCells)));
}

/**
 * Seconds stalled before a hull replans from open water beside itself
 * instead of from under its own keel.
 *
 * A BALANCE-POINT escape, not a schedule. A hull can pin between a forward
 * veto and an astern restore with net zero — measured: beam straddling the
 * x=51 eroded shore off the C-spine, east-drift commits and west asterns
 * cancelling exactly, heading pinned by the asterns so the turn that would
 * escape never starts. Replanning from the same position replays the same
 * route into the same balance. Planning from the most-open water 2.5 cells
 * away instead forces a turn-and-move join (the offset is open, so the steps
 * commit and the heading turns with them) onto a corridor that starts clear
 * of the boundary. Six seconds is past honest slow legs (a quarter-stride
 * cell takes ~1.1 s) and before the stuck clock, so it fires on traps, not
 * traffic.
 */
const OFFSET_REPLAN_SECONDS = 6;

/**
 * The most-open water around a point, 2.5 cells out in fixed E/W/N/S order
 * (deterministic), or null when walled in on all four. Eroded-walkable is
 * enough for a planning fiction — the hull sails there first and the
 * corridor it joins is certified cell by cell as usual.
 */
function reliefOffset(
  eroded: TerrainSampler,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const OFFSET_CELLS = 2.5;
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [OFFSET_CELLS, 0],
    [-OFFSET_CELLS, 0],
    [0, OFFSET_CELLS],
    [0, -OFFSET_CELLS],
  ];
  for (const [dx, dy] of dirs) {
    if (sharedIsWalkableCell(eroded, HULL_PROFILE, x + dx, y + dy)) {
      return { x: x + dx, y: y + dy };
    }
  }
  return null;
}

/**
 * How far the goal may drift before the route planned to it is stale, in
 * cells — two personal spaces (one whole hull). A kraken wandering inside
 * that does not change which way round a headland the fleet goes, so it
 * should not spend the fleet's routing budget finding out.
 */
const REPLAN_GOAL_DRIFT_CELLS = 2 * BOAT_PERSONAL_SPACE_CELLS;

/**
 * Is the hull standing on its own route (index..index+window)?
 *
 * The window mirrors shared's private ROUTE_RESYNC_WINDOW_CELLS
 * (= cellsAcross(2), steering.ts): if it ever changes there, this test only
 * flips cruise/rejoin at the margin.
 */
function onRouteCorridor(route: RouteCell[], index: number, x: number, y: number): boolean {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const windowEnd = Math.min(
    index + Math.max(cellsAcross(2), BOAT_AIM_AHEAD_CELLS),
    route.length - 1,
  );
  for (let i = index; i <= windowEnd; i++) {
    if (route[i].x === cellX && route[i].y === cellY) return true;
  }
  return false;
}

/**
 * Seconds without entering a new route cell before a voyage is declared stuck
 * and replanned.
 *
 * Sized against the coming-about time: a 180° turn at
 * BOAT_TURN_RADIANS_PER_SECOND takes π / 0.5 ≈ 6.3 s at cruise, and a boat
 * most of the way through that arc has made no ROUTE progress while doing
 * exactly what it should. 8 s clears one full coming-about with margin, so
 * the stuck clock fires on a hull that is genuinely wedged, never on one
 * that is merely turning.
 */
const BOAT_STUCK_SECONDS = 8;

/**
 * How many route cells past the current one a follower may aim at directly —
 * BOAT_AIM_AHEAD_CELLS.
 *
 * Derived from the turning circle: the chord a hull needs to trace a smooth
 * arc through a 45° route bend is 2·R·sin(22.5°) ≈ 5.5 cells at R = 7.2, and
 * two hull lengths (7.2 cells, ceiled to 8) covers that chord with margin —
 * far enough to cut the corner, short enough to stay inside the corridor the
 * eroded planner certified. Phase 1 measured that a turn limit ALONE orbits a
 * 1-cell waypoint, so this is the option that lets the limit work.
 */
export const BOAT_AIM_AHEAD_CELLS = Math.ceil(2 * BOAT_HULL_LENGTH_CELLS);

/**
 * The kraken's body as an occupant, in cells — half of its 7-world-unit
 * footprint (KRAKEN_FOOTPRINT_CELLS in plugins/monsters/server/kinds.ts:451,
 * cellsAcross(7)).
 *
 * Restated on this file's usual ground: a server sim does not reach into
 * another plugin's table, and the failure mode of drift is a fleet that
 * stands off a little closer or further than the animal, never a crash.
 */
const KRAKEN_BODY_RADIUS_CELLS = cellsAcross(7) / 2;

/**
 * A boat's voyage: the route it is sailing, where along it stands, the goal
 * that route was planned to, and how long since it entered a new route cell.
 *
 * A SIDE MAP KEYED BY BOAT ID, NOT FIELDS ON `Boat`, for the same reason the
 * `shipyards` map keeps derived state off `Village`: persistence.ts validates
 * the persisted shape exactly, and a route is rederivable — a stale copy
 * restored from disk would send a hull down a channel that is no longer there.
 */
interface Voyage {
  route: RouteCell[] | null;
  routeIndex: number;
  goalX: number;
  goalY: number;
  noProgressSeconds: number;
  /**
   * Last tick's slot index, or null. The ONLY memory the assignment keeps:
   * preferring it is what stops two boats sharing a bearing boundary from
   * swapping slots every tick. Module state, never persisted — a restored
   * fleet replans from scratch, which is correct because the terrain may have
   * changed under the save.
   */
  slot: number | null;
}

const voyages = new Map<number, Voyage>();

/** Drops a voyage when its boat is gone — sunk, burned, or scuttled. */
function dropVoyage(id: number): void {
  voyages.delete(id);
}

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
 * Wind-damage events this fleet has not been pushed by yet, oldest first.
 *
 * A QUEUE, AND NOT A PER-TICK LATCH — the opposite of how the kraken position is
 * held (../server/index.ts's `krakenThisTick`), and the difference is what the
 * two things ARE. A kraken position is a STANDING FACT re-announced every tick,
 * so dropping it at the end of a tick is how "the kraken left" reads. A damage
 * event is a DISCRETE quantum of storm — it arrives once a second and carries
 * the seconds it accounts for — so it must be applied exactly once. Clearing one
 * unapplied would silently drop part of a hurricane; holding one across ticks
 * would apply the same second of wind ten times over.
 *
 * A LIST RATHER THAN ONE SLOT, and this is the CONTRACT rather than the
 * situation. The engine emits one damage event per storm per interval, and how
 * many storms there may be is the EMITTER's number (a RotatingStormProfile's
 * `maxActive`), not this plugin's to know: two of them announcing between two
 * advances is an ordinary tick, not a stall. A single slot would keep the last
 * and silently drop the rest — a fleet pushed by one of the two cyclones over
 * it, with nothing anywhere saying so. That the shipped cyclone allows exactly
 * one storm today is precisely why a slot would have looked correct for as long
 * as it took someone to raise that number.
 *
 * WHY THEY ARE HELD AT ALL, rather than pushing the boats from inside the event
 * handler. The host fans an emit out synchronously, inside the emitting
 * plugin's own onTick (server/src/plugins/host.ts's emit fan-out), and plugins
 * tick in LOAD ORDER — which is alphabetical by directory, so `boats` has
 * already advanced its whole fleet by the time `cyclone` emits. Pushing from
 * the handler would therefore move hulls in the middle of another plugin's
 * tick, after this one's own step, separation and station-keeping had all
 * been resolved against the old positions: a boat could be shoved onto a
 * berth another boat had just been given. Held here and drained at the top of
 * advanceFleet, the push is simply where the fleet starts its next frame.
 *
 * DRAINED IN ARRIVAL ORDER, which is the order the storms were announced in.
 * Two winds on one hull compose the same way either way round — each is a
 * displacement, and the only thing that is not commutative is which one gets
 * stopped by a coastline first. Arrival order is the one order that is a fact
 * about the world rather than about this array.
 */
const pendingWinds: ParsedStormDamage[] = [];

const villageKey = (x: number, y: number): string => `${x},${y}`;

export function resetFleet(): void {
  villages.clear();
  shipyards.clear();
  voyages.clear();
  boats = [];
  nextBoatId = 1;
  krakenWounds = 0;
  sinceLastSinking = 0;
  pendingWinds.length = 0;
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
  const scuttled = boats.filter((boat) => boat.homeX !== x || boat.homeY !== y);
  for (const boat of boats) {
    if (boat.homeX === x && boat.homeY === y) dropVoyage(boat.id);
  }
  boats = scuttled;
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

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * The nearest sailable cell to `village` that no boat is already sitting in, or
 * null when every one of them is taken.
 *
 * THE OTHER HALF OF "SPAWNING ON TOP OF EACH OTHER" (owner, 2026-08-24).
 * Station slots have kept a fighting fleet from stacking since 2026-09-03
 * (before that, `makeRoom`, 2026-08-21), but nothing looked at the fleet on the way IN: every boat of a village was placed
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
  // The eroded sampler is built per call, not per tick: launches are rare
  // (one per BOAT_REBUILD_SECONDS per short village), so sharing
  // advanceFleet's tick sampler would mean threading it through
  // advanceShipyards' exported signature for no measurable gain.
  const eroded = withClearance(world, BOAT_BEAM_CLEARANCE_CELLS);
  for (const [dx, dy] of COASTAL_DISC) {
    const x = village.x + dx;
    const y = village.y + dy;
    if (!isSailable(world, x, y)) continue;
    // The pose the hull will actually be launched with: facing OUT of the
    // harbour, away from the village that built it. A berth whose centre is
    // water but whose bow or stern would already be aground is no berth — the
    // sail step below would refuse to move it and the stuck clock would
    // replan it forever.
    const heading = Math.atan2(y - village.y, x - village.x);
    if (!isHullPose(world, eroded, x, y, heading)) continue;
    // The cell CENTRE is what the boat is placed on, and it is what the
    // clearance is measured from — the same point the resolution pass will
    // keep clear from the next tick onward.
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
 * A boat's goal for this tick: the point it sails for, and how far short of
 * that point counts as arrived.
 */
interface StationGoal {
  readonly x: number;
  readonly y: number;
  /**
   * How far short of the point the boat stops — 0 for a slot or home water
   * (stop exactly on it), the station radius for a fallback run at the kraken
   * itself (hold at arm's length, exactly as a slotted boat holds its slot).
   */
  readonly standoff: number;
  /**
   * The slot index this goal is the point of, or null for a fallback or home
   * goal. Carried so the next tick's assignment can prefer it (stickiness) —
   * it is an angle, not a point, so it tracks a drifting kraken automatically.
   */
  readonly slot: number | null;
}

/**
 * Every engaged boat's station slot for this tick, keyed by boat index.
 *
 * THIS IS THE FIX THAT LETS SEPARATION COME BACK ON. Every boat used to be
 * aimed at the SAME circle with no assigned point on it, so any avoidance
 * term could only express itself by bending the shared radius — measured
 * 5.03 cells against a 5.00 station, which stopped counting as engaged and
 * broke the rout arithmetic. Each boat is now given its OWN point on the
 * station circle, so keeping clear of a neighbour never costs it the fight.
 *
 * In `boats` array order (id order, fixed): each boat takes the nearest FREE
 * slot index to its own bearing from the kraken, searching outward
 * alternating +1/−1. Slots are per-tick and never persisted. Deterministic
 * by construction — no clock, no RNG, fixed order.
 *
 * A slot whose point is not a legal hull pose (the kraken is near a coast)
 * is SKIPPED and claimed anyway: the pose test faces the kraken, which
 * depends only on the slot, so a slot illegal for one boat is illegal for
 * every boat and leaving it free would only make each boat trip over it in
 * turn. A boat with no legal slot sails at the kraken itself and stops at
 * the station radius.
 */
function assignStationGoals(
  world: BoatWorld,
  eroded: TerrainSampler,
  kraken: KrakenTarget | null,
  stationRadius: number,
): Map<number, StationGoal> {
  const goals = new Map<number, StationGoal>();
  if (kraken === null) return goals;
  const slots = slotCountFor(stationRadius);
  const taken = new Set<number>();
  // Sails the point of a slot index on the station circle.
  const pointOf = (slot: number): { x: number; y: number } => {
    const angle = (slot / slots) * 2 * Math.PI;
    return {
      x: kraken.x + Math.cos(angle) * stationRadius,
      y: kraken.y + Math.sin(angle) * stationRadius,
    };
  };
  // A slot's pose test: facing the kraken, the pose a boat arrives in sailing
  // radially onto its slot. It depends only on the slot, so a slot illegal
  // for one boat is illegal for every boat.
  const poseOf = (slot: number): { x: number; y: number } | null => {
    const { x, y } = pointOf(slot);
    const faceKraken = Math.atan2(kraken.y - y, kraken.x - x);
    return isHullPose(world, eroded, x, y, faceKraken) ? { x, y } : null;
  };
  for (let index = 0; index < boats.length; index++) {
    const boat = boats[index];
    if (targetFor(boat, kraken) === null) continue;
    // STICKINESS: a boat keeps last tick's slot while it is still free and
    // still legal. Pure nearest-free FLAPS when two boats share a bearing
    // boundary — measured: they swapped slots every tick, replanned every
    // tick, and sailed nowhere, holding a full fleet 3 cells off station and
    // slipping the rout from 21 s to 31 s against the test that pins it.
    // Order-priority keeps it convergent: boats are seated in fixed array
    // order, so an earlier boat never yields to a later one and no two boats
    // can chase each other's slots. Still per-tick and still unpersisted —
    // the preference is a tie-break inside the recomputation, not a saved
    // berth — and the index is an angle, so a kept slot tracks a drifting
    // kraken on its own.
    const prev = voyages.get(boat.id)?.slot ?? null;
    if (prev !== null && prev < slots && !taken.has(prev)) {
      const pose = poseOf(prev);
      taken.add(prev);
      if (pose !== null) {
        goals.set(index, { x: pose.x, y: pose.y, standoff: 0, slot: prev });
        continue;
      }
    }
    const bearing = Math.atan2(boat.y - kraken.y, boat.x - kraken.x);
    const base = ((Math.round((bearing / (2 * Math.PI)) * slots) % slots) + slots) % slots;
    let seated = false;
    for (let k = 0; k < slots; k++) {
      const off = k === 0 ? 0 : k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
      const slot = (((base + off) % slots) + slots) % slots;
      if (taken.has(slot)) continue;
      taken.add(slot);
      const pose = poseOf(slot);
      if (pose === null) continue;
      goals.set(index, { x: pose.x, y: pose.y, standoff: 0, slot });
      seated = true;
      break;
    }
    if (!seated) {
      goals.set(index, { x: kraken.x, y: kraken.y, standoff: stationRadius, slot: null });
    }
  }
  return goals;
}

/**
 * The water a home-bound boat sails for: the nearest hull-legal cell to its
 * village, read WITHOUT re-walking the cached survey (advanceShipyards
 * already advanced the clock this tick, and this must stay correct under a
 * sculpt even when the village is at strength and no survey is running).
 *
 * Nearest-first disc order, like launchCell — but the gate is the HULL, not
 * the centre. The launch cell is centre-water a hull length from a beach the
 * planner (eroded, HULL_PROFILE) refuses to certify, so routing to it always
 * fails and the boat falls back to dead reckoning — measured: 20-second
 * coming-about tours for a 3-cell trip home, and an orbit that never lands.
 * The mooring is tested on its arrival heading, facing the village it is
 * coming home to. A village with no hull water at all — filled bay, or
 * inland — yields the village itself: an unreachable goal the boat presses
 * toward until hull law stops it, exactly as before.
 */
function homeWaterGoal(world: BoatWorld, eroded: TerrainSampler, boat: Boat): KrakenTarget {
  for (const [dx, dy] of COASTAL_DISC) {
    const x = boat.homeX + dx;
    const y = boat.homeY + dy;
    if (!isSailable(world, x, y)) continue;
    const faceHome = Math.atan2(boat.homeY - y, boat.homeX - x);
    if (!isHullPose(world, eroded, x, y, faceHome)) continue;
    return { x, y };
  }
  return { x: boat.homeX, y: boat.homeY };
}

/**
 * Records the wind a cyclone announced, to be applied at the top of the next
 * frame — see `pendingWind` for why it is not applied here.
 */
export function noteStormWind(damage: ParsedStormDamage): void {
  pendingWinds.push(damage);
}

/**
 * Carries every boat inside each pending storm's disc along that storm's
 * tangential wind, and empties the queue.
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
function applyStormWind(world: BoatWorld, eroded: TerrainSampler): void {
  if (pendingWinds.length === 0) return;
  // Spliced out before any of it is applied, so a push that somehow re-entered
  // this function could not replay the same second of wind.
  const winds = pendingWinds.splice(0, pendingWinds.length);

  for (const wind of winds) {
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
        // Hull law, not water law: the wind may shove a boat along a shore
        // but never grind its bow or stern through one, and the push keeps
        // the heading it found — a hull carried sideways still points where
        // it pointed.
        const nextX = boat.x + direction.x * hop;
        const nextY = boat.y + direction.y * hop;
        if (!isHullPose(world, eroded, nextX, nextY, boat.heading)) break;
        boat.x = nextX;
        boat.y = nextY;
        travelled += hop;
      }
    }
  }
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

  // The eroded sampler is built ONCE per tick: the world object is stable
  // within a tick, and every hull test, plan and step below reads through it.
  const eroded = withClearance(world, BOAT_BEAM_CLEARANCE_CELLS);

  // THE STORM MOVES THE FLEET BEFORE THE FLEET MOVES ITSELF (issue #299). It is
  // first because the push is where each hull ACTUALLY IS when this frame
  // starts — a boat is carried by the wind and then rows from wherever that
  // left it. Doing it after the sail step would mean every station-keeping and
  // separation decision below was made about a position the boat was about to
  // be shoved off, and a fleet at station would spend the whole storm giving
  // way to berths the wind had already emptied.
  applyStormWind(world, eroded);

  // Start-of-tick berth snapshot, so every boat gives way to where the others
  // WERE rather than to where the ones already moved this tick now are — the
  // same order-independence the walker sims keep (pilgrims/server/
  // pilgrimage.ts's own note). Parallel to `boats`, so self-exclusion below is
  // an index test rather than a position test.
  const berths: readonly Occupant[] = fleetBerths();

  const step = BOAT_SPEED_CELLS_PER_SECOND * dt;
  const lookahead = BOAT_SPEED_CELLS_PER_SECOND * BOAT_LOOKAHEAD_SECONDS;
  const maxTurnRadians = BOAT_TURN_RADIANS_PER_SECOND * dt;
  const stationRadius = boatStationRadiusCells(dt);
  // One routing pool for the whole fleet's tick: every search draws from the
  // same allowance, so a headland the whole fleet must round cannot spend one
  // budget per hull. See shared/src/pathing.ts's RouteBudget.
  const budget: RouteBudget = createRouteBudget();
  // The kraken is an occupant, not open water: a hull sails round its body,
  // never through it. One snapshot, taken before anyone moves.
  const krakenOccupant: Occupant | null =
    kraken === null
      ? null
      : { x: kraken.x, y: kraken.y, radiusCells: KRAKEN_BODY_RADIUS_CELLS };
  // Station slots, assigned from start-of-tick positions before anyone moves.
  const goals = assignStationGoals(world, eroded, kraken, stationRadius);

  let engaged = 0;
  for (let index = 0; index < boats.length; index++) {
    const boat = boats[index];
    const target = targetFor(boat, kraken);
    // An engaged boat sails for its slot; a slotless one for the kraken with
    // a standoff; a peacetime boat for its home water, stopping on it.
    // assignStationGoals seats every targeted boat (falling back to the
    // kraken itself), so a missing entry can only mean a mid-tick roster
    // change — sail at the animal rather than hold forever.
    let goalX: number;
    let goalY: number;
    let standoff: number;
    let slotIndex: number | null;
    if (target === null) {
      const home = homeWaterGoal(world, eroded, boat);
      goalX = home.x;
      goalY = home.y;
      standoff = 0;
      slotIndex = null;
    } else {
      const slot = goals.get(index);
      goalX = slot?.x ?? target.x;
      goalY = slot?.y ?? target.y;
      standoff = slot?.standoff ?? stationRadius;
      slotIndex = slot?.slot ?? null;
    }
    const range = distance(boat.x, boat.y, goalX, goalY);
    const krakenRange =
      target === null ? Infinity : distance(boat.x, boat.y, target.x, target.y);

    boat.fighting = target !== null && krakenRange <= BOAT_ENGAGEMENT_RANGE_CELLS;
    if (boat.fighting) engaged++;

    // Holding: at standoff, or within one step of a point goal. A boat AT its
    // slot holds position and does NOT turn while stationary — it faces
    // whatever heading it arrived on (owner rule). There is deliberately no
    // "come round to face the goal" here: turning without moving is the
    // pivot the owner forbids.
    let voyage = voyages.get(boat.id);
    const settle = (holdX: number, holdY: number): void => {
      if (voyage !== undefined) {
        voyage.goalX = holdX;
        voyage.goalY = holdY;
        voyage.noProgressSeconds = 0;
        voyage.slot = slotIndex;
      }
    };
    if (range <= standoff) {
      settle(goalX, goalY);
      continue;
    }
    if (standoff === 0 && range <= step) {
      // Within one tick's travel of a point goal: stop exactly on it, hull
      // permitting — else hold where it lies. Either way the heading is
      // untouched, and either way this is not a sail tick, so a boat pressing
      // an unreachable point never backs-and-fills against it.
      if (isHullPose(world, eroded, goalX, goalY, boat.heading)) {
        boat.x = goalX;
        boat.y = goalY;
      }
      settle(goalX, goalY);
      continue;
    }
    if (boat.fighting) {
      // In the fight: hold water. Seeking the slot from here costs a
      // coming-about arc that exits engagement — measured: a 150° turn at
      // BOAT_TURN_RADIANS_PER_SECOND displaces a hull up to two turning
      // diameters, straight out of a station one tick inside the circle — and
      // the rout arithmetic counts whole seconds of engagement. The slot
      // guides the approach (unengaged boats below still sail to theirs); the
      // melee is held, and station-keeping clearance belongs to the
      // resolution pass, as designed. Snapping (above) still seats a boat a
      // nudge from its slot, for free.
      settle(goalX, goalY);
      continue;
    }

    // The voyage: plan when there is no route, the goal drifted further than
    // REPLAN_GOAL_DRIFT_CELLS from the planned one, the stuck clock fired, or
    // the balance-point escape below fired — never more than one plan per
    // boat per tick, every plan drawing from the fleet's shared pool.
    //
    // OFFSET REPLANS do not count against the one-plan bound the way a
    // same-position replan would: they replace it. When stalled past
    // OFFSET_REPLAN_SECONDS with a route that goes nowhere, the fleet tries
    // open water beside the hull first and falls back to planning from under
    // its own keel — one findRoute either way (the branch below runs once).
    let plannedHere = false;
    if (
      voyage !== undefined &&
      voyage.route !== null &&
      voyage.noProgressSeconds > OFFSET_REPLAN_SECONDS
    ) {
      const relief = reliefOffset(eroded, boat.x, boat.y);
      if (relief !== null) {
        const escape = findRoute(eroded, HULL_PROFILE, relief, { x: goalX, y: goalY }, budget);
        if (escape !== null) {
          voyage.route = [...escape.cells];
          voyage.routeIndex = 0;
          voyage.goalX = goalX;
          voyage.goalY = goalY;
          voyage.noProgressSeconds = 0;
          plannedHere = true;
        }
      }
    }
    if (voyage === undefined) {
      voyage = { route: null, routeIndex: 0, goalX, goalY, noProgressSeconds: 0, slot: null };
      voyages.set(boat.id, voyage);
    }
    if (
      !plannedHere &&
      (voyage.route === null ||
        distance(goalX, goalY, voyage.goalX, voyage.goalY) > REPLAN_GOAL_DRIFT_CELLS ||
        voyage.noProgressSeconds > BOAT_STUCK_SECONDS)
    ) {
      const plan = findRoute(
        eroded,
        HULL_PROFILE,
        { x: boat.x, y: boat.y },
        { x: goalX, y: goalY },
        budget,
      );
      voyage.route = plan === null ? null : [...plan.cells];
      voyage.routeIndex = 0;
      voyage.goalX = goalX;
      voyage.goalY = goalY;
      voyage.noProgressSeconds = 0;
    }
    voyage.slot = slotIndex;

    // Touch-advance the route index over cells the hull demonstrably reached:
    // within TOUCH of route[index+1]'s centre, the window moves up by one,
    // repeatedly. WITHOUT this, a hull that flies past route[index+1]
    // laterally (aiming eight ahead) strands the index behind it: the aim
    // never moves on, every correction aims at stale water, and shared's own
    // resync — containment in a 1×1 cell — never fires (measured: 100+ ticks
    // grinding a wall with the index pinned at 0). And when the resync DOES
    // fire, it jumps up to eight cells at once and jerks the aim the same
    // distance, which is what drives the ±11-cell S-turns down open corridors.
    // Advancing one reached cell at a time keeps the aim gliding.
    //
    // This is NOT shared's condemned proximity advancement (steering.ts): that
    // advanced on a 0.75 radius and then validated a SHORTCUT to the cell
    // after — a diagonal the route never contained — which failed, replanned,
    // and sent the mover back to its own cell in a 2-cycle. This advances
    // only over the single next cell, only when the hull is practically on
    // its centre, and the edge the follower then validates (current→next) is
    // the adjacent, A*-certified one it would have checked anyway.
    const ROUTE_TOUCH_RADIUS_CELLS = 0.6;
    if (voyage.route !== null) {
      while (
        voyage.routeIndex + 1 < voyage.route.length &&
        distance(
          boat.x,
          boat.y,
          voyage.route[voyage.routeIndex + 1].x + 0.5,
          voyage.route[voyage.routeIndex + 1].y + 0.5,
        ) < ROUTE_TOUCH_RADIUS_CELLS
      ) {
        voyage.routeIndex++;
      }
    }

    // Corridor check: is the hull standing on its own route? At cruise it aims
    // BOAT_AIM_AHEAD_CELLS ahead to trace smooth arcs through bends — but the
    // aim must ALSO be making progress. A hull stalled on-corridor (no new
    // route cell for over two seconds — past the slowest honest cell crossing
    // at quarter stride) is dithering against a sub-cell boundary the far aim
    // drags it into — measured: beam straddling x=51 off the C-spine, forward
    // steps vetoed, asterns restoring, net zero forever with the index pinned.
    // Dropping a stalled cruiser to rejoin aim (nearest window cell) breaks
    // the balance: it flies at water beside the boundary instead of along it,
    // enters cells, and cruise resumes on progress.
    // The check also yields the AIM DISTANCE the damping below steers by.
    let onCorridor = false;
    let aimDistance = 1;
    if (voyage.route !== null) {
      onCorridor =
        onRouteCorridor(voyage.route, voyage.routeIndex, boat.x, boat.y) &&
        voyage.noProgressSeconds <= 2;
      if (onCorridor) {
        aimDistance = BOAT_AIM_AHEAD_CELLS;
      } else {
        const windowEnd = Math.min(
          voyage.routeIndex + Math.max(cellsAcross(2), BOAT_AIM_AHEAD_CELLS),
          voyage.route.length - 1,
        );
        let best = voyage.routeIndex + 1;
        let bestDist = Infinity;
        for (let i = voyage.routeIndex + 1; i <= windowEnd; i++) {
          const d = distance(
            boat.x,
            boat.y,
            voyage.route[i].x + 0.5,
            voyage.route[i].y + 0.5,
          );
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        aimDistance = Math.max(1, best - voyage.routeIndex);
      }
    }

    // Never overshoot the standoff: a boat closing on its station stops on it
    // rather than sailing past and turning back forever. The cap is ALSO the
    // distance separation is judged at (shared's stepCells) — a boat easing
    // onto its station is judged against the short step it is really taking,
    // not a full tick of travel it is not.
    //
    // BEAR OFF WAY TO COME ABOUT. The hull turns at a fixed rate, so the
    // tighter it must turn the slower it must go: at full stride every bend
    // becomes a turning-diameter excursion (measured solo: ±11-cell S-turns
    // down a straight open-sea corridor, a 60-cell trip unfinished in 60 s).
    // Full stride inside 45° of the AIM bearing, quarter stride past 135°,
    // linear between. The aim is the cell the follower is actually steering
    // for (shared picks the farthest legal of route[i+1..i+aim], so aiming by
    // the same distance steers by the same water) — NOT the far goal, which
    // stands abeam down every corridor leg and would halve speed for the
    // whole leg. On the final cell, where the aim is the deck under its feet,
    // damping switches off so the arrival keeps full way on. The turn itself
    // is untouched (maxTurnRadians still caps every tick) — only the advance
    // slows, which is backing water, never a pivot: the boat still moves
    // every sail tick.
    let advance = 1;
    if (voyage.route !== null) {
      const aimIndex = Math.min(
        voyage.routeIndex + aimDistance,
        voyage.route.length - 1,
      );
      if (aimIndex > voyage.routeIndex) {
        const aimBearing = Math.atan2(
          voyage.route[aimIndex].y + 0.5 - boat.y,
          voyage.route[aimIndex].x + 0.5 - boat.x,
        );
        const misalignment = Math.abs(normalizeAngle(aimBearing - boat.heading));
        advance =
          misalignment <= Math.PI / 4
            ? 1
            : misalignment >= (3 * Math.PI) / 4
              ? 0.25
              : 1 - 0.75 * ((misalignment - Math.PI / 4) / (Math.PI / 2));
      }
    } else {
      const goalBearing = Math.atan2(goalY - boat.y, goalX - boat.x);
      const misalignment = Math.abs(normalizeAngle(goalBearing - boat.heading));
      advance =
        misalignment <= Math.PI / 4
          ? 1
          : misalignment >= (3 * Math.PI) / 4
            ? 0.25
            : 1 - 0.75 * ((misalignment - Math.PI / 4) / (Math.PI / 2));
    }
    const stride = Math.min(step, range - standoff) * advance;
    // No certified path (illegal goal cell, exhausted pool, open-sea pocket):
    // press on only while the first step toward the goal is hull water, else
    // hold. Dead reckoning toward a point with a turning circle orbits it
    // (Phase 1's finding) or backs-and-fills against the shore one step
    // forward, one step astern, forever — the closest hull-legal approach is
    // the seamanship, and this re-runs every tick so sailing resumes the
    // moment the goal moves into reach.
    if (voyage.route === null && range > 0) {
      const probeX = boat.x + ((goalX - boat.x) / range) * stride;
      const probeY = boat.y + ((goalY - boat.y) / range) * stride;
      if (!isHullPose(world, eroded, probeX, probeY, boat.heading)) {
        settle(goalX, goalY);
        continue;
      }
    }
    // A helm is a boat-shaped view carrying the voyage's route: followRoute
    // mutates the helm, and the commit below carries that — and only that —
    // onto the hull.
    const helm = {
      x: boat.x,
      y: boat.y,
      heading: boat.heading,
      route: voyage.route,
      routeIndex: voyage.routeIndex,
    };
    const others = withoutSelf(berths, berths[index]);
    const result = followRoute(eroded, HULL_PROFILE, helm, {
      stepCells: stride,
      lookaheadCells: lookahead,
      goalX,
      goalY,
      occupants: krakenOccupant === null ? others : [...others, krakenOccupant],
      selfRadiusCells: BOAT_PERSONAL_SPACE_CELLS,
      // Hull law at the step point, on the heading the step is taken from: a
      // step-length move cannot swing the bow far, so the current heading is
      // the right approximation. (An earlier revision checked the whole
      // one-tick turn envelope here; it flickered pass/fail on 0.03-cell
      // margins at headings the hull never adopts and trapped boats against
      // walls they were clearing — reverted. The exact adopted-heading check
      // lives in the post-commit veto below.) The unlocked half is a
      // fog-of-war fact with no business in shared/ — it rides inside
      // isHullPose.
      permits: (x, y) => isHullPose(world, eroded, x, y, helm.heading),
      // BOTH turn options at cruise, per Phase 1's finding: a turn limit alone
      // orbits a 1-cell waypoint, so the follower also aims ahead
      // (BOAT_AIM_AHEAD_CELLS) to trace a smooth arc through the route's
      // 8-direction jag. Off-corridor it aims at the nearest window cell
      // (rejoin mode, see the corridor check above).
      maxTurnRadians,
      aimAheadCells: aimDistance,
      // followRoute's own single-replan safety is capped at what the shared
      // pool still holds: it can spend the remainder, never more.
      replanNodeBudget: budget.remaining,
    });
    // followRoute's commit is the ONLY heading write on a hull: the turn only
    // ever happens by moving (a blocked clamp holds or backs astern with the
    // heading unchanged — it never pivots), so carrying all three fields
    // across is carrying one certified decision, not three — subject to the
    // hull's final veto below.
    //
    // THE SAIL STEP GOES THROUGH isHullPose. `permits` above certifies the
    // step on the PRE-turn heading, but the commit turns first (up to
    // maxTurnRadians) and swings the bow/stern probes by up to 0.09 cells —
    // enough to clip a shore the hull was hugging. So the committed pose is
    // re-tested on the ADOPTED heading.
    //
    // A vetoed commit backs astern instead of holding everything: vetoing the
    // heading with the position would deadlock the hull nose-on — it could
    // never turn its bow away, because every turn is vetoed with the move
    // that carries it. Backing one stride along the CURRENT heading with the
    // heading unchanged is followRoute's own backing maneuver one level up
    // (position changes, heading does not: not a pivot), and it re-opens the
    // forward arc on a later tick. When astern is hull-illegal too, everything
    // holds.
    //
    // A vetoed commit is no progress, even when the helm moved or the stern
    // went back: the hull is exactly as stuck as a refused step, so the stuck
    // clock must see it. (A replan is progress of its own kind — a fresh route
    // may unstick what the old one could not.)
    const committed = isHullPose(world, eroded, helm.x, helm.y, helm.heading);
    if (committed) {
      boat.heading = helm.heading;
      boat.x = helm.x;
      boat.y = helm.y;
    } else {
      const backX = boat.x - Math.cos(boat.heading) * stride;
      const backY = boat.y - Math.sin(boat.heading) * stride;
      if (stride > 0 && isHullPose(world, eroded, backX, backY, boat.heading)) {
        boat.x = backX;
        boat.y = backY;
      }
    }
    voyage.route = helm.route;
    voyage.routeIndex = helm.routeIndex;
    if (result.replanned || (result.progressed && committed)) voyage.noProgressSeconds = 0;
    else voyage.noProgressSeconds += dt;
  }

  // RESOLUTION PASS — belt to the slots' suspenders. The slot spacing seats
  // neighbours a full step beyond clear, so for a fleet at station this pass
  // is a no-op by construction; it exists for transit crossings only, where
  // two hulls closing head-on can end a tick nearer than their combined radii
  // (shared's steering works from a start-of-tick snapshot, so it judges
  // where the other boat WAS). One pass in index order over pairs (i < j):
  // hulls closer than two personal spaces are pushed half the overlap each,
  // directly apart. Headings never change here, and each boat's push is
  // capped at one step per tick, so a resolution cannot teleport.
  const pushLeft = boats.map(() => step);
  // A push that would carry an engaged boat out of engagement is refused like
  // a push into the coast: the station sits one step inside the circle, so an
  // unguarded shove is exactly enough to break it (19.64 + 0.36 = 20.00, and
  // floating point votes against us). The other boat still takes its half.
  const keepsEngagement = (boat: Boat, x: number, y: number): boolean => {
    if (kraken === null || !boat.fighting) return true;
    return distance(x, y, kraken.x, kraken.y) <= BOAT_ENGAGEMENT_RANGE_CELLS;
  };
  for (let i = 0; i < boats.length; i++) {
    for (let j = i + 1; j < boats.length; j++) {
      const lower = boats[i];
      const upper = boats[j];
      const dx = upper.x - lower.x;
      const dy = upper.y - lower.y;
      const gap = Math.hypot(dx, dy);
      const clearance = 2 * BOAT_PERSONAL_SPACE_CELLS;
      if (gap >= clearance) continue;
      // The lower index moves along −d, the higher along +d. An exactly
      // coincident pair has no bearing, so it takes ±x off pair order —
      // deterministic, opposite sides, broken in one tick.
      const bearing = gap > 0 ? Math.atan2(dy, dx) : 0;
      const overlap = clearance - gap;
      const giveLower = Math.min(overlap / 2, pushLeft[i]);
      if (giveLower > 0) {
        const x = lower.x - Math.cos(bearing) * giveLower;
        const y = lower.y - Math.sin(bearing) * giveLower;
        // Each push commits only through the hull predicate, on the heading
        // the boat already has: a boat the coast pins stays, and the other
        // takes the whole separation. Same for engagement (keepsEngagement).
        if (
          isHullPose(world, eroded, x, y, lower.heading) &&
          keepsEngagement(lower, x, y)
        ) {
          lower.x = x;
          lower.y = y;
          pushLeft[i] -= giveLower;
        }
      }
      const giveUpper = Math.min(overlap / 2, pushLeft[j]);
      if (giveUpper > 0) {
        const x = upper.x + Math.cos(bearing) * giveUpper;
        const y = upper.y + Math.sin(bearing) * giveUpper;
        if (
          isHullPose(world, eroded, x, y, upper.heading) &&
          keepsEngagement(upper, x, y)
        ) {
          upper.x = x;
          upper.y = y;
          pushLeft[j] -= giveUpper;
        }
      }
    }
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
    dropVoyage(victim.id);
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
  for (const id of doomed) dropVoyage(id);
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

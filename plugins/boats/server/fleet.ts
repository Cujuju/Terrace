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
  HARBOUR_INSHORE_BAND_WORLD_UNITS,
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
/**
 * The tightest circle a hull may ever turn on, in cells — half a hull length,
 * the radius a rowed boat can manage with one oar backed and way barely on.
 * Bounds the turn per tick BY STRIDE (see `sailBoat`): a hull that has moved
 * `d` may have turned at most `d / this`, whatever the per-second cap allows,
 * which is what makes a pivot unproducible rather than merely avoided.
 */
const BOAT_TIGHTEST_TURN_RADIUS_CELLS = BOAT_HULL_LENGTH_CELLS / 2;

export const BOAT_TURN_RADIANS_PER_SECOND =
  BOAT_SPEED_CELLS_PER_SECOND / (BOAT_TURN_RADIUS_HULL_LENGTHS * BOAT_HULL_LENGTH_CELLS);

/**
 * How much way a hull keeps when it must turn to its aim, as a fraction of
 * its stride — ONE function for the routed and routeless branches, because
 * both steer the same hull round the same turning circle.
 *
 * Speed is this plugin's own (movement.md: a plugin owns its speed), but the
 * SHAPE is turning-circle physics, stated once: full way inside
 * STRIDE_FULL_WAY_CONE_RADIANS of the aim bearing, minimum way past
 * STRIDE_MIN_WAY_CONE_RADIANS, linear between.
 *
 * The full-way cone is one sweep step (π/4, shared's AVOID_TURN_STEP_RADIANS):
 * a misalignment that small is one ladder answer, and the turn limit eats it
 * in a tick or two while advancing — slowing for it only lengthens the leg.
 * Past the minimum-way cone (3π/4) the hull is sailing AWAY from its aim, and
 * anything below quarter way stops being steerage: the turn only happens by
 * moving, so a hull making no way never comes about. Quarter stride still
 * crosses a cell in ~1.1 s at cruise, inside BOAT_STUCK_SECONDS, so the stuck
 * clock keeps watching a hull that is merely coming about and fires only on
 * one that is wedged. The S-turn this shapes is the measure: full stride
 * through every bend traced ±11-cell excursions down a straight open-sea
 * corridor, and a 60-cell trip unfinished in 60 s.
 */
const STRIDE_FULL_WAY_CONE_RADIANS = Math.PI / 4;
const STRIDE_MIN_WAY_CONE_RADIANS = (3 * Math.PI) / 4;
/** Full way (no damping) and minimum way, as fractions of the stride. */
const STRIDE_FULL_FRACTION = 1;
const STRIDE_MIN_FRACTION = 0.25;

/** Fraction of its stride a hull makes at this misalignment to its aim. */
function strideFactorFor(misalignmentRadians: number): number {
  if (misalignmentRadians <= STRIDE_FULL_WAY_CONE_RADIANS) return STRIDE_FULL_FRACTION;
  if (misalignmentRadians >= STRIDE_MIN_WAY_CONE_RADIANS) return STRIDE_MIN_FRACTION;
  const coneSpan = STRIDE_MIN_WAY_CONE_RADIANS - STRIDE_FULL_WAY_CONE_RADIANS;
  const dropSpan = STRIDE_FULL_FRACTION - STRIDE_MIN_FRACTION;
  return STRIDE_FULL_FRACTION - dropSpan * ((misalignmentRadians - STRIDE_FULL_WAY_CONE_RADIANS) / coneSpan);
}

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
 * in BOAT_SHAPE.waterlineLift (client/models.ts:94). Same restatement justification as
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

/**
 * How far a hull is asked to be able to move, ahead or astern, for a pose to
 * count as one it can manoeuvre from — a quarter of a hull length, in cells.
 *
 * Not one tick's travel: it must not depend on `dt`, and it should cover a few
 * ticks of way so a hull is judged wedged while there is still room to do
 * something about it rather than at the last step.
 */
const HULL_SEA_ROOM_CELLS = BOAT_HULL_LENGTH_CELLS / 4;

/**
 * A pose a hull can occupy AND leave without pivoting: legal where it lies,
 * and legal one HULL_SEA_ROOM_CELLS ahead or one astern along its heading.
 *
 * WHY LEGALITY ALONE IS NOT ENOUGH (measured on the owner's world,
 * 2026-09-03). A hull can lie in a pocket exactly its own length — legal where
 * it is, illegal one step ahead AND one step astern. A boat that may not pivot
 * (owner rule) can only begin a turn by moving, so such a hull is wedged for
 * good: every restored boat sat in that pocket and none moved in three
 * minutes. So the places a boat is SENT to rest — moorings, station slots, the
 * cell a refloat kedges toward — are chosen with this predicate, and a hull
 * found wedged is kedged out by `refloat` exactly as one found aground is.
 *
 * The per-step gate stays `isHullPose`: a moving hull only ever needs the pose
 * it is about to take to be legal, and demanding sea room of every step made
 * arrivals refuse berths one step short (measured: the C-bay fleet never
 * engaged, and the rout slipped from 24 s to 29 s).
 *
 * `roomCells` is HULL_SEA_ROOM_CELLS for a place a boat is sent to REST, and
 * the tick's own step for the wedge test on a boat that is trying to SAIL —
 * the room a sailing hull needs is exactly the step it is about to take, and
 * a probe further out can be legal while the step itself is not (measured:
 * a hull judged roomy at a quarter length crawled 0.6 cells in a minute).
 */
function isManoeuvrablePose(
  world: BoatWorld,
  eroded: TerrainSampler,
  x: number,
  y: number,
  heading: number,
  roomCells: number = HULL_SEA_ROOM_CELLS,
): boolean {
  if (!isHullPose(world, eroded, x, y, heading)) return false;
  const dx = Math.cos(heading) * roomCells;
  const dy = Math.sin(heading) * roomCells;
  return (
    isHullPose(world, eroded, x + dx, y + dy, heading) ||
    isHullPose(world, eroded, x - dx, y - dy, heading)
  );
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
 * How far apart two home berths lie, in cells — THREE personal spaces, the
 * same margin station slots keep — and how far off the last berth a surplus
 * boat holds.
 *
 * Two (exactly clear) was tried first and measured on the owner's world,
 * 2026-09-03: two boats seated exactly one clearance apart sit ON the
 * resolution pass's threshold, so floating point decides every tick whether
 * they overlap, and the pass nudges them a few thousandths apart while their
 * berths pull them back — 1 400 of 1 800 ticks of sub-hundredth jitter on
 * one hull, with the heading wobbling to match. One clearance of slack beyond
 * clear makes a seated neighbour scenery, exactly as it does on the circle.
 */
const HOME_BERTH_CLEARANCE_CELLS = 3 * BOAT_PERSONAL_SPACE_CELLS;

/**
 * Berths a village's survey keeps — twice its own fleet.
 *
 * A village's berths are claimed CELL BY CELL across the whole fleet
 * (`homeBerthFor`), and neighbouring villages on one bay survey the same
 * water, so the nearest three are routinely a neighbour's by the time this
 * village's boats come home. The spare three are what those boats fall back
 * to instead of holding off a berth that will never free. Twice, not more:
 * the survey walks nearest-first and stops when it has them, so the cost is
 * a few more hull-pose tests per survey, on the survey's cadence.
 */
const MOORINGS_SURVEYED_PER_VILLAGE = 2 * BOATS_PER_VILLAGE;

/**
 * How far out from a village's own shoreline a war boat's berth must lie, in
 * cells — the floor of the OUTER harbour zone.
 *
 * DERIVED, NEVER TYPED, from three terms that each answer a separate question:
 *
 *   * `cellsAcross(HARBOUR_INSHORE_BAND_WORLD_UNITS)` — the inshore strip the
 *     skiffs own outright. See that constant in ../protocol.ts for the defect
 *     this partitions and why the band is 1.5 world units.
 *   * `BOAT_HULL_LENGTH_CELLS / 2` — a berthed boat lies on its face-home
 *     heading, so half its hull sticks back TOWARD the shore from the cell the
 *     survey picked. Without this term the strip is clear of berth CENTRES and
 *     not of hulls.
 *   * `BOAT_PERSONAL_SPACE_CELLS` — one margin, because the two plugins measure
 *     "nearest water" slightly differently and are entitled to: `isSailable`
 *     here admits raw height 0, structures' confirmed water needs band <= -1,
 *     and the client's drawn contour can differ from both again. The margin is
 *     what keeps a cell of disagreement from being a collision.
 *
 * Today that comes to 6 + 1.8 + 2 = 9.8 cells. It is a REAL distance and not a
 * cell count, so it is not rounded here; only the disc radius below ceils it.
 */
const BERTH_STANDOFF_CELLS =
  cellsAcross(HARBOUR_INSHORE_BAND_WORLD_UNITS) +
  BOAT_HULL_LENGTH_CELLS / 2 +
  BOAT_PERSONAL_SPACE_CELLS;

/**
 * How far the BERTH half of a survey walks, in cells.
 *
 * WIDER THAN THE COASTAL DISC, and it has to be: the coastal verdict looks
 * COASTAL_SEARCH_RADIUS_CELLS (16) out, but a village whose shore is already 12
 * cells away wants berths past 12 + 9.8 = 22 — outside that disc entirely, so
 * on the old radius such a village would find no berth and fall back every
 * time. The coastal/launch verdict itself is NOT widened (see `surveyedLaunch`):
 * what makes a settlement a fishing village is unchanged by this.
 */
const BERTH_SEARCH_RADIUS_CELLS = COASTAL_SEARCH_RADIUS_CELLS + Math.ceil(BERTH_STANDOFF_CELLS);

/**
 * How far the goal may drift before the route planned to it is stale, in
 * cells — two personal spaces (one whole hull). A kraken wandering inside
 * that does not change which way round a headland the fleet goes, so it
 * should not spend the fleet's routing budget finding out.
 */
const REPLAN_GOAL_DRIFT_CELLS = 2 * BOAT_PERSONAL_SPACE_CELLS;

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
   * Last tick's berth index, or null. The ONLY memory either assignment keeps:
   * preferring it is what stops two boats sharing a bearing boundary from
   * swapping slots every tick — and what keeps a boat on her mooring while a
   * sunk sister's replacement takes the free berth rather than hers. A berth
   * index IN WHICHEVER LIST the boat is currently assigned from (station
   * circle in a fight, home moorings in peacetime), and `slotList` names that
   * list: an index is only a preference for the list it came from. Without
   * the discriminator a boat leaving harbour from mooring 0 read that 0 as
   * station slot 0 — the east side of the kraken whatever side it approached
   * from — and sailed the long way round. Module state, never persisted — a
   * restored fleet replans from scratch, which is correct because the terrain
   * may have changed under the save.
   */
  slot: number | null;
  slotList: BerthList | null;
  /**
   * Consecutive sail ticks on which the follower moved the hull nowhere at all
   * — forward vetoed, astern vetoed. See HELD_TICKS_BEFORE_KEDGE.
   */
  heldTicks: number;
  /** Where the hull stood at the top of its last SAIL tick, for the held test. */
  sailedFrom: { x: number; y: number } | null;
  /** Seconds left of a crowd rest — see CROWD_REST_SECONDS. */
  restSeconds: number;
}

/**
 * How little a sailing hull may have moved over a whole tick — its own sail
 * step AND the resolution pass — before the tick counts as held: HALF the
 * smallest stride the sail path ever takes (STRIDE_MIN_FRACTION of a step).
 *
 * Every honest sail tick moves at least a full smallest stride, so a hull
 * under half of one has been put back where it started by the resolution
 * pass. Half, and not the stride itself: at exactly the stride a hull
 * bearing off at minimum way sits ON the threshold and floating point makes
 * it rest mid-passage (measured: the C-bay fleet stopped engaging). Not a
 * quarter either: that left a hull weaving 0.01–0.03 cells a tick in a crowd
 * for 700 ticks (owner's world, 2026-09-03). Half is the midpoint that
 * neither false-positives a slow honest tick nor misses a cancelled one.
 */
const HELD_DISPLACEMENT_FRACTION = STRIDE_MIN_FRACTION / 2;

/**
 * How long a hull held by a CROWD waits before trying again, in seconds.
 *
 * A hull that is on manoeuvrable water and still gets nowhere is being pushed
 * back by the resolution pass as fast as it sails — a neighbour sits between
 * it and its berth (measured on the owner's world, 2026-09-03: one hull
 * dithered ±0.05 rad a tick for three minutes, 4.00 cells off a seated
 * neighbour). Kedging cannot help — there is nothing wrong with the water —
 * so it rests: holds position, heading untouched, and retries after this
 * long. Five seconds is longer than a coming-about (~6 s is a full 180°;
 * most jams clear in a fraction of that) is short, and short enough that a
 * harbour that HAS cleared is not left with a boat idling for no reason.
 */
const CROWD_REST_SECONDS = 5;

/**
 * Sail ticks a hull may be held motionless before it is treated as wedged and
 * kedged out (`refloat`), whatever the pose predicates say about it.
 *
 * THE BELT TO isManoeuvrablePose's SUSPENDERS: that test asks about one step
 * dead ahead and dead astern on the current heading, and the follower's step
 * is taken on the ADOPTED heading, a turn-cap away — so a pose can pass the
 * test and still have every step it actually tries refused. Five ticks (half
 * a second at the shipped rate) is long enough that a hull merely waiting on a
 * crowd to clear is not mistaken for one that is stuck, and short enough that
 * a player never watches a boat sit against a shore.
 */
const HELD_TICKS_BEFORE_KEDGE = 5;

/** Which berth list a sticky slot index belongs to. */
type BerthList = 'station' | 'home';

const voyages = new Map<number, Voyage>();

/** Last tick's berth index for this boat, if it was taken from `list`. */
function stickySlotIn(boatId: number, list: BerthList): number | null {
  const voyage = voyages.get(boatId);
  if (voyage === undefined || voyage.slotList !== list) return null;
  return voyage.slot;
}

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
   * The cached answer from the survey's launch half — null for INLAND.
   * Meaningful only while `surveyedSeconds` is a number; see `surveyedLaunch`.
   */
  launch: KrakenTarget | null;
  /**
   * The cached answer from the survey's mooring half: one berth per boat, up
   * to BOATS_PER_VILLAGE, nearest-first over the SAME disc walk as `launch` —
   * each a hull-legal cell on the face-home heading, spaced
   * HOME_BERTH_CLEARANCE_CELLS from every berth already taken. "Where a boat
   * is built" (launchBerth launches onto the first free one), "where it
   * idles" and "where it returns to" (homeBerthFor assigns the k-th to the
   * k-th boat) are one fact. Empty with `launch` (inland), or when no hull
   * water exists. Invalidated by the same three paths as `launch` (sculpt,
   * chunk unlock, COASTAL_RESURVEY_SECONDS), because both halves read the same
   * water through the same clock.
   *
   * COST: the existing survey walk with one more predicate per candidate — a
   * hull pose plus a spacing check against at most BOATS_PER_VILLAGE taken
   * berths — on the survey's cadence. Never per boat per tick.
   */
  moorings: readonly KrakenTarget[];
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
  return { launch: null, moorings: [], surveyedSeconds: null, afloat: 0 };
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
 * Throws away the cached survey of every village whose survey disc contains a
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
    // BERTH_SEARCH_RADIUS_CELLS and not the coastal radius: the survey's berth
    // half walks the wider disc, so a sculpt out there changes its answer too.
    if (village.x + BERTH_SEARCH_RADIUS_CELLS < minX) continue;
    if (village.x - BERTH_SEARCH_RADIUS_CELLS > maxX) continue;
    if (village.y + BERTH_SEARCH_RADIUS_CELLS < minY) continue;
    if (village.y - BERTH_SEARCH_RADIUS_CELLS > maxY) continue;
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
 * Offsets of the BERTH search disc, nearest-first — the same tight-disc rule as
 * COASTAL_DISC (`dx² + dy² < r·(r−1)`, centre excluded, sorted by distance) at
 * BERTH_SEARCH_RADIUS_CELLS instead of COASTAL_SEARCH_RADIUS_CELLS.
 *
 * A SECOND DISC rather than a widened one, because the two halves of a survey
 * answer different questions: the coastal verdict must stay the set of
 * settlements structures gives a harbour to, and only the berth walk needs to
 * reach past the standoff. COST: about 2.6x COASTAL_DISC's cells (radius 26
 * against 16), walked on the survey cadence only — at most once per
 * COASTAL_RESURVEY_SECONDS per village, never per boat per tick.
 */
const BERTH_DISC: ReadonlyArray<readonly [number, number]> = (() => {
  const threshold = BERTH_SEARCH_RADIUS_CELLS * (BERTH_SEARCH_RADIUS_CELLS - 1);
  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -BERTH_SEARCH_RADIUS_CELLS; dy <= BERTH_SEARCH_RADIUS_CELLS; dy++) {
    for (let dx = -BERTH_SEARCH_RADIUS_CELLS; dx <= BERTH_SEARCH_RADIUS_CELLS; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (dx * dx + dy * dy < threshold) offsets.push([dx, dy]);
    }
  }
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
 * The first surveyed mooring of `village` that no boat is already sitting in,
 * or null when every one of them is taken.
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
 * The berths are the surveyed `moorings` — the SAME list home-bound boats
 * idle on — so "where a boat is built", "where it idles" and "where it
 * returns to" are one fact. No disc walk: the survey already walked it, on
 * the survey's cadence, and a launch that re-walked it could choose water the
 * idle assignment will never offer. No `world` parameter for the same reason:
 * every mooring was certified sailable and hull-legal by the survey.
 *
 * `occupied` is the live fleet, not a start-of-tick snapshot: two villages
 * sharing a bay may both launch on the same tick, and the second must see the
 * first one's new boat.
 */
export function launchBerth(
  village: Village,
  occupied: readonly Occupant[],
): KrakenTarget | null {
  const moorings = shipyards.get(villageKey(village.x, village.y))?.moorings ?? [];
  for (const mooring of moorings) {
    // The cell CENTRE is what the boat is placed on, and it is what the
    // clearance is measured from — the same point the resolution pass will
    // keep clear from the next tick onward.
    if (!isClearOfFleet(mooring.x, mooring.y, occupied)) continue;
    return { x: mooring.x, y: mooring.y };
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
 * This village's launch cell and home mooring, from the cache when the cache
 * is still good.
 *
 * A SURVEY IS RE-WALKED only when something could have changed its answer:
 * never taken, invalidated by a sculpt in its disc or by a chunk unlock (see
 * `resurveyShipyardsNear` / `resurveyAllShipyards`), or older than
 * COASTAL_RESURVEY_SECONDS. Between those it is a field read — which is what
 * lets home-bound boats read their mooring every tick without walking the
 * disc (the same defect issue #276 closed for villages: a 748-cell scan per
 * peacetime boat per tick).
 *
 * TWO WALKS, both nearest-first. The launch half walks COASTAL_DISC and keeps
 * `launchCell`'s bar (nearest sailable cell, valid once COASTAL_MIN_WATER_CELLS
 * of them exist). The mooring half walks the wider BERTH_DISC and takes every
 * hull-legal cell BEYOND BERTH_STANDOFF_CELLS from the shore, on the face-home
 * heading — the arrival heading a boat comes home on — that lies
 * HOME_BERTH_CLEARANCE_CELLS from every berth already taken, until
 * MOORINGS_SURVEYED_PER_VILLAGE are found or the disc is exhausted. The
 * standoff is what keeps war boats out of the skiffs' inshore strip; see
 * BERTH_STANDOFF_CELLS. The gate differs (centre-water versus hull), because the launch
 * cell is centre-water a hull length from a beach the planner refuses to
 * certify, so routing to it always fails — measured: 20-second coming-about
 * tours for a 3-cell trip home, and an orbit that never lands. The eroded
 * sampler is built inside this call: surveys are rare (one per
 * COASTAL_RESURVEY_SECONDS per village at most), so sharing the tick sampler
 * would mean threading it through `advanceShipyards`' exported signature for
 * no measurable gain.
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
  const eroded = withClearance(world, BOAT_BEAM_CLEARANCE_CELLS);

  // THE LAUNCH / COASTAL HALF, on COASTAL_DISC exactly as before: what makes a
  // settlement a fishing village is not changed by where its boats berth.
  let launch: KrakenTarget | null = null;
  let shoreCells = 0;
  let found = 0;
  for (const [dx, dy] of COASTAL_DISC) {
    const x = village.x + dx;
    const y = village.y + dy;
    if (!isSailable(world, x, y)) continue;
    found++;
    // COASTAL_DISC is sorted nearest-first, so the first hit is the closest.
    if (launch === null) {
      launch = { x, y };
      shoreCells = Math.sqrt(dx * dx + dy * dy);
    }
    // The remaining cells cannot change this half's answer.
    if (found >= COASTAL_MIN_WATER_CELLS) break;
  }

  // THE BERTH HALF, on the wider BERTH_DISC, zoned off this village's own
  // shoreline: a berth must lie at least BERTH_STANDOFF_CELLS beyond the
  // nearest water, which is the strip the skiffs orbit in. `shoreCells` is 0
  // for a village with no water in its coastal disc at all — there is no shore
  // to measure from, so the standoff is taken from the village itself.
  const moorings: KrakenTarget[] = [];
  const inshore: KrakenTarget[] = [];
  const berthFloorCells = shoreCells + BERTH_STANDOFF_CELLS;
  for (const [dx, dy] of BERTH_DISC) {
    const x = village.x + dx;
    const y = village.y + dy;
    if (!isSailable(world, x, y)) continue;
    const beyondStandoff = Math.sqrt(dx * dx + dy * dy) >= berthFloorCells;
    const zone = beyondStandoff ? moorings : inshore;
    if (zone.length >= MOORINGS_SURVEYED_PER_VILLAGE) continue;
    const faceHome = Math.atan2(village.y - y, village.x - x);
    const clearOfTaken = zone.every((berth) => {
      const dxb = x - berth.x;
      const dyb = y - berth.y;
      return dxb * dxb + dyb * dyb >= HOME_BERTH_CLEARANCE_CELLS * HOME_BERTH_CLEARANCE_CELLS;
    });
    if (clearOfTaken && isManoeuvrablePose(world, eroded, x, y, faceHome)) {
      zone.push({ x, y });
    }
    // Stop once the outer zone is full. The inshore list is only ever the
    // fallback below, so it never keeps the walk going on its own.
    if (moorings.length >= MOORINGS_SURVEYED_PER_VILLAGE) break;
  }

  // THE FALLBACK, named and bounded: a POCKET BAY — a village whose whole
  // BERTH_DISC holds no hull-legal, manoeuvrable cell beyond the standoff —
  // keeps berthing at the nearest legal cells, as it did before this rule. It
  // must, or its boats have nowhere to launch from and nowhere to return to,
  // which is a worse defect than crowding. THIS IS THE ONE PLACE war boats and
  // skiffs can still share water, and it fires only under that condition.
  shipyard.launch = found >= COASTAL_MIN_WATER_CELLS ? launch : null;
  shipyard.moorings = moorings.length > 0 ? moorings : inshore;
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

    // THE CACHED SURVEY, for every village every tick — not only the short
    // ones. Peacetime boats read their berths from it (see `assignHomeBerths`),
    // so it must stay warm even at strength; between re-walks it is a field
    // read. `launchCell` early-returns only once it has found
    // COASTAL_MIN_WATER_CELLS, so an INLAND village used to walk all of
    // COASTAL_DISC — every tick, forever, producing nothing.
    const launch = surveyedLaunch(world, village, shipyard, dt);
    if (shipyard.afloat >= BOATS_PER_VILLAGE) {
      village.rebuildSeconds = 0;
      continue;
    }
    // Inland, or its water is gone (a player filled the bay in): no progress,
    // and no partial build banked against the day the sea comes back.
    if (launch === null) {
      village.rebuildSeconds = 0;
      continue;
    }
    village.rebuildSeconds += dt;
    if (village.rebuildSeconds < BOAT_REBUILD_SECONDS) continue;

    const berth = launchBerth(village, fleetBerths());
    // The harbour is full: every surveyed berth has a boat on it. The finished
    // build STAYS BANKED (no subtraction, no reset) and the boat slides down
    // the ways on the first tick a berth clears — which is a second or two
    // later, as soon as the fleet ahead of it puts out. Launching anyway is
    // what put two hulls on one cell.
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
   * The slot index this goal is the point of, or null for a fallback, a
   * surplus hold, or a berthless (village-cell) goal. Carried so the next
   * tick's assignment can prefer it (stickiness) — on the station circle it
   * is an angle, not a point, so it tracks a drifting kraken automatically;
   * on the mooring list it is the berth that is hers.
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
    return isManoeuvrablePose(world, eroded, x, y, faceKraken) ? { x, y } : null;
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
    const prev = stickySlotIn(boat.id, 'station');
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
 * This boat's home berth for this tick: the k-th mooring for the k-th boat of
 * its village in `boats` array order — the home-water twin of the station
 * rule, and the fix for the peacetime roam.
 *
 * EVERY BOAT OF A VILLAGE USED TO BE GIVEN THE SAME GOAL — the one surveyed
 * mooring cell. The first boat to arrive held it and every heading that would
 * land the others there was vetoed by separation against her, so they
 * deflected, replanned, and circled the mooring for the life of the world:
 * the identical shape to the station-circle stacking the slots fixed, a
 * shared goal point for several hulls, with the same fix. Each boat is now
 * given her OWN point, so keeping clear of a neighbour never costs her home.
 *
 * In `boats` array order (fixed): each boat takes the k-th mooring for her
 * village-order position k, preferring last tick's berth while it is still a
 * berth of her village and still free (`voyage.slot`, the same sticky field
 * the station path keeps — a berth index in whichever list she is currently
 * assigned from). A village with fewer moorings than boats gives the surplus
 * boats the LAST mooring with a HOME_BERTH_CLEARANCE_CELLS standoff: they
 * hold off it rather than fight its owner for it. Order-priority keeps every
 * branch convergent: boats are seated in fixed array order, so an earlier
 * boat never yields to a later one. Deterministic by construction — no clock,
 * no RNG, fixed order — per-tick and never persisted.
 *
 * Returns null for an engaged boat: she sails under station rules, not home
 * ones, and the station path owns her goal AND her slot memory for the whole
 * fight. `taken` carries every berth an earlier boat claimed this tick,
 * across all villages: two villages sharing a bay survey overlapping mooring
 * lists, and a berth within clearance of one claimed by either is claimed for
 * both. Keyed per village
 * it was not (measured live, 2026-09-03): boats of neighbouring villages were
 * sent to the same cell, converged, were pushed apart by the resolution pass
 * and converged again every tick — a jitter that read as a pivot.
 */
function homeBerthFor(
  index: number,
  kraken: KrakenTarget | null,
  taken: KrakenTarget[],
): StationGoal | null {
  const boat = boats[index];
  if (targetFor(boat, kraken) !== null) return null;
  const key = villageKey(boat.homeX, boat.homeY);
  const moorings = shipyards.get(key)?.moorings ?? [];
  // No berths at all — filled bay, or inland: the village itself, an
  // unreachable goal the boat presses toward until hull law stops it.
  if (moorings.length === 0) {
    return { x: boat.homeX, y: boat.homeY, standoff: 0, slot: null };
  }
  // A berth is free only if it is a whole clearance from every berth already
  // claimed this tick, by ANY village. Cell identity was not enough (measured
  // live, 2026-09-03): two villages' lists held different cells three cells
  // apart, both boats seated, and the resolution pass shoved them a hair apart
  // every tick while their berths pulled them back — sub-hundredth jitter for
  // the life of the world.
  const isFree = (berth: KrakenTarget): boolean =>
    taken.every((held) => {
      const dx = berth.x - held.x;
      const dy = berth.y - held.y;
      return dx * dx + dy * dy >= HOME_BERTH_CLEARANCE_CELLS * HOME_BERTH_CLEARANCE_CELLS;
    });
  // STICKINESS. The guard matters across the peace/war boundary: a station
  // slot index can exceed this list, and a stale one must fall through to
  // the k-th berth rather than off the end of it.
  const prev = stickySlotIn(boat.id, 'home');
  if (prev !== null && prev >= 0 && prev < moorings.length && isFree(moorings[prev])) {
    taken.push(moorings[prev]);
    const berth = moorings[prev];
    return { x: berth.x, y: berth.y, standoff: 0, slot: prev };
  }
  // Otherwise the k-th berth for the k-th boat of this village: `k` counts
  // only earlier boats of the SAME village.
  let k = 0;
  for (let j = 0; j < index; j++) {
    if (boats[j].homeX === boat.homeX && boats[j].homeY === boat.homeY) k++;
  }
  // More boats than berths: hold off the last one at exactly clear.
  // Unclaimed and slotless, so every surplus boat recomputes the same hold
  // every tick instead of queuing on a berth that will never free.
  if (k >= moorings.length) {
    const berth = moorings[moorings.length - 1];
    return { x: berth.x, y: berth.y, standoff: HOME_BERTH_CLEARANCE_CELLS, slot: null };
  }
  // The k-th berth may be sticky-held by an earlier boat (a sunk boat's
  // replacement arrives with no memory while the survivors keep theirs):
  // search outward from k alternating +1/−1, the same spiral the station
  // path searches from its base bearing, and take the nearest free berth.
  for (let n = 0; n < moorings.length; n++) {
    const off = n === 0 ? 0 : n % 2 === 1 ? (n + 1) / 2 : -(n / 2);
    const slot = k + off;
    if (slot < 0 || slot >= moorings.length || !isFree(moorings[slot])) continue;
    taken.push(moorings[slot]);
    const berth = moorings[slot];
    return { x: berth.x, y: berth.y, standoff: 0, slot };
  }
  // Every berth sticky-held by earlier boats (a harbour fuller than its
  // survey): hold off the last one like any other surplus boat.
  const berth = moorings[moorings.length - 1];
  return { x: berth.x, y: berth.y, standoff: HOME_BERTH_CLEARANCE_CELLS, slot: null };
}

/**
 * Every peacetime boat's home berth for this tick, keyed by boat index —
 * assigned from start-of-tick state before anyone moves, the way station
 * slots are. Engaged boats are absent (the station map seats them); a missing
 * entry at sail time can only mean a mid-tick roster change.
 */
function assignHomeBerths(kraken: KrakenTarget | null): Map<number, StationGoal> {
  const goals = new Map<number, StationGoal>();
  const taken: KrakenTarget[] = [];
  for (let index = 0; index < boats.length; index++) {
    const goal = homeBerthFor(index, kraken, taken);
    if (goal !== null) goals.set(index, goal);
  }
  return goals;
}

/**
 * This village's surveyed berths, nearest-first — a read of the survey cache
 * for tooling that reasons about where boats idle (the peacetime trace).
 * Empty before the first survey or when no hull water exists.
 */
export function villageMoorings(homeX: number, homeY: number): readonly KrakenTarget[] {
  return shipyards.get(villageKey(homeX, homeY))?.moorings ?? [];
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
 * One tick's shared sailing state: everything every boat sails from, built
 * once in `advanceFleet` so each hull reads the same snapshots. The berth
 * list parallels `boats` (start-of-tick positions, for order-independent
 * separation) and the routing pool is spent by the whole fleet's tick.
 */
interface SailTick {
  world: BoatWorld;
  eroded: TerrainSampler;
  kraken: KrakenTarget | null;
  dt: number;
  step: number;
  lookahead: number;
  maxTurnRadians: number;
  stationRadius: number;
  budget: RouteBudget;
  berths: readonly Occupant[];
  krakenOccupant: Occupant | null;
  goals: Map<number, StationGoal>;
  homeGoals: Map<number, StationGoal>;
}

/**
 * Sails one boat for one tick: goal, hold-or-sail, plan/replan, follow,
 * commit.
 *
 * One loop body, extracted so `advanceFleet` reads as the tick's shape — no
 * behaviour change in the split. Goal selection (slot, fallback, or home
 * berth), the holding branches, the voyage's single plan per tick, the stride
 * cap, and the followRoute sail-and-commit all live here. `index` is into
 * `boats` (and parallel `tick.berths`), stable for the whole sail pass — the
 * roster only changes in the fight, after.
 */
/**
 * Hauls a hull that is NOT on a legal pose toward the nearest cell where it
 * would be — kedging off, in a sailor's word: no turn, no sail, one step of
 * travel per tick straight at the nearest hull-legal water.
 *
 * WHY A HULL CAN BE SOMEWHERE IT MAY NOT BE. Two ways, and neither is a bug in
 * the sail step: a fleet SAVED under the old point-boat rules sits on the old
 * launch cells, which are the nearest water to each village and therefore
 * shore-adjacent — illegal for a hull with a beam (measured on the owner's
 * world, 2026-09-03: 78 of 78 restored boats); and a player can raise the
 * seabed under a moored boat. Left to the ordinary sail path such a hull is
 * held forever: no route plans from an illegal cell, and the one-step probe
 * toward the goal is refused because the hull is refused where it already is.
 *
 * NEAREST-FIRST over COASTAL_DISC (already sorted by distance), tested on the
 * hull's CURRENT heading so the pose it lands in is one it may hold without
 * turning. Heading is untouched throughout — the hull slides, it does not
 * pivot — and a hull with no legal water inside the disc holds where it is,
 * which is the one honest answer for a boat in a filled-in bay.
 */
function refloat(world: BoatWorld, eroded: TerrainSampler, boat: Boat, step: number): void {
  const originX = Math.floor(boat.x);
  const originY = Math.floor(boat.y);
  for (const [dx, dy] of COASTAL_DISC) {
    const targetX = originX + dx + CELL_CENTRE_OFFSET;
    const targetY = originY + dy + CELL_CENTRE_OFFSET;
    if (!isManoeuvrablePose(world, eroded, targetX, targetY, boat.heading)) continue;
    const range = distance(boat.x, boat.y, targetX, targetY);
    if (range <= step) {
      boat.x = targetX;
      boat.y = targetY;
    } else {
      boat.x += ((targetX - boat.x) / range) * step;
      boat.y += ((targetY - boat.y) / range) * step;
    }
    return;
  }
}

/** Half a cell: a cell's centre, where a refloated hull is placed. */
const CELL_CENTRE_OFFSET = 0.5;

function sailBoat(tick: SailTick, index: number): void {
  const {
    world,
    eroded,
    kraken,
    dt,
    step,
    lookahead,
    maxTurnRadians,
    stationRadius,
    budget,
    berths,
    krakenOccupant,
    goals,
    homeGoals,
  } = tick;
  const boat = boats[index];
  // A hull that may not be where it is — or that is legal but WEDGED, unable
  // to move ahead or astern (isManoeuvrablePose) — does nothing else this tick:
  // it kedges toward water it can manoeuvre in (see `refloat`) and rejoins the
  // ordinary sail path once it is somewhere a route can start from.
  const earlier = voyages.get(boat.id);
  if (earlier !== undefined && earlier.sailedFrom !== null) {
    // The held test covers the WHOLE last tick — sail step plus resolution
    // pass — by measuring from where the hull stood at the top of it.
    const moved = distance(boat.x, boat.y, earlier.sailedFrom.x, earlier.sailedFrom.y);
    earlier.heldTicks = moved < step * HELD_DISPLACEMENT_FRACTION ? earlier.heldTicks + 1 : 0;
    earlier.sailedFrom = null;
  }
  const manoeuvrable = isManoeuvrablePose(world, eroded, boat.x, boat.y, boat.heading, step);
  if (!manoeuvrable) {
    boat.fighting = false;
    refloat(world, eroded, boat, step);
    if (earlier !== undefined) earlier.heldTicks = 0;
    return;
  }
  if (earlier !== undefined && earlier.heldTicks >= HELD_TICKS_BEFORE_KEDGE) {
    // Held on good water: a crowd, not a shore. Rest (see CROWD_REST_SECONDS).
    earlier.heldTicks = 0;
    earlier.restSeconds = CROWD_REST_SECONDS;
  }
  if (earlier !== undefined && earlier.restSeconds > 0) {
    earlier.restSeconds -= dt;
    boat.fighting = targetFor(boat, kraken) !== null &&
      distance(boat.x, boat.y, kraken!.x, kraken!.y) <= BOAT_ENGAGEMENT_RANGE_CELLS;
    return;
  }
  const target = targetFor(boat, kraken);
  // An engaged boat sails for its slot; a slotless one for the kraken with
  // a standoff; a peacetime boat for her OWN berth, stopping on it.
  // assignStationGoals seats every targeted boat (falling back to the
  // kraken itself), and assignHomeBerths seats every peacetime one (falling
  // back to the village itself), so a missing entry can only mean a mid-tick
  // roster change — sail at the animal, or hold the village, rather than hold
  // forever.
  let goalX: number;
  let goalY: number;
  let standoff: number;
  let slotIndex: number | null;
  // Which list `slotIndex` indexes, so next tick's stickiness reads it against
  // the right one (see Voyage.slotList).
  const slotList: BerthList = target === null ? 'home' : 'station';
  if (target === null) {
    const home = homeGoals.get(index);
    goalX = home?.x ?? boat.homeX;
    goalY = home?.y ?? boat.homeY;
    standoff = home?.standoff ?? 0;
    slotIndex = home?.slot ?? null;
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
      voyage.slotList = slotList;
    }
  };
  // WITHIN ONE STEP OF THE STANDOFF COUNTS AS ON IT. Creeping the last fraction
  // of a cell onto a stand-off circle made a stride of a few thousandths, and a
  // heading that turned the full per-tick cap over it — a pivot in every way a
  // player can see (measured live, 2026-09-03: hulls turning 0.25 rad per
  // broadcast with no visible displacement, all of them surplus boats holding
  // off a shared mooring). A hull one step short of arm's length is there.
  //
  // A SURPLUS BOAT'S HOLD IS A BAND, NOT A LINE: several boats holding off
  // the same last berth would otherwise be pushed apart by the resolution pass
  // and sail straight back to the line, every tick. Within one clearance of
  // arm's length is close enough to be home.
  const holdSlack = standoff === 0 ? 0 : target === null ? HOME_BERTH_CLEARANCE_CELLS : step;
  if (range <= standoff + holdSlack) {
    settle(goalX, goalY);
    return;
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
    return;
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
    return;
  }

  // The voyage: plan when there is no route, the goal drifted further than
  // REPLAN_GOAL_DRIFT_CELLS from the planned one, or the stuck clock fired —
  // never more than one plan per boat per tick, every plan drawing from the
  // fleet's shared pool.
  //
  // The balance-point escape that used to live here — replanning from open
  // water beside a stalled hull — went with the plugin-level post-commit veto
  // whose oscillation against followRoute's astern was its stated cause. The
  // contract now judges every step at the heading the hull will actually hold
  // (adopted forward, current astern), so that oscillation is gone. If a
  // stalled hull reproduces on the C-bay, the fix goes back into the contract
  // — not here.
  if (voyage === undefined) {
    voyage = {
      route: null,
      routeIndex: 0,
      goalX,
      goalY,
      noProgressSeconds: 0,
      slot: null,
      slotList: null,
      heldTicks: 0,
      sailedFrom: null,
      restSeconds: 0,
    };
    voyages.set(boat.id, voyage);
  }
  if (
    voyage.route === null ||
    distance(goalX, goalY, voyage.goalX, voyage.goalY) > REPLAN_GOAL_DRIFT_CELLS ||
    voyage.noProgressSeconds > BOAT_STUCK_SECONDS
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
  voyage.slotList = slotList;

  // STRIDE, not just heading: BEAR OFF WAY TO COME ABOUT. The hull turns at a
  // fixed rate, so the tighter it must turn the slower it must go: at full
  // stride every bend becomes a turning-diameter excursion (measured solo:
  // ±11-cell S-turns down a straight open-sea corridor, a 60-cell trip
  // unfinished in 60 s). The bearing steered by is the cell the follower is
  // actually steering for (shared picks the farthest legal of
  // route[i+1..i+aim], so aiming BOAT_AIM_AHEAD_CELLS out steers by the same
  // water) — NOT the far goal, which stands abeam down every corridor leg and
  // would halve speed for the whole leg. On the final cell the bearing is the
  // deck under its feet, so the factor is full way and the arrival keeps way
  // on. The turn itself is untouched (maxTurnRadians still caps every tick) —
  // only the advance slows, which is backing water, never a pivot: the boat
  // still moves every sail tick.
  //
  // Never overshoot the standoff either: a boat closing on its station stops
  // on it rather than sailing past and turning back forever. The cap is ALSO
  // the distance separation is judged at (shared's stepCells) — a boat easing
  // onto its station is judged against the short step it is really taking,
  // not a full tick of travel it is not.
  let aimBearing: number;
  if (voyage.route !== null) {
    const aimIndex = Math.min(
      voyage.routeIndex + BOAT_AIM_AHEAD_CELLS,
      voyage.route.length - 1,
    );
    aimBearing =
      aimIndex > voyage.routeIndex
        ? Math.atan2(
            voyage.route[aimIndex].y + 0.5 - boat.y,
            voyage.route[aimIndex].x + 0.5 - boat.x,
          )
        : boat.heading;
  } else {
    aimBearing = Math.atan2(goalY - boat.y, goalX - boat.x);
  }
  const advance = strideFactorFor(Math.abs(normalizeAngle(aimBearing - boat.heading)));
  const stride = Math.min(step, range - standoff) * advance;
  // THE TURN IS BOUGHT WITH THE STRIDE. The per-second cap is the turning circle
  // at cruise; at a shorter stride the hull may still not swing more than its
  // tightest circle allows over the distance actually travelled — so a stride
  // of nothing turns nothing, and a pivot cannot be produced by any stride the
  // arithmetic above can hand down. The belt to the hold above.
  const turnThisTick = Math.min(maxTurnRadians, stride / BOAT_TIGHTEST_TURN_RADIUS_CELLS);
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
      return;
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
    // Hull law at the step point, judged AT THE HEADING followRoute passes —
    // the candidate heading in the sweep, the adopted heading for the
    // turn-limited step, the current heading astern, the sail bearing in the
    // aim-ahead loop (shared's permits contract) — so the pose certified is
    // the pose the hull will actually hold, and no second veto is needed after
    // the commit. (An earlier revision checked the whole one-tick turn
    // envelope here; it flickered pass/fail on 0.03-cell margins at headings
    // the hull never adopts and trapped boats against walls they were
    // clearing — reverted.) The unlocked half is a fog-of-war fact with no
    // business in shared/ — it rides inside isHullPose.
    permits: (x, y, heading) => isHullPose(world, eroded, x, y, heading),
    // BOTH turn options at cruise, per Phase 1's finding: a turn limit alone
    // orbits a 1-cell waypoint, so the follower also aims ahead
    // (BOAT_AIM_AHEAD_CELLS) to trace a smooth arc through the route's
    // 8-direction jag. Rejoining a cut corner is the contract's own re-sync
    // (shared's ROUTE_REJOIN_RADIUS_CELLS) — not a callsite aim.
    maxTurnRadians: turnThisTick,
    aimAheadCells: BOAT_AIM_AHEAD_CELLS,
    // followRoute's own single-replan safety is capped at what the shared
    // pool still holds: it can spend the remainder, never more.
    replanNodeBudget: budget.remaining,
  });
  // followRoute's commit is the ONLY heading write on a hull: the turn only
  // ever happens by moving (a blocked clamp holds or backs astern with the
  // heading unchanged — it never pivots), so carrying all three fields across
  // is carrying one certified decision, not three. Every step of it was judged
  // at the heading the hull holds — adopted forward, current astern — so the
  // plugin-level second veto and its own astern are gone: followRoute's own
  // astern is the one backing manoeuvre.
  // Where this sail tick started, for next tick's held test (the resolution
  // pass has not run yet, so the test cannot be taken here).
  voyage.sailedFrom = { x: boat.x, y: boat.y };
  boat.heading = helm.heading;
  boat.x = helm.x;
  boat.y = helm.y;
  voyage.route = helm.route;
  voyage.routeIndex = helm.routeIndex;
  if (result.replanned || result.progressed) voyage.noProgressSeconds = 0;
  else voyage.noProgressSeconds += dt;
}

/**
 * Pushes apart hulls that ended the sail pass nearer than two personal
 * spaces — belt to the slots' suspenders.
 *
 * The slot spacing seats neighbours a full step beyond clear, so for a fleet
 * at station this pass is a no-op by construction; it exists for transit
 * crossings only, where two hulls closing head-on can end a tick nearer than
 * their combined radii (shared's steering works from a start-of-tick
 * snapshot, so it judges where the other boat WAS). One pass in index order
 * over pairs (i < j): hulls closer than two personal spaces are pushed half
 * the overlap each, directly apart. Headings never change here, and each
 * boat's push is capped at one step per tick, so a resolution cannot teleport.
 */
function resolveOverlaps(
  world: BoatWorld,
  eroded: TerrainSampler,
  kraken: KrakenTarget | null,
  step: number,
): void {
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
}

/**
 * Advances every boat by `dt`, and the fight with them.
 *
 * THE TICK'S SHAPE: shipyards, wind, goals, sail, resolve, fight — the bodies
 * live in `sailBoat` and `resolveOverlaps` above.
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
  // Home berths, assigned the same way from each village's own surveyed list.
  const homeGoals = assignHomeBerths(kraken);

  // One tick's shared sailing state: every boat sails from the same snapshots.
  const tick: SailTick = {
    world,
    eroded,
    kraken,
    dt,
    step,
    lookahead,
    maxTurnRadians,
    stationRadius,
    budget,
    berths,
    krakenOccupant,
    goals,
    homeGoals,
  };

  let engaged = 0;
  for (let index = 0; index < boats.length; index++) {
    sailBoat(tick, index);
    if (boats[index].fighting) engaged++;
  }

  resolveOverlaps(world, eroded, kraken, step);

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

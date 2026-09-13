import {
  MAX_DEBUG_SAILED_CELLS_PER_CHAIN,
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  OPEN_WATER_PROFILE,
  ROUTE_NODE_BUDGET,
  WORLD_UNIT_CELLS,
  buildWaypointChain,
  cellsAcross,
  createRouteBudget,
  findRouteWithStatus,
  followRoute,
  isWalkableCell as sharedIsWalkableCell,
  labelSeaRegions,
  navigableWaterProfile,
  nearestWithinReach,
  normalizeAngle,
  regionAt,
  snapWaypointToWalkable,
  waypointForMember,
  withClearance,
  withoutSelf,
  type Occupant,
  type RouteBudget,
  type RouteCell,
  type SeaRegions,
  type TerrainSampler,
  type Waypoint,
  type WaypointChainSnapshot,
  type WaypointDebugFrame,
} from '@terrace/shared';
import {
  severityAt,
  tangentialWindAt,
  type ParsedStormDamage,
} from '../../../server/src/plugins/kit/rotatingStormDamage.ts';
import {
  isPerfLoggingEnabled,
  perfLogLine,
} from '../../../server/src/plugins/kit/perf-logging.ts';
import {
  BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND,
  BOAT_WIND_PUSH_STEP_CELLS,
} from './cyclone-event.ts';
import {
  HOME_GUARD_BOATS_PER_VILLAGE,
  SQUADRON_LEG_LENGTH_CELLS,
  SQUADRON_LEG_MIN_LENGTH_CELLS,
  SQUADRON_MUSTER_RADIUS_CELLS,
  SQUADRON_WAYPOINT_ATTEMPTS,
  advanceSquadrons,
  formationStats,
  hashCell,
  replanSquadronLeg,
  resetSquadrons,
  squadronCount,
  squadronMembers,
  squadronOf,
  type SquadronBoat,
  type SquadronNavigator,
  type SquadronWaypoint,
} from './squadrons.ts';
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

export interface BoatWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

function isUnlockedCellInWorld(world: BoatWorld, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  return world.isCellUnlocked(x, y);
}

export interface Village {
  readonly x: number;
  readonly y: number;
  rebuildSeconds: number;
}

export interface Boat {
  readonly id: number;
  readonly homeX: number;
  readonly homeY: number;
  x: number;
  y: number;
  heading: number;
  fighting: boolean;
}

export interface KrakenTarget {
  readonly x: number;
  readonly y: number;
}

export const BOAT_PERSONAL_SPACE_CELLS = cellsAcross(0.5);

/** Cruiser legs split into hops of at most this span. Short hops fit one
 * budgeted trial search AND keep the search box hugging the leg, so coastal
 * detours stay inside the box instead of exhausting it; a whole 256-512
 * cell leg never could. */
const FLEET_HOP_LENGTH_CELLS = 48;

/** Cap for one leg-level route search when a fleet (re)builds its chain.
 * One routed leg subdivides into walkable-by-construction hops, so this
 * single search amortizes over the whole leg lifetime. One attempt per tick. */
const LEG_ROUTE_NODE_CAP = 32768;

/** Seconds a flagship goes without holding any route before its cruising
 * leg is declared blocked and re-planned from where it sits. Some legs
 * point across water that only connects via detours no boxed search can
 * fit; facing another spoke beats retrying the same span forever. */
const SQUADRON_LEG_STALE_SECONDS = 60;

/** Lattice spacing between station slots around a fleet hop. Rank 0 is the
 * flagship on the hop; the rest fan out instead of stacking. */
const FLEET_FORMATION_SPACING_CELLS = 3 * BOAT_PERSONAL_SPACE_CELLS;

/** Adoption radius for a shared fleet route: members farther than this from
 * every shared cell fall back to their own search. */
const FLEET_ROUTE_REJOIN_CELLS = 8;

/** Snap radius for blind chain points and formation slots: hops and berths
 * land on the nearest sailable cell within this many cells, so a leg drawn
 * across a peninsula still aims at water. Anything farther out keeps the old
 * direct-steer fallback rather than dragging the aim across the map. */
const FLEET_SNAP_RADIUS_CELLS = 12;

/** Cohesion margin around the flagship: members this far ahead slow down to
 * let the fleet catch up, and the flagship slows when its worst straggler
 * trails beyond it. Full hold at twice the margin. Sized to clear formation
 * slots plus snap drift, so holding station never reads as straggling. */
const FLEET_COHESION_MARGIN_CELLS = 24;

function cohesionSlowdown(offsetCells: number): number {
  if (offsetCells <= FLEET_COHESION_MARGIN_CELLS) return 1;
  if (offsetCells >= FLEET_COHESION_MARGIN_CELLS * 2) return 0;
  return 1 - (offsetCells - FLEET_COHESION_MARGIN_CELLS) / FLEET_COHESION_MARGIN_CELLS;
}

/** Speed factor keeping a fleet together. Members ahead of the flagship along
 * the fleet bearing ease off; the flagship eases off for stragglers behind.
 * No hard gate: one stuck boat slows its fleet, never freezes it. */
function fleetCohesion(boat: Boat, squadronId: number, goalX: number, goalY: number): number {
  const members = squadronMembers(squadronId);
  if (members.length < 2) return 1;
  const flagship = boatPosition(members[0]);
  if (flagship === null) return 1;
  let dx = goalX - flagship.x;
  let dy = goalY - flagship.y;
  let length = Math.hypot(dx, dy);
  if (length <= 0) {
    dx = boat.x - flagship.x;
    dy = boat.y - flagship.y;
    length = Math.hypot(dx, dy);
    if (length <= 0) return 1;
  }
  dx /= length;
  dy /= length;
  if (boat.id === members[0]) {
    let worstBehind = 0;
    for (const id of members) {
      if (id === boat.id) continue;
      const pos = boatPosition(id);
      if (pos === null) continue;
      const behind = -((pos.x - flagship.x) * dx + (pos.y - flagship.y) * dy);
      if (behind > worstBehind) worstBehind = behind;
    }
    return cohesionSlowdown(worstBehind);
  }
  const ahead = (boat.x - flagship.x) * dx + (boat.y - flagship.y) * dy;
  return cohesionSlowdown(ahead);
}

interface FleetChain {
  legX: number;
  legY: number;
  points: Waypoint[];
  index: number;
}

const fleetChains = new Map<number, FleetChain>();

/** Last successful hop search per squadron, shared fleet-wide across ticks.
 * The flagship writes it when its search lands; every member adopts from it
 * instead of searching. Keyed by squadron; entries die with their chain, so
 * a hop change can never serve a previous hop's cells. */
const fleetSharedRoutes = new Map<number, { hopX: number; hopY: number; cells: RouteCell[] }>();

/** Last searched hop route per squadron, for the `?waypoints` overlay's sailed
 * lines. Written at the end of every tick from that tick's shared searches;
 * entries for dissolved squadrons are pruned alongside the chains. Debug
 * only: steering reads voyage routes, never this map. */
const lastSailedBySquadron = new Map<number, readonly RouteCell[] | null>();

function nearestRouteIndex(
  cells: readonly RouteCell[],
  x: number,
  y: number,
  capCells: number,
): number {
  let best = 0;
  let bestSquared = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const dx = cells[i].x + 0.5 - x;
    const dy = cells[i].y + 0.5 - y;
    const d = dx * dx + dy * dy;
    if (d < bestSquared) {
      bestSquared = d;
      best = i;
    }
  }
  return bestSquared <= capCells * capCells ? best : 0;
}

const BOAT_LOOKAHEAD_SECONDS = 1;

const BOAT_HULL_LENGTH_CELLS = cellsAcross(0.9);

const BOAT_TURN_RADIUS_HULL_LENGTHS = 2;

const BOAT_TIGHTEST_TURN_RADIUS_CELLS = BOAT_HULL_LENGTH_CELLS / 2;

export const BOAT_TURN_RADIANS_PER_SECOND =
  BOAT_SPEED_CELLS_PER_SECOND / (BOAT_TURN_RADIUS_HULL_LENGTHS * BOAT_HULL_LENGTH_CELLS);

const STRIDE_FULL_WAY_CONE_RADIANS = Math.PI / 4;
const STRIDE_MIN_WAY_CONE_RADIANS = (3 * Math.PI) / 4;
const STRIDE_FULL_FRACTION = 1;
const STRIDE_MIN_FRACTION = 0.25;

function strideFactorFor(misalignmentRadians: number): number {
  if (misalignmentRadians <= STRIDE_FULL_WAY_CONE_RADIANS) return STRIDE_FULL_FRACTION;
  if (misalignmentRadians >= STRIDE_MIN_WAY_CONE_RADIANS) return STRIDE_MIN_FRACTION;
  const coneSpan = STRIDE_MIN_WAY_CONE_RADIANS - STRIDE_FULL_WAY_CONE_RADIANS;
  const dropSpan = STRIDE_FULL_FRACTION - STRIDE_MIN_FRACTION;
  return STRIDE_FULL_FRACTION - dropSpan * ((misalignmentRadians - STRIDE_FULL_WAY_CONE_RADIANS) / coneSpan);
}

const BOAT_HULL_DEPTH = 0.2;

const BOAT_WATERLINE_BITE = 0.55;

export const BOAT_DRAFT_HEIGHT_UNITS = Math.floor(
  ((BOAT_HULL_DEPTH * BOAT_WATERLINE_BITE) * MAX_HEIGHT) / MAX_RELIEF_WORLD_UNITS,
);

export const HULL_PROFILE = navigableWaterProfile(BOAT_DRAFT_HEIGHT_UNITS);

const BOAT_HULL_BEAM = 0.34;

export const BOAT_BEAM_CLEARANCE_CELLS = Math.ceil((BOAT_HULL_BEAM / 2) * WORLD_UNIT_CELLS);

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
    if (!isUnlockedCellInWorld(world, Math.floor(probeX), Math.floor(probeY))) return false;
    if (!sharedIsWalkableCell(eroded, HULL_PROFILE, probeX, probeY)) return false;
  }
  return true;
}

const HULL_SEA_ROOM_CELLS = BOAT_HULL_LENGTH_CELLS / 4;

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

const STATION_MARGIN_TICKS = 1;

export function boatStationRadiusCells(dt: number): number {
  return BOAT_ENGAGEMENT_RANGE_CELLS - BOAT_SPEED_CELLS_PER_SECOND * dt * STATION_MARGIN_TICKS;
}

function slotSpacingRadians(stationRadiusCells: number): number {
  return (3 * BOAT_PERSONAL_SPACE_CELLS) / stationRadiusCells;
}

function slotCountFor(stationRadiusCells: number): number {
  return Math.max(1, Math.floor((2 * Math.PI) / slotSpacingRadians(stationRadiusCells)));
}

const HOME_BERTH_CLEARANCE_CELLS = 3 * BOAT_PERSONAL_SPACE_CELLS;

const MOORINGS_SURVEYED_PER_VILLAGE = 2 * BOATS_PER_VILLAGE;

const BERTH_STANDOFF_CELLS =
  cellsAcross(HARBOUR_INSHORE_BAND_WORLD_UNITS) +
  BOAT_HULL_LENGTH_CELLS / 2 +
  BOAT_PERSONAL_SPACE_CELLS;

const BERTH_SEARCH_RADIUS_CELLS = COASTAL_SEARCH_RADIUS_CELLS + Math.ceil(BERTH_STANDOFF_CELLS);

const REPLAN_GOAL_DRIFT_CELLS = 2 * BOAT_PERSONAL_SPACE_CELLS;

const BOAT_STUCK_SECONDS = 8;

export const BOAT_AIM_AHEAD_CELLS = Math.ceil(2 * BOAT_HULL_LENGTH_CELLS);

const KRAKEN_BODY_RADIUS_CELLS = cellsAcross(7) / 2;

interface Voyage {
  route: RouteCell[] | null;
  routeIndex: number;
  goalX: number;
  goalY: number;
  noProgressSeconds: number;
  /** Seconds since any route was held. Direct-steer creep counts as progress
   * for stuck detection but never produces a route; without this, a boat
   * creeping along a shore never escalates to rescue. */
  nullSeconds: number;
  poolTried: boolean;
  slot: number | null;
  slotList: BerthList | null;
  heldTicks: number;
  sailedFrom: { x: number; y: number } | null;
  restSeconds: number;
}

const HELD_DISPLACEMENT_FRACTION = STRIDE_MIN_FRACTION / 2;

const CROWD_REST_SECONDS = 5;

const HELD_TICKS_BEFORE_KEDGE = 5;

type BerthList = 'station' | 'home' | 'squadron';

const voyages = new Map<number, Voyage>();

function stickySlotIn(boatId: number, list: BerthList): number | null {
  const voyage = voyages.get(boatId);
  if (voyage === undefined || voyage.slotList !== list) return null;
  return voyage.slot;
}

function dropVoyage(id: number): void {
  voyages.delete(id);
}

const villages = new Map<string, Village>();
let boats: Boat[] = [];
let nextBoatId = 1;

const COASTAL_RESURVEY_SECONDS = BOAT_REBUILD_SECONDS;

interface Shipyard {
  launch: KrakenTarget | null;
  moorings: readonly KrakenTarget[];
  surveyedSeconds: number | null;
  afloat: number;
}

const shipyards = new Map<string, Shipyard>();

function unsurveyedShipyard(): Shipyard {
  return { launch: null, moorings: [], surveyedSeconds: null, afloat: 0 };
}

export function resurveyAllShipyards(): void {
  noteTerrainChanged();
  for (const shipyard of shipyards.values()) shipyard.surveyedSeconds = null;
}

export function resurveyShipyardsNear(diff: readonly { readonly x: number; readonly y: number }[]): void {
  if (diff.length === 0) return;
  noteTerrainChanged();

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
    if (village.x + BERTH_SEARCH_RADIUS_CELLS < minX) continue;
    if (village.x - BERTH_SEARCH_RADIUS_CELLS > maxX) continue;
    if (village.y + BERTH_SEARCH_RADIUS_CELLS < minY) continue;
    if (village.y - BERTH_SEARCH_RADIUS_CELLS > maxY) continue;
    shipyard.surveyedSeconds = null;
  }
}
let krakenWounds = 0;
let sinceLastSinking = 0;

const pendingWinds: ParsedStormDamage[] = [];

const villageKey = (x: number, y: number): string => `${x},${y}`;

export function resetFleet(): void {
  resetSquadrons();
  villages.clear();
  shipyards.clear();
  voyages.clear();
  fleetChains.clear();
  boats = [];
  nextBoatId = 1;
  noteTerrainChanged();
  seaRegions = null;
  seaRegionsDemand = false;
  sailCursor = 0;
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

export function rememberVillage(x: number, y: number): void {
  const key = villageKey(x, y);
  if (villages.has(key)) return;
  villages.set(key, { x, y, rebuildSeconds: 0 });
  shipyards.set(key, unsurveyedShipyard());
}

export function forgetVillage(x: number, y: number): void {
  if (!villages.delete(villageKey(x, y))) return;
  shipyards.delete(villageKey(x, y));
  const scuttled = boats.filter((boat) => boat.homeX !== x || boat.homeY !== y);
  for (const boat of boats) {
    if (boat.homeX === x && boat.homeY === y) dropVoyage(boat.id);
  }
  boats = scuttled;
}

export function isSailable(world: BoatWorld, cellX: number, cellY: number): boolean {
  const x = Math.floor(cellX);
  const y = Math.floor(cellY);
  if (!isUnlockedCellInWorld(world, x, y)) return false;
  return sharedIsWalkableCell(world, OPEN_WATER_PROFILE, x, y);
}

const COASTAL_DISC: ReadonlyArray<readonly [number, number]> = (() => {
  const threshold = COASTAL_SEARCH_RADIUS_CELLS * (COASTAL_SEARCH_RADIUS_CELLS - 1);
  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -COASTAL_SEARCH_RADIUS_CELLS; dy <= COASTAL_SEARCH_RADIUS_CELLS; dy++) {
    for (let dx = -COASTAL_SEARCH_RADIUS_CELLS; dx <= COASTAL_SEARCH_RADIUS_CELLS; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (dx * dx + dy * dy < threshold) offsets.push([dx, dy]);
    }
  }
  offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
  return offsets;
})();

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

export function launchCell(world: BoatWorld, village: Village): KrakenTarget | null {
  let nearest: KrakenTarget | null = null;
  let found = 0;
  for (const [dx, dy] of COASTAL_DISC) {
    const x = village.x + dx;
    const y = village.y + dy;
    if (!isSailable(world, x, y)) continue;
    found++;
    if (nearest === null) nearest = { x, y };
    if (found >= COASTAL_MIN_WATER_CELLS) return nearest;
  }
  return null;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function launchBerth(
  village: Village,
  occupied: readonly Occupant[],
): KrakenTarget | null {
  const moorings = shipyards.get(villageKey(village.x, village.y))?.moorings ?? [];
  for (const mooring of moorings) {
    if (!isClearOfFleet(mooring.x, mooring.y, occupied)) continue;
    return { x: mooring.x, y: mooring.y };
  }
  return null;
}

function isClearOfFleet(x: number, y: number, occupied: readonly Occupant[]): boolean {
  for (const berth of occupied) {
    const clearance = BOAT_PERSONAL_SPACE_CELLS + berth.radiusCells;
    const dx = x - berth.x;
    const dy = y - berth.y;
    if (dx * dx + dy * dy < clearance * clearance) return false;
  }
  return true;
}

function fleetBerths(): Occupant[] {
  return boats.map((boat) => ({
    x: boat.x,
    y: boat.y,
    radiusCells: BOAT_PERSONAL_SPACE_CELLS,
  }));
}

function tallyFleetHomes(): void {
  for (const shipyard of shipyards.values()) shipyard.afloat = 0;
  for (const boat of boats) {
    const shipyard = shipyards.get(villageKey(boat.homeX, boat.homeY));
    if (shipyard !== undefined) shipyard.afloat++;
  }
}

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

  let launch: KrakenTarget | null = null;
  let shoreCells = 0;
  let found = 0;
  for (const [dx, dy] of COASTAL_DISC) {
    const x = village.x + dx;
    const y = village.y + dy;
    if (!isSailable(world, x, y)) continue;
    found++;
    if (launch === null) {
      launch = { x, y };
      shoreCells = Math.sqrt(dx * dx + dy * dy);
    }
    if (found >= COASTAL_MIN_WATER_CELLS) break;
  }

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
    if (moorings.length >= MOORINGS_SURVEYED_PER_VILLAGE) break;
  }

  shipyard.launch = found >= COASTAL_MIN_WATER_CELLS ? launch : null;
  shipyard.moorings = moorings.length > 0 ? moorings : inshore;
  shipyard.surveyedSeconds = 0;
  return shipyard.launch;
}

/** Deterministic 1-or-0 launch quota per village (average 0.5): the hash is
 * stable across ticks and reboots, so the same villages always host boats. */
function villageBoatQuota(homeX: number, homeY: number): number {
  return hashCell(homeX, homeY) % 2 === 0 ? 1 : 0;
}

function scuttleSurplus(homeX: number, homeY: number, surplus: number): void {
  const doomed = boats
    .filter((boat) => boat.homeX === homeX && boat.homeY === homeY)
    .sort((a, b) => b.id - a.id)
    .slice(0, surplus);
  const gone = new Set(doomed.map((boat) => boat.id));
  for (const id of gone) dropVoyage(id);
  boats = boats.filter((boat) => !gone.has(boat.id));
}

export function advanceShipyards(world: BoatWorld, dt: number): void {
  tallyFleetHomes();

  for (const [key, village] of villages) {
    const shipyard = shipyards.get(key);
    if (shipyard === undefined) continue;

    const quota = villageBoatQuota(village.x, village.y);
    if (shipyard.afloat > quota) {
      scuttleSurplus(village.x, village.y, shipyard.afloat - quota);
      shipyard.afloat = quota;
      village.rebuildSeconds = 0;
      continue;
    }

    const launch = surveyedLaunch(world, village, shipyard, dt);
    if (shipyard.afloat >= quota) {
      village.rebuildSeconds = 0;
      continue;
    }
    if (launch === null) {
      village.rebuildSeconds = 0;
      continue;
    }
    village.rebuildSeconds += dt;
    if (village.rebuildSeconds < BOAT_REBUILD_SECONDS) continue;

    const berth = launchBerth(village, fleetBerths());
    if (berth === null) continue;

    village.rebuildSeconds -= BOAT_REBUILD_SECONDS;
    shipyard.afloat++;
    boats.push({
      id: nextBoatId++,
      homeX: village.x,
      homeY: village.y,
      x: berth.x,
      y: berth.y,
      heading: Math.atan2(berth.y - village.y, berth.x - village.x),
      fighting: false,
    });
  }
}

function targetFor(boat: Boat, kraken: KrakenTarget | null): KrakenTarget | null {
  if (kraken === null) return null;
  if (distance(boat.homeX, boat.homeY, kraken.x, kraken.y) > VILLAGE_PATROL_RANGE_CELLS) {
    return null;
  }
  return kraken;
}

export interface FleetOutcome {
  readonly routed: boolean;
  readonly sunk: readonly number[];
}

const NOTHING_HAPPENED: FleetOutcome = { routed: false, sunk: [] };

interface StationGoal {
  readonly x: number;
  readonly y: number;
  readonly standoff: number;
  readonly slot: number | null;
}

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
  const pointOf = (slot: number): { x: number; y: number } => {
    const angle = (slot / slots) * 2 * Math.PI;
    return {
      x: kraken.x + Math.cos(angle) * stationRadius,
      y: kraken.y + Math.sin(angle) * stationRadius,
    };
  };
  const poseOf = (slot: number): { x: number; y: number } | null => {
    const { x, y } = pointOf(slot);
    const faceKraken = Math.atan2(kraken.y - y, kraken.x - x);
    return isManoeuvrablePose(world, eroded, x, y, faceKraken) ? { x, y } : null;
  };
  for (let index = 0; index < boats.length; index++) {
    const boat = boats[index];
    if (targetFor(boat, kraken) === null) continue;
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

function homeBerthFor(
  index: number,
  kraken: KrakenTarget | null,
  atSea: ReadonlyMap<number, StationGoal>,
  taken: KrakenTarget[],
): StationGoal | null {
  const boat = boats[index];
  if (targetFor(boat, kraken) !== null) return null;
  if (atSea.has(index)) return null;
  const key = villageKey(boat.homeX, boat.homeY);
  const moorings = shipyards.get(key)?.moorings ?? [];
  if (moorings.length === 0) {
    return { x: boat.homeX, y: boat.homeY, standoff: 0, slot: null };
  }
  const isFree = (berth: KrakenTarget): boolean =>
    taken.every((held) => {
      const dx = berth.x - held.x;
      const dy = berth.y - held.y;
      return dx * dx + dy * dy >= HOME_BERTH_CLEARANCE_CELLS * HOME_BERTH_CLEARANCE_CELLS;
    });
  const prev = stickySlotIn(boat.id, 'home');
  if (prev !== null && prev >= 0 && prev < moorings.length && isFree(moorings[prev])) {
    taken.push(moorings[prev]);
    const berth = moorings[prev];
    return { x: berth.x, y: berth.y, standoff: 0, slot: prev };
  }
  let k = 0;
  for (let j = 0; j < index; j++) {
    if (boats[j].homeX === boat.homeX && boats[j].homeY === boat.homeY) k++;
  }
  if (k >= moorings.length) {
    const berth = moorings[moorings.length - 1];
    return { x: berth.x, y: berth.y, standoff: HOME_BERTH_CLEARANCE_CELLS, slot: null };
  }
  for (let n = 0; n < moorings.length; n++) {
    const off = n === 0 ? 0 : n % 2 === 1 ? (n + 1) / 2 : -(n / 2);
    const slot = k + off;
    if (slot < 0 || slot >= moorings.length || !isFree(moorings[slot])) continue;
    taken.push(moorings[slot]);
    const berth = moorings[slot];
    return { x: berth.x, y: berth.y, standoff: 0, slot };
  }
  const berth = moorings[moorings.length - 1];
  return { x: berth.x, y: berth.y, standoff: HOME_BERTH_CLEARANCE_CELLS, slot: null };
}

function assignHomeBerths(
  kraken: KrakenTarget | null,
  atSea: ReadonlyMap<number, StationGoal>,
): Map<number, StationGoal> {
  const goals = new Map<number, StationGoal>();
  const taken: KrakenTarget[] = [];
  for (let index = 0; index < boats.length; index++) {
    const goal = homeBerthFor(index, kraken, atSea, taken);
    if (goal !== null) goals.set(index, goal);
  }
  return goals;
}

const SQUADRON_LEG_SHORTEN_STEP_CELLS = BOAT_HULL_LENGTH_CELLS;

const FULL_TURN_RADIANS = 2 * Math.PI;

const TICK_ROUTE_SEARCH_CAP = 8;

/** Trial expansions per sail search (~2ms). Near and open-water routes complete
 * far below this (probes show 3-15); maze searches that would eat the whole
 * pool exhaust the trial instead and defer, retrying as the boat moves. */
const TRIAL_NODE_BUDGET = 1024;

/** Rescue budget for stuck boats: a capped draw from the shared tick pool.
 * Whole-journey spans (a boat 300 cells from home) can never fit a trial;
 * one capped pool search per stuck episode either brings it home or proves
 * the span needs subdivision. Capped (not the whole pool) so one rescue
 * cannot eat the tick; once-per-episode so failures cannot burn it yearly. */
const STUCK_POOL_NODES = 8192;

/** Beyond this chebyshev distance A* boxes dwarf the node pool, so boats steer
 * direct (today's null-route behavior) until they close within range. Far
 * open-water legs need no route; far maze legs cannot fit the pool anyway. */
const ROUTE_DIRECT_RANGE_CELLS = 300;

const UNREACHABLE_CACHE_CAP = 4096;

const SEA_REGIONS_REBUILD_COOLDOWN_MS = 15_000;

let terrainVersion = 0;
let terrainChangeBumps = 0;

function noteTerrainChanged(): void {
  terrainVersion++;
  terrainChangeBumps++;
}

const unreachableCache = new Map<string, number>();

/** Spans that exhausted the trial, keyed like unreachableCache. A span that
 * fills the box once fills it every tick until the terrain or the endpoints
 * move; re-spending trials on it starves routable searches. Same cap. */
const exhaustedCache = new Map<string, number>();

function rememberExhausted(key: string): void {
  if (!exhaustedCache.has(key) && exhaustedCache.size >= UNREACHABLE_CACHE_CAP) {
    const oldest = exhaustedCache.keys().next();
    if (!oldest.done) exhaustedCache.delete(oldest.value);
  }
  exhaustedCache.set(key, terrainVersion);
}

function rememberUnreachable(key: string): void {
  if (!unreachableCache.has(key) && unreachableCache.size >= UNREACHABLE_CACHE_CAP) {
    const oldest = unreachableCache.keys().next();
    if (!oldest.done) unreachableCache.delete(oldest.value);
  }
  unreachableCache.set(key, terrainVersion);
}

let seaRegions: SeaRegions | null = null;
let seaRegionsVersion = -1;
let seaRegionsDemand = false;
let seaRegionsLastBuildMs = 0;

function currentSeaRegions(): SeaRegions | null {
  if (seaRegions !== null && seaRegionsVersion === terrainVersion) return seaRegions;
  seaRegionsDemand = true;
  return null;
}

function maybeRebuildSeaRegions(eroded: TerrainSampler): void {
  if (seaRegions !== null && seaRegionsVersion === terrainVersion) return;
  if (!seaRegionsDemand) return;
  const nowMs = performance.now();
  if (seaRegions !== null && nowMs - seaRegionsLastBuildMs < SEA_REGIONS_REBUILD_COOLDOWN_MS) {
    return;
  }
  seaRegionsDemand = false;
  seaRegionsLastBuildMs = nowMs;
  seaRegions = labelSeaRegions(eroded, HULL_PROFILE);
  seaRegionsVersion = terrainVersion;
}

let sailCursor = 0;

let routeLogCooldownMs = 0;

const ROUTE_LOG_INTERVAL_MS = 2000;

/** Per-tick route-search counters, emitted to perf.log when perf logging is on. */
interface FleetRouteDebug {
  sailPlans: number;
  sailRepeat: number;
  sailDrift: number;
  sailStuck: number;
  sailNulls: number;
  readonly sailNullBoats: Set<number>;
  sailSearches: number;
  sailDeferred: number;
  cacheHits: number;
  exhaustedHits: number;
  regionHits: number;
  farSkips: number;
  expensive: number;
  bumps: number;
  tver: number;
  rver: number;
  rcount: number;
  probe: null | {
    sx: number;
    sy: number;
    gx: number;
    gy: number;
    fr: number;
    gr: number;
    status: string;
    spent: number;
  };
  followReplans: number;
  legFromCalls: number;
  legFromNulls: number;
  legRouted: number;
  legStraight: number;
  legReplans: number;
  sailRescue: number;
  fleetChains: number;
  fleetShared: number;
  fleetSearches: number;
  fleetHold: number;
  fleetCohesion: number;
}

function createFleetRouteDebug(): FleetRouteDebug {
  return {
    sailPlans: 0,
    sailRepeat: 0,
    sailDrift: 0,
    sailStuck: 0,
    sailNulls: 0,
    sailNullBoats: new Set<number>(),
    sailSearches: 0,
    sailDeferred: 0,
    cacheHits: 0,
    exhaustedHits: 0,
    regionHits: 0,
    farSkips: 0,
    expensive: 0,
    bumps: 0,
    tver: 0,
    rver: -1,
    rcount: -1,
    probe: null,
    followReplans: 0,
    legFromCalls: 0,
    legFromNulls: 0,
    legRouted: 0,
    legStraight: 0,
    legReplans: 0,
    fleetChains: 0,
    fleetShared: 0,
    fleetSearches: 0,
    fleetHold: 0,
    fleetCohesion: 0,
    sailRescue: 0,
  };
}

function squadronNavigator(
  world: BoatWorld,
  eroded: TerrainSampler,
  debug: FleetRouteDebug,
): SquadronNavigator {
  return {
    rendezvousFor(homeX: number, homeY: number): SquadronWaypoint | null {
      const moorings = shipyards.get(villageKey(homeX, homeY))?.moorings ?? [];
      return moorings.length === 0 ? null : moorings[0];
    },

    isInHarbour(homeX: number, homeY: number, x: number, y: number): boolean {
      return distance(x, y, homeX, homeY) <= BERTH_SEARCH_RADIUS_CELLS;
    },

    legFrom(
      fromX: number,
      fromY: number,
      seed: number,
      attempt: number,
    ): SquadronWaypoint | null {
      // Pose-only draw: the fleet subdivides the leg into short hops and
      // pathfinds once per hop, so no long A* runs here. Legs stay inside
      // the departure sea region: a leg no boat can sail only builds chains
      // whose hops sit on land.
      const regions = currentSeaRegions();
      const fromRegion =
        regions === null ? 0 : regionAt(regions, world.worldSize, fromX, fromY);
      const spoke = (seed + attempt) % SQUADRON_WAYPOINT_ATTEMPTS;
      const bearing = (spoke * FULL_TURN_RADIANS) / SQUADRON_WAYPOINT_ATTEMPTS;
      const dx = Math.cos(bearing);
      const dy = Math.sin(bearing);
      for (
        let reach = SQUADRON_LEG_LENGTH_CELLS;
        reach >= SQUADRON_LEG_MIN_LENGTH_CELLS;
        reach -= SQUADRON_LEG_SHORTEN_STEP_CELLS
      ) {
        const x = fromX + dx * reach;
        const y = fromY + dy * reach;
        if (!isManoeuvrablePose(world, eroded, x, y, bearing)) continue;
        if (regions !== null && fromRegion !== 0) {
          const goalRegion = regionAt(regions, world.worldSize, x, y);
          if (goalRegion !== 0 && goalRegion !== fromRegion) continue;
        }
        debug.legFromCalls++;
        return { x, y };
      }
      debug.legFromNulls++;
      return null;
    },
  };
}

function villageRanks(): number[] {
  const seen = new Map<string, number>();
  const ranks: number[] = [];
  for (const boat of boats) {
    const key = villageKey(boat.homeX, boat.homeY);
    const rank = seen.get(key) ?? 0;
    ranks.push(rank);
    seen.set(key, rank + 1);
  }
  return ranks;
}

/** Route a fleet leg once and stride the route into hops. Returns null
 * when the leg won't route (different sea regions, no pool left, search
 * fails) so the caller falls back to straight subdivision. Hops sampled
 * from route cells are walkable by construction. */
function routeLegPoints(
  world: BoatWorld,
  eroded: TerrainSampler,
  flagship: { x: number; y: number },
  leg: SquadronWaypoint,
  budget: RouteBudget,
  debug: FleetRouteDebug,
): Waypoint[] | null {
  if (budget.remaining <= 0) return null;
  const regions = currentSeaRegions();
  const fromRegion =
    regions === null ? 0 : regionAt(regions, world.worldSize, flagship.x, flagship.y);
  const goalRegion =
    regions === null ? 0 : regionAt(regions, world.worldSize, leg.x, leg.y);
  if (regions !== null && fromRegion !== 0 && goalRegion !== 0 && fromRegion !== goalRegion) {
    return null;
  }
  const allowance = Math.min(budget.remaining, LEG_ROUTE_NODE_CAP);
  const legBudget = createRouteBudget(allowance);
  const outcome = findRouteWithStatus(
    eroded,
    HULL_PROFILE,
    { x: flagship.x, y: flagship.y },
    { x: leg.x, y: leg.y },
    legBudget,
  );
  budget.remaining -= allowance - legBudget.remaining;
  if (outcome.plan === null) {
    if (outcome.status === 'unreachable') {
      rememberUnreachable(
        `${Math.floor(flagship.x)},${Math.floor(flagship.y)}>` +
          `${Math.floor(leg.x)},${Math.floor(leg.y)}`,
      );
    }
    if (isPerfLoggingEnabled()) {
      perfLogLine(
        `[tick] boats legroute failed status=${outcome.status} ` +
          `spent=${allowance - legBudget.remaining} regions=${fromRegion}>${goalRegion}`,
      );
    }
    return null;
  }
  const points: Waypoint[] = [];
  for (let i = 0; i < outcome.plan.cells.length; i += FLEET_HOP_LENGTH_CELLS) {
    points.push({ x: outcome.plan.cells[i].x, y: outcome.plan.cells[i].y });
  }
  const last = outcome.plan.cells[outcome.plan.cells.length - 1];
  const tail = points[points.length - 1];
  if (tail === undefined || tail.x !== last.x || tail.y !== last.y) {
    points.push({ x: last.x, y: last.y });
  }
  if (points.length === 0) return null;
  if (isPerfLoggingEnabled()) {
    perfLogLine(
      `[tick] boats legroute ok cells=${outcome.plan.cells.length} hops=${points.length}`,
    );
  }
  return points;
}

function assignSquadronGoals(
  world: BoatWorld,
  eroded: TerrainSampler,
  kraken: KrakenTarget | null,
  dt: number,
  debug: FleetRouteDebug,
  budget: RouteBudget,
): Map<number, StationGoal> {
  const ranks = villageRanks();
  const candidates: SquadronBoat[] = [];
  const indexOfBoat = new Map<number, number>();
  for (let index = 0; index < boats.length; index++) {
    const boat = boats[index];
    if (ranks[index] < HOME_GUARD_BOATS_PER_VILLAGE) continue;
    if (targetFor(boat, kraken) !== null) continue;
    candidates.push({
      id: boat.id,
      x: boat.x,
      y: boat.y,
      homeX: boat.homeX,
      homeY: boat.homeY,
    });
    indexOfBoat.set(boat.id, index);
  }
  const nav = squadronNavigator(world, eroded, debug);
  const waypoints = advanceSquadrons(candidates, nav, dt);
  const positionOf = new Map<number, SquadronBoat>();
  for (const boat of candidates) positionOf.set(boat.id, boat);
  const liveSquadrons = new Set<number>();
  for (const boatId of waypoints.keys()) {
    const squadronId = squadronOf(boatId);
    if (squadronId !== null) liveSquadrons.add(squadronId);
  }
  for (const squadronId of [...fleetChains.keys()]) {
    if (!liveSquadrons.has(squadronId)) fleetChains.delete(squadronId);
  }
  for (const squadronId of [...fleetSharedRoutes.keys()]) {
    if (!fleetChains.has(squadronId)) fleetSharedRoutes.delete(squadronId);
  }
  // One shared chain per fleet: the squadron draws the coarse leg, the
  // fleet routes it once around barriers, and the flagship cursor drives
  // every member along the subdivided route. Hops sampled from route cells
  // are walkable by construction; straight subdivision is only the fallback
  // when the leg itself won't route.
  const arrivalSquared = SQUADRON_MUSTER_RADIUS_CELLS * SQUADRON_MUSTER_RADIUS_CELLS;
  const hops = new Map<number, SquadronWaypoint>();
  let legRoutedThisTick = false;
  for (const squadronId of [...liveSquadrons].sort((a, b) => a - b)) {
    const members = squadronMembers(squadronId);
    const flagship = positionOf.get(members[0]);
    let leg = flagship === undefined ? undefined : waypoints.get(flagship.id);
    if (flagship === undefined || leg === undefined) continue;
    const flagshipVoyage = voyages.get(flagship.id);
    if (
      flagshipVoyage !== undefined &&
      flagshipVoyage.nullSeconds > SQUADRON_LEG_STALE_SECONDS
    ) {
      const fresh = replanSquadronLeg(
        squadronId,
        { x: flagship.x, y: flagship.y },
        flagship,
        nav,
      );
      if (fresh !== null && (fresh.x !== leg.x || fresh.y !== leg.y)) {
        leg = fresh;
        debug.legReplans++;
      }
    }
    let chain = fleetChains.get(squadronId);
    if (chain === undefined || chain.legX !== leg.x || chain.legY !== leg.y) {
      let points: Waypoint[] | null = null;
      if (!legRoutedThisTick) {
        legRoutedThisTick = true;
        points = routeLegPoints(world, eroded, flagship, leg, budget, debug);
      }
      if (points === null) {
        const built = buildWaypointChain(
          { x: flagship.x, y: flagship.y },
          [leg],
          FLEET_HOP_LENGTH_CELLS,
        );
        const raw = built.length > 0 ? built : [{ x: leg.x, y: leg.y }];
        points = raw.map((hop) =>
          snapWaypointToWalkable(eroded, HULL_PROFILE, hop.x, hop.y, FLEET_SNAP_RADIUS_CELLS),
        );
        debug.legStraight++;
      } else {
        debug.legRouted++;
      }
      chain = {
        legX: leg.x,
        legY: leg.y,
        points,
        index: 0,
      };
      fleetChains.set(squadronId, chain);
    }
    while (chain.index < chain.points.length) {
      const hop = chain.points[chain.index];
      const dx = flagship.x - hop.x;
      const dy = flagship.y - hop.y;
      if (dx * dx + dy * dy > arrivalSquared) break;
      chain.index++;
    }
    hops.set(squadronId, chain.points[Math.min(chain.index, chain.points.length - 1)]);
  }
  debug.fleetChains = fleetChains.size;
  const goals = new Map<number, StationGoal>();
  for (const boatId of waypoints.keys()) {
    const squadronId = squadronOf(boatId);
    const hop = squadronId === null ? undefined : hops.get(squadronId);
    if (hop === undefined) continue;
    const index = indexOfBoat.get(boatId);
    if (index === undefined) continue;
    goals.set(index, { x: hop.x, y: hop.y, standoff: 0, slot: null });
  }
  return goals;
}

export { squadronCount, squadronMembers, squadronOf };

export function villageMoorings(homeX: number, homeY: number): readonly KrakenTarget[] {
  return shipyards.get(villageKey(homeX, homeY))?.moorings ?? [];
}

export function noteStormWind(damage: ParsedStormDamage): void {
  pendingWinds.push(damage);
}

function applyStormWind(world: BoatWorld, eroded: TerrainSampler): void {
  if (pendingWinds.length === 0) return;
  const winds = pendingWinds.splice(0, pendingWinds.length);

  for (const wind of winds) {
    for (const boat of boats) {
      const severity = severityAt(wind, boat.x, boat.y);
      if (severity <= 0) continue;
      const direction = tangentialWindAt(wind, boat.x, boat.y);
      if (direction === null) continue;

      const distance = severity * wind.durationSeconds * BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND;
      let travelled = 0;
      while (travelled < distance) {
        const hop = Math.min(BOAT_WIND_PUSH_STEP_CELLS, distance - travelled);
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
  debug: FleetRouteDebug;
  searchesLeft: number;
  fleetRoutes: Map<number, { hopX: number; hopY: number; cells: RouteCell[] | null }>;
  /** Squadrons with a shared route this tick: members hold once anyone
   * has shared. Failed attempts do NOT mark, so a fleet whose flagship
   * cannot bridge its span still sails when any member can. */
  fleetSearched: Set<number>;
  berths: readonly Occupant[];
  krakenOccupant: Occupant | null;
  goals: Map<number, StationGoal>;
  squadronGoals: Map<number, StationGoal>;
  homeGoals: Map<number, StationGoal>;
}

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

const CELL_CENTRE_OFFSET = 0.5;

/** One capped rescue search from the shared tick pool for a stuck boat. The
 * caller gates this to once per stuck episode; the cap keeps one rescue from
 * eating the tick. Deducts what it spends so later searches see the pool. */
function rescueRoute(
  tick: SailTick,
  eroded: TerrainSampler,
  boat: Boat,
  goalX: number,
  goalY: number,
): { readonly cells: ReadonlyArray<RouteCell>; readonly cost: number } | null {
  const allowance = Math.min(tick.budget.remaining, STUCK_POOL_NODES);
  const rescue = createRouteBudget(allowance);
  const outcome = findRouteWithStatus(
    eroded,
    HULL_PROFILE,
    { x: boat.x, y: boat.y },
    { x: goalX, y: goalY },
    rescue,
  );
  tick.budget.remaining -= allowance - rescue.remaining;
  if (outcome.status === 'unreachable') {
    rememberUnreachable(
      `${Math.floor(boat.x)},${Math.floor(boat.y)}>` +
        `${Math.floor(goalX)},${Math.floor(goalY)}`,
    );
  }
  return outcome.plan;
}

/** Rescue is due when a cruising boat is definitionally failing: physically
 * stuck, or chronically routeless (creeping without a route never clears
 * this). Station approaches never rescue: shuffling into engagement is
 * tactical crowd behavior, and a pool route to a drifting station slot
 * changes combat dynamics. */
function rescueDue(tick: SailTick, voyage: Voyage, cruising: boolean): boolean {
  return (
    cruising &&
    (voyage.noProgressSeconds > BOAT_STUCK_SECONDS ||
      voyage.nullSeconds > BOAT_STUCK_SECONDS) &&
    !voyage.poolTried &&
    tick.budget.remaining > 0
  );
}

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
    squadronGoals,
    homeGoals,
  } = tick;
  const boat = boats[index];
  const earlier = voyages.get(boat.id);
  if (earlier !== undefined && earlier.sailedFrom !== null) {
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
  let goalX: number;
  let goalY: number;
  let standoff: number;
  let slotIndex: number | null;
  const squadron = target === null ? squadronGoals.get(index) : undefined;
  const slotList: BerthList =
    target !== null ? 'station' : squadron !== undefined ? 'squadron' : 'home';
  const squadronId = squadron !== undefined ? squadronOf(boat.id) : null;
  let squadronRank = 0;
  if (squadron !== undefined && squadronId !== null) {
    const rank = squadronMembers(squadronId).indexOf(boat.id);
    squadronRank = rank < 0 ? 0 : rank;
  }
  if (squadron !== undefined) {
    // Fleet station: flagship takes the hop, members fan out on lattice
    // slots. Slots clamp in-bounds; edge offsets would route off the map.
    // Both are snapped to sailable water: a lattice offset past a shoreline
    // is an unreachable search goal, which is how boats park on beaches.
    const slot = waypointForMember(squadron, squadronRank, FLEET_FORMATION_SPACING_CELLS);
    const berth = snapWaypointToWalkable(
      eroded,
      HULL_PROFILE,
      slot.x,
      slot.y,
      FLEET_SNAP_RADIUS_CELLS,
    );
    goalX = Math.min(Math.max(berth.x, 0.5), world.worldSize - 0.5);
    goalY = Math.min(Math.max(berth.y, 0.5), world.worldSize - 0.5);
    standoff = squadron.standoff;
    slotIndex = squadron.slot;
  } else if (target === null) {
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

  let voyage = voyages.get(boat.id);
  const settle = (holdX: number, holdY: number): void => {
    if (voyage !== undefined) {
      voyage.goalX = holdX;
      voyage.goalY = holdY;
      voyage.noProgressSeconds = 0;
      voyage.poolTried = false;
      voyage.slot = slotIndex;
      voyage.slotList = slotList;
    }
  };
  const holdSlack = standoff === 0 ? 0 : target === null ? HOME_BERTH_CLEARANCE_CELLS : step;
  if (range <= standoff + holdSlack) {
    settle(goalX, goalY);
    return;
  }
  if (standoff === 0 && range <= step) {
    if (isHullPose(world, eroded, goalX, goalY, boat.heading)) {
      boat.x = goalX;
      boat.y = goalY;
    }
    settle(goalX, goalY);
    return;
  }
  if (boat.fighting) {
    settle(goalX, goalY);
    return;
  }

  if (voyage === undefined) {
    voyage = {
      route: null,
      routeIndex: 0,
      goalX,
      goalY,
      noProgressSeconds: 0,
      nullSeconds: 0,
      poolTried: false,
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
    const debug = tick.debug;
    debug.sailPlans++;
    if (voyage.route === null) debug.sailRepeat++;
    else if (voyage.noProgressSeconds > BOAT_STUCK_SECONDS) debug.sailStuck++;
    else debug.sailDrift++;
    let plan: { readonly cells: ReadonlyArray<RouteCell>; readonly cost: number } | null = null;
    const shared =
      squadron !== undefined && squadronId !== null
        ? tick.fleetRoutes.get(squadronId)
        : undefined;
    const persisted =
      shared !== undefined || squadron === undefined || squadronId === null
        ? undefined
        : fleetSharedRoutes.get(squadronId);
    const live = shared ?? persisted;
    const fresh =
      live !== undefined &&
      squadron !== undefined &&
      live.hopX === squadron.x &&
      live.hopY === squadron.y;
    if (fresh) {
      // Pathfound once per fleet: the flagship searched this hop (this tick
      // or an earlier one) and everyone adopts its cells at their nearest
      // index, steering to their own station slots from there.
      debug.fleetShared++;
      if (live.cells !== null) {
        voyage.route = [...live.cells];
        voyage.routeIndex = nearestRouteIndex(
          live.cells,
          boat.x,
          boat.y,
          FLEET_ROUTE_REJOIN_CELLS,
        );
      } else {
        voyage.route = null;
        voyage.routeIndex = 0;
        debug.sailNulls++;
        debug.sailNullBoats.add(boat.id);
      }
      voyage.goalX = goalX;
      voyage.goalY = goalY;
      voyage.noProgressSeconds = 0;
      voyage.poolTried = false;
    } else if (
      squadron !== undefined &&
      squadronId !== null &&
      squadronRank !== 0 &&
      (tick.fleetSearched.has(squadronId) || tick.searchesLeft <= 0)
    ) {
      // Fleet members never search: the flagship pathfinds once per hop and
      // the fleet adopts. Hold formation on the current route; null it only
      // when the hop moved on (goal drift), so a stale route never leads a
      // member at the previous hop. A failed flagship search stays local
      // instead of nulling the whole fleet for a tick.
      debug.fleetHold++;
      if (distance(goalX, goalY, voyage.goalX, voyage.goalY) > REPLAN_GOAL_DRIFT_CELLS) {
        voyage.route = null;
        voyage.routeIndex = 0;
      }
      voyage.goalX = goalX;
      voyage.goalY = goalY;
    } else if (tick.searchesLeft <= 0) {
      debug.sailDeferred++;
    } else if (
      Math.max(Math.abs(boat.x - goalX), Math.abs(boat.y - goalY)) > ROUTE_DIRECT_RANGE_CELLS
    ) {
      // Whole-journey spans never fit a trial; a failing boat may spend one
      // capped rescue from the pool instead of burning trials on them.
      if (rescueDue(tick, voyage, target === null)) {
        voyage.poolTried = true;
        debug.sailRescue++;
        plan = rescueRoute(tick, eroded, boat, goalX, goalY);
      } else {
        debug.farSkips++;
      }
    } else {
      const key =
        `${Math.floor(boat.x)},${Math.floor(boat.y)}>` +
        `${Math.floor(goalX)},${Math.floor(goalY)}`;
      if (unreachableCache.get(key) === terrainVersion) {
        debug.cacheHits++;
      } else if (exhaustedCache.get(key) === terrainVersion && !rescueDue(tick, voyage, target === null)) {
        // Same span filled the box on this terrain version and no rescue is
        // due: re-spending the trial would starve routable searches.
        debug.exhaustedHits++;
      } else {
        const regions = currentSeaRegions();
        const fromRegion =
          regions === null ? 0 : regionAt(regions, world.worldSize, boat.x, boat.y);
        const goalRegion =
          regions === null ? 0 : regionAt(regions, world.worldSize, goalX, goalY);
        if (regions !== null && fromRegion !== 0 && goalRegion !== 0 && fromRegion !== goalRegion) {
          debug.regionHits++;
          rememberUnreachable(key);
        } else {
          tick.searchesLeft--;
          debug.sailSearches++;
          const trial = createRouteBudget(TRIAL_NODE_BUDGET);
          const outcome = findRouteWithStatus(
            eroded,
            HULL_PROFILE,
            { x: boat.x, y: boat.y },
            { x: goalX, y: goalY },
            trial,
          );
          if (outcome.status === 'exhausted') {
            debug.expensive++;
            rememberExhausted(key);
          }
          if (debug.probe === null) {
            debug.probe = {
              sx: boat.x,
              sy: boat.y,
              gx: goalX,
              gy: goalY,
              fr: fromRegion,
              gr: goalRegion,
              status: outcome.status,
              spent: TRIAL_NODE_BUDGET - trial.remaining,
            };
          }
          if (outcome.status === 'unreachable') rememberUnreachable(key);
          plan = outcome.plan;
          if (plan === null && outcome.status === 'exhausted' && rescueDue(tick, voyage, target === null)) {
            voyage.poolTried = true;
            debug.sailRescue++;
            plan = rescueRoute(tick, eroded, boat, goalX, goalY);
          }
        }
      }
    }
    if (!fresh) {
      if (plan === null) {
        debug.sailNulls++;
        debug.sailNullBoats.add(boat.id);
      }
      voyage.route = plan === null ? null : [...plan.cells];
      voyage.routeIndex = 0;
      voyage.goalX = goalX;
      voyage.goalY = goalY;
      voyage.noProgressSeconds = 0;
      if (plan !== null) voyage.poolTried = false;
      if (squadron !== undefined && squadronId !== null && voyage.route !== null) {
        const cells = [...voyage.route];
        tick.fleetSearched.add(squadronId);
        tick.fleetRoutes.set(squadronId, {
          hopX: squadron.x,
          hopY: squadron.y,
          cells,
        });
        fleetSharedRoutes.set(squadronId, {
          hopX: squadron.x,
          hopY: squadron.y,
          cells,
        });
        debug.fleetSearches++;
      }
    }
  }
  voyage.slot = slotIndex;
  voyage.slotList = slotList;

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
  let cohesion = 1;
  if (squadron !== undefined && squadronId !== null) {
    cohesion = fleetCohesion(boat, squadronId, goalX, goalY);
    if (cohesion < 1) tick.debug.fleetCohesion++;
  }
  const stride = Math.min(step, range - standoff) * advance * cohesion;
  const turnThisTick = Math.min(maxTurnRadians, stride / BOAT_TIGHTEST_TURN_RADIUS_CELLS);
  if (voyage.route === null && range > 0) {
    const probeX = boat.x + ((goalX - boat.x) / range) * stride;
    const probeY = boat.y + ((goalY - boat.y) / range) * stride;
    if (!isHullPose(world, eroded, probeX, probeY, boat.heading)) {
      settle(goalX, goalY);
      return;
    }
  }
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
    permits: (x, y, heading) => isHullPose(world, eroded, x, y, heading),
    maxTurnRadians: turnThisTick,
    aimAheadCells: BOAT_AIM_AHEAD_CELLS,
    replanNodeBudget: Math.min(budget.remaining, TRIAL_NODE_BUDGET),
  });
  voyage.sailedFrom = { x: boat.x, y: boat.y };
  boat.heading = helm.heading;
  boat.x = helm.x;
  boat.y = helm.y;
  voyage.route = helm.route;
  voyage.routeIndex = helm.routeIndex;
  if (result.replanned) tick.debug.followReplans++;
  if (result.replanned || result.progressed) {
    voyage.noProgressSeconds = 0;
    voyage.poolTried = false;
  } else {
    voyage.noProgressSeconds += dt;
  }
  if (!boat.fighting) {
    if (voyage.route === null) voyage.nullSeconds += dt;
    else voyage.nullSeconds = 0;
  }
}

function resolveOverlaps(
  world: BoatWorld,
  eroded: TerrainSampler,
  kraken: KrakenTarget | null,
  step: number,
): void {
  const pushLeft = boats.map(() => step);
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
      const bearing = gap > 0 ? Math.atan2(dy, dx) : 0;
      const overlap = clearance - gap;
      const giveLower = Math.min(overlap / 2, pushLeft[i]);
      if (giveLower > 0) {
        const x = lower.x - Math.cos(bearing) * giveLower;
        const y = lower.y - Math.sin(bearing) * giveLower;
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

export function advanceFleet(
  world: BoatWorld,
  kraken: KrakenTarget | null,
  dt: number,
): FleetOutcome {
  advanceShipyards(world, dt);

  const eroded = withClearance(world, BOAT_BEAM_CLEARANCE_CELLS);

  applyStormWind(world, eroded);

  const berths: readonly Occupant[] = fleetBerths();

  const step = BOAT_SPEED_CELLS_PER_SECOND * dt;
  const lookahead = BOAT_SPEED_CELLS_PER_SECOND * BOAT_LOOKAHEAD_SECONDS;
  const maxTurnRadians = BOAT_TURN_RADIANS_PER_SECOND * dt;
  const stationRadius = boatStationRadiusCells(dt);
  const budget: RouteBudget = createRouteBudget();
  const krakenOccupant: Occupant | null =
    kraken === null
      ? null
      : { x: kraken.x, y: kraken.y, radiusCells: KRAKEN_BODY_RADIUS_CELLS };
  maybeRebuildSeaRegions(eroded);
  const debug: FleetRouteDebug = createFleetRouteDebug();
  debug.bumps = terrainChangeBumps;
  terrainChangeBumps = 0;
  debug.tver = terrainVersion;
  debug.rver = seaRegions === null ? -1 : seaRegionsVersion;
  debug.rcount = seaRegions === null ? -1 : seaRegions.regionCount;
  const goals = assignStationGoals(world, eroded, kraken, stationRadius);
  const squadronGoals = assignSquadronGoals(world, eroded, kraken, dt, debug, budget);
  const homeGoals = assignHomeBerths(kraken, squadronGoals);

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
    squadronGoals,
    homeGoals,
    debug,
    searchesLeft: TICK_ROUTE_SEARCH_CAP,
    fleetRoutes: new Map(),
    fleetSearched: new Set(),
  };

  let engaged = 0;
  const fleetSize = boats.length;
  for (let n = 0; n < fleetSize; n++) {
    const index = fleetSize === 0 ? 0 : (sailCursor + n) % fleetSize;
    sailBoat(tick, index);
    if (boats[index].fighting) engaged++;
  }
  if (fleetSize > 0) sailCursor = (sailCursor + 1) % fleetSize;

  for (const [squadronId, shared] of tick.fleetRoutes) {
    lastSailedBySquadron.set(squadronId, shared.cells);
  }
  for (const squadronId of [...lastSailedBySquadron.keys()]) {
    if (!fleetChains.has(squadronId)) lastSailedBySquadron.delete(squadronId);
  }

  resolveOverlaps(world, eroded, kraken, step);

  routeLogCooldownMs -= dt * 1000;
  if (isPerfLoggingEnabled() && routeLogCooldownMs <= 0) {
    routeLogCooldownMs += ROUTE_LOG_INTERVAL_MS;
    perfLogLine(
      `[tick] boats routes budget=${budget.remaining}/${ROUTE_NODE_BUDGET} ` +
        `sailPlans=${debug.sailPlans} sailNulls=${debug.sailNulls} ` +
        `(repeat=${debug.sailRepeat} drift=${debug.sailDrift} stuck=${debug.sailStuck}) ` +
        `searches=${debug.sailSearches} deferred=${debug.sailDeferred} ` +
        `cache=${debug.cacheHits} xcache=${debug.exhaustedHits} region=${debug.regionHits} ` +
        `far=${debug.farSkips} ` +
        `expensive=${debug.expensive} ` +
        `fleets=${debug.fleetChains} shared=${debug.fleetShared} fsearch=${debug.fleetSearches} ` +
        `hold=${debug.fleetHold} cohere=${debug.fleetCohesion} ` +
        `rescue=${debug.sailRescue} ` +
        `bumps=${debug.bumps} tv=${debug.tver} rv=${debug.rver} rc=${debug.rcount} ` +
        `nullBoats=${debug.sailNullBoats.size} followReplans=${debug.followReplans} ` +
        `legFrom=${debug.legFromCalls} legNulls=${debug.legFromNulls} ` +
        `legroute=${debug.legRouted}/${debug.legStraight} legreplan=${debug.legReplans} ` +
        `boats=${boats.length} villages=${villages.size} squadrons=${squadronCount()} ` +
        `form=${formationStats().candidates}/${formationStats().inHarbour}/` +
        `${formationStats().moored}/${formationStats().crews}/${formationStats().affiliated}`,
    );
    if (debug.probe !== null) {
      const p = debug.probe;
      perfLogLine(
        `[tick] boats probe from=(${p.sx.toFixed(1)},${p.sy.toFixed(1)}) ` +
          `to=(${p.gx.toFixed(1)},${p.gy.toFixed(1)}) regions=${p.fr}>${p.gr} ` +
          `${p.status} spent=${p.spent}`,
      );
    }
    for (const chain of fleetWaypointDebug().chains) {
      const hop = chain.hops[Math.min(chain.cursor, chain.hops.length - 1)];
      perfLogLine(
        `[tick] boats squadron #${chain.id} cursor=${chain.cursor}/${chain.hops.length} ` +
          `hop=(${hop === undefined ? '?,?' : `${hop.x.toFixed(0)},${hop.y.toFixed(0)}`}) ` +
          `sailed=${chain.sailed.length} members=${chain.members} ` +
          `crew=[${(chain.crew ?? []).join(',')}]`,
      );
    }
  }

  if (kraken === null || engaged === 0) {
    krakenWounds = Math.max(0, krakenWounds - KRAKEN_WOUND_HEAL_PER_SECOND * dt);
    sinceLastSinking = 0;
    return NOTHING_HAPPENED;
  }

  krakenWounds += engaged * BOAT_WOUNDS_PER_SECOND * dt;

  const sunk: number[] = [];
  sinceLastSinking += dt;
  while (sinceLastSinking >= KRAKEN_SINKS_BOAT_EVERY_SECONDS) {
    sinceLastSinking -= KRAKEN_SINKS_BOAT_EVERY_SECONDS;
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
    krakenWounds = 0;
    sinceLastSinking = 0;
    return { routed: true, sunk };
  }
  return { routed: false, sunk };
}

const FIRE_REACH_CELLS = BOAT_PERSONAL_SPACE_CELLS;

export function burnableBoatAt(x: number, y: number): { id: number; distanceCells: number } | null {
  const nearest = nearestWithinReach(boats, x, y, FIRE_REACH_CELLS, (boat) => boat);
  return nearest === null
    ? null
    : { id: nearest.item.id, distanceCells: nearest.distanceCells };
}

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

export function boatPosition(id: number): { x: number; y: number } | null {
  const boat = boats.find((candidate) => candidate.id === id);
  return boat === undefined ? null : { x: boat.x, y: boat.y };
}

export function burnBoats(ids: readonly number[]): number {
  const doomed = new Set(ids);
  const before = boats.length;
  for (const id of doomed) dropVoyage(id);
  boats = boats.filter((boat) => !doomed.has(boat.id));
  return before - boats.length;
}

export function boatStates(worldSize: number): BoatState[] {
  return boats.map((boat) => ({
    id: boat.id,
    x: roundBroadcastCell(boat.x, worldSize),
    y: roundBroadcastCell(boat.y, worldSize),
    heading: roundBroadcastPosition(boat.heading),
    fighting: boat.fighting,
  }));
}

/** Debug-only snapshot of every live fleet chain for the `?waypoints` overlay.
 * Read-only over the chains `assignSquadronGoals` already maintains: the
 * anchor is the flagship's current position (what the chain was built from),
 * `hops` are the subdivided points ending at the leg goal, and `cursor` is
 * the flagship's hop. Never read back; visualisation only. */
export function fleetWaypointDebug(): WaypointDebugFrame {
  const chains: WaypointChainSnapshot[] = [];
  for (const [squadronId, chain] of fleetChains) {
    const members = squadronMembers(squadronId);
    const flagship = members.length > 0 ? boatPosition(members[0]) : null;
    const firstHop = chain.points[0];
    const anchor = flagship ?? firstHop ?? { x: chain.legX, y: chain.legY };
    const sailed = lastSailedBySquadron.get(squadronId) ?? null;
    chains.push({
      id: squadronId,
      label: `squadron ${squadronId}`,
      anchor: { x: anchor.x, y: anchor.y },
      hops: chain.points.map((hop) => ({ x: hop.x, y: hop.y })),
      cursor: Math.max(0, Math.min(chain.index, chain.points.length)),
      members: members.length,
      spacing: FLEET_FORMATION_SPACING_CELLS,
      crew: [...members],
      sailed:
        sailed === null
          ? []
          : sailed
              .slice(0, MAX_DEBUG_SAILED_CELLS_PER_CHAIN)
              .map((cell) => ({ x: cell.x + 0.5, y: cell.y + 0.5 })),
    });
  }
  return { chains };
}

export function fleetSnapshot(): {
  villages: Village[];
  boats: Boat[];
  nextBoatId: number;
} {  return { villages: [...villages.values()], boats: [...boats], nextBoatId };
}

export function restoreFleet(saved: {
  villages: readonly Village[];
  boats: readonly Boat[];
  nextBoatId: number;
}): void {
  resetFleet();
  for (const village of saved.villages) {
    const key = villageKey(village.x, village.y);
    villages.set(key, { ...village });
    shipyards.set(key, unsurveyedShipyard());
  }
  boats = saved.boats.map((boat) => ({ ...boat }));
  nextBoatId = saved.nextBoatId;
}

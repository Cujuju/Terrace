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
  HOME_GUARD_BOATS_PER_VILLAGE,
  SQUADRON_LEG_LENGTH_CELLS,
  SQUADRON_LEG_MIN_LENGTH_CELLS,
  SQUADRON_WAYPOINT_ATTEMPTS,
  advanceSquadrons,
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
  for (const shipyard of shipyards.values()) shipyard.surveyedSeconds = null;
}

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

export function advanceShipyards(world: BoatWorld, dt: number): void {
  tallyFleetHomes();

  for (const [key, village] of villages) {
    const shipyard = shipyards.get(key);
    if (shipyard === undefined) continue;

    const launch = surveyedLaunch(world, village, shipyard, dt);
    if (shipyard.afloat >= BOATS_PER_VILLAGE) {
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

function squadronNavigator(
  world: BoatWorld,
  eroded: TerrainSampler,
  legBudget: RouteBudget,
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
        const plan = findRoute(
          eroded,
          HULL_PROFILE,
          { x: fromX, y: fromY },
          { x, y },
          legBudget,
        );
        if (plan !== null) return { x, y };
      }
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

function assignSquadronGoals(
  world: BoatWorld,
  eroded: TerrainSampler,
  kraken: KrakenTarget | null,
  legBudget: RouteBudget,
  dt: number,
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
  const waypoints = advanceSquadrons(
    candidates,
    squadronNavigator(world, eroded, legBudget),
    dt,
  );
  const goals = new Map<number, StationGoal>();
  for (const [boatId, waypoint] of waypoints) {
    const index = indexOfBoat.get(boatId);
    if (index === undefined) continue;
    goals.set(index, { x: waypoint.x, y: waypoint.y, standoff: 0, slot: null });
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
  if (squadron !== undefined) {
    goalX = squadron.x;
    goalY = squadron.y;
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
    replanNodeBudget: budget.remaining,
  });
  voyage.sailedFrom = { x: boat.x, y: boat.y };
  boat.heading = helm.heading;
  boat.x = helm.x;
  boat.y = helm.y;
  voyage.route = helm.route;
  voyage.routeIndex = helm.routeIndex;
  if (result.replanned || result.progressed) voyage.noProgressSeconds = 0;
  else voyage.noProgressSeconds += dt;
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
  const legBudget: RouteBudget = createRouteBudget();
  const krakenOccupant: Occupant | null =
    kraken === null
      ? null
      : { x: kraken.x, y: kraken.y, radiusCells: KRAKEN_BODY_RADIUS_CELLS };
  const goals = assignStationGoals(world, eroded, kraken, stationRadius);
  const squadronGoals = assignSquadronGoals(world, eroded, kraken, legBudget, dt);
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
  };

  let engaged = 0;
  for (let index = 0; index < boats.length; index++) {
    sailBoat(tick, index);
    if (boats[index].fighting) engaged++;
  }

  resolveOverlaps(world, eroded, kraken, step);

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

export function fleetSnapshot(): {
  villages: Village[];
  boats: Boat[];
  nextBoatId: number;
} {
  return { villages: [...villages.values()], boats: [...boats], nextBoatId };
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

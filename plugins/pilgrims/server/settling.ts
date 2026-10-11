import {
  ROUTE_NODE_BUDGET,
  ROUTE_SEARCH_MARGIN_CELLS,
  cellsAcross,
  createRouteBudget,
  floodReachableRegion,
  climbWireOf,
  advanceStillness,
  newStillness,
  stanceWireOf,
} from '@terrace/shared';
import type { ClimbState, Occupant, ReachableRegion, RouteBudget, RouteCell } from '@terrace/shared';
import { SETTLERS_CAP, hashCell, settlementRace, type PilgrimEntityState } from '../protocol.ts';
import type { SettlerRace } from '../protocol.ts';
import {
  ARRIVAL_RADIUS_CELLS,
  PILGRIM_STUCK_SECONDS,
  PILGRIM_WALKER_PROFILE,
  WalkerIdAllocator,
  advanceWalker,
  isWalkableCell,
  panicStep,
  planRoute,
  walkerOccupants,
  type MovingWalker,
  type PanickingWalker,
  type PilgrimWorld,
} from './pilgrimage.ts';
import { canFoundStructureAt, foundStructureAt } from './structures-bridge.ts';
import type { BridgedTemple } from './temples-bridge.ts';

export const SETTLER_DISPATCH_SECONDS = 25;

export const SETTLE_MIN_DISTANCE_CELLS = cellsAcross(4);

export const SETTLE_MAX_DISTANCE_CELLS = cellsAcross(20);

export const SETTLE_RING_SAMPLES = 48;

export const SETTLE_DISTANCE_STEPS = 16;

const SETTLE_REACHABILITY_MARGIN_CELLS = ROUTE_SEARCH_MARGIN_CELLS;

const SETTLE_SCAN_EXPANSION_POOL = ROUTE_NODE_BUDGET / 4;

const SETTLE_PROBE_EXPANSIONS = ROUTE_NODE_BUDGET / 16;

export const SETTLER_SITE_ATTEMPTS = 3;

const TEMPLE_KEY_STRIDE = 65536;

const HOMESTEAD_EDGE_CELLS = 2;

const HOMESTEAD_MIN_CELLS = 3;

interface SettleOrigin {
  readonly x: number;
  readonly y: number;
}

interface SettleSite {
  readonly x: number;
  readonly y: number;
  readonly goalX: number;
  readonly goalY: number;
}

function doorOf(temple: BridgedTemple): { x: number; y: number } {
  return { x: temple.doorX ?? temple.x + 0.5, y: temple.doorY ?? temple.y + 0.5 };
}

function scanSettleSites<T>(
  world: PilgrimWorld,
  origin: SettleOrigin,
  start: { readonly x: number; readonly y: number },
  roll: number,
  plan: (site: SettleSite, budget: RouteBudget) => T | null,
): { site: SettleSite; planned: T } | null {
  const bearingOffset = roll % SETTLE_RING_SAMPLES;
  const span = SETTLE_MAX_DISTANCE_CELLS - SETTLE_MIN_DISTANCE_CELLS;

  const ringReach = SETTLE_MAX_DISTANCE_CELLS + HOMESTEAD_EDGE_CELLS;
  const floodBounds = () => ({
    minX: Math.floor(Math.min(origin.x - ringReach, start.x)) - SETTLE_REACHABILITY_MARGIN_CELLS,
    minY: Math.floor(Math.min(origin.y - ringReach, start.y)) - SETTLE_REACHABILITY_MARGIN_CELLS,
    maxX: Math.floor(Math.max(origin.x + ringReach, start.x)) + SETTLE_REACHABILITY_MARGIN_CELLS,
    maxY: Math.floor(Math.max(origin.y + ringReach, start.y)) + SETTLE_REACHABILITY_MARGIN_CELLS,
  });
  let reachable: ReachableRegion | null = null;
  const probeBudget = createRouteBudget(SETTLE_PROBE_EXPANSIONS);
  const scanBudget = createRouteBudget(SETTLE_SCAN_EXPANSION_POOL);

  for (let s = 0; s < SETTLE_RING_SAMPLES; s++) {
    const bearing = ((bearingOffset + s) % SETTLE_RING_SAMPLES) / SETTLE_RING_SAMPLES;
    const angle = bearing * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    for (let d = 0; d < SETTLE_DISTANCE_STEPS; d++) {
      const distance =
        SETTLE_MIN_DISTANCE_CELLS + (span * d) / Math.max(1, SETTLE_DISTANCE_STEPS - 1);
      const anchorX = Math.floor(origin.x + cos * distance);
      const anchorY = Math.floor(origin.y + sin * distance);
      if (!isBlockSettleable(world, anchorX, anchorY)) continue;

      const site: SettleSite = {
        x: anchorX,
        y: anchorY,
        goalX: anchorX + HOMESTEAD_EDGE_CELLS / 2,
        goalY: anchorY + HOMESTEAD_EDGE_CELLS / 2,
      };
      if (reachable === null) {
        const probed = plan(site, probeBudget);
        if (probed !== null) return { site, planned: probed };
        reachable = floodReachableRegion(world, PILGRIM_WALKER_PROFILE, start, floodBounds());
      }
      if (!reachable.has(site.goalX, site.goalY)) continue;
      const planned = plan(site, scanBudget);
      if (planned !== null) return { site, planned };
    }
  }
  return null;
}

function isBlockSettleable(world: PilgrimWorld, anchorX: number, anchorY: number): boolean {
  for (let dy = 0; dy < HOMESTEAD_EDGE_CELLS; dy++) {
    for (let dx = 0; dx < HOMESTEAD_EDGE_CELLS; dx++) {
      const x = anchorX + dx;
      const y = anchorY + dy;
      if (!isWalkableCell(world, x, y)) return false;
      if (!canFoundStructureAt(world, x, y)) return false;
    }
  }
  return true;
}

export function canDispatchSettler(world: PilgrimWorld, temple: BridgedTemple): boolean {
  const door = doorOf(temple);
  if (!isWalkableCell(world, Math.floor(door.x), Math.floor(door.y))) return false;
  return (
    scanSettleSites(world, temple, door, 0, (site, budget) =>
      planRoute(world, door.x, door.y, site.goalX, site.goalY, budget),
    ) !== null
  );
}

interface Settler {
  readonly id: number;
  readonly race: SettlerRace;
  x: number;
  y: number;
  heading: number;
  goalX: number;
  goalY: number;
  siteX: number;
  siteY: number;
  readonly origin: SettleOrigin;
  readonly boundToTemple: boolean;
  attempts: number;
  stuckSeconds: number;
  panicSecondsRemaining: number;
  panicFromX: number;
  panicFromY: number;
  route: RouteCell[] | null;
  routeIndex: number;
  climb: ClimbState | null;
  stillSeconds: number;
  stillX: number;
  stillY: number;
}

function crowd(
  self: MovingWalker,
  population: readonly MovingWalker[],
  snapshot: readonly Occupant[],
  foreign: readonly Occupant[],
): Occupant[] {
  const rows: Occupant[] = [];
  for (let i = 0; i < population.length; i++) {
    if (population[i] !== self) rows.push(snapshot[i]);
  }
  for (const row of foreign) rows.push(row);
  return rows;
}

export class Settling {
  private readonly settlers = new Map<number, Settler>();
  private readonly ids: WalkerIdAllocator;
  private elapsedSeconds = 0;
  private rolledEpoch = -1;
  private templeKey: number | null = null;

  constructor(ids?: WalkerIdAllocator) {
    this.ids = ids ?? new WalkerIdAllocator();
  }

  advance(
    world: PilgrimWorld,
    temple: BridgedTemple | null,
    dt: number,
    occupants: readonly Occupant[] = [],
  ): void {
    const key = temple === null ? null : temple.y * TEMPLE_KEY_STRIDE + temple.x;
    if (key !== this.templeKey) {
      this.templeKey = key;
      this.elapsedSeconds = 0;
      this.rolledEpoch = -1;
    }

    this.elapsedSeconds += dt;

    const epoch = Math.floor(this.elapsedSeconds / SETTLER_DISPATCH_SECONDS);
    if (epoch > this.rolledEpoch) {
      this.rolledEpoch = epoch;
      if (temple !== null) this.dispatch(world, temple, epoch);
    }

    const own = [...this.settlers.values()];
    const ownCrowd = walkerOccupants(own);

    for (const settler of this.settlers.values()) {
      advanceStillness(settler, dt);

      if (panicStep(world, settler, dt, crowd(settler, own, ownCrowd, occupants))) continue;

      const advance = advanceWalker(
        world,
        settler,
        dt,
        crowd(settler, own, ownCrowd, occupants),
      );
      if (advance === 'fell') {
        this.settlers.delete(settler.id);
        continue;
      }
      if (advance === 'progressed') settler.stuckSeconds = 0;
      else settler.stuckSeconds += dt;

      const dx = settler.goalX - settler.x;
      const dy = settler.goalY - settler.y;
      if (dx * dx + dy * dy <= ARRIVAL_RADIUS_CELLS * ARRIVAL_RADIUS_CELLS) {
        this.arrive(world, settler, temple, epoch);
        continue;
      }

      if (settler.stuckSeconds >= PILGRIM_STUCK_SECONDS) {
        this.retryOrRetire(world, settler, temple, epoch);
      }
    }
  }

  private arrive(
    world: PilgrimWorld,
    settler: Settler,
    temple: BridgedTemple | null,
    epoch: number,
  ): void {
    let raised = 0;
    for (let dy = 0; dy < HOMESTEAD_EDGE_CELLS; dy++) {
      for (let dx = 0; dx < HOMESTEAD_EDGE_CELLS; dx++) {
        if (foundStructureAt(world, settler.siteX + dx, settler.siteY + dy)) raised++;
      }
    }

    if (raised >= HOMESTEAD_MIN_CELLS) {
      this.settlers.delete(settler.id);
      return;
    }
    this.retryOrRetire(world, settler, temple, epoch);
  }

  private retryOrRetire(
    world: PilgrimWorld,
    settler: Settler,
    temple: BridgedTemple | null,
    epoch: number,
  ): void {
    if (settler.attempts >= SETTLER_SITE_ATTEMPTS) {
      this.settlers.delete(settler.id);
      return;
    }
    if (settler.boundToTemple && temple === null) {
      this.settlers.delete(settler.id);
      return;
    }

    const found = scanSettleSites(
      world,
      settler.origin,
      settler,
      hashCell(epoch, settler.id + settler.attempts),
      (candidate, budget) =>
        planRoute(world, settler.x, settler.y, candidate.goalX, candidate.goalY, budget),
    );
    if (found === null) {
      this.settlers.delete(settler.id);
      return;
    }
    const { site, planned: route } = found;

    settler.siteX = site.x;
    settler.siteY = site.y;
    settler.goalX = site.goalX;
    settler.goalY = site.goalY;
    settler.attempts++;
    settler.stuckSeconds = 0;
    settler.route = route;
    settler.routeIndex = 0;
  }

  private dispatch(world: PilgrimWorld, temple: BridgedTemple, epoch: number): void {
    if (this.settlers.size >= SETTLERS_CAP) return;

    const roll = hashCell(hashCell(temple.x, temple.y) ^ epoch, epoch);
    const door = doorOf(temple);
    const { x: doorX, y: doorY } = door;
    const found = scanSettleSites(world, temple, door, roll, (candidate, budget) =>
      planRoute(world, doorX, doorY, candidate.goalX, candidate.goalY, budget),
    );
    if (found === null) return;
    const { site, planned: route } = found;

    const id = this.ids.allocate();
    this.settlers.set(id, {
      id,
      race: settlementRace(temple.x, temple.y),
      x: doorX,
      y: doorY,
      heading: Math.atan2(site.goalY - doorY, site.goalX - doorX),
      goalX: site.goalX,
      goalY: site.goalY,
      siteX: site.x,
      siteY: site.y,
      origin: { x: temple.x, y: temple.y },
      boundToTemple: true,
      attempts: 1,
      stuckSeconds: 0,
      ...newStillness(doorX, doorY),
      panicSecondsRemaining: 0,
      panicFromX: 0,
      panicFromY: 0,
      route,
      routeIndex: 0,
      climb: null,
    });
  }

  emitFrom(world: PilgrimWorld, x: number, y: number): boolean {
    if (this.settlers.size >= SETTLERS_CAP) return false;

    const origin: SettleOrigin = { x, y };
    const startX = x + 0.5;
    const startY = y + 0.5;

    const id = this.ids.allocate();
    const found = scanSettleSites(
      world,
      origin,
      { x: startX, y: startY },
      hashCell(hashCell(x, y), id),
      (candidate, budget) =>
        planRoute(world, startX, startY, candidate.goalX, candidate.goalY, budget),
    );
    if (found === null) return false;
    const { site, planned: route } = found;

    this.settlers.set(id, {
      id,
      race: settlementRace(x, y),
      x: startX,
      y: startY,
      heading: Math.atan2(site.goalY - startY, site.goalX - startX),
      goalX: site.goalX,
      goalY: site.goalY,
      siteX: site.x,
      siteY: site.y,
      origin,
      boundToTemple: false,
      attempts: 1,
      stuckSeconds: 0,
      ...newStillness(startX, startY),
      panicSecondsRemaining: 0,
      panicFromX: 0,
      panicFromY: 0,
      route,
      routeIndex: 0,
      climb: null,
    });
    return true;
  }

  states(): PilgrimEntityState[] {
    const rows: PilgrimEntityState[] = [];
    for (const settler of this.settlers.values()) {
      rows.push({
        id: settler.id,
        kind: 'settler',
        race: settler.race,
        x: settler.x,
        y: settler.y,
        heading: settler.heading,
        ...climbWireOf(settler.climb),
        ...stanceWireOf(settler),
      });
    }
    return rows;
  }

  populationCount(): number {
    return this.settlers.size;
  }

  walkers(): readonly PanickingWalker[] {
    return [...this.settlers.values()];
  }

  remove(id: number): boolean {
    return this.settlers.delete(id);
  }

  clear(): void {
    this.settlers.clear();
    this.elapsedSeconds = 0;
    this.rolledEpoch = -1;
    this.templeKey = null;
  }
}

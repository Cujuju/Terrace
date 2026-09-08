import {
  WORLD_UNIT_CELLS,
  cellsAcross,
  climbWireOf,
  advanceStillness,
  newStillness,
  stanceWireOf,
} from '@terrace/shared';
import type { ClimbState, Occupant, RouteCell } from '@terrace/shared';
import { WANDERERS_CAP, hashCell, settlementRace, type PilgrimEntityState } from '../protocol.ts';
import {
  ARRIVAL_RADIUS_CELLS,
  PILGRIM_STUCK_SECONDS,
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
import type { SettlerRace } from '../protocol.ts';

export const WANDERER_MIN_AGE_GENERATIONS = 4;

function isEstablished(cell: SettlementCell): boolean {
  return (cell.age ?? Infinity) >= WANDERER_MIN_AGE_GENERATIONS;
}

export const WANDER_EPOCH_SECONDS = 60;

export const WANDER_DISPATCH_MODULUS = 4;

export const WANDER_MIN_DISTANCE_CELLS = cellsAcross(8);

export const WANDER_RANGE_CELLS = cellsAcross(48);

export const WANDERER_VISIT_SECONDS = 10;

type WandererLeg = 'outbound' | 'visiting' | 'homebound';

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

interface Wanderer {
  readonly id: number;
  readonly race: SettlerRace;
  readonly homeX: number;
  readonly homeY: number;
  x: number;
  y: number;
  heading: number;
  leg: WandererLeg;
  goalX: number;
  goalY: number;
  visitSeconds: number;
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

interface SettlementCell {
  readonly x: number;
  readonly y: number;
  readonly age?: number;
}

export class Wandering {
  private readonly wanderers = new Map<number, Wanderer>();
  private readonly ids: WalkerIdAllocator;
  private readonly dispatchModulus: number;
  private elapsedSeconds = 0;
  private rolledEpoch = -1;

  constructor(ids?: WalkerIdAllocator, dispatchModulus: number = WANDER_DISPATCH_MODULUS) {
    this.ids = ids ?? new WalkerIdAllocator();
    this.dispatchModulus = dispatchModulus;
  }

  advance(
    world: PilgrimWorld,
    settlements: ReadonlyArray<SettlementCell>,
    dt: number,
    occupants: readonly Occupant[] = [],
  ): void {
    this.elapsedSeconds += dt;

    const epoch = Math.floor(this.elapsedSeconds / WANDER_EPOCH_SECONDS);
    if (epoch > this.rolledEpoch) {
      this.rolledEpoch = epoch;
      this.dispatch(world, settlements, epoch);
    }

    const own = [...this.wanderers.values()];
    const ownCrowd = walkerOccupants(own);

    for (const wanderer of this.wanderers.values()) {
      advanceStillness(wanderer, dt);

      if (panicStep(world, wanderer, dt, crowd(wanderer, own, ownCrowd, occupants))) continue;

      if (wanderer.leg === 'visiting') {
        wanderer.visitSeconds += dt;
        if (wanderer.visitSeconds >= WANDERER_VISIT_SECONDS) {
          wanderer.leg = 'homebound';
          wanderer.goalX = wanderer.homeX + 0.5;
          wanderer.goalY = wanderer.homeY + 0.5;
          wanderer.stuckSeconds = 0;
          wanderer.route = planRoute(world, wanderer.x, wanderer.y, wanderer.goalX, wanderer.goalY);
          wanderer.routeIndex = 0;
        }
        continue;
      }

      const advance = advanceWalker(world, wanderer, dt, crowd(wanderer, own, ownCrowd, occupants));
      if (advance === 'fell') {
        this.wanderers.delete(wanderer.id);
        continue;
      }
      if (advance === 'progressed') wanderer.stuckSeconds = 0;
      else wanderer.stuckSeconds += dt;

      const afterDx = wanderer.goalX - wanderer.x;
      const afterDy = wanderer.goalY - wanderer.y;
      const after = afterDx * afterDx + afterDy * afterDy;

      if (after <= ARRIVAL_RADIUS_CELLS * ARRIVAL_RADIUS_CELLS) {
        if (wanderer.leg === 'outbound') {
          wanderer.leg = 'visiting';
          wanderer.visitSeconds = 0;
        } else {
          this.wanderers.delete(wanderer.id);
        }
        continue;
      }

      if (wanderer.stuckSeconds >= PILGRIM_STUCK_SECONDS) {
        if (wanderer.leg === 'outbound') {
          wanderer.leg = 'homebound';
          wanderer.goalX = wanderer.homeX + 0.5;
          wanderer.goalY = wanderer.homeY + 0.5;
          wanderer.stuckSeconds = 0;
          wanderer.route = planRoute(world, wanderer.x, wanderer.y, wanderer.goalX, wanderer.goalY);
          wanderer.routeIndex = 0;
        } else {
          this.wanderers.delete(wanderer.id);
        }
      }
    }
  }

  private dispatch(
    world: PilgrimWorld,
    settlements: ReadonlyArray<SettlementCell>,
    epoch: number,
  ): void {
    const ordered = [...settlements].sort((a, b) => a.y - b.y || a.x - b.x);

    for (const cell of ordered) {
      if (this.wanderers.size >= WANDERERS_CAP) break;
      if (!isEstablished(cell)) continue;
      if (!isWalkableCell(world, cell.x, cell.y)) continue;
      if (this.hasWandererFrom(cell.x, cell.y)) continue;

      const roll = hashCell(hashCell(cell.x, cell.y) ^ epoch, epoch);
      if (roll % this.dispatchModulus !== 0) continue;

      const candidates = ordered
        .map((other) => {
          const dx = other.x - cell.x;
          const dy = other.y - cell.y;
          return { other, distanceSq: dx * dx + dy * dy };
        })
        .filter(
          (c) =>
            c.distanceSq >= WANDER_MIN_DISTANCE_CELLS * WANDER_MIN_DISTANCE_CELLS &&
            c.distanceSq <= WANDER_RANGE_CELLS * WANDER_RANGE_CELLS &&
            isWalkableCell(world, c.other.x, c.other.y),
        )
        .sort(
          (a, b) => a.distanceSq - b.distanceSq || a.other.y - b.other.y || a.other.x - b.other.x,
        );
      if (candidates.length === 0) continue;

      const destination = candidates[(roll >>> 8) % candidates.length].other;
      const homeX = cell.x + 0.5;
      const homeY = cell.y + 0.5;
      const goalX = destination.x + 0.5;
      const goalY = destination.y + 0.5;

      const route = planRoute(world, homeX, homeY, goalX, goalY);
      if (route === null) continue;

      const id = this.ids.allocate();
      this.wanderers.set(id, {
        id,
        race: settlementRace(cell.x, cell.y),
        homeX: cell.x,
        homeY: cell.y,
        x: homeX,
        y: homeY,
        heading: Math.atan2(goalY - homeY, goalX - homeX),
        leg: 'outbound',
        goalX,
        goalY,
        visitSeconds: 0,
        stuckSeconds: 0,
        ...newStillness(homeX, homeY),
        panicSecondsRemaining: 0,
        panicFromX: 0,
        panicFromY: 0,
        route,
        routeIndex: 0,
      climb: null,
      });
    }
  }

  private hasWandererFrom(homeX: number, homeY: number): boolean {
    for (const wanderer of this.wanderers.values()) {
      if (wanderer.homeX === homeX && wanderer.homeY === homeY) return true;
    }
    return false;
  }

  states(): PilgrimEntityState[] {
    const rows: PilgrimEntityState[] = [];
    for (const wanderer of this.wanderers.values()) {
      rows.push({
        id: wanderer.id,
        kind: 'wanderer',
        race: wanderer.race,
        x: wanderer.x,
        y: wanderer.y,
        heading: wanderer.heading,
        ...climbWireOf(wanderer.climb),
        ...stanceWireOf(wanderer),
      });
    }
    return rows;
  }

  populationCount(): number {
    return this.wanderers.size;
  }

  walkers(): readonly PanickingWalker[] {
    return [...this.wanderers.values()];
  }

  routes(): ReadonlyArray<{ readonly homeX: number; readonly homeY: number; readonly cells: RouteCell[] }> {
    const rows: Array<{ homeX: number; homeY: number; cells: RouteCell[] }> = [];
    for (const wanderer of this.wanderers.values()) {
      if (wanderer.route !== null) {
        rows.push({ homeX: wanderer.homeX, homeY: wanderer.homeY, cells: wanderer.route });
      }
    }
    return rows;
  }

  remove(id: number): boolean {
    return this.wanderers.delete(id);
  }

  clear(): void {
    this.wanderers.clear();
    this.elapsedSeconds = 0;
    this.rolledEpoch = -1;
  }
}

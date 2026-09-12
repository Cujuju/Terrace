import {
  CELL_CENTRE_OFFSET,
  advanceClimb,
  approachAndClimb as sharedApproachAndClimb,
  climbSeed,
  climbingWalkerProfile,
  isClimbStep,
  ROUTE_NODE_BUDGET,
  WORLD_UNIT_CELLS,
  cellsAcross,
  createRouteBudget,
  findRoute,
  findRouteWithStatus,
  followRoute,
  isWalkableCell as sharedIsWalkableCell,
  steerWithShorteningProbe,
  type FreshwaterMap,
  type ClimbState,
  type Occupant,
  type RouteBudget,
  type RouteCell,
  type RoutedMover,
  type TraversalProfile,
  climbWireOf,
  advanceStillness,
  newStillness,
  stanceWireOf,
} from '@terrace/shared';
import {
  PILGRIMS_CAP,
  settlementRace,
  type PilgrimEntityState,
  type SettlerRace,
} from '../protocol.ts';

export interface PilgrimWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  readonly freshwater?: FreshwaterMap;
}

export const MONSTER_SETTLED_RADIUS_CELLS = cellsAcross(16);

export const PILGRIMAGE_ONSET_SECONDS = 120;

export const PILGRIMAGE_CATCHMENT_CELLS = cellsAcross(64);

export const VIEWPOINT_RING_CELLS = MONSTER_SETTLED_RADIUS_CELLS + cellsAcross(8);

export const VIEWPOINT_RING_SAMPLES = 16;

export const PILGRIM_WALK_SPEED_CELLS_PER_SECOND = cellsAcross(0.5);

export const PILGRIM_LINGER_SECONDS = 30;

export const PILGRIM_STUCK_SECONDS = 20;

export const LOOKAHEAD_SECONDS = 0.6;

export const ARRIVAL_RADIUS_CELLS = cellsAcross(0.75);

export const PILGRIM_DISPATCH_EXPANSION_POOL = ROUTE_NODE_BUDGET;

/** Trial expansions per pilgrim search (~2ms). Catchment-local and homebound
 * routes complete far below this; maze searches exhaust the trial and defer
 * instead of eating a full pool solo. Callers that pass a real pool keep
 * exact fallback semantics (see planRoute). */
export const PILGRIM_ROUTE_TRIAL_EXPANSIONS = 1024;

const SETTLEMENT_KEY_STRIDE = 65536;

interface CatchmentMemo {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly unroutable: Set<number>;
}

interface AnchorRecord {
  x: number;
  y: number;
  settledSeconds: number;
}

export interface SettledMonster {
  readonly monsterId: number;
  readonly x: number;
  readonly y: number;
}

export class SettlednessTracker {
  private readonly anchors = new Map<number, AnchorRecord>();

  advance(
    monsters: ReadonlyArray<{ readonly id: number; readonly x: number; readonly y: number }>,
    dt: number,
  ): SettledMonster[] {
    const seen = new Set<number>();
    const settled: SettledMonster[] = [];

    for (const monster of monsters) {
      seen.add(monster.id);
      const anchor = this.anchors.get(monster.id);
      if (anchor === undefined) {
        this.anchors.set(monster.id, { x: monster.x, y: monster.y, settledSeconds: 0 });
        continue;
      }
      const dx = monster.x - anchor.x;
      const dy = monster.y - anchor.y;
      if (dx * dx + dy * dy > MONSTER_SETTLED_RADIUS_CELLS * MONSTER_SETTLED_RADIUS_CELLS) {
        anchor.x = monster.x;
        anchor.y = monster.y;
        anchor.settledSeconds = 0;
        continue;
      }
      anchor.settledSeconds += dt;
      if (anchor.settledSeconds >= PILGRIMAGE_ONSET_SECONDS) {
        settled.push({ monsterId: monster.id, x: anchor.x, y: anchor.y });
      }
    }

    for (const id of this.anchors.keys()) {
      if (!seen.has(id)) this.anchors.delete(id);
    }
    return settled;
  }

  clear(): void {
    this.anchors.clear();
  }
}

export const PILGRIM_CLIMB_FALL_CHANCE = 0.15;

export const PILGRIM_WALKER_PROFILE: TraversalProfile = climbingWalkerProfile(PILGRIM_CLIMB_FALL_CHANCE);

export function isWalkableCell(world: PilgrimWorld, x: number, y: number): boolean {
  return sharedIsWalkableCell(world, PILGRIM_WALKER_PROFILE, x, y);
}

export function pickViewpoint(
  world: PilgrimWorld,
  anchorX: number,
  anchorY: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestHeight = -Infinity;
  for (let i = 0; i < VIEWPOINT_RING_SAMPLES; i++) {
    const angle = (i / VIEWPOINT_RING_SAMPLES) * 2 * Math.PI;
    const x = Math.floor(anchorX + Math.cos(angle) * VIEWPOINT_RING_CELLS);
    const y = Math.floor(anchorY + Math.sin(angle) * VIEWPOINT_RING_CELLS);
    if (!isWalkableCell(world, x, y)) continue;
    const height = world.heightAt(x, y);
    if (height > bestHeight) {
      bestHeight = height;
      best = { x: x + 0.5, y: y + 0.5 };
    }
  }
  return best;
}

export function planRoute(
  world: PilgrimWorld,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  budget?: RouteBudget,
): RouteCell[] | null {
  const trial = createRouteBudget(PILGRIM_ROUTE_TRIAL_EXPANSIONS);
  const attempt = findRouteWithStatus(
    world,
    PILGRIM_WALKER_PROFILE,
    { x: fromX, y: fromY },
    { x: toX, y: toY },
    trial,
  );
  if (attempt.status !== 'exhausted') {
    return attempt.plan === null ? null : [...attempt.plan.cells];
  }
  if (budget === undefined) return null;
  const plan = findRoute(
    world,
    PILGRIM_WALKER_PROFILE,
    { x: fromX, y: fromY },
    { x: toX, y: toY },
    budget,
  );
  return plan === null ? null : [...plan.cells];
}

export type PilgrimLeg = 'outbound' | 'lingering' | 'homebound';

export class WalkerIdAllocator {
  private next = 1;

  allocate(): number {
    return this.next++;
  }

  reset(): void {
    this.next = 1;
  }
}

export interface Pilgrim {
  readonly id: number;
  readonly race: SettlerRace;
  readonly homeX: number;
  readonly homeY: number;
  readonly monsterId: number;
  x: number;
  y: number;
  heading: number;
  leg: PilgrimLeg;
  goalX: number;
  goalY: number;
  lingerSeconds: number;
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

export interface MovingWalker {
  x: number;
  y: number;
  heading: number;
  goalX: number;
  goalY: number;
  climb: ClimbState | null;
  stillSeconds: number;
  stillX: number;
  stillY: number;
}

export type WalkerAdvance = 'progressed' | 'held' | 'fell';

export interface RoutedWalker extends MovingWalker, RoutedMover {}

export const WALKER_PERSONAL_SPACE_CELLS = cellsAcross(0.17);

export function walkerOccupants(walkers: Iterable<MovingWalker>): Occupant[] {
  const rows: Occupant[] = [];
  for (const walker of walkers) {
    rows.push({ x: walker.x, y: walker.y, radiusCells: WALKER_PERSONAL_SPACE_CELLS });
  }
  return rows;
}

function crowdAround(
  self: MovingWalker,
  population: readonly MovingWalker[],
  crowd: readonly Occupant[],
  foreign: readonly Occupant[],
): Occupant[] {
  const rows: Occupant[] = [];
  for (let i = 0; i < population.length; i++) {
    if (population[i] !== self) rows.push(crowd[i]);
  }
  for (const row of foreign) rows.push(row);
  return rows;
}

function lookaheadCells(): number {
  return PILGRIM_WALK_SPEED_CELLS_PER_SECOND * LOOKAHEAD_SECONDS;
}

export function stepWalker(
  world: PilgrimWorld,
  pilgrim: MovingWalker,
  dt: number,
  targetX: number = pilgrim.goalX,
  targetY: number = pilgrim.goalY,
  occupants: readonly Occupant[] = [],
  permits?: (x: number, y: number) => boolean,
): void {
  const desired = Math.atan2(targetY - pilgrim.y, targetX - pilgrim.x);
  const stepCells = PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt;
  const heading = steerWithShorteningProbe(
    world,
    PILGRIM_WALKER_PROFILE,
    pilgrim,
    desired,
    lookaheadCells(),
    { stepCells, occupants, selfRadiusCells: WALKER_PERSONAL_SPACE_CELLS, permits },
  );
  if (heading === null) return;

  pilgrim.heading = heading;
  pilgrim.x += Math.cos(heading) * stepCells;
  pilgrim.y += Math.sin(heading) * stepCells;
}

export function advanceWalker(
  world: PilgrimWorld,
  walker: RoutedWalker,
  dt: number,
  occupants: readonly Occupant[] = [],
): WalkerAdvance {
  if (walker.climb !== null) {
    const outcome = advanceClimb(walker, dt);
    if (outcome === 'fallen') return 'fell';
    if (outcome === 'arrived') walker.climb = null;
    return 'progressed';
  }

  const climbing = climbTowardWall(world, walker, routeClimbTargetOf(world, walker), dt);
  if (climbing !== null) return climbing;

  const wasX = walker.x;
  const wasY = walker.y;
  const result = followRoute(world, PILGRIM_WALKER_PROFILE, walker, {
    stepCells: PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt,
    lookaheadCells: lookaheadCells(),
    goalX: walker.goalX,
    goalY: walker.goalY,
    occupants,
    selfRadiusCells: WALKER_PERSONAL_SPACE_CELLS,
    replanNodeBudget: PILGRIM_ROUTE_TRIAL_EXPANSIONS,
  });
  if (result.progressed) return 'progressed';

  if (walker.x !== wasX || walker.y !== wasY) return 'held';
  return climbTowardWall(world, walker, goalwardNeighbourOf(walker), dt) ?? 'held';
}

function climbTowardWall(
  world: PilgrimWorld,
  walker: RoutedWalker,
  target: RouteCell | null,
  dt: number,
): WalkerAdvance | null {
  if (target === null) return null;
  const outcome = sharedApproachAndClimb(
    world,
    PILGRIM_WALKER_PROFILE,
    walker,
    target,
    PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt,
    climbSeedFor(walker, target),
  );
  return outcome === null ? null : 'progressed';
}

function routeClimbTargetOf(world: PilgrimWorld, walker: RoutedWalker): RouteCell | null {
  const route = walker.route;
  if (route === null) return null;
  const next = route[walker.routeIndex + 1];
  if (next === undefined) return null;

  const cellX = Math.floor(walker.x);
  const cellY = Math.floor(walker.y);
  const dx = next.x - cellX;
  const dy = next.y - cellY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return null;

  if (dx !== 0 && dy !== 0) {
    const alongX = { x: cellX + dx, y: cellY };
    if (isClimbStep(world, PILGRIM_WALKER_PROFILE, walker.x, walker.y, alongX.x, alongX.y)) return alongX;
    const alongY = { x: cellX, y: cellY + dy };
    return isClimbStep(world, PILGRIM_WALKER_PROFILE, walker.x, walker.y, alongY.x, alongY.y)
      ? alongY
      : null;
  }
  return isClimbStep(world, PILGRIM_WALKER_PROFILE, walker.x, walker.y, next.x, next.y) ? next : null;
}

function goalwardNeighbourOf(walker: RoutedWalker): RouteCell | null {
  const dx = walker.goalX - walker.x;
  const dy = walker.goalY - walker.y;
  if (dx === 0 && dy === 0) return null;
  const cellX = Math.floor(walker.x);
  const cellY = Math.floor(walker.y);
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: cellX + Math.sign(dx), y: cellY }
    : { x: cellX, y: cellY + Math.sign(dy) };
}

function climbSeedFor(walker: RoutedWalker, target: RouteCell): number {
  return climbSeed(
    walker.routeIndex,
    Math.floor(walker.x),
    Math.floor(walker.y),
    target.x,
    target.y,
  );
}

export const WALKER_PANIC_SPEED_MULTIPLIER = 3;

export const WALKER_PANIC_SECONDS = 2.5;

export const FIRE_STARTLE_RADIUS_CELLS = Math.round(
  PILGRIM_WALK_SPEED_CELLS_PER_SECOND * WALKER_PANIC_SPEED_MULTIPLIER * WALKER_PANIC_SECONDS,
);

export interface PanickingWalker extends RoutedWalker {
  readonly id: number;
  stuckSeconds: number;
  panicSecondsRemaining: number;
  panicFromX: number;
  panicFromY: number;
}

export function panicStep(
  world: PilgrimWorld,
  walker: PanickingWalker,
  dt: number,
  occupants: readonly Occupant[] = [],
): boolean {
  if (walker.panicSecondsRemaining <= 0) return false;

  walker.panicSecondsRemaining = Math.max(0, walker.panicSecondsRemaining - dt);

  const awayX = walker.x - walker.panicFromX;
  const awayY = walker.y - walker.panicFromY;
  const fleeing = awayX !== 0 || awayY !== 0 ? Math.atan2(awayY, awayX) : walker.heading;
  const anchorDistanceSq = awayX * awayX + awayY * awayY;

  stepWalker(
    world,
    walker,
    dt * WALKER_PANIC_SPEED_MULTIPLIER,
    walker.x + Math.cos(fleeing) * FIRE_STARTLE_RADIUS_CELLS,
    walker.y + Math.sin(fleeing) * FIRE_STARTLE_RADIUS_CELLS,
    occupants,
    (x, y) => {
      const dx = x - walker.panicFromX;
      const dy = y - walker.panicFromY;
      return dx * dx + dy * dy > anchorDistanceSq;
    },
  );

  if (walker.panicSecondsRemaining <= 0) {
    walker.route = planRoute(world, walker.x, walker.y, walker.goalX, walker.goalY);
    walker.routeIndex = 0;
    walker.stuckSeconds = 0;
  }
  return true;
}

export function startleWalkersNear(
  walkers: Iterable<PanickingWalker>,
  centerX: number,
  centerY: number,
  radius: number,
): number {
  const radiusSquared = radius * radius;
  let startled = 0;

  for (const walker of walkers) {
    const dx = walker.x - centerX;
    const dy = walker.y - centerY;
    if (dx * dx + dy * dy > radiusSquared) continue;

    walker.panicFromX = centerX;
    walker.panicFromY = centerY;
    walker.panicSecondsRemaining = Math.max(walker.panicSecondsRemaining, WALKER_PANIC_SECONDS);
    startled++;
  }
  return startled;
}

export function panicWalkers(
  walkers: Iterable<PanickingWalker>,
  ids: readonly number[],
  seconds: number,
): number {
  if (seconds <= 0) return 0;

  let panicked = 0;
  for (const walker of walkers) {
    if (!ids.includes(walker.id)) continue;
    walker.panicFromX = walker.x;
    walker.panicFromY = walker.y;
    walker.panicSecondsRemaining = Math.max(walker.panicSecondsRemaining, seconds);
    panicked++;
  }
  return panicked;
}

function goalDistanceSq(pilgrim: Pilgrim): number {
  const dx = pilgrim.goalX - pilgrim.x;
  const dy = pilgrim.goalY - pilgrim.y;
  return dx * dx + dy * dy;
}

export class Pilgrimage {
  private readonly tracker = new SettlednessTracker();
  private readonly pilgrims = new Map<number, Pilgrim>();
  private readonly ids: WalkerIdAllocator;
  private readonly ownsIds: boolean;
  private readonly catchmentMemos = new Map<number, CatchmentMemo>();

  constructor(ids?: WalkerIdAllocator) {
    this.ids = ids ?? new WalkerIdAllocator();
    this.ownsIds = ids === undefined;
  }

  advance(
    world: PilgrimWorld,
    monsters: ReadonlyArray<{ readonly id: number; readonly x: number; readonly y: number }>,
    settlements: ReadonlyArray<{ readonly x: number; readonly y: number }>,
    dt: number,
    occupants: readonly Occupant[] = [],
  ): void {
    const settled = this.tracker.advance(monsters, dt);
    const settledById = new Map(settled.map((s) => [s.monsterId, s]));

    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.leg === 'homebound') continue;
      if (settledById.has(pilgrim.monsterId)) continue;
      pilgrim.leg = 'homebound';
      pilgrim.goalX = pilgrim.homeX + 0.5;
      pilgrim.goalY = pilgrim.homeY + 0.5;
      pilgrim.stuckSeconds = 0;
      pilgrim.route = planRoute(world, pilgrim.x, pilgrim.y, pilgrim.goalX, pilgrim.goalY);
      pilgrim.routeIndex = 0;
    }

    const dispatchBudget = createRouteBudget(PILGRIM_DISPATCH_EXPANSION_POOL);
    for (const monsterId of this.catchmentMemos.keys()) {
      if (!settledById.has(monsterId)) this.catchmentMemos.delete(monsterId);
    }

    let dispatchAllowanceSpent = false;

    for (const monster of settled) {
      if (dispatchAllowanceSpent) break;
      const viewpoint = pickViewpoint(world, monster.x, monster.y);
      if (viewpoint === null) continue;

      let memo = this.catchmentMemos.get(monster.monsterId);
      if (memo !== undefined && (memo.anchorX !== monster.x || memo.anchorY !== monster.y)) {
        this.catchmentMemos.delete(monster.monsterId);
        memo = undefined;
      }

      const candidates = settlements
        .map((cell) => {
          const dx = cell.x - monster.x;
          const dy = cell.y - monster.y;
          return { cell, distanceSq: dx * dx + dy * dy };
        })
        .filter((c) => c.distanceSq <= PILGRIMAGE_CATCHMENT_CELLS * PILGRIMAGE_CATCHMENT_CELLS)
        .sort(
          (a, b) =>
            a.distanceSq - b.distanceSq ||
            a.cell.y - b.cell.y ||
            a.cell.x - b.cell.x,
        );

      for (const { cell } of candidates) {
        if (this.pilgrims.size >= PILGRIMS_CAP) break;
        if (!isWalkableCell(world, cell.x, cell.y)) continue;
        if (this.hasPilgrimFrom(cell.x, cell.y, monster.monsterId)) continue;

        const settlementKey = cell.y * SETTLEMENT_KEY_STRIDE + cell.x;
        if (memo !== undefined && memo.unroutable.has(settlementKey)) continue;

        const homeX = cell.x + 0.5;
        const homeY = cell.y + 0.5;
        const allowanceBefore = dispatchBudget.remaining;
        const route = planRoute(world, homeX, homeY, viewpoint.x, viewpoint.y, dispatchBudget);
        if (route === null) {
          if (allowanceBefore < ROUTE_NODE_BUDGET) {
            dispatchAllowanceSpent = true;
            break;
          }
          if (memo === undefined) {
            memo = { anchorX: monster.x, anchorY: monster.y, unroutable: new Set<number>() };
            this.catchmentMemos.set(monster.monsterId, memo);
          }
          memo.unroutable.add(settlementKey);
          continue;
        }

        const id = this.ids.allocate();
        this.pilgrims.set(id, {
          id,
          race: settlementRace(cell.x, cell.y),
          homeX: cell.x,
          homeY: cell.y,
          monsterId: monster.monsterId,
          x: homeX,
          y: homeY,
          heading: Math.atan2(viewpoint.y - homeY, viewpoint.x - homeX),
          leg: 'outbound',
          goalX: viewpoint.x,
          goalY: viewpoint.y,
          lingerSeconds: 0,
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

    const own = [...this.pilgrims.values()];
    const ownCrowd = walkerOccupants(own);

    for (const pilgrim of this.pilgrims.values()) {
      advanceStillness(pilgrim, dt);

      if (panicStep(world, pilgrim, dt, crowdAround(pilgrim, own, ownCrowd, occupants))) continue;

      if (pilgrim.leg === 'lingering') {
        pilgrim.lingerSeconds += dt;
        const monster = settledById.get(pilgrim.monsterId);
        if (monster !== undefined) {
          pilgrim.heading = Math.atan2(monster.y - pilgrim.y, monster.x - pilgrim.x);
        }
        if (pilgrim.lingerSeconds >= PILGRIM_LINGER_SECONDS) {
          pilgrim.leg = 'homebound';
          pilgrim.goalX = pilgrim.homeX + 0.5;
          pilgrim.goalY = pilgrim.homeY + 0.5;
          pilgrim.stuckSeconds = 0;
          pilgrim.route = planRoute(world, pilgrim.x, pilgrim.y, pilgrim.goalX, pilgrim.goalY);
          pilgrim.routeIndex = 0;
        }
        continue;
      }

      const advance = advanceWalker(world, pilgrim, dt, crowdAround(pilgrim, own, ownCrowd, occupants));
      if (advance === 'fell') {
        this.pilgrims.delete(pilgrim.id);
        continue;
      }
      if (advance === 'progressed') pilgrim.stuckSeconds = 0;
      else pilgrim.stuckSeconds += dt;

      const after = goalDistanceSq(pilgrim);

      if (after <= ARRIVAL_RADIUS_CELLS * ARRIVAL_RADIUS_CELLS) {
        if (pilgrim.leg === 'outbound') {
          pilgrim.leg = 'lingering';
          pilgrim.lingerSeconds = 0;
        } else {
          this.pilgrims.delete(pilgrim.id);
        }
        continue;
      }

      if (pilgrim.stuckSeconds >= PILGRIM_STUCK_SECONDS) {
        if (pilgrim.leg === 'outbound') {
          pilgrim.leg = 'homebound';
          pilgrim.goalX = pilgrim.homeX + 0.5;
          pilgrim.goalY = pilgrim.homeY + 0.5;
          pilgrim.stuckSeconds = 0;
          pilgrim.route = planRoute(world, pilgrim.x, pilgrim.y, pilgrim.goalX, pilgrim.goalY);
          pilgrim.routeIndex = 0;
        } else {
          this.pilgrims.delete(pilgrim.id);
        }
      }
    }
  }

  private hasPilgrimFrom(homeX: number, homeY: number, monsterId: number): boolean {
    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.homeX === homeX && pilgrim.homeY === homeY && pilgrim.monsterId === monsterId) {
        return true;
      }
    }
    return false;
  }

  states(): PilgrimEntityState[] {
    const rows: PilgrimEntityState[] = [];
    for (const pilgrim of this.pilgrims.values()) {
      rows.push({
        id: pilgrim.id,
        kind: 'pilgrim',
        race: pilgrim.race,
        x: pilgrim.x,
        y: pilgrim.y,
        heading: pilgrim.heading,
        ...climbWireOf(pilgrim.climb),
        ...stanceWireOf(pilgrim),
      });
    }
    return rows;
  }

  blessedCellKeys(): number[] {
    const keys = new Set<number>();
    for (const pilgrim of this.pilgrims.values()) {
      keys.add(pilgrim.homeY * 65536 + pilgrim.homeX);
    }
    return [...keys];
  }

  populationCount(): number {
    return this.pilgrims.size;
  }

  walkers(): readonly PanickingWalker[] {
    return [...this.pilgrims.values()];
  }

  routes(): ReadonlyArray<{ readonly homeX: number; readonly homeY: number; readonly cells: RouteCell[] }> {
    const rows: Array<{ homeX: number; homeY: number; cells: RouteCell[] }> = [];
    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.route !== null) {
        rows.push({ homeX: pilgrim.homeX, homeY: pilgrim.homeY, cells: pilgrim.route });
      }
    }
    return rows;
  }

  remove(id: number): boolean {
    return this.pilgrims.delete(id);
  }

  forgetRouteFailures(): void {
    this.catchmentMemos.clear();
  }

  clear(): void {
    this.tracker.clear();
    this.pilgrims.clear();
    this.catchmentMemos.clear();
    if (this.ownsIds) this.ids.reset();
  }
}

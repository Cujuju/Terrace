import {
  WORLD_UNIT_CELLS,
  cellsAcross,
} from './constants.ts';
import { findRoute, type RouteCell } from './pathing.ts';
import { canProceedAlong, type TerrainSampler, type TraversalProfile } from './traversal.ts';

const TWO_PI = Math.PI * 2;

export function normalizeAngle(radians: number): number {
  const wrapped = radians % TWO_PI;
  if (wrapped > Math.PI) return wrapped - TWO_PI;
  if (wrapped <= -Math.PI) return wrapped + TWO_PI;
  return wrapped;
}

export function limitTurn(turn: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, turn));
}

export function turnToward(
  heading: number,
  target: number,
  radiansPerSecond: number,
  dt: number,
): number {
  const remaining = normalizeAngle(target - heading);
  return normalizeAngle(heading + limitTurn(remaining, radiansPerSecond * dt));
}

export const AVOID_TURN_ATTEMPTS = 8;

export const AVOID_TURN_STEP_RADIANS = Math.PI / 4;

export interface Mover {
  x: number;
  y: number;
  heading: number;
}

export interface Occupant {
  readonly x: number;
  readonly y: number;
  readonly radiusCells: number;
}

export interface SteerOptions {
  readonly stepCells: number;
  readonly occupants?: readonly Occupant[];
  readonly selfRadiusCells?: number;
  readonly attempts?: number;
  readonly stepRadians?: number;
  readonly permits?: (x: number, y: number, heading: number) => boolean;
}

function isClearOfOccupants(
  x: number,
  y: number,
  occupants: readonly Occupant[],
  selfRadiusCells: number,
): boolean {
  for (const occupant of occupants) {
    const dx = x - occupant.x;
    const dy = y - occupant.y;
    const clearance = selfRadiusCells + occupant.radiusCells;
    if (dx * dx + dy * dy < clearance * clearance) return false;
  }
  return true;
}

export function steerAvoiding(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: Mover,
  desired: number,
  lookaheadCells: number,
  options: SteerOptions,
): number | null {
  const attempts = options.attempts ?? AVOID_TURN_ATTEMPTS;
  const stepRadians = options.stepRadians ?? AVOID_TURN_STEP_RADIANS;
  const occupants = options.occupants ?? [];
  const selfRadius = options.selfRadiusCells ?? 0;
  const separates = occupants.length > 0;

  let crowded: number | null = null;

  for (let attempt = 0; attempt <= attempts; attempt++) {
    const magnitude = Math.ceil(attempt / 2) * stepRadians;
    const sign = attempt % 2 === 1 ? 1 : -1;
    const heading = desired + sign * magnitude;
    const aheadX = mover.x + Math.cos(heading) * lookaheadCells;
    const aheadY = mover.y + Math.sin(heading) * lookaheadCells;

    if (!canProceedAlong(world, profile, mover.x, mover.y, aheadX, aheadY)) continue;
    if (options.permits !== undefined && !options.permits(aheadX, aheadY, heading)) continue;
    if (separates) {
      const stepX = mover.x + Math.cos(heading) * options.stepCells;
      const stepY = mover.y + Math.sin(heading) * options.stepCells;
      if (!isClearOfOccupants(stepX, stepY, occupants, selfRadius)) {
        if (crowded === null) crowded = heading;
        continue;
      }
    }

    return normalizeAngle(heading);
  }

  return crowded === null ? null : normalizeAngle(crowded);
}

export const CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR = 2;

export function steerWithShorteningProbe(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: Mover,
  desired: number,
  lookaheadCells: number,
  options: SteerOptions,
): number | null {
  const full = steerAvoiding(world, profile, mover, desired, lookaheadCells, options);
  if (full !== null) return full;

  const { occupants: _ignored, ...alone } = options;

  const contour = steerAvoiding(
    world,
    profile,
    mover,
    mover.heading,
    lookaheadCells / CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR,
    alone,
  );
  if (contour !== null) return contour;

  return steerAvoiding(world, profile, mover, mover.heading, options.stepCells, alone);
}

export function withoutSelf<T>(occupants: readonly T[], self: T): readonly T[] {
  return occupants.filter((occupant) => occupant !== self);
}

export interface RoutedMover extends Mover {
  route: RouteCell[] | null;
  routeIndex: number;
}

const ROUTE_RESYNC_WINDOW_CELLS = cellsAcross(2);

const ROUTE_REJOIN_RADIUS_CELLS = 1;

function cellCentre(cell: RouteCell): { x: number; y: number } {
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

export interface FollowRouteOptions extends SteerOptions {
  readonly lookaheadCells: number;
  readonly goalX: number;
  readonly goalY: number;
  readonly replanNodeBudget?: number;
  readonly maxTurnRadians?: number;
  readonly aimAheadCells?: number;
}

export interface FollowRouteResult {
  readonly progressed: boolean;
  readonly arrived: boolean;
  readonly replanned: boolean;
}

export function followRoute(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: RoutedMover,
  options: FollowRouteOptions,
): FollowRouteResult {
  const stepOnce = (targetX: number, targetY: number): void => {
    const desired = Math.atan2(targetY - mover.y, targetX - mover.x);
    const heading = steerWithShorteningProbe(
      world,
      profile,
      mover,
      desired,
      options.lookaheadCells,
      options,
    );
    if (heading === null) return;
    if (options.maxTurnRadians === undefined) {
      mover.heading = heading;
      mover.x += Math.cos(heading) * options.stepCells;
      mover.y += Math.sin(heading) * options.stepCells;
      return;
    }
    const adopted = turnToward(mover.heading, heading, options.maxTurnRadians, 1);
    const stepX = mover.x + Math.cos(adopted) * options.stepCells;
    const stepY = mover.y + Math.sin(adopted) * options.stepCells;
    if (
      canProceedAlong(world, profile, mover.x, mover.y, stepX, stepY) &&
      (options.permits === undefined || options.permits(stepX, stepY, adopted))
    ) {
      mover.heading = adopted;
      mover.x = stepX;
      mover.y = stepY;
      return;
    }
    const backX = mover.x - Math.cos(mover.heading) * options.stepCells;
    const backY = mover.y - Math.sin(mover.heading) * options.stepCells;
    if (
      canProceedAlong(world, profile, mover.x, mover.y, backX, backY) &&
      (options.permits === undefined || options.permits(backX, backY, mover.heading))
    ) {
      mover.x = backX;
      mover.y = backY;
    }
  };

  if (mover.route === null || mover.route.length === 0) {
    const fromCellX = Math.floor(mover.x);
    const fromCellY = Math.floor(mover.y);
    stepOnce(options.goalX, options.goalY);
    const moved = Math.floor(mover.x) !== fromCellX || Math.floor(mover.y) !== fromCellY;
    return { progressed: moved, arrived: false, replanned: false };
  }

  const aimAheadCount = Math.max(1, Math.floor(options.aimAheadCells ?? 1));
  const cellX = Math.floor(mover.x);
  const cellY = Math.floor(mover.y);
  let progressed = false;
  const limit = Math.min(
    mover.routeIndex + Math.max(ROUTE_RESYNC_WINDOW_CELLS, aimAheadCount),
    mover.route.length - 1,
  );
  let synced = false;
  for (let i = mover.routeIndex + 1; i <= limit; i++) {
    if (mover.route[i].x === cellX && mover.route[i].y === cellY) {
      mover.routeIndex = i;
      progressed = true;
      synced = true;
      break;
    }
  }
  if (!synced && aimAheadCount > 1) {
    const rejoinRadiusSquared = ROUTE_REJOIN_RADIUS_CELLS * ROUTE_REJOIN_RADIUS_CELLS;
    for (let i = limit; i > mover.routeIndex; i--) {
      const centre = cellCentre(mover.route[i]);
      const dx = centre.x - mover.x;
      const dy = centre.y - mover.y;
      if (dx * dx + dy * dy <= rejoinRadiusSquared) {
        mover.routeIndex = i;
        progressed = true;
        break;
      }
    }
  }

  if (mover.routeIndex >= mover.route.length - 1) {
    stepOnce(options.goalX, options.goalY);
    return { progressed, arrived: true, replanned: false };
  }

  let current = cellCentre(mover.route[mover.routeIndex]);
  let next = cellCentre(mover.route[mover.routeIndex + 1]);
  let replanned = false;

  if (!isRouteEdgeStillLegal(world, profile, current, next)) {
    const plan = findRoute(
      world,
      profile,
      { x: mover.x, y: mover.y },
      { x: options.goalX, y: options.goalY },
      options.replanNodeBudget,
    );
    replanned = true;
    mover.route = plan === null ? null : [...plan.cells];
    mover.routeIndex = 0;
    if (mover.route === null || mover.route.length < 2) {
      stepOnce(options.goalX, options.goalY);
      return { progressed, arrived: false, replanned };
    }
    current = cellCentre(mover.route[0]);
    next = cellCentre(mover.route[1]);
  }

  const aimLimit = Math.min(mover.routeIndex + aimAheadCount, mover.route.length - 1);
  let aimX = next.x;
  let aimY = next.y;
  for (let k = aimLimit; k > mover.routeIndex + 1; k--) {
    const candidate = cellCentre(mover.route[k]);
    if (!canProceedAlong(world, profile, mover.x, mover.y, candidate.x, candidate.y)) continue;
    if (options.permits !== undefined) {
      const bearing = Math.atan2(candidate.y - mover.y, candidate.x - mover.x);
      if (!options.permits(candidate.x, candidate.y, bearing)) continue;
    }
    aimX = candidate.x;
    aimY = candidate.y;
    break;
  }

  stepOnce(aimX, aimY);
  return { progressed, arrived: false, replanned };
}

function isRouteEdgeStillLegal(
  world: TerrainSampler,
  profile: TraversalProfile,
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return canProceedAlong(world, profile, from.x, from.y, to.x, to.y);
}

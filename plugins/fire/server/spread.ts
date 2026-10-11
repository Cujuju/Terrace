import { BAND_HEIGHT } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import {
  fireEntityKey,
  fireIntensity,
  fireKey,
  type FireCellState,
  type FireEntityState,
} from '../protocol.ts';
import type { Blaze } from './blaze.ts';
import type { EntityBlaze } from './entityBlaze.ts';
import { entityFuelSources, type FlammableIndividual } from './entityFuel.ts';
import { HeatLedger } from './heat.ts';
import { currentWind, precipitationAt } from './weather-bridge.ts';

export interface SpreadSource {
  readonly x: number;
  readonly y: number;
  readonly ageSeconds: number;
  readonly burnSeconds: number;
}

export const SPREAD_INTERVAL_SECONDS = 1;

export const BASE_SPREAD_RATE_PER_SECOND = 0.14;

export const SPREAD_MIN_INTENSITY = 0.35;

export const WIND_DOWNWIND_MULTIPLIER = 2;

export const WIND_REFERENCE_SPEED_CELLS_PER_SECOND = 2;

export const WIND_UPWIND_FLOOR = 0.2;

export const SLOPE_UPHILL_MULTIPLIER_PER_BAND = 1.6;

export const SLOPE_CLAMP_BANDS = 2;

export const WET_SPREAD_PENALTY = 0.9;

export const SPREAD_REACH_CELLS = Math.SQRT2;

export const SPREAD_MIN_DISTANCE_CELLS = 1;

export const CONTACT_IGNITION_SECONDS = 0.15;

export const CONTACT_SPREAD_RATE_PER_SECOND = 1 / CONTACT_IGNITION_SECONDS;

function distanceFactor(distanceCells: number): number {
  if (distanceCells >= SPREAD_MIN_DISTANCE_CELLS) return SPREAD_MIN_DISTANCE_CELLS / distanceCells;

  const contactFactor = CONTACT_SPREAD_RATE_PER_SECOND / BASE_SPREAD_RATE_PER_SECOND;
  const towardsContact =
    (SPREAD_MIN_DISTANCE_CELLS - Math.max(0, distanceCells)) / SPREAD_MIN_DISTANCE_CELLS;
  return 1 + (contactFactor - 1) * towardsContact;
}

function cellOf(value: number): number {
  return Math.round(value);
}

const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

function windFactor(dx: number, dy: number, heading: number, speed: number): number {
  if (speed <= 0) return 1;

  const stepLength = Math.hypot(dx, dy);
  if (stepLength === 0) return 1;

  const alignment = (dx * Math.cos(heading) + dy * Math.sin(heading)) / stepLength;
  const strength = Math.min(1, speed / WIND_REFERENCE_SPEED_CELLS_PER_SECOND);
  const factor = 1 + alignment * strength * (WIND_DOWNWIND_MULTIPLIER - 1);
  return Math.max(WIND_UPWIND_FLOOR, factor);
}

function slopeFactor(fromHeight: number, toHeight: number): number {
  const bands = (toHeight - fromHeight) / BAND_HEIGHT;
  const clamped = Math.max(-SLOPE_CLAMP_BANDS, Math.min(SLOPE_CLAMP_BANDS, bands));
  return Math.pow(SLOPE_UPHILL_MULTIPLIER_PER_BAND, clamped);
}

function spreadingIntensity(source: SpreadSource): number {
  const intensity = fireIntensity(source.ageSeconds, source.burnSeconds);
  return intensity < SPREAD_MIN_INTENSITY ? 0 : intensity;
}

export function spreadRate(
  world: WorldApi,
  from: SpreadSource,
  to: { readonly x: number; readonly y: number },
  wind: { readonly heading: number; readonly speed: number },
  gapCells?: number,
): number {
  const intensity = spreadingIntensity(from);
  if (intensity === 0) return 0;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const gap = gapCells ?? Math.hypot(dx, dy);
  if (gap > SPREAD_REACH_CELLS) return 0;

  const wetFactor = 1 - WET_SPREAD_PENALTY * precipitationAt(cellOf(to.x), cellOf(to.y));
  return (
    BASE_SPREAD_RATE_PER_SECOND *
    intensity *
    windFactor(dx, dy, wind.heading, wind.speed) *
    slopeFactor(
      world.heightAt(cellOf(from.x), cellOf(from.y)),
      world.heightAt(cellOf(to.x), cellOf(to.y)),
    ) *
    distanceFactor(gap) *
    wetFactor
  );
}

export interface SpreadResult {
  readonly cells: FireCellState[];
  readonly entities: FireEntityState[];
}

const SELF_AND_NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  ...NEIGHBOUR_OFFSETS,
];

function flammableNow(): FlammableIndividual[] {
  const found: FlammableIndividual[] = [];
  for (const source of entityFuelSources()) {
    if (source.flammable === undefined) continue;
    for (const individual of source.flammable()) {
      if (individual.fuel.burnSeconds <= 0) continue;
      if (!Number.isFinite(individual.x) || !Number.isFinite(individual.y)) continue;
      found.push(individual);
    }
  }
  return found;
}

interface Position {
  readonly x: number;
  readonly y: number;
}

let previousSweep = new Map<string, Position>();

const heatLedger = new HeatLedger();

export function resetSpreadSweep(): void {
  previousSweep.clear();
  heatLedger.clear();
}

function whereItWas(sourceName: string, id: number, now: Position): Position {
  return previousSweep.get(fireEntityKey(sourceName, id)) ?? now;
}

function stoodStill(at: Position): Position {
  return at;
}

const SPREAD_BUCKET_CELLS = 4;

interface SweptCandidate {
  readonly individual: FlammableIndividual;
  readonly key: string;
  readonly was: Position;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function sweptCandidates(candidates: readonly FlammableIndividual[]): SweptCandidate[] {
  const swept: SweptCandidate[] = [];
  for (const individual of candidates) {
    const key = fireEntityKey(individual.sourceName, individual.id);
    const was = previousSweep.get(key) ?? individual;
    const reach = SPREAD_REACH_CELLS + Math.max(0, individual.radiusCells);
    swept.push({
      individual,
      key,
      was,
      minX: Math.min(was.x, individual.x) - reach,
      minY: Math.min(was.y, individual.y) - reach,
      maxX: Math.max(was.x, individual.x) + reach,
      maxY: Math.max(was.y, individual.y) + reach,
    });
  }
  return swept;
}

function ascending(a: number, b: number): number {
  return a - b;
}

class CandidateGrid {
  readonly candidates: readonly SweptCandidate[];

  private readonly bucketsPerSide: number;
  private readonly buckets = new Map<number, number[]>();
  private readonly seen: Int32Array;
  private queries = 0;
  private readonly hits: number[] = [];

  constructor(worldSize: number, candidates: readonly SweptCandidate[]) {
    this.candidates = candidates;
    this.bucketsPerSide = Math.max(1, Math.ceil(worldSize / SPREAD_BUCKET_CELLS));
    this.seen = new Int32Array(candidates.length);

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const lastX = this.bucketOf(candidate.maxX);
      const lastY = this.bucketOf(candidate.maxY);
      for (let bx = this.bucketOf(candidate.minX); bx <= lastX; bx++) {
        for (let by = this.bucketOf(candidate.minY); by <= lastY; by++) {
          const key = bx * this.bucketsPerSide + by;
          const list = this.buckets.get(key);
          if (list === undefined) this.buckets.set(key, [index]);
          else list.push(index);
        }
      }
    }
  }

  near(start: Position, end: Position): readonly number[] {
    const stamp = ++this.queries;
    const hits = this.hits;
    hits.length = 0;

    const lastX = this.bucketOf(Math.max(start.x, end.x));
    const lastY = this.bucketOf(Math.max(start.y, end.y));
    for (let bx = this.bucketOf(Math.min(start.x, end.x)); bx <= lastX; bx++) {
      for (let by = this.bucketOf(Math.min(start.y, end.y)); by <= lastY; by++) {
        const list = this.buckets.get(bx * this.bucketsPerSide + by);
        if (list === undefined) continue;
        for (const index of list) {
          if (this.seen[index] === stamp) continue;
          this.seen[index] = stamp;
          hits.push(index);
        }
      }
    }

    hits.sort(ascending);
    return hits;
  }

  private bucketOf(coord: number): number {
    const bucket = Math.floor(coord / SPREAD_BUCKET_CELLS);
    if (bucket < 0) return 0;
    if (bucket >= this.bucketsPerSide) return this.bucketsPerSide - 1;
    return bucket;
  }
}

interface Exposure {
  readonly dwellSeconds: number;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly gapCells: number;
}

function exposureAlongPaths(
  fromStart: Position,
  fromEnd: Position,
  toStart: Position,
  toEnd: Position,
  radiusCells: number,
  dt: number,
): Exposure | null {
  const reach = SPREAD_REACH_CELLS + Math.max(0, radiusCells);

  const startDx = toStart.x - fromStart.x;
  const startDy = toStart.y - fromStart.y;
  const driftX = toEnd.x - fromEnd.x - startDx;
  const driftY = toEnd.y - fromEnd.y - startDy;

  const driftSquared = driftX * driftX + driftY * driftY;
  const startDotDrift = startDx * driftX + startDy * driftY;
  const startSquared = startDx * startDx + startDy * startDy;

  let enter = 0;
  let leave = 1;
  if (driftSquared === 0) {
    if (startSquared > reach * reach) return null;
  } else {
    const discriminant =
      startDotDrift * startDotDrift - driftSquared * (startSquared - reach * reach);
    if (discriminant <= 0) return null;
    const root = Math.sqrt(discriminant);
    enter = Math.max(0, (-startDotDrift - root) / driftSquared);
    leave = Math.min(1, (-startDotDrift + root) / driftSquared);
    if (leave <= enter) return null;
  }

  const closest =
    driftSquared === 0
      ? enter
      : Math.max(enter, Math.min(leave, -startDotDrift / driftSquared));

  const separation = Math.hypot(startDx + driftX * closest, startDy + driftY * closest);
  return {
    dwellSeconds: (leave - enter) * dt,
    fromX: fromStart.x + (fromEnd.x - fromStart.x) * closest,
    fromY: fromStart.y + (fromEnd.y - fromStart.y) * closest,
    toX: toStart.x + (toEnd.x - toStart.x) * closest,
    toY: toStart.y + (toEnd.y - toStart.y) * closest,
    gapCells: Math.max(0, separation - Math.max(0, radiusCells)),
  };
}

function spreadToIndividuals(
  world: WorldApi,
  entityBlaze: EntityBlaze,
  from: SpreadSource,
  fromWas: Position,
  grid: CandidateGrid,
  wind: { readonly heading: number; readonly speed: number },
  dt: number,
  caught: FireEntityState[],
): void {
  for (const index of grid.near(fromWas, from)) {
    const swept = grid.candidates[index]!;
    const candidate = swept.individual;
    if (entityBlaze.isBurningKey(swept.key)) continue;

    const exposure = exposureAlongPaths(
      fromWas,
      from,
      swept.was,
      candidate,
      candidate.radiusCells,
      dt,
    );
    if (exposure === null) continue;

    const rate = spreadRate(
      world,
      { ...from, x: exposure.fromX, y: exposure.fromY },
      { x: exposure.toX, y: exposure.toY },
      wind,
      exposure.gapCells,
    );
    if (rate <= 0) continue;
    if (!heatLedger.absorb(swept.key, rate, exposure.dwellSeconds)) continue;

    const lit = entityBlaze.igniteIndividual(candidate);
    if (lit === null) continue;
    heatLedger.consume(swept.key);
    caught.push(lit);
  }
}

interface HeatedCell {
  readonly key: number;
  readonly x: number;
  readonly y: number;
  readonly excess: number;
}

function spreadToCells(
  world: WorldApi,
  blaze: Blaze,
  from: SpreadSource,
  origin: { readonly x: number; readonly y: number },
  offsets: readonly (readonly [number, number])[],
  wind: { readonly heading: number; readonly speed: number },
  dt: number,
  crossed: Map<number, { readonly x: number; readonly y: number }>,
): void {
  for (const [dx, dy] of offsets) {
    const x = cellOf(origin.x) + dx;
    const y = cellOf(origin.y) + dy;
    if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
    if (blaze.isBurning(x, y)) continue;

    const rate = spreadRate(world, from, { x, y }, wind);
    if (rate <= 0) continue;
    const key = fireKey(x, y);
    if (!heatLedger.absorb(key, rate, dt)) continue;

    if (!crossed.has(key)) crossed.set(key, { x, y });
  }
}

function igniteInHeatOrder(
  blaze: Blaze,
  crossed: ReadonlyMap<number, { readonly x: number; readonly y: number }>,
): FireCellState[] {
  const caught: FireCellState[] = [];
  if (crossed.size === 0) return caught;

  const ordered: HeatedCell[] = [];
  for (const [key, cell] of crossed) {
    ordered.push({ key, x: cell.x, y: cell.y, excess: heatLedger.excessHeat(key) });
  }
  ordered.sort((a, b) => b.excess - a.excess || a.x - b.x || a.y - b.y);

  for (const cell of ordered) {
    const lit = blaze.ignite(cell.x, cell.y);
    if (lit === null) continue;
    heatLedger.consume(cell.key);
    caught.push(lit);
  }
  return caught;
}

export function spreadOnce(
  world: WorldApi,
  blaze: Blaze,
  entityBlaze: EntityBlaze,
  dt: number,
): SpreadResult {
  const wind = currentWind();
  const cellSources = blaze.fires();
  const entitySources = entityBlaze.burningWithAge();
  const candidates = sweptCandidates(flammableNow());
  const grid = new CandidateGrid(world.worldSize, candidates);

  const crossed = new Map<number, { readonly x: number; readonly y: number }>();
  const entities: FireEntityState[] = [];

  for (const fire of cellSources) {
    spreadToCells(world, blaze, fire, fire, NEIGHBOUR_OFFSETS, wind, dt, crossed);
    spreadToIndividuals(world, entityBlaze, fire, stoodStill(fire), grid, wind, dt, entities);
  }

  for (const fire of entitySources) {
    spreadToCells(world, blaze, fire, fire, SELF_AND_NEIGHBOUR_OFFSETS, wind, dt, crossed);
    spreadToIndividuals(
      world,
      entityBlaze,
      fire,
      whereItWas(fire.sourceName, fire.id, fire),
      grid,
      wind,
      dt,
      entities,
    );
  }

  const sweep = new Map<string, Position>();
  for (const candidate of candidates) {
    sweep.set(candidate.key, { x: candidate.individual.x, y: candidate.individual.y });
  }
  for (const fire of entitySources) {
    sweep.set(fireEntityKey(fire.sourceName, fire.id), { x: fire.x, y: fire.y });
  }
  previousSweep = sweep;

  const cells = igniteInHeatOrder(blaze, crossed);

  heatLedger.endStep();

  return { cells, entities };
}

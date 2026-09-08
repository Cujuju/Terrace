import { BAND_HEIGHT, MAX_BRUSH_RADIUS, type FreshwaterMap } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import {
  GENESIS_CONE_BANDS,
  LAVA_COOL_SECONDS,
  lavaKey,
  type LavaCellState,
  type VentState,
} from '../protocol.ts';

export { GENESIS_CONE_BANDS };
import {
  FLOW_BRUSH_RADIUS,
  FLOW_SPEED_CELLS_PER_SECOND,
  FLOW_THICKNESS,
  MAX_FLOW_CELLS,
  MAX_TRACKED_FLOW_CELLS,
  nextFlowCell,
  type FlowStop,
} from './flow.ts';
import { createVolcanoRng, exponentialWaitSeconds, rollEvent, VOLCANO_RNG_DEFAULT_SEED, type VolcanoRng } from './rng.ts';
import {
  chooseVentSite,
  genesisVentCount,
  isSiteClear,
  MAX_VENTS_PER_WORLD,
  type Site,
} from './siting.ts';

export const ERUPTION_SECONDS = 60;

export const DORMANT_MEAN_SECONDS_AT_MIN_DIFFICULTY = 3600;
export const DORMANT_MEAN_SECONDS_AT_MAX_DIFFICULTY = 600;

export const SPONTANEOUS_BIRTH_MEAN_SECONDS_AT_MIN_DIFFICULTY = 86_400;
export const SPONTANEOUS_BIRTH_MEAN_SECONDS_AT_MAX_DIFFICULTY = 7_200;

export const CONE_RING_OFFSET = MAX_BRUSH_RADIUS;

const CONE_RING_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-CONE_RING_OFFSET, 0],
  [CONE_RING_OFFSET, 0],
  [0, -CONE_RING_OFFSET],
  [0, CONE_RING_OFFSET],
];

export const CONE_SCULPTS_PER_TICK = 1;

export type ConeRingTiming = 'immediate' | 'deferred';

export const CONE_PEAK_BANDS_PER_ERUPTION = 1;

export const CONE_BRUSH_BANDS_PER_PEAK_BAND = 2;

export const CONE_GROWTH_BANDS_PER_ERUPTION =
  CONE_PEAK_BANDS_PER_ERUPTION * CONE_BRUSH_BANDS_PER_PEAK_BAND;

function ringAmount(bands: number): number {
  return Math.floor((bands * BAND_HEIGHT) / 2);
}

export function byDifficulty(difficulty: number, atMin: number, atMax: number): number {
  const clamped = Math.min(100, Math.max(1, difficulty));
  return atMin + ((atMax - atMin) * (clamped - 1)) / 99;
}

export interface Vent {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  erupting: boolean;
  phaseSeconds: number;
  coneBands: number;
}

interface LavaCell {
  readonly x: number;
  readonly y: number;
  ageSeconds: number;
}

interface Front {
  x: number;
  y: number;
  advance: number;
  laid: number;
  visited: Set<number>;
  readonly freshwater: FreshwaterMap;
}

let vents: Vent[] = [];
let nextVentId = 1;
let rng: VolcanoRng = createVolcanoRng(VOLCANO_RNG_DEFAULT_SEED);
let seeded = false;

const lava = new Map<number, LavaCell>();

const fronts = new Map<number, Front>();

interface PendingConeSculpt {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly amount: number;
}

let pendingConeSculpts: PendingConeSculpt[] = [];

let selfSculptDepth = 0;

export function isSelfSculpting(): boolean {
  return selfSculptDepth > 0;
}

function sculptAsVolcano(world: WorldApi, x: number, y: number, radius: number, amount: number): void {
  selfSculptDepth++;
  try {
    world.sculpt(x, y, radius, amount);
  } finally {
    selfSculptDepth--;
  }
}

export function forgetLavaAt(
  cells: Iterable<{ readonly x: number; readonly y: number }>,
): Array<{ x: number; y: number }> {
  const forgotten: Array<{ x: number; y: number }> = [];
  for (const cell of cells) {
    const key = lavaKey(cell.x, cell.y);
    const tracked = lava.get(key);
    if (tracked === undefined) continue;
    lava.delete(key);
    forgotten.push({ x: tracked.x, y: tracked.y });
  }
  return forgotten;
}

export function resetVolcanoes(): void {
  vents = [];
  nextVentId = 1;
  rng = createVolcanoRng(VOLCANO_RNG_DEFAULT_SEED);
  seeded = false;
  lava.clear();
  fronts.clear();
  pendingConeSculpts = [];
}

export function ventStates(): VentState[] {
  return vents.map((vent) => ({
    id: vent.id,
    x: vent.x,
    y: vent.y,
    erupting: vent.erupting,
  }));
}

export function lavaStates(): LavaCellState[] {
  return [...lava.values()].map((cell) => ({
    x: cell.x,
    y: cell.y,
    ageSeconds: cell.ageSeconds,
  }));
}

export function ventSites(): Site[] {
  return vents.map((vent) => ({ x: vent.x, y: vent.y }));
}

export function ventCount(): number {
  return vents.length;
}

export function anyErupting(): boolean {
  return vents.some((vent) => vent.erupting);
}

function raiseCone(
  world: WorldApi,
  x: number,
  y: number,
  bands: number,
  ringTiming: ConeRingTiming,
): void {
  const size = world.worldSize;
  sculptAsVolcano(world, x, y, MAX_BRUSH_RADIUS, bands * BAND_HEIGHT);

  const rim = ringAmount(bands);
  for (const [dx, dy] of CONE_RING_OFFSETS) {
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
    if (ringTiming === 'immediate') {
      sculptAsVolcano(world, cx, cy, MAX_BRUSH_RADIUS, rim);
      continue;
    }
    pendingConeSculpts.push({ x: cx, y: cy, radius: MAX_BRUSH_RADIUS, amount: rim });
  }
}

export function drainPendingConeSculpts(world: WorldApi): void {
  for (let applied = 0; applied < CONE_SCULPTS_PER_TICK; applied++) {
    const step = pendingConeSculpts.shift();
    if (step === undefined) return;
    sculptAsVolcano(world, step.x, step.y, step.radius, step.amount);
  }
}

export function openVent(
  world: WorldApi,
  x: number,
  y: number,
  coneBands: number,
  ringTiming: ConeRingTiming,
): Vent | null {
  if (vents.length >= MAX_VENTS_PER_WORLD) return null;
  if (!isSiteClear({ x, y }, ventSites())) return null;

  const vent: Vent = {
    id: nextVentId++,
    x,
    y,
    erupting: false,
    phaseSeconds: exponentialWaitSeconds(rng, dormantMeanSeconds(world)),
    coneBands: 0,
  };
  vents.push(vent);

  if (coneBands > 0) {
    raiseCone(world, x, y, coneBands, ringTiming);
    vent.coneBands = coneBands;
  }
  return vent;
}

export function seedGenesisVents(world: WorldApi): readonly Vent[] {
  if (seeded) return [];
  seeded = true;

  const wanted = genesisVentCount(world.worldSize);
  const created: Vent[] = [];
  for (let i = 0; i < wanted; i++) {
    const site = chooseVentSite(world, rng, ventSites());
    if (site === null) break;
    const vent = openVent(world, site.x, site.y, GENESIS_CONE_BANDS, 'immediate');
    if (vent !== null) created.push(vent);
  }
  return created;
}

export function rollSpontaneousBirth(world: WorldApi, dt: number): Vent | null {
  if (vents.length >= MAX_VENTS_PER_WORLD) return null;

  const meanSeconds = byDifficulty(
    world.difficulty,
    SPONTANEOUS_BIRTH_MEAN_SECONDS_AT_MIN_DIFFICULTY,
    SPONTANEOUS_BIRTH_MEAN_SECONDS_AT_MAX_DIFFICULTY,
  );
  if (!rollEvent(rng, 1 / meanSeconds, dt)) return null;

  const site = chooseVentSite(world, rng, ventSites());
  if (site === null) return null;
  return openVent(world, site.x, site.y, GENESIS_CONE_BANDS, 'deferred');
}

export interface VolcanoTick {
  readonly molten: LavaCellState[];
  readonly forgotten: Array<{ x: number; y: number }>;
  readonly erupted: Vent[];
  readonly quieted: Vent[];
  readonly ventsChanged: boolean;
}

function dormantMeanSeconds(world: WorldApi): number {
  return byDifficulty(
    world.difficulty,
    DORMANT_MEAN_SECONDS_AT_MIN_DIFFICULTY,
    DORMANT_MEAN_SECONDS_AT_MAX_DIFFICULTY,
  );
}

function beginEruption(vent: Vent, world: WorldApi): void {
  vent.erupting = true;
  vent.phaseSeconds = ERUPTION_SECONDS;

  raiseCone(world, vent.x, vent.y, CONE_GROWTH_BANDS_PER_ERUPTION, 'deferred');
  vent.coneBands += CONE_GROWTH_BANDS_PER_ERUPTION;

  fronts.set(vent.id, {
    x: vent.x,
    y: vent.y,
    advance: 0,
    laid: 0,
    visited: new Set<number>([lavaKey(vent.x, vent.y)]),
    freshwater: world.freshwater,
  });
}

export function nearestVent(x: number, y: number): Vent | null {
  let best: Vent | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const vent of vents) {
    const dx = vent.x - x;
    const dy = vent.y - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = vent;
    }
  }
  return best;
}

export function forceEruption(vent: Vent, world: WorldApi): boolean {
  if (vent.erupting) return false;
  beginEruption(vent, world);
  return true;
}

function endEruption(vent: Vent, world: WorldApi): void {
  vent.erupting = false;
  vent.phaseSeconds = exponentialWaitSeconds(rng, dormantMeanSeconds(world));
  fronts.delete(vent.id);
}

function meltCell(world: WorldApi, x: number, y: number): LavaCellState | null {
  sculptAsVolcano(world, x, y, FLOW_BRUSH_RADIUS, FLOW_THICKNESS);

  const key = lavaKey(x, y);
  const existing = lava.get(key);
  if (existing !== undefined) {
    existing.ageSeconds = 0;
    return null;
  }
  lava.set(key, { x, y, ageSeconds: 0 });
  return { x, y, ageSeconds: 0 };
}

function evictOldFlow(forgotten: Array<{ x: number; y: number }>): void {
  while (lava.size > MAX_TRACKED_FLOW_CELLS) {
    const oldest = lava.keys().next();
    if (oldest.done === true) return;
    const cell = lava.get(oldest.value);
    lava.delete(oldest.value);
    if (cell !== undefined) forgotten.push({ x: cell.x, y: cell.y });
  }
}

function advanceFront(world: WorldApi, vent: Vent, dt: number, molten: LavaCellState[]): void {
  const front = fronts.get(vent.id);
  if (front === undefined) return;

  front.advance += FLOW_SPEED_CELLS_PER_SECOND * dt;
  while (front.advance >= 1) {
    front.advance -= 1;

    if (front.laid >= MAX_FLOW_CELLS) {
      stopFront(vent, 'length');
      return;
    }

    const next = nextFlowCell(world, front.freshwater, front.x, front.y, front.visited);
    if (typeof next === 'string') {
      stopFront(vent, next);
      return;
    }

    front.x = next.x;
    front.y = next.y;
    front.laid++;
    front.visited.add(lavaKey(next.x, next.y));

    const state = meltCell(world, next.x, next.y);
    if (state !== null) molten.push(state);
  }
}

function stopFront(vent: Vent, _reason: FlowStop): void {
  fronts.delete(vent.id);
}

export function advanceVolcanoes(world: WorldApi, dt: number, eruptionsAllowed: boolean): VolcanoTick {
  const molten: LavaCellState[] = [];
  const forgotten: Array<{ x: number; y: number }> = [];
  const erupted: Vent[] = [];
  const quieted: Vent[] = [];

  for (const vent of vents) {
    vent.phaseSeconds -= dt;

    if (vent.erupting) {
      advanceFront(world, vent, dt, molten);
      if (vent.phaseSeconds <= 0) {
        endEruption(vent, world);
        quieted.push(vent);
      }
      continue;
    }

    if (vent.phaseSeconds > 0) continue;

    if (!eruptionsAllowed) {
      vent.phaseSeconds = exponentialWaitSeconds(rng, dormantMeanSeconds(world));
      continue;
    }

    beginEruption(vent, world);
    erupted.push(vent);
  }

  for (const cell of lava.values()) {
    if (cell.ageSeconds < LAVA_COOL_SECONDS) cell.ageSeconds += dt;
  }
  evictOldFlow(forgotten);

  return {
    molten,
    forgotten,
    erupted,
    quieted,
    ventsChanged: erupted.length > 0 || quieted.length > 0,
  };
}

export interface VolcanoSnapshot {
  readonly seeded: boolean;
  readonly nextVentId: number;
  readonly rngState: number;
  readonly vents: readonly Vent[];
  readonly lava: ReadonlyArray<{ x: number; y: number; ageSeconds: number }>;
  readonly pendingConeSculpts: readonly PendingConeSculpt[];
}

export function volcanoSnapshot(): VolcanoSnapshot {
  return {
    seeded,
    nextVentId,
    rngState: rng.state(),
    vents: vents.map((vent) => ({
      id: vent.id,
      x: vent.x,
      y: vent.y,
      erupting: false,
      phaseSeconds: vent.phaseSeconds,
      coneBands: vent.coneBands,
    })),
    lava: [...lava.values()].map((cell) => ({
      x: cell.x,
      y: cell.y,
      ageSeconds: cell.ageSeconds,
    })),
    pendingConeSculpts: pendingConeSculpts.map((step) => ({ ...step })),
  };
}

export function restoreVolcanoes(snapshot: VolcanoSnapshot): void {
  vents = snapshot.vents.map((vent) => ({
    id: vent.id,
    x: vent.x,
    y: vent.y,
    erupting: false,
    phaseSeconds: vent.phaseSeconds,
    coneBands: vent.coneBands,
  }));
  nextVentId = snapshot.nextVentId;
  rng = createVolcanoRng(snapshot.rngState);
  seeded = snapshot.seeded;
  fronts.clear();
  lava.clear();
  for (const cell of snapshot.lava) {
    lava.set(lavaKey(cell.x, cell.y), { x: cell.x, y: cell.y, ageSeconds: cell.ageSeconds });
  }
  pendingConeSculpts = snapshot.pendingConeSculpts.map((step) => ({ ...step }));
}

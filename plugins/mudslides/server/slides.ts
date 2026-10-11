import { BAND_HEIGHT, CHUNK_SIZE } from '@terrace/shared';
import {
  MUDSLIDE_MAX_PATH_CELLS,
  cellsAcross,
  type DebrisCell,
  type MudslideFlowEvent,
  type MudslideStop,
  type SlideState,
  MAX_ACTIVE_SLIDES,
} from '../protocol.ts';
import {
  cellKey,
  footprintUnlocked,
  freshwaterAdjacent,
  inBounds,
  nextFlowCell,
  sculptGuarded,
  slopeAt,
  type MudslideWorld,
} from './terrain.ts';
import { rainAt } from './weather-bridge.ts';
import {
  MUDSLIDE_RNG_DEFAULT_SEED,
  createMudslideRng,
  randomIndex,
  rollEvent,
  type MudslideRng,
} from './rng.ts';

export const MUDSLIDE_SURVEY_INTERVAL_SECONDS = 5;

export const MUDSLIDE_SURVEY_SAMPLES = 64;

export const MAX_TRACKED_SITES = 96;

export const MUDSLIDE_SOAKING_RAIN_INTENSITY = 0.35;

export const MUDSLIDE_SATURATION_SECONDS = 90;

export const MUDSLIDE_FRESHWATER_SOAK_RATE = 0.5;

export const MUDSLIDE_DRYING_RATE = 1 / 3;

export const MUDSLIDE_SITE_COOLDOWN_SECONDS = 600;

export const MUDSLIDE_INTERVAL_AT_MIN_DIFFICULTY_SECONDS = 480;
export const MUDSLIDE_INTERVAL_AT_MAX_DIFFICULTY_SECONDS = 90;

const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 100;

export const FREQUENCY_INTERVAL_MULTIPLIERS = { rare: 6, uncommon: 3, common: 1 } as const;

export { MAX_ACTIVE_SLIDES };

export const MUDSLIDE_BRUSH_RADIUS_WORLD_UNITS = 1.5;
export const MUDSLIDE_BRUSH_RADIUS_CELLS = cellsAcross(MUDSLIDE_BRUSH_RADIUS_WORLD_UNITS);

export const MUDSLIDE_HEAD_SCOUR_BANDS_PER_STEP = 1;

export const MUDSLIDE_HEAD_SCOUR_STEPS = 3;

export const MUDSLIDE_SCULPT_INTERVAL_SECONDS = 0.3;

export const MUDSLIDE_FRONT_SPEED_WORLD_UNITS_PER_SECOND = 4;
const FRONT_SPEED_CELLS_PER_SECOND = cellsAcross(MUDSLIDE_FRONT_SPEED_WORLD_UNITS_PER_SECOND);

const MAX_STEPS_PER_TICK = 8;

export const MUDSLIDE_TRACK_DEPOSIT_FRACTION = 0.15;

export const MUDSLIDE_TOE_DUMP_STEPS = 8;

export const MUDSLIDE_TOE_LOBE_CELLS = 4;

export const MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS = 4;

export const MUDSLIDE_LINGER_SECONDS = 1;

export const MAX_TRACKED_DEBRIS = 256;

export interface Site {
  readonly x: number;
  readonly y: number;
  saturation: number;
  cooldownSeconds: number;
  freshwater: boolean;
}

export interface Slide {
  readonly id: number;
  readonly headX: number;
  readonly headY: number;
  x: number;
  y: number;
  nextX: number;
  nextY: number;
  progress: number;
  sculptTimerSeconds: number;
  headSteps: number;
  toeSteps: number;
  excavated: number;
  carried: number;
  gain: number;
  unmeasuredCells: number;
  readonly path: Array<{ readonly x: number; readonly y: number }>;
  readonly deltas: Map<number, number>;
  readonly pendingDebris: DebrisCell[];
  readonly visited: Set<number>;
  stop: MudslideStop | null;
  lingerSeconds: number;
}

let sites = new Map<number, Site>();
let slides: Slide[] = [];
let debris: DebrisCell[] = [];
let nextSlideId = 1;
let rng: MudslideRng = createMudslideRng(MUDSLIDE_RNG_DEFAULT_SEED);
let surveyTimerSeconds = MUDSLIDE_SURVEY_INTERVAL_SECONDS;
let revealedChunks: Array<{ readonly cx: number; readonly cy: number }> = [];
let devFrozen = false;

let devSlowFactor = 1;

export function resetSlides(): void {
  sites = new Map();
  slides = [];
  debris = [];
  nextSlideId = 1;
  rng = createMudslideRng(MUDSLIDE_RNG_DEFAULT_SEED);
  surveyTimerSeconds = MUDSLIDE_SURVEY_INTERVAL_SECONDS;
  revealedChunks = [];
  devFrozen = false;
  devSlowFactor = 1;
}

export function setDevFrozen(frozen: boolean): void {
  devFrozen = frozen;
}

export function setDevSlowFactor(factor: number): void {
  devSlowFactor = Number.isFinite(factor) && factor > 1 ? factor : 1;
}

export function livingSlides(): readonly Slide[] {
  return slides;
}

export function trackedSites(): ReadonlyMap<number, Site> {
  return sites;
}

export function trackedDebris(): readonly DebrisCell[] {
  return debris;
}

function rebuildRevealedChunks(world: MudslideWorld): void {
  revealedChunks = [];
  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      if (world.isChunkUnlocked(cx, cy)) revealedChunks.push({ cx, cy });
    }
  }
}

function admitSite(site: Site): void {
  const key = cellKey(site.x, site.y);
  if (sites.has(key)) return;
  if (sites.size >= MAX_TRACKED_SITES) {
    let driestKey = -1;
    let driest = Number.POSITIVE_INFINITY;
    for (const [otherKey, other] of sites) {
      const score = other.cooldownSeconds > 0 ? -other.cooldownSeconds : other.saturation;
      if (score >= driest) continue;
      driest = score;
      driestKey = otherKey;
    }
    if (driestKey < 0 || driest >= 0) return;
    sites.delete(driestKey);
  }
  sites.set(key, site);
}

export function surveySites(world: MudslideWorld, dt: number): void {
  surveyTimerSeconds += dt;
  if (surveyTimerSeconds < MUDSLIDE_SURVEY_INTERVAL_SECONDS) return;
  surveyTimerSeconds = 0;

  rebuildRevealedChunks(world);
  if (revealedChunks.length === 0) return;

  const size = CHUNK_SIZE;
  for (let sample = 0; sample < MUDSLIDE_SURVEY_SAMPLES; sample++) {
    const chunk = revealedChunks[randomIndex(rng, revealedChunks.length)]!;
    const x = chunk.cx * size + randomIndex(rng, size);
    const y = chunk.cy * size + randomIndex(rng, size);
    if (!inBounds(world, x, y)) continue;
    if (slopeAt(world, x, y) === null) continue;
    admitSite({
      x,
      y,
      saturation: 0,
      cooldownSeconds: 0,
      freshwater: freshwaterAdjacent(world, x, y),
    });
  }

  for (const [key, site] of sites) {
    if (slopeAt(world, site.x, site.y) === null) {
      sites.delete(key);
      continue;
    }
    site.freshwater = freshwaterAdjacent(world, site.x, site.y);
  }
}

export function isSaturated(site: Site): boolean {
  return site.cooldownSeconds <= 0 && site.saturation >= MUDSLIDE_SATURATION_SECONDS;
}

export function soakSites(dt: number): void {
  for (const site of sites.values()) {
    if (site.cooldownSeconds > 0) {
      site.cooldownSeconds = Math.max(0, site.cooldownSeconds - dt);
      site.saturation = Math.max(0, site.saturation - dt * MUDSLIDE_DRYING_RATE);
      continue;
    }

    const rainRate = rainAt(site.x, site.y) >= MUDSLIDE_SOAKING_RAIN_INTENSITY ? 1 : 0;
    const waterRate = site.freshwater ? MUDSLIDE_FRESHWATER_SOAK_RATE : 0;
    const wetting = Math.max(rainRate, waterRate);

    site.saturation =
      wetting > 0
        ? Math.min(MUDSLIDE_SATURATION_SECONDS, site.saturation + dt * wetting)
        : Math.max(0, site.saturation - dt * MUDSLIDE_DRYING_RATE);
  }
}

export function meanIntervalSeconds(difficulty: number): number {
  const clamped = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, difficulty));
  const t = (clamped - MIN_DIFFICULTY) / (MAX_DIFFICULTY - MIN_DIFFICULTY);
  return (
    MUDSLIDE_INTERVAL_AT_MIN_DIFFICULTY_SECONDS +
    t * (MUDSLIDE_INTERVAL_AT_MAX_DIFFICULTY_SECONDS - MUDSLIDE_INTERVAL_AT_MIN_DIFFICULTY_SECONDS)
  );
}

export function saturatedFraction(): number {
  let saturated = 0;
  for (const site of sites.values()) if (isSaturated(site)) saturated++;
  return Math.min(1, saturated / MAX_TRACKED_SITES);
}

function pickSaturatedSite(): Site | null {
  const pool: Site[] = [];
  let total = 0;
  for (const site of sites.values()) {
    if (!isSaturated(site)) continue;
    pool.push(site);
    total += site.saturation;
  }
  if (pool.length === 0) return null;

  let ticket = rng.next() * total;
  for (const site of pool) {
    ticket -= site.saturation;
    if (ticket <= 0) return site;
  }
  return pool[pool.length - 1]!;
}

export function rollTrigger(
  world: MudslideWorld,
  difficulty: number,
  intervalMultiplier: number,
  dt: number,
): Slide | null {
  if (devFrozen) return null;
  if (slides.length >= MAX_ACTIVE_SLIDES) return null;

  const wetShare = saturatedFraction();
  if (wetShare <= 0) return null;

  const meanInterval = meanIntervalSeconds(difficulty) * intervalMultiplier;
  if (!rollEvent(rng, wetShare / meanInterval, dt)) return null;

  const site = pickSaturatedSite();
  if (site === null) return null;
  const slide = startSlide(world, site.x, site.y);
  if (slide === null) sites.delete(cellKey(site.x, site.y));
  return slide;
}

export function startSlide(world: MudslideWorld, x: number, y: number): Slide | null {
  if (slopeAt(world, x, y) === null) return null;

  if (!footprintUnlocked(world, x, y, MUDSLIDE_BRUSH_RADIUS_CELLS)) return null;

  const first = nextFlowCell(world, x, y, new Set([cellKey(x, y)]));
  if (typeof first === 'string') return null;

  const site = sites.get(cellKey(x, y));
  if (site !== undefined) {
    site.cooldownSeconds = MUDSLIDE_SITE_COOLDOWN_SECONDS;
    site.saturation = 0;
  }

  const slide: Slide = {
    id: nextSlideId++,
    headX: x,
    headY: y,
    x,
    y,
    nextX: first.x,
    nextY: first.y,
    progress: 0,
    sculptTimerSeconds: 0,
    headSteps: 0,
    toeSteps: 0,
    excavated: 0,
    carried: 0,
    gain: 0,
    unmeasuredCells: 0,
    path: [{ x, y }],
    deltas: new Map(),
    pendingDebris: [],
    visited: new Set([cellKey(x, y), cellKey(first.x, first.y)]),
    stop: null,
    lingerSeconds: 0,
  };
  slides.push(slide);
  return slide;
}

function recordDelta(slide: Slide, x: number, y: number, delta: number): void {
  const key = cellKey(x, y);
  slide.deltas.set(key, (slide.deltas.get(key) ?? 0) + delta);
}

function scourHead(world: MudslideWorld, slide: Slide): void {
  const bandAmount = -MUDSLIDE_HEAD_SCOUR_BANDS_PER_STEP * BAND_HEIGHT;
  const measured = sculptGuarded(
    world,
    slide.headX,
    slide.headY,
    MUDSLIDE_BRUSH_RADIUS_CELLS,
    bandAmount,
  );
  slide.headSteps++;
  slide.unmeasuredCells += measured.unmeasuredCells;
  if (measured.net >= 0) {
    if (slide.excavated <= 0 && slide.headSteps >= MUDSLIDE_HEAD_SCOUR_STEPS) {
      slide.stop = 'spent';
    }
    return;
  }

  const removed = -measured.net;
  slide.excavated += removed;
  slide.carried += removed;
  recordDelta(slide, slide.headX, slide.headY, measured.net);

  const gain = removed / Math.abs(bandAmount);
  slide.gain = slide.gain === 0 ? gain : (slide.gain + gain) / 2;
}

function deposit(world: MudslideWorld, slide: Slide, x: number, y: number, volume: number): void {
  if (slide.gain <= 0 || volume <= 0) return;
  const amount = Math.max(1, Math.round(volume / slide.gain));

  const measured = sculptGuarded(world, x, y, MUDSLIDE_BRUSH_RADIUS_CELLS, amount);
  slide.unmeasuredCells += measured.unmeasuredCells;
  if (measured.net <= 0) return;

  slide.carried = Math.max(0, slide.carried - measured.net);
  recordDelta(slide, x, y, measured.net);

  const cell: DebrisCell = { x, y, depth: Math.max(1, Math.round(measured.net)) };
  slide.pendingDebris.push(cell);
  debris.push(cell);
  if (debris.length > MAX_TRACKED_DEBRIS) debris.splice(0, debris.length - MAX_TRACKED_DEBRIS);
}

function advanceFront(world: MudslideWorld, slide: Slide, dt: number): void {
  if (slide.stop !== null) return;

  slide.progress += dt * FRONT_SPEED_CELLS_PER_SECOND;
  let steps = 0;
  while (slide.progress >= 1 && steps < MAX_STEPS_PER_TICK) {
    slide.progress -= 1;
    steps++;

    slide.x = slide.nextX;
    slide.y = slide.nextY;
    slide.path.push({ x: slide.x, y: slide.y });

    if (slide.path.length >= MUDSLIDE_MAX_PATH_CELLS) {
      slide.stop = 'length';
      slide.progress = 0;
      return;
    }

    const next = nextFlowCell(world, slide.x, slide.y, slide.visited);
    if (typeof next === 'string') {
      slide.stop = next;
      slide.progress = 0;
      return;
    }
    slide.nextX = next.x;
    slide.nextY = next.y;
    slide.visited.add(cellKey(next.x, next.y));
  }
  if (slide.progress >= 1) slide.progress = 0;
}

function sculptStep(world: MudslideWorld, slide: Slide): void {
  if (slide.headSteps < MUDSLIDE_HEAD_SCOUR_STEPS) {
    scourHead(world, slide);
    return;
  }

  if (slide.carried <= MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS) {
    if (slide.stop === null) slide.stop = 'spent';
    return;
  }

  if (slide.stop === null) {
    deposit(world, slide, slide.x, slide.y, slide.carried * MUDSLIDE_TRACK_DEPOSIT_FRACTION);
    return;
  }

  if (slide.toeSteps >= MUDSLIDE_TOE_DUMP_STEPS) return;
  slide.toeSteps++;
  const back = slide.toeSteps % MUDSLIDE_TOE_LOBE_CELLS;
  const cell = slide.path[Math.max(0, slide.path.length - 1 - back)]!;
  const stepsLeft = Math.max(1, MUDSLIDE_TOE_DUMP_STEPS - slide.toeSteps + 1);
  deposit(world, slide, cell.x, cell.y, slide.carried / stepsLeft);
}

export function movedGround(slide: Slide): boolean {
  return slide.excavated > 0;
}

function isFinished(slide: Slide): boolean {
  if (slide.stop === null) return false;
  const owing = slide.carried > MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS;
  if (owing && slide.toeSteps < MUDSLIDE_TOE_DUMP_STEPS) return false;
  return slide.lingerSeconds >= MUDSLIDE_LINGER_SECONDS;
}

export function flowEventFor(slide: Slide): MudslideFlowEvent {
  const toe = slide.path[slide.path.length - 1]!;
  return {
    slideId: slide.id,
    headX: slide.headX,
    headY: slide.headY,
    toeX: toe.x,
    toeY: toe.y,
    cells: slide.path.map((cell) => ({
      x: cell.x,
      y: cell.y,
      delta: Math.round(slide.deltas.get(cellKey(cell.x, cell.y)) ?? 0),
    })),
    volumeMoved: Math.round(slide.excavated),
    stop: slide.stop ?? 'spent',
  };
}

export function residualHeightUnits(slide: Slide): number {
  return Math.max(0, Math.round(slide.carried));
}

export interface SlideTick {
  readonly finished: readonly Slide[];
  readonly changed: boolean;
}

export function advanceSlides(world: MudslideWorld, rawDt: number): SlideTick {
  if (slides.length === 0) return { finished: [], changed: false };
  const dt = rawDt / devSlowFactor;

  const finished: Slide[] = [];
  const surviving: Slide[] = [];

  for (const slide of slides) {
    advanceFront(world, slide, dt);

    slide.sculptTimerSeconds += dt;
    let ops = 0;
    while (
      slide.sculptTimerSeconds >= MUDSLIDE_SCULPT_INTERVAL_SECONDS &&
      ops < MAX_STEPS_PER_TICK
    ) {
      slide.sculptTimerSeconds -= MUDSLIDE_SCULPT_INTERVAL_SECONDS;
      ops++;
      sculptStep(world, slide);
    }
    if (slide.sculptTimerSeconds >= MUDSLIDE_SCULPT_INTERVAL_SECONDS) {
      slide.sculptTimerSeconds = 0;
    }

    if (slide.stop !== null) slide.lingerSeconds += dt;

    if (isFinished(slide)) finished.push(slide);
    else surviving.push(slide);
  }

  slides = surviving;
  return { finished, changed: true };
}

export function slideStates(): readonly SlideState[] {
  return slides.map((slide) => {
    const dx = slide.stop === null ? slide.nextX - slide.x : 0;
    const dy = slide.stop === null ? slide.nextY - slide.y : 0;
    return {
      id: slide.id,
      x: slide.x + dx * slide.progress,
      y: slide.y + dy * slide.progress,
      vx: dx * FRONT_SPEED_CELLS_PER_SECOND,
      vy: dy * FRONT_SPEED_CELLS_PER_SECOND,
      load: slide.excavated > 0 ? Math.min(1, slide.carried / slide.excavated) : 0,
    };
  });
}

export function takePendingDebris(alsoFrom: readonly Slide[] = []): DebrisCell[] {
  const cells: DebrisCell[] = [];
  for (const slide of [...slides, ...alsoFrom]) {
    if (slide.pendingDebris.length === 0) continue;
    cells.push(...slide.pendingDebris);
    slide.pendingDebris.length = 0;
  }
  return cells;
}

export interface SlidesSnapshot {
  readonly nextSlideId: number;
  readonly rngState: number;
  readonly sites: readonly Site[];
  readonly slides: readonly SerializedSlide[];
  readonly debris: readonly DebrisCell[];
}

export interface SerializedSlide {
  readonly id: number;
  readonly headX: number;
  readonly headY: number;
  readonly x: number;
  readonly y: number;
  readonly nextX: number;
  readonly nextY: number;
  readonly progress: number;
  readonly sculptTimerSeconds: number;
  readonly headSteps: number;
  readonly toeSteps: number;
  readonly excavated: number;
  readonly carried: number;
  readonly gain: number;
  readonly unmeasuredCells: number;
  readonly path: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly stop: MudslideStop | null;
  readonly lingerSeconds: number;
}

export function slidesSnapshot(): SlidesSnapshot {
  return {
    nextSlideId,
    rngState: rng.state(),
    sites: [...sites.values()],
    slides: slides.map((slide) => ({
      id: slide.id,
      headX: slide.headX,
      headY: slide.headY,
      x: slide.x,
      y: slide.y,
      nextX: slide.nextX,
      nextY: slide.nextY,
      progress: slide.progress,
      sculptTimerSeconds: slide.sculptTimerSeconds,
      headSteps: slide.headSteps,
      toeSteps: slide.toeSteps,
      excavated: slide.excavated,
      carried: slide.carried,
      gain: slide.gain,
      unmeasuredCells: slide.unmeasuredCells,
      path: slide.path.map((cell) => ({ x: cell.x, y: cell.y })),
      stop: slide.stop,
      lingerSeconds: slide.lingerSeconds,
    })),
    debris: [...debris],
  };
}

export function restoreSlides(snapshot: SlidesSnapshot): void {
  nextSlideId = snapshot.nextSlideId;
  rng = createMudslideRng(snapshot.rngState);
  sites = new Map();
  for (const site of snapshot.sites) sites.set(cellKey(site.x, site.y), { ...site });
  debris = [...snapshot.debris];
  slides = snapshot.slides.map((saved) => ({
    id: saved.id,
    headX: saved.headX,
    headY: saved.headY,
    x: saved.x,
    y: saved.y,
    nextX: saved.nextX,
    nextY: saved.nextY,
    progress: saved.progress,
    sculptTimerSeconds: saved.sculptTimerSeconds,
    headSteps: saved.headSteps,
    toeSteps: saved.toeSteps,
    excavated: saved.excavated,
    carried: saved.carried,
    gain: saved.gain,
    unmeasuredCells: saved.unmeasuredCells,
    path: saved.path.map((cell) => ({ x: cell.x, y: cell.y })),
    deltas: new Map<number, number>(),
    pendingDebris: [],
    visited: new Set(saved.path.map((cell) => cellKey(cell.x, cell.y))),
    stop: saved.stop,
    lingerSeconds: saved.lingerSeconds,
  }));
  revealedChunks = [];
  surveyTimerSeconds = MUDSLIDE_SURVEY_INTERVAL_SECONDS;
}

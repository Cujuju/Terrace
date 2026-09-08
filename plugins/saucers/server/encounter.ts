import {
  ALTITUDE_TIER_WORLD_UNITS,
  APPROACH_SECONDS,
  APPROACH_SPEED_CELLS_PER_SECOND,
  ARENA_RADIUS_CELLS,
  BREATHE_RADIUS_FRACTION,
  CLIMB_WORLD_UNITS,
  CRASH_CRATER_DEPTH_BANDS,
  CRASH_CRATER_RADIUS_CELLS,
  CRASH_SEABED_CRATER_MAX_DEPTH_BANDS,
  CRASH_FIRE_RING_OFFSETS,
  CRASH_WIRE_SECONDS,
  DIVE_SECONDS,
  DOGFIGHT_SECONDS,
  DOGFIGHT_SPEED_CELLS_PER_SECOND,
  ENTRY_DISTANCE_CELLS,
  EXIT_SPEED_MAX_CELLS_PER_SECOND,
  FLYBY_SECONDS,
  HEIGHT_WORLD_SCALE,
  LASER_BOLT_LIFETIME_SECONDS,
  LASER_BOLT_SPEED_CELLS_PER_SECOND,
  LASER_BURST_REST_MAX_SECONDS,
  LASER_BURST_REST_MIN_SECONDS,
  LASER_BURST_SHOTS,
  LASER_HIT_CHANCE,
  LASER_HIT_DAMAGE,
  LASER_MISS_OFFSET_MAX_CELLS,
  LASER_MISS_OFFSET_MIN_CELLS,
  LASER_MUZZLE_DROP_WORLD_UNITS,
  LASER_RANGE_CELLS,
  LASER_SHOT_GAP_SECONDS,
  MAX_FACTIONS_PER_ENCOUNTER,
  MAX_SAUCERS_PER_FACTION,
  MAX_SAUCERS_PER_FLYBY,
  MIN_FACTIONS_PER_ENCOUNTER,
  MIN_SAUCERS_PER_ENCOUNTER,
  MIN_SAUCERS_PER_FACTION,
  MIN_SAUCERS_PER_FLYBY,
  ORBIT_RADIUS_FRACTION_MAX,
  ORBIT_RADIUS_FRACTION_MIN,
  RESOLVE_SECONDS,
  SAUCER_MAX_HP,
  SAUCER_VARIANT_COUNT,
  type CrashState,
  type LaserBolt,
  type SaucerPhase,
  type SaucerState,
} from '../protocol.ts';
import { BAND_HEIGHT, CELL_WORLD_SIZE } from '@terrace/shared';
import { igniteCrashCell } from './fire-bridge.ts';
import { createEncounterRng } from './rng.ts';
import {
  findArenaSite,
  findArenaSiteNear,
  type ArenaSite,
  type CrashCell,
  type SiteWorld,
} from './site.ts';

export interface EncounterWorld extends SiteWorld {
  sculpt(x: number, y: number, radius: number, amount: number): unknown;
}

const BREATHE_RADIANS_PER_SECOND_MIN = 0.9;
const BREATHE_RADIANS_PER_SECOND_MAX = 1.6;

const CLIMB_RADIANS_PER_SECOND_MIN = 0.8;
const CLIMB_RADIANS_PER_SECOND_MAX = 1.4;

const ARC_TABLE_STEP_SECONDS = 0.05;

const ARC_TABLE_PARAMETER_HEADROOM =
  ORBIT_RADIUS_FRACTION_MIN / (ORBIT_RADIUS_FRACTION_MIN - BREATHE_RADIUS_FRACTION);
const ARC_TABLE_SAMPLES =
  Math.ceil((DOGFIGHT_SECONDS * ARC_TABLE_PARAMETER_HEADROOM) / ARC_TABLE_STEP_SECONDS) + 1;

const FLYBY_WING_SPACING_CELLS = 6;
const FLYBY_WING_STAGGER_CELLS = 4;

const WINGMATE_BEARING_SPREAD_RADIANS = 0.35;

const EXIT_CLIMB_WORLD_UNITS = 12;

const CRASH_CRATER_AMOUNT = -(CRASH_CRATER_DEPTH_BANDS * BAND_HEIGHT);

type Resolution = 'dive' | 'exit';

interface Saucer {
  readonly id: number;
  readonly variant: number;
  readonly bearing: number;
  readonly orbitDirection: number;
  readonly orbitRadiusFraction: number;
  readonly altitudeOffset: number;
  readonly arcLength: Float64Array;
  readonly formationSlot: number;
  readonly breatheRate: number;
  readonly breathePhase: number;
  readonly climbRate: number;
  readonly climbPhase: number;
  phase: SaucerPhase;
  hp: number;
  fireIn: number;
  shotsLeft: number;
  burstTarget: number | null;
  lastTarget: number | null;
  resolution: Resolution;
  resolveSeconds: number;
  crashCell: CrashCell | null;
  resolveFromX: number;
  resolveFromY: number;
  resolveFromAlt: number;
  resolveFromSpeed: number;
  diveSeconds: number;
  gone: boolean;
  x: number;
  y: number;
  alt: number;
  heading: number;
  speed: number;
}

interface Bolt extends LaserBolt {
  readonly hit: boolean;
  readonly travelSeconds: number;
  age: number;
  landed: boolean;
}

interface Crash extends CrashState {
  age: number;
}

type Stage = 'approach' | 'dogfight' | 'resolve' | 'flyby';

export type EncounterKind = 'dogfight' | 'flyby';

interface Encounter {
  readonly kind: EncounterKind;
  readonly seed: number;
  readonly random: () => number;
  readonly site: ArenaSite;
  stage: Stage;
  stageSeconds: number;
  readonly saucers: Saucer[];
  bolts: Bolt[];
  crashes: Crash[];
  crashCellsUsed: number;
}

interface Roster {
  readonly factionVariants: readonly number[];
  readonly factionSizes: readonly number[];
  readonly total: number;
}

let encounter: Encounter | null = null;

let nextSaucerId = 1;

export function hasEncounter(): boolean {
  return encounter !== null;
}

export function encounterSeed(): number | null {
  return encounter === null ? null : encounter.seed;
}

export function resetEncounter(): void {
  encounter = null;
}

function between(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

function wholeBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function dealRoster(random: () => number): Roster {
  const factions = wholeBetween(random, MIN_FACTIONS_PER_ENCOUNTER, MAX_FACTIONS_PER_ENCOUNTER);
  const variants = shuffledRange(random, SAUCER_VARIANT_COUNT);

  const sizes: number[] = [];
  let total = 0;
  for (let faction = 0; faction < factions; faction++) {
    const size = wholeBetween(random, MIN_SAUCERS_PER_FACTION, MAX_SAUCERS_PER_FACTION);
    sizes.push(size);
    total += size;
  }
  for (let faction = 0; total < MIN_SAUCERS_PER_ENCOUNTER; faction = (faction + 1) % factions) {
    sizes[faction]!++;
    total++;
  }

  return { factionVariants: variants.slice(0, factions), factionSizes: sizes, total };
}

function dealFlybyRoster(random: () => number): Roster {
  const variant = wholeBetween(random, 0, SAUCER_VARIANT_COUNT - 1);
  const size = wholeBetween(random, MIN_SAUCERS_PER_FLYBY, MAX_SAUCERS_PER_FLYBY);
  return { factionVariants: [variant], factionSizes: [size], total: size };
}

function shuffledRange(random: () => number, count: number): number[] {
  const values: number[] = [];
  for (let value = 0; value < count; value++) values.push(value);
  for (let index = values.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    const held = values[index]!;
    values[index] = values[swap]!;
    values[swap] = held;
  }
  return values;
}

function rung(rank: number, count: number, min: number, max: number): number {
  if (count <= 1) return (min + max) / 2;
  return min + ((max - min) * rank) / (count - 1);
}

function begin(
  kind: EncounterKind,
  site: ArenaSite,
  roster: Roster,
  rng: { readonly seed: number; readonly next: () => number },
): number {
  const { seed, next } = rng;

  const compassOffset = next() * Math.PI * 2;
  const factionSpacing = (Math.PI * 2) / roster.factionVariants.length;

  const orbitRanks = shuffledRange(next, roster.total);
  const tierRanks = shuffledRange(next, roster.total);
  const tierSpan = (roster.total - 1) * ALTITUDE_TIER_WORLD_UNITS;

  const saucers: Saucer[] = [];
  for (let faction = 0; faction < roster.factionVariants.length; faction++) {
    const variant = roster.factionVariants[faction]!;
    const size = roster.factionSizes[faction]!;
    const factionBearing = compassOffset + faction * factionSpacing;
    for (let wingmate = 0; wingmate < size; wingmate++) {
      const index = saucers.length;
      const formationSlot = wingmate - (size - 1) / 2;
      const saucer: Saucer = {
        id: nextSaucerId++,
        variant,
        bearing:
          kind === 'flyby'
            ? factionBearing
            : factionBearing + formationSlot * WINGMATE_BEARING_SPREAD_RADIANS,
        orbitDirection: index % 2 === 0 ? 1 : -1,
        orbitRadiusFraction: rung(
          orbitRanks[index]!,
          roster.total,
          ORBIT_RADIUS_FRACTION_MIN,
          ORBIT_RADIUS_FRACTION_MAX,
        ),
        altitudeOffset: rung(tierRanks[index]!, roster.total, -tierSpan / 2, tierSpan / 2),
        arcLength: new Float64Array(kind === 'flyby' ? 0 : ARC_TABLE_SAMPLES),
        formationSlot,
        breatheRate: between(next, BREATHE_RADIANS_PER_SECOND_MIN, BREATHE_RADIANS_PER_SECOND_MAX),
        breathePhase: next() * Math.PI * 2,
        climbRate: between(next, CLIMB_RADIANS_PER_SECOND_MIN, CLIMB_RADIANS_PER_SECOND_MAX),
        climbPhase: next() * Math.PI * 2,
        phase: kind === 'flyby' ? 'flyby' : 'approach',
        hp: SAUCER_MAX_HP,
        fireIn: next() * LASER_BURST_REST_MIN_SECONDS,
        shotsLeft: LASER_BURST_SHOTS,
        burstTarget: null,
        lastTarget: null,
        resolution: 'exit',
        resolveSeconds: 0,
        crashCell: null,
        resolveFromX: 0,
        resolveFromY: 0,
        resolveFromAlt: 0,
        resolveFromSpeed: 0,
        diveSeconds: DIVE_SECONDS,
        gone: false,
        x: 0,
        y: 0,
        alt: site.altitude,
        heading: 0,
        speed: 0,
      };
      if (kind === 'dogfight') tabulateArcLength(saucer);
      saucers.push(saucer);
    }
  }

  encounter = {
    kind,
    seed,
    random: next,
    site,
    stage: kind === 'flyby' ? 'flyby' : 'approach',
    stageSeconds: 0,
    saucers,
    bolts: [],
    crashes: [],
    crashCellsUsed: 0,
  };

  placeSaucers();
  return seed;
}

export interface EncounterStart {
  readonly kind: EncounterKind;
  readonly seed: number;
  readonly site: ArenaSite;
  readonly saucers: number;
  readonly factions: number;
}

export function trySpawnEncounter(world: EncounterWorld, kind: EncounterKind): EncounterStart | null {
  if (encounter !== null) return null;
  const rng = createEncounterRng();
  const roster = kind === 'flyby' ? dealFlybyRoster(rng.next) : dealRoster(rng.next);
  const site = findArenaSite(world, Math.random, kind === 'flyby' ? 0 : roster.total);
  if (site === null) return null;
  return {
    kind,
    seed: begin(kind, site, roster, rng),
    site,
    saucers: roster.total,
    factions: roster.factionVariants.length,
  };
}

export function forceEncounterNear(
  world: EncounterWorld,
  kind: EncounterKind,
  near: { readonly x: number; readonly y: number },
): EncounterStart | null {
  if (encounter !== null) return null;
  const rng = createEncounterRng();
  const roster = kind === 'flyby' ? dealFlybyRoster(rng.next) : dealRoster(rng.next);
  const site = findArenaSiteNear(world, near, Math.random, kind === 'flyby' ? 0 : roster.total);
  if (site === null) return null;
  return {
    kind,
    seed: begin(kind, site, roster, rng),
    site,
    saucers: roster.total,
    factions: roster.factionVariants.length,
  };
}

interface CurvePoint {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const curvePoint: CurvePoint = { x: 0, y: 0, vx: 0, vy: 0 };

function curveAt(saucer: Saucer, u: number, out: CurvePoint): void {
  const meanRadius = ARENA_RADIUS_CELLS * saucer.orbitRadiusFraction;
  const orbitRate = (saucer.orbitDirection * DOGFIGHT_SPEED_CELLS_PER_SECOND) / meanRadius;
  const angle = saucer.bearing + orbitRate * u;
  const breathe = saucer.breatheRate * u + saucer.breathePhase;
  const radius = meanRadius + ARENA_RADIUS_CELLS * BREATHE_RADIUS_FRACTION * Math.sin(breathe);
  const radiusRate = ARENA_RADIUS_CELLS * BREATHE_RADIUS_FRACTION * saucer.breatheRate * Math.cos(breathe);

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  out.x = cos * radius;
  out.y = sin * radius;
  out.vx = radiusRate * cos - radius * sin * orbitRate;
  out.vy = radiusRate * sin + radius * cos * orbitRate;
}

function tabulateArcLength(saucer: Saucer): void {
  const table = saucer.arcLength;
  curveAt(saucer, 0, curvePoint);
  let previousSpeed = Math.hypot(curvePoint.vx, curvePoint.vy);
  table[0] = 0;
  for (let sample = 1; sample < table.length; sample++) {
    curveAt(saucer, sample * ARC_TABLE_STEP_SECONDS, curvePoint);
    const speed = Math.hypot(curvePoint.vx, curvePoint.vy);
    table[sample] = table[sample - 1]! + ((previousSpeed + speed) / 2) * ARC_TABLE_STEP_SECONDS;
    previousSpeed = speed;
  }
}

function parameterAtDistance(table: Float64Array, distance: number): number {
  const last = table.length - 1;
  if (distance <= 0) return 0;
  if (distance >= table[last]!) return last * ARC_TABLE_STEP_SECONDS;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (table[mid]! <= distance) low = mid;
    else high = mid;
  }
  const span = table[high]! - table[low]!;
  const fraction = span > 0 ? (distance - table[low]!) / span : 0;
  return (low + fraction) * ARC_TABLE_STEP_SECONDS;
}

interface CurvePose {
  x: number;
  y: number;
  alt: number;
  heading: number;
}

const shooterPose: CurvePose = { x: 0, y: 0, alt: 0, heading: 0 };
const targetPose: CurvePose = { x: 0, y: 0, alt: 0, heading: 0 };

function poseOnCurve(saucer: Saucer, site: ArenaSite, t: number, out: CurvePose): void {
  const u = parameterAtDistance(saucer.arcLength, DOGFIGHT_SPEED_CELLS_PER_SECOND * t);
  curveAt(saucer, u, curvePoint);
  out.x = site.centreX + curvePoint.x;
  out.y = site.centreY + curvePoint.y;
  out.heading = Math.atan2(curvePoint.vy, curvePoint.vx);
  out.alt =
    site.altitude +
    saucer.altitudeOffset +
    CLIMB_WORLD_UNITS * Math.sin(saucer.climbRate * t + saucer.climbPhase);
}

function placeOnCurve(saucer: Saucer, site: ArenaSite, t: number): void {
  poseOnCurve(saucer, site, t, saucer);
  saucer.speed = DOGFIGHT_SPEED_CELLS_PER_SECOND;
}

const curveStartPose: CurvePose = { x: 0, y: 0, alt: 0, heading: 0 };

function poseOnApproach(saucer: Saucer, site: ArenaSite, t: number, out: CurvePose): void {
  poseOnCurve(saucer, site, 0, curveStartPose);
  const curveStart = Math.hypot(curveStartPose.x - site.centreX, curveStartPose.y - site.centreY);
  const distance = ENTRY_DISTANCE_CELLS + (curveStart - ENTRY_DISTANCE_CELLS) * t;
  out.x = site.centreX + Math.cos(saucer.bearing) * distance;
  out.y = site.centreY + Math.sin(saucer.bearing) * distance;
  out.alt = site.altitude + saucer.altitudeOffset;
  out.heading = saucer.bearing + Math.PI;
}

function poseAtEncounterTime(saucer: Saucer, site: ArenaSite, seconds: number, out: CurvePose): void {
  if (seconds < APPROACH_SECONDS) poseOnApproach(saucer, site, seconds / APPROACH_SECONDS, out);
  else poseOnCurve(saucer, site, seconds - APPROACH_SECONDS, out);
}

function encounterSeconds(live: Encounter): number {
  return live.stage === 'approach' ? live.stageSeconds : APPROACH_SECONDS + live.stageSeconds;
}

function placeSaucers(): void {
  const live = encounter;
  if (live === null) return;
  const { site } = live;

  for (const saucer of live.saucers) {
    if (saucer.phase === 'approach') {
      poseOnApproach(saucer, site, clamp01(live.stageSeconds / APPROACH_SECONDS), saucer);
      saucer.speed = APPROACH_SPEED_CELLS_PER_SECOND;
      continue;
    }

    if (saucer.phase === 'flyby') {
      const inward = ENTRY_DISTANCE_CELLS - APPROACH_SPEED_CELLS_PER_SECOND * live.stageSeconds;
      const along = inward + Math.abs(saucer.formationSlot) * FLYBY_WING_STAGGER_CELLS;
      const abeam = saucer.formationSlot * FLYBY_WING_SPACING_CELLS;
      const cos = Math.cos(saucer.bearing);
      const sin = Math.sin(saucer.bearing);
      saucer.x = site.centreX + cos * along - sin * abeam;
      saucer.y = site.centreY + sin * along + cos * abeam;
      saucer.alt = site.altitude;
      saucer.heading = saucer.bearing + Math.PI;
      saucer.speed = APPROACH_SPEED_CELLS_PER_SECOND;
      continue;
    }

    if (saucer.phase === 'dogfight') {
      placeOnCurve(saucer, site, live.stageSeconds);
      continue;
    }

    const cell = saucer.crashCell;
    if (saucer.resolution === 'dive' && cell !== null) {
      const t = clamp01(saucer.resolveSeconds / saucer.diveSeconds);
      const dx = cell.x - saucer.resolveFromX;
      const dy = cell.y - saucer.resolveFromY;
      const dAlt = cell.groundY - saucer.resolveFromAlt;
      const length = Math.hypot(dx, dy, dAlt / CELL_WORLD_SIZE);
      const entry =
        length > 0 ? Math.min(1, (saucer.resolveFromSpeed * saucer.diveSeconds) / length) : 1;
      const fall = entry * t + (1 - entry) * t * t;
      saucer.x = saucer.resolveFromX + dx * fall;
      saucer.y = saucer.resolveFromY + dy * fall;
      saucer.alt = saucer.resolveFromAlt + dAlt * fall;
      saucer.heading = Math.atan2(dy, dx);
      saucer.speed = ((entry + 2 * (1 - entry) * t) * length) / saucer.diveSeconds;
      continue;
    }
    const t = clamp01(saucer.resolveSeconds / RESOLVE_SECONDS);
    const gain = EXIT_SPEED_MAX_CELLS_PER_SECOND - saucer.resolveFromSpeed;
    const run = RESOLVE_SECONDS * (saucer.resolveFromSpeed * t + (gain * t * t * t) / 3);
    saucer.x = saucer.resolveFromX + Math.cos(saucer.bearing) * run;
    saucer.y = saucer.resolveFromY + Math.sin(saucer.bearing) * run;
    saucer.alt = saucer.resolveFromAlt + EXIT_CLIMB_WORLD_UNITS * t * t * t;
    saucer.heading = saucer.bearing;
    saucer.speed = saucer.resolveFromSpeed + gain * t * t;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function isFighting(saucer: Saucer): boolean {
  return saucer.phase === 'dogfight' || saucer.phase === 'approach';
}

function nearestEnemy(live: Encounter, shooter: Saucer): Saucer | null {
  const unengaged = nearestEnemyWhere(
    live,
    shooter,
    (other) => (other.burstTarget ?? other.lastTarget) !== shooter.id,
  );
  return unengaged ?? nearestEnemyWhere(live, shooter, () => true);
}

function nearestEnemyWhere(
  live: Encounter,
  shooter: Saucer,
  accept: (other: Saucer) => boolean,
): Saucer | null {
  let best: Saucer | null = null;
  let bestDistance = Infinity;
  for (const other of live.saucers) {
    if (other.variant === shooter.variant || !isFighting(other) || !accept(other)) continue;
    const dx = other.x - shooter.x;
    const dy = other.y - shooter.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = other;
    }
  }
  return best;
}

function saucerById(live: Encounter, id: number): Saucer | null {
  for (const saucer of live.saucers) if (saucer.id === id) return saucer;
  return null;
}

function advanceFight(dt: number): void {
  const live = encounter;
  if (live === null) return;

  for (const bolt of live.bolts) {
    bolt.age += dt;
    if (!bolt.hit || bolt.landed || bolt.age < bolt.travelSeconds) continue;
    bolt.landed = true;
    const target = saucerById(live, bolt.to);
    if (target === null || !isFighting(target)) continue;
    target.hp -= LASER_HIT_DAMAGE;
    if (target.hp > 0) continue;
    target.hp = 0;
    shootDown(live, target);
  }
  if (live.bolts.length > 0) {
    live.bolts = live.bolts.filter((bolt) => bolt.age < LASER_BOLT_LIFETIME_SECONDS);
  }

  for (const shooter of live.saucers) {
    if (!isFighting(shooter)) continue;
    shooter.fireIn -= dt;
    if (shooter.fireIn > 0) continue;

    let target = shooter.burstTarget === null ? null : saucerById(live, shooter.burstTarget);
    if (target === null || !isFighting(target)) {
      target = nearestEnemy(live, shooter);
      shooter.burstTarget = target === null ? null : target.id;
    }
    if (target === null) continue;
    const bolt = fireAt(live, shooter, target);
    if (bolt === null) {
      shooter.fireIn = 0;
      continue;
    }
    shooter.lastTarget = target.id;
    live.bolts.push(bolt);

    shooter.shotsLeft--;
    if (shooter.shotsLeft > 0) {
      shooter.fireIn += LASER_SHOT_GAP_SECONDS;
      continue;
    }
    shooter.shotsLeft = LASER_BURST_SHOTS;
    shooter.burstTarget = null;
    shooter.fireIn += between(live.random, LASER_BURST_REST_MIN_SECONDS, LASER_BURST_REST_MAX_SECONDS);
  }
}

function shotLengthCells(from: CurvePose, to: CurvePose): number {
  return Math.hypot(to.x - from.x, to.y - from.y, (to.alt - from.alt) / CELL_WORLD_SIZE);
}

const AIM_PASSES = 8;

function fireAt(live: Encounter, shooter: Saucer, target: Saucer): Bolt | null {
  const now = encounterSeconds(live);
  poseAtEncounterTime(shooter, live.site, now, shooterPose);
  shooterPose.alt -= LASER_MUZZLE_DROP_WORLD_UNITS;

  poseAtEncounterTime(target, live.site, now, targetPose);
  for (let pass = 0; pass < AIM_PASSES; pass++) {
    const travel = shotLengthCells(shooterPose, targetPose) / LASER_BOLT_SPEED_CELLS_PER_SECOND;
    poseAtEncounterTime(target, live.site, now + travel, targetPose);
  }
  if (shotLengthCells(shooterPose, targetPose) > LASER_RANGE_CELLS) return null;

  const hit = live.random() < LASER_HIT_CHANCE;
  if (!hit) {
    const side = live.random() < 0.5 ? -1 : 1;
    const offset = between(live.random, LASER_MISS_OFFSET_MIN_CELLS, LASER_MISS_OFFSET_MAX_CELLS);
    const dx = targetPose.x - shooterPose.x;
    const dy = targetPose.y - shooterPose.y;
    const length = Math.hypot(dx, dy);
    if (length > 0) {
      targetPose.x += (-dy / length) * side * offset;
      targetPose.y += (dx / length) * side * offset;
    }
  }

  return {
    from: shooter.id,
    to: target.id,
    x: shooterPose.x,
    y: shooterPose.y,
    alt: shooterPose.alt,
    aimX: targetPose.x,
    aimY: targetPose.y,
    aimAlt: targetPose.alt,
    hit,
    travelSeconds: shotLengthCells(shooterPose, targetPose) / LASER_BOLT_SPEED_CELLS_PER_SECOND,
    age: 0,
    landed: false,
  };
}

function shootDown(live: Encounter, saucer: Saucer): void {
  const cell = live.site.crashCells[live.crashCellsUsed];
  if (cell === undefined) {
    resolveAs(saucer, 'exit', null);
    return;
  }
  live.crashCellsUsed++;
  resolveAs(saucer, 'dive', cell);
}

function resolveAs(saucer: Saucer, resolution: Resolution, cell: CrashCell | null): void {
  saucer.phase = 'resolve';
  saucer.resolution = resolution;
  saucer.crashCell = cell;
  saucer.resolveSeconds = 0;
  saucer.resolveFromX = saucer.x;
  saucer.resolveFromY = saucer.y;
  saucer.resolveFromAlt = saucer.alt;
  saucer.resolveFromSpeed = saucer.speed;
  saucer.diveSeconds = DIVE_SECONDS;
  if (cell !== null && saucer.speed > 0) {
    const length = Math.hypot(
      cell.x - saucer.x,
      cell.y - saucer.y,
      (cell.groundY - saucer.alt) / CELL_WORLD_SIZE,
    );
    saucer.diveSeconds = Math.min(DIVE_SECONDS, length / saucer.speed);
  }
}

function fightingFactions(live: Encounter): number[] {
  const factions: number[] = [];
  for (const saucer of live.saucers) {
    if (isFighting(saucer) && !factions.includes(saucer.variant)) factions.push(saucer.variant);
  }
  return factions;
}

function decideOnTime(live: Encounter): void {
  const factions = fightingFactions(live);
  let winner = factions[0]!;
  let winnerHp = -1;
  for (const faction of factions) {
    let hp = 0;
    for (const saucer of live.saucers) if (isFighting(saucer) && saucer.variant === faction) hp += saucer.hp;
    if (hp > winnerHp || (hp === winnerHp && live.random() < 0.5)) {
      winner = faction;
      winnerHp = hp;
    }
  }
  for (const saucer of live.saucers) {
    if (isFighting(saucer) && saucer.variant !== winner) shootDown(live, saucer);
  }
}

function applyCrash(world: EncounterWorld, cell: CrashCell): void {
  if (cell.water) {
    if (cell.depthBands <= CRASH_SEABED_CRATER_MAX_DEPTH_BANDS) {
      world.sculpt(cell.x, cell.y, CRASH_CRATER_RADIUS_CELLS, CRASH_CRATER_AMOUNT);
    }
    return;
  }
  world.sculpt(cell.x, cell.y, CRASH_CRATER_RADIUS_CELLS, CRASH_CRATER_AMOUNT);

  for (const [dx, dy] of CRASH_FIRE_RING_OFFSETS) {
    igniteRingCell(cell.x + dx, cell.y + dy, world.worldSize);
  }
}

function igniteRingCell(x: number, y: number, worldSize: number): void {
  if (x < 0 || y < 0 || x >= worldSize || y >= worldSize) return;
  igniteCrashCell(x, y);
}

export interface EncounterTick {
  readonly changed: boolean;
  readonly crashed: readonly CrashCell[];
  readonly ended: boolean;
}

const NO_CHANGE: EncounterTick = { changed: false, crashed: [], ended: false };

export function advanceEncounter(world: EncounterWorld, dt: number): EncounterTick {
  const live = encounter;
  if (live === null) return NO_CHANGE;

  live.stageSeconds += dt;

  if (live.stage === 'flyby') {
    if (live.stageSeconds >= FLYBY_SECONDS) {
      encounter = null;
      return { changed: true, crashed: [], ended: true };
    }
    placeSaucers();
    return { changed: true, crashed: [], ended: false };
  }

  if (live.stage === 'approach' && live.stageSeconds >= APPROACH_SECONDS) {
    for (const saucer of live.saucers) if (saucer.phase === 'approach') saucer.phase = 'dogfight';
    enterStage(live, 'dogfight');
  }
  if (live.stage === 'approach' || live.stage === 'dogfight') {
    advanceFight(dt);
    if (
      live.stage === 'dogfight' &&
      live.stageSeconds >= DOGFIGHT_SECONDS &&
      fightingFactions(live).length > 1
    ) {
      decideOnTime(live);
    }
    if (fightingFactions(live).length <= 1) {
      for (const saucer of live.saucers) if (isFighting(saucer)) resolveAs(saucer, 'exit', null);
      enterStage(live, 'resolve');
    }
  }

  const crashed: CrashCell[] = [];
  for (const saucer of live.saucers) {
    if (saucer.phase !== 'resolve') continue;
    saucer.resolveSeconds += dt;
    if (saucer.resolveSeconds < (saucer.resolution === 'dive' ? saucer.diveSeconds : RESOLVE_SECONDS)) {
      continue;
    }
    saucer.gone = true;
    const cell = saucer.crashCell;
    if (saucer.resolution !== 'dive' || cell === null) continue;
    applyCrash(world, cell);
    live.crashes.push({ id: saucer.id, x: cell.x, y: cell.y, water: cell.water, age: 0 });
    crashed.push(cell);
  }
  if (live.saucers.some((saucer) => saucer.gone)) {
    const kept = live.saucers.filter((saucer) => !saucer.gone);
    live.saucers.length = 0;
    live.saucers.push(...kept);
  }

  for (const crash of live.crashes) crash.age += dt;
  if (live.crashes.length > 0) {
    live.crashes = live.crashes.filter((crash) => crash.age < CRASH_WIRE_SECONDS);
  }

  if (live.stage === 'resolve' && live.saucers.length === 0 && live.crashes.length === 0) {
    encounter = null;
    return { changed: true, crashed, ended: true };
  }

  placeSaucers();
  return { changed: true, crashed, ended: false };
}

function enterStage(live: Encounter, stage: Stage): void {
  live.stage = stage;
  live.stageSeconds = 0;
}

export function encounterSaucers(): readonly SaucerState[] {
  const live = encounter;
  if (live === null) return [];
  return live.saucers.map((saucer) => ({
    id: saucer.id,
    variant: saucer.variant,
    x: saucer.x,
    y: saucer.y,
    alt: saucer.alt,
    heading: saucer.heading,
    speed: saucer.speed,
    phase: saucer.phase,
    hp: saucer.hp,
  }));
}

export function encounterBolts(): readonly LaserBolt[] {
  const live = encounter;
  if (live === null) return [];
  return live.bolts.map((bolt) => ({
    from: bolt.from,
    to: bolt.to,
    x: bolt.x,
    y: bolt.y,
    alt: bolt.alt,
    aimX: bolt.aimX,
    aimY: bolt.aimY,
    aimAlt: bolt.aimAlt,
    age: bolt.age,
  }));
}

export function encounterCrashes(): readonly CrashState[] {
  const live = encounter;
  if (live === null) return [];
  return live.crashes.map((crash) => ({
    id: crash.id,
    x: crash.x,
    y: crash.y,
    water: crash.water,
    age: crash.age,
  }));
}

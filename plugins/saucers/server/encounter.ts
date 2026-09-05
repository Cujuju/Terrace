// THE ENCOUNTER: one dogfight, from the moment the factions come over the
// horizon to the moment the last crater stops smoking.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE NULLABLE SLOT, NOT A LIST. `MAX_LIVING_ENCOUNTERS` is 1 and the invariant
// is STRUCTURAL rather than counted — there is exactly one variable below that
// can hold an encounter, so a second one is unrepresentable. That is monsters'
// per-kind-slot argument (plugins/monsters/server/summoning.ts) applied to a
// thing that is rarer still.
//
// ─────────────────────────────────────────────────────────────────────────────
// POSITIONS ARE PARAMETRIC, NOT INTEGRATED, and that is the deliberate
// difference from every other moving plugin in this repo.
//
// A boat, a monster and a tornado all integrate a velocity: they are wandering,
// and where they end up is the sim's business. A saucer is not wandering — its
// whole path is decided the instant the encounter is sited (the run-in bearing,
// the curve it flies, the cell it goes into), and the clocks are the only state
// that advances. Evaluating position as a function of a clock rather than
// summing steps means:
//
//   * a saucer arrives EXACTLY where its fight path begins when the approach
//     clock expires, and a wreck lands EXACTLY on the crash cell the sculpt is
//     aimed at, rather than near it plus accumulated float error;
//   * a retuned TICK_HZ changes nothing about where anything goes;
//   * there is no drift to correct and therefore no correction to get wrong.
//
// The one thing that IS integrated is the fight itself — hit points, the burst
// timers and the bolt ages — because those are events, not geometry.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY SAUCER FLIES ITS OWN CURVE (owner, 2026-09-04: the shared circle
// "looks like they are connected by one string"). Each one orbits the arena
// centre on its own radius, in its own direction, breathing in and out and
// porpoising up and down at its own rates and phases — a rosette, not a ring.
// Neighbours on the roster orbit opposite ways, so paths cross at angles
// several times a fight instead of chasing each other round one track.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY RANDOM CHOICE COMES FROM THE ENCOUNTER'S OWN SEEDED GENERATOR
// (./rng.ts), including the roster, every curve and who wins. Same seed, same
// fight, on any machine. Iteration over the roster is by index, always.

import {
  APPROACH_SECONDS,
  APPROACH_SPEED_CELLS_PER_SECOND,
  ARENA_RADIUS_CELLS,
  CRASH_CRATER_DEPTH_BANDS,
  CRASH_CRATER_RADIUS_CELLS,
  CRASH_FIRE_RING_OFFSETS,
  CRASH_WIRE_SECONDS,
  DIVE_SPEED_CELLS_PER_SECOND,
  DOGFIGHT_HOLD_FIRE_SECONDS,
  DOGFIGHT_SECONDS,
  DOGFIGHT_SPEED_CELLS_PER_SECOND,
  ENTRY_DISTANCE_CELLS,
  EXIT_SPEED_CELLS_PER_SECOND,
  HEIGHT_WORLD_SCALE,
  LASER_BOLT_LIFETIME_SECONDS,
  LASER_BOLT_SPEED_CELLS_PER_SECOND,
  LASER_BURST_REST_MAX_SECONDS,
  LASER_BURST_REST_MIN_SECONDS,
  LASER_BURST_SHOTS,
  LASER_HIT_CHANCE,
  LASER_HIT_DAMAGE,
  LASER_SHOT_GAP_SECONDS,
  MAX_FACTIONS_PER_ENCOUNTER,
  MAX_SAUCERS_PER_FACTION,
  MIN_FACTIONS_PER_ENCOUNTER,
  MIN_SAUCERS_PER_ENCOUNTER,
  MIN_SAUCERS_PER_FACTION,
  RESOLVE_SECONDS,
  SAUCER_MAX_HP,
  SAUCER_VARIANT_COUNT,
  type CrashState,
  type LaserBolt,
  type SaucerPhase,
  type SaucerState,
} from '../protocol.ts';
import { BAND_HEIGHT } from '@terrace/shared';
import { igniteCrashCell } from './fire-bridge.ts';
import { createEncounterRng } from './rng.ts';
import {
  findArenaSite,
  findArenaSiteNear,
  type ArenaSite,
  type CrashCell,
  type SiteWorld,
} from './site.ts';

/**
 * The slice of the world an encounter needs beyond siting: the two writes a
 * crash makes. Structural, so `WorldApi` satisfies it directly.
 */
export interface EncounterWorld extends SiteWorld {
  sculpt(x: number, y: number, radius: number, amount: number): unknown;
}

/**
 * The band of orbit radii a saucer's curve is drawn from, as fractions of the
 * arena radius. 0.55 to 1.0: the inner edge keeps the tightest orbit wider
 * than a hull, so a saucer never wheels about its own length, and the outer
 * edge is the arena's own rim, which the site was cleared for.
 */
const ORBIT_RADIUS_FRACTION_MIN = 0.55;
const ORBIT_RADIUS_FRACTION_MAX = 1;

/**
 * How far off its own orbit each saucer breathes, as a fraction of the arena
 * radius, and the band of rates it breathes at.
 *
 * A THIRD, at 0.9–1.6 rad/s. The breathing is what turns a ring into a
 * rosette: two saucers on nearby orbits, going opposite ways and breathing out
 * of phase, cross at a different angle every time. The rate band is chosen
 * not to contain a whole multiple of any orbit rate, so no path closes inside
 * DOGFIGHT_SECONDS.
 */
const BREATHE_RADIUS_FRACTION = 0.3;
const BREATHE_RADIANS_PER_SECOND_MIN = 0.9;
const BREATHE_RADIANS_PER_SECOND_MAX = 1.6;

/**
 * How far a saucer rises and falls over the fight, in world units, and the
 * band of rates it does so at.
 *
 * TWO units at 0.8–1.4 rad/s — a porpoise. The purpose is that the saucers do
 * not sit in one flat plane; anything deeper starts to look like they are
 * losing control, which is the dive's job to say.
 */
const CLIMB_WORLD_UNITS = 2;
const CLIMB_RADIANS_PER_SECOND_MIN = 0.8;
const CLIMB_RADIANS_PER_SECOND_MAX = 1.4;

/**
 * How far apart a faction's wingmates come in, in radians of bearing about
 * the arena centre. 0.35 rad (20°) between neighbours: a faction of five spans
 * 80°, which reads as a formation rather than a line astern.
 */
const WINGMATE_BEARING_SPREAD_RADIANS = 0.35;

/**
 * How far the winners climb on the way out, in world units.
 *
 * TWELVE — nearly the world's whole relief again, on top of an altitude that is
 * already six bands clear of the ground. Combined with EXIT_SPEED that takes a
 * saucer off the top of the frame rather than off the side of it, which is what
 * "takes off" means and is also why nothing has to chase it to the map edge.
 */
const EXIT_CLIMB_WORLD_UNITS = 12;

/** The crater's depth as `sculpt` takes it: negative height units. */
const CRASH_CRATER_AMOUNT = -(CRASH_CRATER_DEPTH_BANDS * BAND_HEIGHT);

/** What a saucer in `resolve` is doing. */
type Resolution = 'dive' | 'exit';

/** One saucer's live state. Mutable — this is the sim's own record. */
interface Saucer {
  readonly id: number;
  /** The faction, and the hull. See protocol.ts: a faction IS a hull. */
  readonly variant: number;
  /**
   * The bearing this saucer owns for the whole encounter: it comes in along it,
   * begins its curve from it, and (if it wins) leaves along it. Radians from
   * the arena centre. Factions are spread evenly round the compass and
   * wingmates fan out either side of their faction's bearing.
   */
  readonly bearing: number;
  /** +1 anticlockwise, -1 clockwise. Alternates down the roster. */
  readonly orbitDirection: number;
  /** Fraction of the arena radius this saucer's orbit sits at. */
  readonly orbitRadiusFraction: number;
  readonly breatheRate: number;
  readonly breathePhase: number;
  readonly climbRate: number;
  readonly climbPhase: number;
  phase: SaucerPhase;
  hp: number;
  /** Seconds until this saucer's next shot. */
  fireIn: number;
  /** Shots still to fire in the burst under way. */
  shotsLeft: number;
  /** Id of the saucer the current burst is aimed at, or null between bursts. */
  burstTarget: number | null;
  /** Set on entering `resolve`. */
  resolution: Resolution;
  /** Seconds elapsed inside `resolve`. */
  resolveSeconds: number;
  /** Where the dive ends. Null until this saucer is shot down. */
  crashCell: CrashCell | null;
  /** The pose it held when `resolve` began — the dive/climb starts here. */
  resolveFromX: number;
  resolveFromY: number;
  resolveFromAlt: number;
  /** Set on the tick the dive lands or the climb-out finishes. */
  gone: boolean;
  /** Filled every tick; what goes on the wire. */
  x: number;
  y: number;
  alt: number;
  heading: number;
  speed: number;
}

/**
 * A bolt in flight, ageing. Whether it will connect was rolled the instant it
 * was fired; the DAMAGE lands when the bolt does — `travelSeconds` after the
 * shot — so the hit on the wire and the bolt on the screen arrive together.
 */
interface Bolt {
  readonly from: number;
  readonly to: number;
  readonly hit: boolean;
  readonly travelSeconds: number;
  age: number;
  landed: boolean;
}

/** An impact still on the wire. */
interface Crash extends CrashState {
  age: number;
}

/**
 * The encounter's own stage: the approach everyone flies together, the fight,
 * and the resolve that begins the moment a faction has won (or the clock has
 * decided) — saucers leave the sky one by one after that.
 */
type Stage = 'approach' | 'dogfight' | 'resolve';

interface Encounter {
  readonly seed: number;
  readonly random: () => number;
  readonly site: ArenaSite;
  stage: Stage;
  /** Seconds elapsed inside the current stage. */
  stageSeconds: number;
  readonly saucers: Saucer[];
  bolts: Bolt[];
  crashes: Crash[];
  /** How many of the site's crash cells have been handed out. */
  crashCellsUsed: number;
}

/** The roster one encounter is dealt: which hull each faction wears, and how many. */
interface Roster {
  readonly factionVariants: readonly number[];
  readonly factionSizes: readonly number[];
  readonly total: number;
}

/**
 * THE SLOT. One encounter or none, for the whole world. See this file's header
 * for why it is a variable and not a list.
 */
let encounter: Encounter | null = null;

/** Ids are unique for the life of the process — the client keys views by them. */
let nextSaucerId = 1;

/** Whether an encounter is running right now. */
export function hasEncounter(): boolean {
  return encounter !== null;
}

/** The seed of the running encounter, for a log line. Null when none is. */
export function encounterSeed(): number | null {
  return encounter === null ? null : encounter.seed;
}

/** Drops everything. Called on world create, world close and from the test seam. */
export function resetEncounter(): void {
  encounter = null;
}

/** A draw from [min, max). */
function between(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

/** A whole number from [min, max], both inclusive. */
function wholeBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Deals the roster: how many factions, which hull each wears, how many saucers
 * each brings — within protocol.ts's bounds.
 *
 * Hulls are dealt by a seeded Fisher–Yates over the variant list, so two
 * factions never share a body (the header's "a faction is a hull"). A total
 * under the encounter floor is topped up faction by faction from the first,
 * which keeps every faction at least MIN_SAUCERS_PER_FACTION and the result
 * a function of the draws alone.
 */
function dealRoster(random: () => number): Roster {
  const factions = wholeBetween(random, MIN_FACTIONS_PER_ENCOUNTER, MAX_FACTIONS_PER_ENCOUNTER);

  const variants: number[] = [];
  for (let variant = 0; variant < SAUCER_VARIANT_COUNT; variant++) variants.push(variant);
  for (let index = variants.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    const held = variants[index]!;
    variants[index] = variants[swap]!;
    variants[swap] = held;
  }

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

/**
 * Starts an encounter at `site` with `roster`, off `rng`.
 *
 * PRIVATE TO THIS FILE'S TWO ENTRY POINTS (`trySpawnEncounter` and
 * `forceEncounterNear`), because a caller that could supply its own site could
 * supply one whose crash cells were never checked — and the whole argument in
 * site.ts is that an encounter with an unchecked crash cell must not exist.
 * The site was asked for exactly `roster.total` cells, one per saucer, because
 * two bolts landing on the same tick can take the last two saucers down
 * together and leave nobody to fly away.
 */
function begin(
  site: ArenaSite,
  roster: Roster,
  rng: { readonly seed: number; readonly next: () => number },
): number {
  const { seed, next } = rng;

  // Factions spread evenly round the compass from one drawn bearing, so they
  // come in from as far apart as the count allows.
  const compassOffset = next() * Math.PI * 2;
  const factionSpacing = (Math.PI * 2) / roster.factionVariants.length;

  const saucers: Saucer[] = [];
  for (let faction = 0; faction < roster.factionVariants.length; faction++) {
    const variant = roster.factionVariants[faction]!;
    const size = roster.factionSizes[faction]!;
    const factionBearing = compassOffset + faction * factionSpacing;
    for (let wingmate = 0; wingmate < size; wingmate++) {
      const index = saucers.length;
      saucers.push({
        id: nextSaucerId++,
        variant,
        bearing: factionBearing + (wingmate - (size - 1) / 2) * WINGMATE_BEARING_SPREAD_RADIANS,
        orbitDirection: index % 2 === 0 ? 1 : -1,
        orbitRadiusFraction: between(next, ORBIT_RADIUS_FRACTION_MIN, ORBIT_RADIUS_FRACTION_MAX),
        breatheRate: between(next, BREATHE_RADIANS_PER_SECOND_MIN, BREATHE_RADIANS_PER_SECOND_MAX),
        breathePhase: next() * Math.PI * 2,
        climbRate: between(next, CLIMB_RADIANS_PER_SECOND_MIN, CLIMB_RADIANS_PER_SECOND_MAX),
        climbPhase: next() * Math.PI * 2,
        phase: 'approach',
        hp: SAUCER_MAX_HP,
        // Everyone opens fire within one rest of the hold-fire floor lifting,
        // each at their own moment.
        fireIn: next() * LASER_BURST_REST_MIN_SECONDS,
        shotsLeft: LASER_BURST_SHOTS,
        burstTarget: null,
        resolution: 'exit',
        resolveSeconds: 0,
        crashCell: null,
        resolveFromX: 0,
        resolveFromY: 0,
        resolveFromAlt: 0,
        gone: false,
        x: 0,
        y: 0,
        alt: site.altitude,
        heading: 0,
        speed: 0,
      });
    }
  }

  encounter = {
    seed,
    random: next,
    site,
    stage: 'approach',
    stageSeconds: 0,
    saucers,
    bolts: [],
    crashes: [],
    crashCellsUsed: 0,
  };

  // The poses are filled before anything can read them: an encounter that
  // existed for one broadcast with every saucer at (0, 0) would put the whole
  // roster in the corner of the map for a tenth of a second.
  placeSaucers();
  return seed;
}

/** What an encounter's start looks like to the caller. */
export interface EncounterStart {
  readonly seed: number;
  readonly site: ArenaSite;
  readonly saucers: number;
  readonly factions: number;
}

/**
 * Rolls an encounter into existence somewhere on this world, or reports why not.
 *
 * Returns null when the world has nowhere legal to fly one (see
 * site.ts#findArenaSite) — an ordinary answer, not an error. THE ROSTER IS
 * DEALT BEFORE THE SITE, because the site has to know how many crash cells to
 * find; the site draw itself runs off the arrival stream's generator, not the
 * encounter's, exactly as before.
 */
export function trySpawnEncounter(world: EncounterWorld): EncounterStart | null {
  if (encounter !== null) return null;
  const rng = createEncounterRng();
  const roster = dealRoster(rng.next);
  const site = findArenaSite(world, Math.random, roster.total);
  if (site === null) return null;
  return {
    seed: begin(site, roster, rng),
    site,
    saucers: roster.total,
    factions: roster.factionVariants.length,
  };
}

/**
 * THE ADMIN PANEL'S DOGFIGHT: an encounter over the nearest legal ground to
 * where the operator is looking.
 *
 * Returns the start, or null with nothing changed.
 */
export function forceEncounterNear(
  world: EncounterWorld,
  near: { readonly x: number; readonly y: number },
): EncounterStart | null {
  if (encounter !== null) return null;
  const rng = createEncounterRng();
  const roster = dealRoster(rng.next);
  const site = findArenaSiteNear(world, near, Math.random, roster.total);
  if (site === null) return null;
  return {
    seed: begin(site, roster, rng),
    site,
    saucers: roster.total,
    factions: roster.factionVariants.length,
  };
}

/**
 * Where a saucer's fight curve is at `t` seconds into the fight, and which way
 * it is going. Pure — the rosette described in the file header, with the
 * velocity taken analytically so the heading is exact rather than differenced.
 */
function placeOnCurve(saucer: Saucer, site: ArenaSite, t: number): void {
  const meanRadius = ARENA_RADIUS_CELLS * saucer.orbitRadiusFraction;
  // Angular rate DERIVED from the linear speed and the orbit, so retuning
  // either keeps the other honest: a saucer that "flies at 20 units/s" flies at
  // about that whatever circle it is on.
  const orbitRate = (saucer.orbitDirection * DOGFIGHT_SPEED_CELLS_PER_SECOND) / meanRadius;
  const angle = saucer.bearing + orbitRate * t;
  const breathe = saucer.breatheRate * t + saucer.breathePhase;
  const radius = meanRadius + ARENA_RADIUS_CELLS * BREATHE_RADIUS_FRACTION * Math.sin(breathe);
  const radiusRate = ARENA_RADIUS_CELLS * BREATHE_RADIUS_FRACTION * saucer.breatheRate * Math.cos(breathe);

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  saucer.x = site.centreX + cos * radius;
  saucer.y = site.centreY + sin * radius;
  const vx = radiusRate * cos - radius * sin * orbitRate;
  const vy = radiusRate * sin + radius * cos * orbitRate;
  saucer.heading = Math.atan2(vy, vx);
  saucer.speed = Math.sqrt(vx * vx + vy * vy);
  saucer.alt = site.altitude + CLIMB_WORLD_UNITS * Math.sin(saucer.climbRate * t + saucer.climbPhase);
}

/**
 * Recomputes every saucer's pose from the clocks. See this file's header for
 * why the whole path is a function of time rather than an integration.
 */
function placeSaucers(): void {
  const live = encounter;
  if (live === null) return;
  const { site } = live;

  for (const saucer of live.saucers) {
    if (saucer.phase === 'approach') {
      // Distance shrinks from the run-in start to where this saucer's own curve
      // begins, so it is exactly on its curve — where the dogfight begins — as
      // the clock expires.
      const t = clamp01(live.stageSeconds / APPROACH_SECONDS);
      placeOnCurve(saucer, site, 0);
      const curveStart = Math.hypot(saucer.x - site.centreX, saucer.y - site.centreY);
      const distance = ENTRY_DISTANCE_CELLS + (curveStart - ENTRY_DISTANCE_CELLS) * t;
      saucer.x = site.centreX + Math.cos(saucer.bearing) * distance;
      saucer.y = site.centreY + Math.sin(saucer.bearing) * distance;
      saucer.alt = site.altitude;
      // Flying INWARD along its own bearing — the reciprocal of it.
      saucer.heading = saucer.bearing + Math.PI;
      saucer.speed = APPROACH_SPEED_CELLS_PER_SECOND;
      continue;
    }

    if (saucer.phase === 'dogfight') {
      placeOnCurve(saucer, site, live.stageSeconds);
      continue;
    }

    // resolve — a loser dives at its crash cell, a winner climbs away along its
    // own bearing. Both start from the pose held when the phase began.
    const t = clamp01(saucer.resolveSeconds / RESOLVE_SECONDS);
    const cell = saucer.crashCell;
    if (saucer.resolution === 'dive' && cell !== null) {
      // t² rather than t: a wreck ACCELERATES into the ground. A straight lerp
      // reads as a controlled descent, which is the one thing this must not look
      // like.
      const fall = t * t;
      saucer.x = saucer.resolveFromX + (cell.x - saucer.resolveFromX) * fall;
      saucer.y = saucer.resolveFromY + (cell.y - saucer.resolveFromY) * fall;
      saucer.alt = saucer.resolveFromAlt + (cell.groundY - saucer.resolveFromAlt) * fall;
      saucer.heading = Math.atan2(cell.y - saucer.resolveFromY, cell.x - saucer.resolveFromX);
      saucer.speed = DIVE_SPEED_CELLS_PER_SECOND;
      continue;
    }
    const run = EXIT_SPEED_CELLS_PER_SECOND * RESOLVE_SECONDS * t;
    saucer.x = saucer.resolveFromX + Math.cos(saucer.bearing) * run;
    saucer.y = saucer.resolveFromY + Math.sin(saucer.bearing) * run;
    saucer.alt = saucer.resolveFromAlt + EXIT_CLIMB_WORLD_UNITS * t;
    saucer.heading = saucer.bearing;
    saucer.speed = EXIT_SPEED_CELLS_PER_SECOND;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Still fighting: in the sky, taking and dealing shots. */
function isFighting(saucer: Saucer): boolean {
  return saucer.phase === 'dogfight';
}

/**
 * The enemy this saucer should shoot at: the NEAREST one still fighting, ties
 * to the earlier index. Null when no enemy is left, which is the fight ending.
 */
function nearestEnemy(live: Encounter, shooter: Saucer): Saucer | null {
  let best: Saucer | null = null;
  let bestDistance = Infinity;
  for (const other of live.saucers) {
    if (other.variant === shooter.variant || !isFighting(other)) continue;
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

/**
 * Runs the fight for one tick: bolts landing, burst timers, shots, bolt ages.
 *
 * FIXED ITERATION ORDER — bolts oldest first, then saucers by roster index,
 * every tick, forever — so the same seed resolves the same fight.
 *
 * DAMAGE LANDS WITH THE BOLT, not with the shot: a bolt rolled as a hit takes
 * its hit points off when its age reaches its travel time, and only if its
 * target is still fighting — a saucer already diving cannot be shot down
 * twice. A bolt whose shooter has since gone down still lands, because it was
 * already in the air; that is how the last two saucers can take each other
 * down on the same tick, and why the site holds a crash cell for everyone.
 *
 * A SAUCER FIRES AT MOST ONE SHOT PER TICK; LASER_SHOT_GAP_SECONDS is a tick,
 * so a burst is three consecutive ticks and a longer tick simply widens the
 * gap to itself.
 */
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
  // Pruned by rebuilding rather than by splicing in place: the list holds at
  // most MAX_LASER_BOLTS entries and is rebuilt at most ten times a second for
  // the twenty seconds an encounter lasts, so the allocation is nothing, and a
  // backwards splice loop is the kind of thing that is wrong once.
  if (live.bolts.length > 0) {
    live.bolts = live.bolts.filter((bolt) => bolt.age < LASER_BOLT_LIFETIME_SECONDS);
  }

  for (const shooter of live.saucers) {
    if (!isFighting(shooter)) continue;
    shooter.fireIn -= dt;
    if (shooter.fireIn > 0) continue;

    // A burst is aimed once, at its first shot; a target that goes down
    // mid-burst hands the rest of the burst to the next nearest.
    let target = shooter.burstTarget === null ? null : saucerById(live, shooter.burstTarget);
    if (target === null || !isFighting(target)) {
      target = nearestEnemy(live, shooter);
      shooter.burstTarget = target === null ? null : target.id;
    }
    if (target === null) continue;

    const distance = Math.hypot(target.x - shooter.x, target.y - shooter.y);
    live.bolts.push({
      from: shooter.id,
      to: target.id,
      hit: live.random() < LASER_HIT_CHANCE,
      travelSeconds: distance / LASER_BOLT_SPEED_CELLS_PER_SECOND,
      age: 0,
      landed: false,
    });

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

/**
 * Takes one saucer out of the fight and into its dive, on the next unused
 * crash cell. The site holds one cell per saucer (see `begin`), so the cell is
 * always there; the guard is belt and suspenders, and a saucer it fires for
 * leaves the sky under power rather than diving at nothing.
 */
function shootDown(live: Encounter, saucer: Saucer): void {
  const cell = live.site.crashCells[live.crashCellsUsed];
  if (cell === undefined) {
    resolveAs(saucer, 'exit', null);
    return;
  }
  live.crashCellsUsed++;
  resolveAs(saucer, 'dive', cell);
}

/** Moves a saucer into `resolve` from wherever it is right now. */
function resolveAs(saucer: Saucer, resolution: Resolution, cell: CrashCell | null): void {
  saucer.phase = 'resolve';
  saucer.resolution = resolution;
  saucer.crashCell = cell;
  saucer.resolveSeconds = 0;
  // The dive and the climb both start from where the saucer actually is at
  // this instant, which is why the pose is captured on the transition rather
  // than recomputed from the curve afterwards.
  saucer.resolveFromX = saucer.x;
  saucer.resolveFromY = saucer.y;
  saucer.resolveFromAlt = saucer.alt;
}

/** The distinct factions with a saucer still fighting, in roster order. */
function fightingFactions(live: Encounter): number[] {
  const factions: number[] = [];
  for (const saucer of live.saucers) {
    if (isFighting(saucer) && !factions.includes(saucer.variant)) factions.push(saucer.variant);
  }
  return factions;
}

/**
 * Names the winner when the dogfight clock runs out with more than one faction
 * still flying: THE FACTION WITH THE MOST HIT POINTS LEFT, ties to the
 * encounter's own coin. Everyone else goes down.
 *
 * It exists because a fight that simply stopped would leave the roster
 * orbiting forever, and because "whoever is ahead on the clock wins" is the
 * result a watching player would already have predicted from the damage they
 * have seen. IT IS THE UNCOMMON PATH, by construction — see SAUCER_MAX_HP.
 */
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

/**
 * THE CRASH — the only thing this plugin writes into the world.
 *
 * ONE `sculpt` and then the fire ring, in that order and never the reverse: the
 * sculpt moves the ground, and a fire lit before it would be lit on cells the
 * crater then swallows.
 *
 * NEITHER CAN BE VETOED, and the crash cell was therefore vetted at siting
 * rather than here — see structures-bridge.ts for the source reading behind
 * that.
 */
function applyCrash(world: EncounterWorld, cell: CrashCell): void {
  world.sculpt(cell.x, cell.y, CRASH_CRATER_RADIUS_CELLS, CRASH_CRATER_AMOUNT);

  // Fixed iteration order over a fixed table (../protocol.ts) — the same crash
  // lights the same cells on every machine. Most of these refuse; see
  // fire-bridge.ts.
  for (const [dx, dy] of CRASH_FIRE_RING_OFFSETS) {
    igniteRingCell(cell.x + dx, cell.y + dy, world.worldSize);
  }
}

/**
 * Lights one ring cell, if it is on the map at all. The bounds check is here
 * rather than inside the bridge because "off the map" is not fire's business —
 * it is this plugin's, and a crash on the very edge of the world is legal.
 */
function igniteRingCell(x: number, y: number, worldSize: number): void {
  if (x < 0 || y < 0 || x >= worldSize || y >= worldSize) return;
  igniteCrashCell(x, y);
}

/** What one tick of the encounter produced, for the caller to act on. */
export interface EncounterTick {
  /** The roster or a phase changed, so clients need telling now. */
  readonly changed: boolean;
  /** The impacts on this tick, in roster order — for the world event. */
  readonly crashed: readonly CrashCell[];
  /** The encounter finished on this tick, so one last empty payload is owed. */
  readonly ended: boolean;
}

const NO_CHANGE: EncounterTick = { changed: false, crashed: [], ended: false };

/**
 * Advances the running encounter by one tick.
 *
 * STAGE TRANSITIONS ARE CHECKED AFTER the clocks advance and BEFORE the poses
 * are recomputed, so a saucer is never placed with a clock that has run past
 * its phase's length — the clamps in `placeSaucers` are belt and suspenders
 * for that, not the mechanism.
 */
export function advanceEncounter(world: EncounterWorld, dt: number): EncounterTick {
  const live = encounter;
  if (live === null) return NO_CHANGE;

  live.stageSeconds += dt;

  if (live.stage === 'approach') {
    if (live.stageSeconds >= APPROACH_SECONDS) {
      for (const saucer of live.saucers) saucer.phase = 'dogfight';
      enterStage(live, 'dogfight');
    }
  } else if (live.stage === 'dogfight') {
    // THE HOLD-FIRE FLOOR: the curves are flown from the first second, but no
    // shot is fired — and so nobody can go down — before it lifts.
    if (live.stageSeconds >= DOGFIGHT_HOLD_FIRE_SECONDS) advanceFight(dt);
    if (live.stageSeconds >= DOGFIGHT_SECONDS && fightingFactions(live).length > 1) {
      decideOnTime(live);
    }
    if (fightingFactions(live).length <= 1) {
      // The winners take off the moment the last enemy starts falling.
      for (const saucer of live.saucers) if (isFighting(saucer)) resolveAs(saucer, 'exit', null);
      enterStage(live, 'resolve');
    }
  }

  // Divers land and winners leave on their own clocks, whichever stage the
  // encounter is in — a saucer shot down mid-fight is in the ground before the
  // fight is over.
  const crashed: CrashCell[] = [];
  for (const saucer of live.saucers) {
    if (saucer.phase !== 'resolve') continue;
    saucer.resolveSeconds += dt;
    if (saucer.resolveSeconds < RESOLVE_SECONDS) continue;
    saucer.gone = true;
    const cell = saucer.crashCell;
    if (saucer.resolution !== 'dive' || cell === null) continue;
    applyCrash(world, cell);
    live.crashes.push({ id: saucer.id, x: cell.x, y: cell.y, age: 0 });
    crashed.push(cell);
  }
  if (live.saucers.some((saucer) => saucer.gone)) {
    // Rebuilt rather than spliced, for advanceFight's reason; roster order is
    // preserved, which is what keeps the iteration order fixed.
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

/** The live saucers at wire precision is the caller's business; these are raw. */
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

/** The bolts in flight, oldest first (the order they were fired in). */
export function encounterBolts(): readonly LaserBolt[] {
  const live = encounter;
  if (live === null) return [];
  return live.bolts.map((bolt) => ({ from: bolt.from, to: bolt.to, age: bolt.age }));
}

/**
 * The impacts still on the wire, oldest first. A wreck still diving is not
 * here — it has not hit anything yet, and a client told where it WILL hit
 * could draw the fireball early.
 */
export function encounterCrashes(): readonly CrashState[] {
  const live = encounter;
  if (live === null) return [];
  return live.crashes.map((crash) => ({ id: crash.id, x: crash.x, y: crash.y, age: crash.age }));
}

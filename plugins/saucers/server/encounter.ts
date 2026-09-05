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
// THE SECOND REVISION (owner, 2026-09-04: "clumping up too much, running in to
// each other, and slowing down when they do come too close") found the shape's
// two faults, and both were in the parametrisation, not the shape:
//
//   * THE SPEED WAS THE RADIUS. The angular rate was fixed by the MEAN radius,
//     so the linear speed was `radius × rate` — a saucer breathing in to a
//     quarter of the arena flew at under half speed, and every inner-orbit
//     saucer did so at the centre, together. The curve is now flown by ARC
//     LENGTH: a per-saucer table (`arcLength`) maps distance flown to the
//     curve parameter, and the wire speed is DOGFIGHT_SPEED exactly, always.
//   * THE RADII WERE DRAWN, so two could land on the same orbit. Each saucer
//     now owns a distinct RUNG of the orbit band, and a distinct ALTITUDE TIER
//     with the porpoise kept smaller than the tier spacing — which is the
//     collision guarantee: two curves may cross in plan, never in the air.
//
// A FLY-BY (same revision) is the other kind of encounter: one faction in a
// V formation, straight through the arena at approach speed and out the far
// side, with no fight, no bolts and no crash cells. It shares the slot.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY RANDOM CHOICE COMES FROM THE ENCOUNTER'S OWN SEEDED GENERATOR
// (./rng.ts), including the roster, every curve and who wins. Same seed, same
// fight, on any machine. Iteration over the roster is by index, always.

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

/**
 * The slice of the world an encounter needs beyond siting: the two writes a
 * crash makes. Structural, so `WorldApi` satisfies it directly.
 */
export interface EncounterWorld extends SiteWorld {
  sculpt(x: number, y: number, radius: number, amount: number): unknown;
}

/**
 * The orbit band and the breathing amplitude live in ../protocol.ts (the
 * bolt lifetime is derived from them). EACH SAUCER OWNS ONE RUNG of the band —
 * the band divided evenly by the roster, dealt by a seeded shuffle — rather
 * than a draw from it, so no two fly the same orbit (the header's second
 * revision).
 *
 * The band of rates the breathing runs at: 0.9–1.6 rad/s. The breathing is
 * what turns a ring into a rosette: two saucers on nearby orbits, going
 * opposite ways and breathing out of phase, cross at a different angle every
 * time. The band is chosen not to contain a whole multiple of any orbit rate,
 * so no path closes inside DOGFIGHT_SECONDS.
 */
const BREATHE_RADIANS_PER_SECOND_MIN = 0.9;
const BREATHE_RADIANS_PER_SECOND_MAX = 1.6;

/**
 * THE COLLISION GUARANTEE: each saucer owns one ALTITUDE TIER, dealt by a
 * seeded shuffle and centred on the site's altitude, and porpoises about it by
 * less than half the tier spacing — so two saucers whose curves cross in plan
 * are never closer in the air than the difference.
 *
 * A tier is ONE WORLD UNIT — one hull diameter (SAUCER_DIAMETER_CELLS) — and
 * a porpoise a quarter of that: ALTITUDE_TIER_WORLD_UNITS and CLIMB_WORLD_UNITS
 * in ../protocol.ts, on the wire's side because the stack's height is a leg of
 * the longest shot. A porpoise of a quarter unit leaves neighbours at least
 * half a unit apart at the worst moment — two cells, which a disc a hull wide
 * is assumed thinner than (unverified against the GLBs). The largest roster
 * stacks eight units tall, centred six above the arena's peak; a typical one
 * is under four.
 */
const CLIMB_RADIANS_PER_SECOND_MIN = 0.8;
const CLIMB_RADIANS_PER_SECOND_MAX = 1.4;

/**
 * The step, in curve-parameter seconds, the arc-length table is sampled at.
 * A twentieth of a second: at dogfight speed that is one world unit of path,
 * one hull, and the curve bends little over one hull, so the linear
 * inversion between samples is invisible.
 */
const ARC_TABLE_STEP_SECONDS = 0.05;

/**
 * How far the curve parameter can run ahead of the clock, and so how long the
 * table must be. DERIVED: the curve is slowest — and the parameter advances
 * fastest — at the inner edge of the innermost orbit, where the linear speed
 * is the parameter's nominal speed scaled by that radius over the orbit's
 * mean. The table covers the whole dogfight at that worst case.
 */
const ARC_TABLE_PARAMETER_HEADROOM =
  ORBIT_RADIUS_FRACTION_MIN / (ORBIT_RADIUS_FRACTION_MIN - BREATHE_RADIUS_FRACTION);
const ARC_TABLE_SAMPLES =
  Math.ceil((DOGFIGHT_SECONDS * ARC_TABLE_PARAMETER_HEADROOM) / ARC_TABLE_STEP_SECONDS) + 1;

/**
 * A fly-by's V formation, in cells: the lateral gap between neighbouring
 * wingmates and how far each one trails the wingmate inboard of it.
 *
 * SIX cells abreast — a hull and a half, so the wings never overlap in plan —
 * and four back, which opens the V enough to read as one from any angle.
 */
const FLYBY_WING_SPACING_CELLS = 6;
const FLYBY_WING_STAGGER_CELLS = 4;

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
  /** Fraction of the arena radius this saucer's orbit sits at — its rung. */
  readonly orbitRadiusFraction: number;
  /** World units above or below the site's altitude — its tier. */
  readonly altitudeOffset: number;
  /**
   * Cumulative length of the fight curve, in cells, sampled every
   * ARC_TABLE_STEP_SECONDS of the curve parameter. What makes the wire speed
   * constant; see `placeOnCurve`. Empty for a fly-by.
   */
  readonly arcLength: Float64Array;
  /** A fly-by wingmate's slot in the V, centred on zero. Zero in a dogfight. */
  readonly formationSlot: number;
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
  /**
   * Id of the saucer the LAST burst was aimed at, kept through the rest — what
   * "is shooting at us" means to `nearestEnemy` between bursts, which is most
   * of a fight. Null until the first burst.
   */
  lastTarget: number | null;
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
  /** The speed it held then — the dive and the launch both start from it. */
  resolveFromSpeed: number;
  /**
   * How long this saucer's dive takes: DIVE_SECONDS, or less when the crash
   * cell is so close that its entry speed alone would get there sooner — a
   * dive never flies slower than the saucer came in. Set on entering `resolve`.
   */
  diveSeconds: number;
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
 * The endpoints are the wire's (LaserBolt): fixed at the shot, the aim point
 * being where the target was predicted to be at arrival — see `fireAt`.
 */
interface Bolt extends LaserBolt {
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
type Stage = 'approach' | 'dogfight' | 'resolve' | 'flyby';

/** The two things an encounter can be. See the file header. */
export type EncounterKind = 'dogfight' | 'flyby';

interface Encounter {
  readonly kind: EncounterKind;
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

/** A fly-by's roster: one faction in a drawn hull, MIN..MAX_SAUCERS_PER_FLYBY strong. */
function dealFlybyRoster(random: () => number): Roster {
  const variant = wholeBetween(random, 0, SAUCER_VARIANT_COUNT - 1);
  const size = wholeBetween(random, MIN_SAUCERS_PER_FLYBY, MAX_SAUCERS_PER_FLYBY);
  return { factionVariants: [variant], factionSizes: [size], total: size };
}

/** 0..count-1 in a seeded Fisher–Yates order. */
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

/**
 * The `rank`-th of `count` evenly spaced values across [min, max], with a lone
 * value at the middle — so one saucer flies the band's centre, not its edge.
 */
function rung(rank: number, count: number, min: number, max: number): number {
  if (count <= 1) return (min + max) / 2;
  return min + ((max - min) * rank) / (count - 1);
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
  kind: EncounterKind,
  site: ArenaSite,
  roster: Roster,
  rng: { readonly seed: number; readonly next: () => number },
): number {
  const { seed, next } = rng;

  // Factions spread evenly round the compass from one drawn bearing, so they
  // come in from as far apart as the count allows.
  const compassOffset = next() * Math.PI * 2;
  const factionSpacing = (Math.PI * 2) / roster.factionVariants.length;

  // The rungs and the tiers: two independent seeded orders over the roster,
  // so the innermost orbit is not also the lowest, and a faction is not a
  // stack.
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
        // A fly-by flies its faction's bearing exactly; the formation is the
        // slot, not a spread of bearings.
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
        // Everyone opens fire within one rest of the hold-fire floor lifting,
        // each at their own moment.
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

  // The poses are filled before anything can read them: an encounter that
  // existed for one broadcast with every saucer at (0, 0) would put the whole
  // roster in the corner of the map for a tenth of a second.
  placeSaucers();
  return seed;
}

/** What an encounter's start looks like to the caller. */
export interface EncounterStart {
  readonly kind: EncounterKind;
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
export function trySpawnEncounter(world: EncounterWorld, kind: EncounterKind): EncounterStart | null {
  if (encounter !== null) return null;
  const rng = createEncounterRng();
  const roster = kind === 'flyby' ? dealFlybyRoster(rng.next) : dealRoster(rng.next);
  // A fly-by never crashes, so its site needs no crash cells — and no unlocked
  // land beyond the arena clearance a dogfight's site also asks for.
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

/**
 * THE ADMIN PANEL'S DOGFIGHT: an encounter over the nearest legal ground to
 * where the operator is looking.
 *
 * Returns the start, or null with nothing changed.
 */
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

/** A point on a fight curve and the curve's velocity there. Scratch, reused. */
interface CurvePoint {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const curvePoint: CurvePoint = { x: 0, y: 0, vx: 0, vy: 0 };

/**
 * The rosette described in the file header, evaluated at curve parameter `u`
 * (in seconds of the curve's own nominal clock), relative to the arena centre.
 * Pure. The velocity is taken analytically so the heading is exact rather
 * than differenced — and so the arc-length table can be built from it.
 */
function curveAt(saucer: Saucer, u: number, out: CurvePoint): void {
  const meanRadius = ARENA_RADIUS_CELLS * saucer.orbitRadiusFraction;
  // The parameter's nominal angular rate: the linear speed over the mean
  // radius. What the saucer actually flies is decided by arc length, below.
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

/**
 * Fills `saucer.arcLength`: the curve's cumulative length at every
 * ARC_TABLE_STEP_SECONDS of parameter, by the trapezium rule on the analytic
 * speed. Built once, at `begin`, in fixed order — same seed, same table.
 */
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

/**
 * The curve parameter at which `distance` cells of the curve have been flown:
 * a binary search of the table and a linear interpolation between samples.
 * Past the table's end — unreachable, see ARC_TABLE_PARAMETER_HEADROOM — the
 * parameter is clamped to it, which stops the saucer rather than flinging it.
 */
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

/** A pose on a fight curve. Scratch, reused — see `curvePoint`. */
interface CurvePose {
  x: number;
  y: number;
  alt: number;
  heading: number;
}

const shooterPose: CurvePose = { x: 0, y: 0, alt: 0, heading: 0 };
const targetPose: CurvePose = { x: 0, y: 0, alt: 0, heading: 0 };

/**
 * Where a saucer's fight curve is at `t` seconds into the fight, and which way
 * it is going — flown by ARC LENGTH, so the speed on the wire is
 * DOGFIGHT_SPEED exactly wherever the curve is (the header's second revision).
 * PURE in `t`: the fight aims by evaluating a target's curve at the moment a
 * bolt will arrive, which is only possible because the path is a function of
 * the clock and not an integration (file header).
 */
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

/** Writes `poseOnCurve` into the saucer's own wire pose. */
function placeOnCurve(saucer: Saucer, site: ArenaSite, t: number): void {
  poseOnCurve(saucer, site, t, saucer);
  saucer.speed = DOGFIGHT_SPEED_CELLS_PER_SECOND;
}

const curveStartPose: CurvePose = { x: 0, y: 0, alt: 0, heading: 0 };

/**
 * The run-in at fraction `t` of APPROACH_SECONDS: inward along the saucer's
 * own bearing, from the entry distance to where its curve begins, so it is
 * exactly on its curve — where the dogfight begins — as the clock expires.
 * Already on its tier, so the stack is in place when the curves begin and
 * nobody has to climb through a neighbour. Pure in `t`, as `poseOnCurve`.
 */
function poseOnApproach(saucer: Saucer, site: ArenaSite, t: number, out: CurvePose): void {
  poseOnCurve(saucer, site, 0, curveStartPose);
  const curveStart = Math.hypot(curveStartPose.x - site.centreX, curveStartPose.y - site.centreY);
  const distance = ENTRY_DISTANCE_CELLS + (curveStart - ENTRY_DISTANCE_CELLS) * t;
  out.x = site.centreX + Math.cos(saucer.bearing) * distance;
  out.y = site.centreY + Math.sin(saucer.bearing) * distance;
  out.alt = site.altitude + saucer.altitudeOffset;
  // Flying INWARD along its own bearing — the reciprocal of it.
  out.heading = saucer.bearing + Math.PI;
}

/**
 * Where a saucer that is still fighting will be `seconds` after the encounter
 * began, across the run-in and the fight — the run-in until APPROACH_SECONDS,
 * its curve after. What a shot is aimed with: a bolt fired on the run-in at a
 * target about to start its curve is led onto the curve.
 */
function poseAtEncounterTime(saucer: Saucer, site: ArenaSite, seconds: number, out: CurvePose): void {
  if (seconds < APPROACH_SECONDS) poseOnApproach(saucer, site, seconds / APPROACH_SECONDS, out);
  else poseOnCurve(saucer, site, seconds - APPROACH_SECONDS, out);
}

/** Seconds since the encounter began, for a run-in or a fight — `poseAtEncounterTime`'s clock. */
function encounterSeconds(live: Encounter): number {
  return live.stage === 'approach' ? live.stageSeconds : APPROACH_SECONDS + live.stageSeconds;
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
      poseOnApproach(saucer, site, clamp01(live.stageSeconds / APPROACH_SECONDS), saucer);
      saucer.speed = APPROACH_SPEED_CELLS_PER_SECOND;
      continue;
    }

    if (saucer.phase === 'flyby') {
      // A straight line through the centre, inbound along the bearing from the
      // entry distance and out the far side to it. The V: each wingmate sits
      // its slot abeam of the leader's line and trails it by its distance
      // from the centre of the formation.
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

    // resolve — a loser dives at its crash cell, a winner climbs away along its
    // own bearing. Both start from the pose held when the phase began.
    const cell = saucer.crashCell;
    if (saucer.resolution === 'dive' && cell !== null) {
      const t = clamp01(saucer.resolveSeconds / saucer.diveSeconds);
      const dx = cell.x - saucer.resolveFromX;
      const dy = cell.y - saucer.resolveFromY;
      const dAlt = cell.groundY - saucer.resolveFromAlt;
      const length = Math.hypot(dx, dy, dAlt / CELL_WORLD_SIZE);
      // A wreck KEEPS THE SPEED IT WAS FLYING AT into the dive and accelerates
      // from there: the fraction of the path its entry speed would cover in
      // the dive's time is flown linearly, the rest as t². A pure t² fall
      // started from rest and hung in the air for the first third of a second
      // (owner, 2026-09-05); a straight lerp reads as a controlled descent,
      // which is the one thing this must not look like. `diveSeconds` is
      // shortened so that a path the entry speed covers sooner is flown at
      // that speed (entry = 1), never slower.
      const entry =
        length > 0 ? Math.min(1, (saucer.resolveFromSpeed * saucer.diveSeconds) / length) : 1;
      const fall = entry * t + (1 - entry) * t * t;
      saucer.x = saucer.resolveFromX + dx * fall;
      saucer.y = saucer.resolveFromY + dy * fall;
      saucer.alt = saucer.resolveFromAlt + dAlt * fall;
      saucer.heading = Math.atan2(dy, dx);
      // The path's own speed — d(fall)/dt times its length, the vertical leg
      // in cells — so the wire says how fast it is really falling.
      saucer.speed = ((entry + 2 * (1 - entry) * t) * length) / saucer.diveSeconds;
      continue;
    }
    // THE LAUNCH: speed grows from the speed it had with the SQUARE of the
    // time since — v(t) = v0 + (vmax − v0)·t² — so the distance run is its
    // integral, and the climb takes the same shape (RESOLVE_SECONDS, protocol).
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

/** Still fighting: in the sky, taking and dealing shots — on the run-in or on its curve. */
function isFighting(saucer: Saucer): boolean {
  return saucer.phase === 'dogfight' || saucer.phase === 'approach';
}

/**
 * The enemy this saucer should shoot at: the NEAREST one still fighting, ties
 * to the earlier index. Null when no enemy is left, which is the fight ending.
 *
 * PREFER AN ENEMY THAT IS NOT ALREADY SHOOTING AT US (owner, 2026-09-04: "if A
 * is shooting at B, prefer that B is shooting at a different saucer. Not
 * necessarily firing back at A"). Two saucers trading fire nose to nose read
 * as a duel inside the fight; a chain — A on B, B on C — reads as a melee. It
 * is a PREFERENCE and not a rule: when every enemy left is on us, the nearest
 * of them will do, which is also the whole answer when only one is left.
 */
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
    const bolt = fireAt(live, shooter, target);
    if (bolt === null) {
      // OUT OF RANGE (the run-in, mostly): hold the burst, try again next tick.
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

/**
 * The distance a bolt flies between two points, in cells: plan in cells,
 * altitude in world units brought to cells. The one length the travel time is
 * taken from.
 */
function shotLengthCells(from: CurvePose, to: CurvePose): number {
  return Math.hypot(to.x - from.x, to.y - from.y, (to.alt - from.alt) / CELL_WORLD_SIZE);
}

/**
 * How many times the aim is refined. The arrival time depends on where the
 * target will be, which depends on the arrival time: a fixed-point iteration,
 * started from the target's current position. Each pass shrinks the error by
 * the ratio of the hull's speed to the bolt's (DOGFIGHT_SPEED over
 * LASER_BOLT_SPEED: 0.4) in the worst case, a target flying straight away.
 * EIGHT passes take the longest shot in the fight (FIGHT_SPAN_CELLS, ~110)
 * from a whole-fight error to under 0.1 cell, which is below wire precision;
 * two — the first draft — left the aim nearly a hull off on a long receding
 * shot (harness, 2026-09-05).
 */
const AIM_PASSES = 8;

/**
 * One shot: rolls the hit, aims, and returns the bolt with its endpoints
 * fixed — the shooter's muzzle where it is NOW and, for a hit, the point the
 * target's curve reaches when the bolt does; for a miss, that point pushed
 * LASER_MISS_OFFSET to one side, so the bolt visibly passes the hull instead
 * of flying through it for no effect.
 *
 * Poses are read off the paths at the encounter clock rather than from the
 * wire fields, because the fight advances BEFORE the poses are recomputed
 * each tick (`advanceEncounter`) — the wire fields are a tick stale here —
 * and because predicting the target needs the path anyway. Both saucers are
 * fighting, so both are on their run-in or their curve.
 *
 * NULL WHEN THE SHOT WOULD BE LONGER THAN LASER_RANGE_CELLS — the aimed shot,
 * so a target flying away is out of range a little sooner than one closing.
 * Nothing is drawn from the generator for a shot not taken, so the range
 * check leaves the fight's sequence of rolls exactly as it would have been.
 *
 * THE DRAW ORDER IS FIXED — hit, then (for a miss only) side and offset — so
 * the same seed fires the same fight.
 */
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
    // Perpendicular, in plan, to the line of the shot.
    const dx = targetPose.x - shooterPose.x;
    const dy = targetPose.y - shooterPose.y;
    const length = Math.hypot(dx, dy);
    // Two saucers never share a plan position (distinct rungs and tiers), so
    // this is belt and suspenders against a NaN direction, not a case.
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
 * INTO THE SEA: no fire — nothing burns on water — and the crater only where
 * the seabed is shallow (CRASH_SEABED_CRATER_MAX_DEPTH_BANDS). Deep water
 * swallows the wreck and the world is unchanged; the splash is the client's.
 *
 * NEITHER CAN BE VETOED, and the crash cell was therefore vetted at siting
 * rather than here — see structures-bridge.ts for the source reading behind
 * that.
 */
function applyCrash(world: EncounterWorld, cell: CrashCell): void {
  if (cell.water) {
    if (cell.depthBands <= CRASH_SEABED_CRATER_MAX_DEPTH_BANDS) {
      world.sculpt(cell.x, cell.y, CRASH_CRATER_RADIUS_CELLS, CRASH_CRATER_AMOUNT);
    }
    return;
  }
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

  if (live.stage === 'flyby') {
    // Out the far side and gone, all together: nothing lands, nothing burns.
    if (live.stageSeconds >= FLYBY_SECONDS) {
      encounter = null;
      return { changed: true, crashed: [], ended: true };
    }
    placeSaucers();
    return { changed: true, crashed: [], ended: false };
  }

  if (live.stage === 'approach' && live.stageSeconds >= APPROACH_SECONDS) {
    // Onto the curves — those still flying in; one shot down on the run-in is
    // already diving.
    for (const saucer of live.saucers) if (saucer.phase === 'approach') saucer.phase = 'dogfight';
    enterStage(live, 'dogfight');
  }
  if (live.stage === 'approach' || live.stage === 'dogfight') {
    // THE FIGHT RUNS FROM THE FIRST TICK, run-in included (protocol.ts, on the
    // hold-fire floor that is no more); range is what keeps the first bursts
    // for the moment the factions close.
    advanceFight(dt);
    if (
      live.stage === 'dogfight' &&
      live.stageSeconds >= DOGFIGHT_SECONDS &&
      fightingFactions(live).length > 1
    ) {
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

/**
 * The impacts still on the wire, oldest first. A wreck still diving is not
 * here — it has not hit anything yet, and a client told where it WILL hit
 * could draw the fireball early.
 */
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

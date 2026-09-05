// THE ENCOUNTER: one dogfight, from the moment two saucers come over the horizon
// to the moment the crater stops smoking.
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
// the circle it flies, the cell it goes into), and the phase clock is the only
// state that advances. Evaluating position as a function of that clock rather
// than summing steps means:
//
//   * a saucer arrives EXACTLY at the arena rim when the approach clock expires,
//     and the wreck lands EXACTLY on the crash cell the sculpt is aimed at,
//     rather than near it plus accumulated float error;
//   * a retuned TICK_HZ changes nothing about where anything goes;
//   * there is no drift to correct and therefore no correction to get wrong.
//
// The one thing that IS integrated is the fight itself — hit points, the burst
// timers and the bolt ages — because those are events, not geometry.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY RANDOM CHOICE COMES FROM THE ENCOUNTER'S OWN SEEDED GENERATOR
// (./rng.ts), including who wins. Same seed, same fight, on any machine.

import {
  APPROACH_SECONDS,
  APPROACH_SPEED_CELLS_PER_SECOND,
  ARENA_RADIUS_CELLS,
  AFTERMATH_SECONDS,
  CRASH_CRATER_DEPTH_BANDS,
  CRASH_CRATER_RADIUS_CELLS,
  CRASH_FIRE_RING_OFFSETS,
  DIVE_SPEED_CELLS_PER_SECOND,
  DOGFIGHT_SECONDS,
  DOGFIGHT_SPEED_CELLS_PER_SECOND,
  ENTRY_DISTANCE_CELLS,
  EXIT_SPEED_CELLS_PER_SECOND,
  HEIGHT_WORLD_SCALE,
  LASER_BOLT_LIFETIME_SECONDS,
  LASER_BURST_INTERVAL_SECONDS,
  LASER_HIT_CHANCE,
  LASER_HIT_DAMAGE,
  RESOLVE_SECONDS,
  SAUCERS_PER_ENCOUNTER,
  SAUCER_MAX_HP,
  SAUCER_VARIANT_COUNT,
  type LaserBolt,
  type SaucerPhase,
  type SaucerState,
} from '../protocol.ts';
import { BAND_HEIGHT } from '@terrace/shared';
import { igniteCrashCell } from './fire-bridge.ts';
import { createEncounterRng } from './rng.ts';
import { findArenaSite, findArenaSiteNear, type ArenaSite, type SiteWorld } from './site.ts';

/**
 * The slice of the world an encounter needs beyond siting: the two writes a
 * crash makes. Structural, so `WorldApi` satisfies it directly.
 */
export interface EncounterWorld extends SiteWorld {
  sculpt(x: number, y: number, radius: number, amount: number): unknown;
}

/**
 * How far off the perfect circle each saucer weaves, as a fraction of the arena
 * radius, and how fast.
 *
 * A QUARTER, at 1.7 rad/s. Without the weave the two fly a fixed circle exactly
 * half a lap apart forever, which reads as a carousel rather than a fight; a
 * quarter of the radius is enough that the gap between them visibly opens and
 * closes, and the rate is deliberately not a whole multiple of the orbit rate,
 * so the pattern does not repeat inside DOGFIGHT_SECONDS.
 */
const WEAVE_RADIUS_FRACTION = 0.25;
const WEAVE_RADIANS_PER_SECOND = 1.7;

/**
 * How far a saucer rises and falls over the fight, in world units, and how fast.
 *
 * ONE AND A HALF units at 1.1 rad/s — a shallow porpoise. The purpose is that
 * the two do not sit in one flat plane; anything deeper starts to look like the
 * pair are losing control, which is the resolve phase's job to say.
 */
const WEAVE_ALTITUDE_WORLD_UNITS = 1.5;
const WEAVE_ALTITUDE_RADIANS_PER_SECOND = 1.1;

/**
 * How far the winner climbs on the way out, in world units.
 *
 * TWELVE — nearly the world's whole relief again, on top of an altitude that is
 * already six bands clear of the ground. Combined with EXIT_SPEED that takes it
 * off the top of the frame rather than off the side of it, which is what "takes
 * off" means and is also why nothing has to chase it to the map edge.
 */
const EXIT_CLIMB_WORLD_UNITS = 12;

/**
 * Where in its burst cycle each saucer starts, as a fraction of the interval.
 *
 * STAGGERED so the pair do not fire on the same tick for the whole fight: two
 * bolts that always appear together read as one effect, and — more to the point
 * — simultaneous mutual kills would be a real outcome the resolve phase has no
 * representation for (it names ONE loser). A quarter and three quarters puts
 * half an interval between them, permanently, because both timers then run at
 * exactly the same rate.
 */
const FIRE_STAGGER_FRACTIONS: readonly number[] = [0.25, 0.75];

/** The crater's depth as `sculpt` takes it: negative height units. */
const CRASH_CRATER_AMOUNT = -(CRASH_CRATER_DEPTH_BANDS * BAND_HEIGHT);

/** One saucer's live state. Mutable — this is the sim's own record. */
interface Saucer {
  readonly id: number;
  readonly variant: number;
  /**
   * The bearing this saucer owns for the whole encounter: it comes in along it,
   * orbits from it, and (if it wins) leaves along it. Radians from the arena
   * centre. The two saucers' bearings are exactly π apart, which is what makes
   * "opposite map edges" true by construction rather than by two draws that
   * might land near each other.
   */
  readonly bearing: number;
  hp: number;
  /** Seconds until this saucer's next burst. */
  fireIn: number;
  /** The pose it held when the resolve phase began — the dive/climb starts here. */
  resolveFromX: number;
  resolveFromY: number;
  resolveFromAlt: number;
  /** Filled every tick; what goes on the wire. */
  x: number;
  y: number;
  alt: number;
  heading: number;
  speed: number;
}

/** A bolt in flight, ageing. */
interface Bolt {
  readonly from: number;
  readonly to: number;
  age: number;
}

/** The encounter's own phase — the wire's three, plus the one nothing flies in. */
type EncounterPhase = SaucerPhase | 'aftermath';

interface Encounter {
  readonly seed: number;
  readonly random: () => number;
  readonly site: ArenaSite;
  /** World-space Y of the ground at the crash cell — where the dive ends. */
  readonly crashGroundY: number;
  phase: EncounterPhase;
  /** Seconds elapsed inside the current phase. */
  phaseSeconds: number;
  readonly saucers: Saucer[];
  bolts: Bolt[];
  /** Index into `saucers` of the one that will crash. Null until it is decided. */
  loser: number | null;
  /** Set once, when the crater is cut — so a re-entered aftermath cannot cut two. */
  crashApplied: boolean;
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

/**
 * Starts an encounter at `site`. Returns the new encounter's seed.
 *
 * PRIVATE TO THIS FILE'S TWO ENTRY POINTS (`trySpawnEncounter` and
 * `forceEncounterNear`), because a caller that could supply its own site could
 * supply one whose crash cell was never checked — and the whole argument in
 * site.ts is that an encounter with an unchecked crash cell must not exist.
 */
function begin(world: EncounterWorld, site: ArenaSite): number {
  const { seed, next } = createEncounterRng();

  // The run-in bearing. Drawn once; the second saucer takes the opposite one.
  const bearing = next() * Math.PI * 2;

  // Two DIFFERENT hulls, always: `variantB` steps a random offset off `variantA`
  // rather than drawing again, because a second uniform draw would put the two
  // saucers in the same body one time in three, and a duel between two identical
  // ships is a duel a player cannot follow.
  const variantA = Math.floor(next() * SAUCER_VARIANT_COUNT) % SAUCER_VARIANT_COUNT;
  const variantB =
    (variantA + 1 + Math.floor(next() * (SAUCER_VARIANT_COUNT - 1))) % SAUCER_VARIANT_COUNT;
  const variants = [variantA, variantB];

  const saucers: Saucer[] = [];
  for (let index = 0; index < SAUCERS_PER_ENCOUNTER; index++) {
    saucers.push({
      id: nextSaucerId++,
      variant: variants[index] ?? 0,
      bearing: bearing + index * Math.PI,
      hp: SAUCER_MAX_HP,
      fireIn: (FIRE_STAGGER_FRACTIONS[index] ?? 0) * LASER_BURST_INTERVAL_SECONDS,
      resolveFromX: 0,
      resolveFromY: 0,
      resolveFromAlt: 0,
      x: 0,
      y: 0,
      alt: site.altitude,
      heading: 0,
      speed: 0,
    });
  }

  encounter = {
    seed,
    random: next,
    site,
    crashGroundY: world.heightAt(site.crashX, site.crashY) * HEIGHT_WORLD_SCALE,
    phase: 'approach',
    phaseSeconds: 0,
    saucers,
    bolts: [],
    loser: null,
    crashApplied: false,
  };

  // The poses are filled before anything can read them: an encounter that
  // existed for one broadcast with both saucers at (0, 0) would put two hulls in
  // the corner of the map for a tenth of a second.
  placeSaucers();
  return seed;
}

/**
 * Rolls an encounter into existence somewhere on this world, or reports why not.
 *
 * Returns null when the world has nowhere legal to fly one (see
 * site.ts#findArenaSite) — an ordinary answer, not an error.
 */
export function trySpawnEncounter(world: EncounterWorld): number | null {
  if (encounter !== null) return null;
  // The SITE draw runs off the arrival stream's generator, not off an
  // encounter's — there is no encounter yet to have one. It is the last thing
  // this plugin does with an unseeded source; everything after `begin` is
  // seeded.
  const site = findArenaSite(world, Math.random);
  if (site === null) return null;
  return begin(world, site);
}

/**
 * THE ADMIN PANEL'S DOGFIGHT: an encounter over the nearest legal ground to
 * where the operator is looking.
 *
 * Returns the site and seed, or null with nothing changed.
 */
export function forceEncounterNear(
  world: EncounterWorld,
  near: { readonly x: number; readonly y: number },
): { readonly site: ArenaSite; readonly seed: number } | null {
  if (encounter !== null) return null;
  const site = findArenaSiteNear(world, near, Math.random);
  if (site === null) return null;
  return { site, seed: begin(world, site) };
}

/**
 * Recomputes both saucers' poses from the phase clock. See this file's header
 * for why the whole path is a function of time rather than an integration.
 */
function placeSaucers(): void {
  const live = encounter;
  if (live === null) return;
  const { site } = live;

  for (let index = 0; index < live.saucers.length; index++) {
    const saucer = live.saucers[index]!;
    if (live.phase === 'approach') {
      // Distance shrinks from the run-in start to the arena rim, so the saucer
      // is exactly on the rim — where the dogfight begins — as the clock
      // expires.
      const t = clamp01(live.phaseSeconds / APPROACH_SECONDS);
      const distance = ENTRY_DISTANCE_CELLS + (ARENA_RADIUS_CELLS - ENTRY_DISTANCE_CELLS) * t;
      saucer.x = site.centreX + Math.cos(saucer.bearing) * distance;
      saucer.y = site.centreY + Math.sin(saucer.bearing) * distance;
      saucer.alt = site.altitude;
      // Flying INWARD along its own bearing — the reciprocal of it.
      saucer.heading = saucer.bearing + Math.PI;
      saucer.speed = APPROACH_SPEED_CELLS_PER_SECOND;
      continue;
    }

    if (live.phase === 'dogfight') {
      // Angular rate DERIVED from the linear speed and the radius, so retuning
      // either keeps the other honest: a saucer that "flies at 20 units/s" flies
      // at 20 units/s whatever circle it is on.
      const omega = DOGFIGHT_SPEED_CELLS_PER_SECOND / ARENA_RADIUS_CELLS;
      const angle = saucer.bearing + omega * live.phaseSeconds;
      const weave =
        1 +
        WEAVE_RADIUS_FRACTION *
          Math.sin(WEAVE_RADIANS_PER_SECOND * live.phaseSeconds + saucer.bearing);
      const radius = ARENA_RADIUS_CELLS * weave;
      saucer.x = site.centreX + Math.cos(angle) * radius;
      saucer.y = site.centreY + Math.sin(angle) * radius;
      saucer.alt =
        site.altitude +
        WEAVE_ALTITUDE_WORLD_UNITS *
          Math.sin(WEAVE_ALTITUDE_RADIANS_PER_SECOND * live.phaseSeconds + saucer.bearing);
      // Tangent to the circle it is flying, in the direction it is flying it.
      saucer.heading = angle + Math.PI / 2;
      saucer.speed = DOGFIGHT_SPEED_CELLS_PER_SECOND;
      continue;
    }

    // resolve — the loser dives at the crash cell, the winner climbs away along
    // its own bearing. Both start from the pose they held when the phase began.
    const t = clamp01(live.phaseSeconds / RESOLVE_SECONDS);
    if (index === live.loser) {
      // t² rather than t: a wreck ACCELERATES into the ground. A straight lerp
      // reads as a controlled descent, which is the one thing this must not look
      // like.
      const fall = t * t;
      saucer.x = saucer.resolveFromX + (site.crashX - saucer.resolveFromX) * fall;
      saucer.y = saucer.resolveFromY + (site.crashY - saucer.resolveFromY) * fall;
      saucer.alt = saucer.resolveFromAlt + (live.crashGroundY - saucer.resolveFromAlt) * fall;
      saucer.heading = Math.atan2(site.crashY - saucer.resolveFromY, site.crashX - saucer.resolveFromX);
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

/**
 * Runs the fight for one tick: burst timers, hit rolls, hit points, bolt ages.
 *
 * FIXED ITERATION ORDER — saucer 0 then saucer 1, every tick, forever — so the
 * same seed resolves the same fight. A pass that iterated a map's insertion
 * order would be reproducible today and not the day something reorders the list.
 *
 * A SAUCER THAT HAS JUST BEEN SHOT DOWN STILL FIRES ITS OWN PENDING BURST on the
 * tick it dies, because the loop does not check hp before firing. That is
 * deliberate and it is the honest simulation of two ships firing at once; the
 * shot cannot change the outcome, since `loser` is latched by the FIRST saucer
 * to reach zero and re-checking hp afterwards cannot un-latch it.
 */
function advanceFight(dt: number): void {
  const live = encounter;
  if (live === null) return;

  for (const bolt of live.bolts) bolt.age += dt;
  // Pruned by rebuilding rather than by splicing in place: the list holds at
  // most MAX_LASER_BOLTS entries and is rebuilt at most ten times a second for
  // the twenty seconds an encounter lasts, so the allocation is nothing, and a
  // backwards splice loop is the kind of thing that is wrong once.
  if (live.bolts.length > 0) {
    live.bolts = live.bolts.filter((bolt) => bolt.age < LASER_BOLT_LIFETIME_SECONDS);
  }

  for (let index = 0; index < live.saucers.length; index++) {
    const shooter = live.saucers[index]!;
    shooter.fireIn -= dt;
    if (shooter.fireIn > 0) continue;
    shooter.fireIn += LASER_BURST_INTERVAL_SECONDS;

    // The other one. Written as a modulo over the list rather than as `1 -
    // index` so it stays correct if SAUCERS_PER_ENCOUNTER ever stops being two —
    // at which point it becomes "the next one round", which is at least a
    // defined thing rather than an index of -1.
    const target = live.saucers[(index + 1) % live.saucers.length]!;
    live.bolts.push({ from: shooter.id, to: target.id, age: 0 });

    if (live.random() >= LASER_HIT_CHANCE) continue;
    target.hp -= LASER_HIT_DAMAGE;
    if (target.hp > 0) continue;
    target.hp = 0;
    if (live.loser === null) live.loser = (index + 1) % live.saucers.length;
  }
}

/**
 * Names the loser when the dogfight clock runs out with both still flying.
 *
 * THE WOUNDED ONE GOES DOWN, and a dead heat is settled by the encounter's own
 * coin. It exists because a fight that simply stopped would leave the pair
 * orbiting forever, and because "whoever is ahead on the clock wins" is the
 * result a watching player would already have predicted from the damage they
 * have seen.
 *
 * IT IS THE UNCOMMON PATH, by construction: LASER_BURST_INTERVAL and
 * LASER_HIT_CHANCE are set so the mean damage over DOGFIGHT_SECONDS is well past
 * SAUCER_MAX_HP (see those constants). It is not dead code — it is the tail.
 */
function decideOnTime(): void {
  const live = encounter;
  if (live === null || live.loser !== null) return;
  const first = live.saucers[0]!;
  const second = live.saucers[1]!;
  if (first.hp !== second.hp) {
    live.loser = first.hp < second.hp ? 0 : 1;
    return;
  }
  live.loser = live.random() < 0.5 ? 0 : 1;
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
function applyCrash(world: EncounterWorld): { x: number; y: number } | null {
  const live = encounter;
  if (live === null || live.crashApplied) return null;
  live.crashApplied = true;

  const { crashX, crashY } = live.site;
  world.sculpt(crashX, crashY, CRASH_CRATER_RADIUS_CELLS, CRASH_CRATER_AMOUNT);

  // Fixed iteration order over a fixed table (../protocol.ts) — the same crash
  // lights the same cells on every machine. Most of these refuse; see
  // fire-bridge.ts.
  for (const [dx, dy] of CRASH_FIRE_RING_OFFSETS) {
    igniteRingCell(crashX + dx, crashY + dy, world.worldSize);
  }
  return { x: crashX, y: crashY };
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
  /** The roster or the phase changed, so clients need telling now. */
  readonly changed: boolean;
  /** The impact, on the tick it happened — for the world event. Null otherwise. */
  readonly crashed: { readonly x: number; readonly y: number } | null;
  /** The encounter finished on this tick, so one last empty payload is owed. */
  readonly ended: boolean;
}

const NO_CHANGE: EncounterTick = { changed: false, crashed: null, ended: false };

/**
 * Advances the running encounter by one tick.
 *
 * PHASE TRANSITIONS ARE CHECKED AFTER the clock advances and BEFORE the poses
 * are recomputed, so a saucer is never placed with a phase clock that has run
 * past its phase's length — the clamp in `placeSaucers` is belt and suspenders
 * for that, not the mechanism.
 */
export function advanceEncounter(world: EncounterWorld, dt: number): EncounterTick {
  const live = encounter;
  if (live === null) return NO_CHANGE;

  live.phaseSeconds += dt;
  let crashed: { x: number; y: number } | null = null;

  if (live.phase === 'approach') {
    if (live.phaseSeconds >= APPROACH_SECONDS) enterPhase('dogfight');
  } else if (live.phase === 'dogfight') {
    advanceFight(dt);
    if (live.loser === null && live.phaseSeconds >= DOGFIGHT_SECONDS) decideOnTime();
    if (live.loser !== null) {
      // The dive and the climb both start from where the pair actually are at
      // this instant, which is why the poses are captured on the transition
      // rather than recomputed from the dogfight's formula afterwards.
      for (const saucer of live.saucers) {
        saucer.resolveFromX = saucer.x;
        saucer.resolveFromY = saucer.y;
        saucer.resolveFromAlt = saucer.alt;
      }
      enterPhase('resolve');
    }
  } else if (live.phase === 'resolve') {
    if (live.phaseSeconds >= RESOLVE_SECONDS) {
      crashed = applyCrash(world);
      // The sky empties on the same tick the ground changes: the loser is IN the
      // crater and the winner is above the frame, so there is nothing left to
      // draw but the fireball, which the client plays off `crash`.
      live.saucers.length = 0;
      live.bolts = [];
      enterPhase('aftermath');
    }
  } else if (live.phaseSeconds >= AFTERMATH_SECONDS) {
    encounter = null;
    return { changed: true, crashed: null, ended: true };
  }

  placeSaucers();
  return { changed: true, crashed, ended: false };
}

function enterPhase(phase: EncounterPhase): void {
  if (encounter === null) return;
  encounter.phase = phase;
  encounter.phaseSeconds = 0;
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
    // `aftermath` never reaches the wire — the list is empty in it — so the cast
    // is a statement about that, not a widening of the type.
    phase: live.phase === 'aftermath' ? 'resolve' : live.phase,
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
 * The crash, while the aftermath lasts. Null at every other moment, including
 * during the dive — the wreck has not hit anything yet, and a client told where
 * it WILL hit could draw the fireball early.
 */
export function encounterCrash(): { readonly x: number; readonly y: number; readonly age: number } | null {
  const live = encounter;
  if (live === null || live.phase !== 'aftermath') return null;
  return { x: live.site.crashX, y: live.site.crashY, age: live.phaseSeconds };
}

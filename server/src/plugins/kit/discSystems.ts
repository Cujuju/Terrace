// DRIFTING DISCS: a population of coherent masses that gather, ride a supplied
// velocity, dissipate and are replaced — as a mechanism.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MODEL. One mass is a DISC: a centre, a radius of tens of cells and a
// strength. Not a per-cell field, not a noise texture, not a particle stream —
// one object with one position. Within a mass the whole body moves as one; its
// shape is fixed for its whole life and the only thing that changes is where its
// centre is.
//
// REJECTED: a scalar field sampled per cell (Perlin/simplex over the map). It
// would give softer, more organic edges, but there is then no such thing as "a
// system": nothing to spawn, decay, count, cap or send. The bandwidth would be a
// texture instead of ~90 B × a handful, and a client could not know where to put
// a bolt.
//
// WHAT THIS MODULE DOES NOT DECIDE, and why. It does not own a VELOCITY —
// callers hand one in per tick, so several instances can be driven by one shared
// source and move as a piece, which is a property no instance could give itself.
// It does not own a KIND — one instance is one kind, and which kind is the
// caller's whole identity. It does not read the ground: a caller that cares
// where its masses may sit supplies a `siting` predicate and does its own
// lookups behind it, which is what keeps this file free of any world at all.
//
// CLOCK: `dt` from the caller. No wall clock anywhere in this file.
//
// DETERMINISM. Fixed iteration order everywhere, and every draw comes from the
// caller's own `random` — so a caller that installs a seeded source gets a
// reproducible population out of this engine.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type DiscSystemState,
  cellsAcross,
  randomInRange,
  rollEvent,
  roundBroadcastIntensity,
  roundBroadcastPosition,
} from '@terrace/shared';

// ── How many, how big, how long ──────────────────────────────────────────────

/**
 * The fewest masses a derived cap may fall to, whatever the arithmetic says.
 *
 * ONE, not zero: on a world small enough that a single mass already covers more
 * than the target, the honest answer is "one, and it covers a lot", not "none".
 * Zero would be an instance that silently does nothing.
 */
export const DISC_MIN_ACTIVE_SYSTEMS = 1;

/**
 * Mean simulated seconds ONE EMPTY SLOT waits before it is filled — the arrival
 * hazard is this rate times the number of free slots, so a population that has
 * just emptied refills proportionally faster than one that is nearly full.
 *
 * PER SLOT, and that is the only formulation that holds at every world size with
 * ONE constant: with the cap derived from the world's size, a single world-wide
 * arrival rate would fill a small world's 1 slot as fast as a large world's 10,
 * so the large world would sit far below its cap forever and the coverage target
 * would be a number that was never reached.
 *
 * TWENTY SECONDS. It sets how closely the population tracks its cap, and that is
 * the whole of what it does: with a drift-shortened effective lifetime of
 * L ≈ 130 s (measured), the birth-death equilibrium is C × L/(L+T), so T = 20
 * holds the population at ~87% of the cap. 40 would hold it at 76% and leave the
 * coverage target visibly unmet; going much below 20 buys the last few percent
 * for a population that visibly pops rather than gathers.
 */
export const DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS = 20;

/**
 * How long a mass actually lasts on the shipped world, in simulated seconds —
 * MEASURED (2026-08-28 sweep), not DISC_MEAN_LIFETIME_SECONDS: drift off the
 * edge kills most of them long before old age does, so the effective figure is
 * about half the nominal one.
 *
 * It exists for one arithmetic fact: a birth-death population with per-slot
 * refill T and lifetime L sits at C × L/(L+T) of its cap C, not at C. Sizing the
 * cap for the target coverage without that factor delivered 0.146 for a target
 * of 0.18 (review 2026-08-28). The cap is therefore inflated by (L+T)/L so the
 * EQUILIBRIUM meets the target.
 */
export const DISC_EFFECTIVE_LIFETIME_SECONDS = 130;

/** Fraction of the cap a population holds at equilibrium — see above. */
export const DISC_EQUILIBRIUM_OCCUPANCY =
  DISC_EFFECTIVE_LIFETIME_SECONDS /
  (DISC_EFFECTIVE_LIFETIME_SECONDS + DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS);

/**
 * Mean simulated seconds a mass lives before it starts dissipating, again as a
 * constant hazard.
 *
 * FOUR MINUTES, sized against the crossing time rather than pulled from the air:
 * at a mean drift of 1.3 cells/s a mass covers ~310 cells in 240 s, i.e. rather
 * more than a 512-cell world. So the ordinary end of one is that it drifts off
 * the map, and this hazard is what makes the OTHER ending possible — a mass that
 * dies where it stands. Both endings look the same to a player (the fade below),
 * and having both is what stops every mass taking the identical one-way trip.
 */
export const DISC_MEAN_LIFETIME_SECONDS = 240;

/**
 * Seconds a mass takes to gather from nothing to full strength, and to
 * dissipate back to nothing.
 *
 * THIRTY. A mass gathers; it does not switch on. It is also what makes a client
 * need no fade of its own: a mass enters the broadcast at intensity ~0 and
 * leaves it at ~0, so appearing and disappearing in the list are both invisible
 * events. Sized well above the 1 s broadcast interval (30 broadcasts across the
 * ramp), so nothing about the fade can be aliased against message arrival.
 */
export const DISC_FADE_SECONDS = 30;

/**
 * The BASE radius band a mass is drawn from, in cells — stated in WORLD UNITS
 * and converted, because a mass's size is measured against the camera and the
 * world's width.
 *
 * The floor is 24 — with the camera orbiting at 80 world units
 * (client/src/config.ts, CAMERA_INITIAL_DISTANCE) a 48-unit-wide mass fills a
 * good part of the view, so anything smaller reads as a local effect. The
 * ceiling is 56, a 112-unit body: most of a 128-unit world's width and about a
 * fifth of a 512-unit one, which is as large as a mass can get and still have an
 * outside that a player can stand in and look at.
 *
 * BASE, because a population may ask for a larger footprint than this
 * (`DiscSystemsSpec.footprintAreaScale`); these two are the band at scale 1,
 * which is what every population that does not ask gets, unchanged.
 */
export const DISC_SYSTEM_MIN_RADIUS_CELLS = cellsAcross(24);
export const DISC_SYSTEM_MAX_RADIUS_CELLS = cellsAcross(56);

/**
 * The footprint scale a population gets when it does not ask for one: the base
 * band above, exactly.
 *
 * ONE AND NOT A NUMBER NEAR IT: every use below multiplies a radius by
 * `Math.sqrt(scale)`, and `Math.sqrt(1)` is exactly 1 and multiplying by 1 is
 * exact in IEEE — so a population at this default draws bit-for-bit the radii it
 * drew before the option existed. That is what makes fog and thunderstorm
 * untouched by rain and snow being enlarged.
 */
export const DISC_DEFAULT_FOOTPRINT_AREA_SCALE = 1;

/**
 * The RADIUS factor a footprint AREA scale works out to.
 *
 * AREA IS THE DECISION AND RADIUS IS THE CONSEQUENCE — "three times as much sky
 * under one storm" is what a caller means and what a player sees, and a disc's
 * area goes as r², so the radius factor is the square root. Callers state the
 * area and never the root: the wrong power here is silent (it would be a storm
 * nine times the area, or 1.7 times it, with nothing failing), which is the same
 * hazard `cellsOverArea` exists for in @terrace/shared.
 *
 * `Math.sqrt` is exactly specified by IEEE-754 and is therefore allowed in this
 * codebase's determinism rules (docs/DESIGN.md); a given scale yields the same
 * factor on every machine. Nothing here is broadcast raw anyway — the resulting
 * radius goes on the wire already rounded (`states`).
 */
export function discRadiusFactorFor(footprintAreaScale: number): number {
  return Math.sqrt(footprintAreaScale);
}

/**
 * Ceiling on a radius as a fraction of the world edge.
 *
 * WORLD_SIZE is a self-hoster's setting and a 128-unit world is explicitly
 * supported (docs/DESIGN.md), where a 56-unit radius would blanket the entire
 * map. 0.35 keeps the largest mass's diameter at 70% of the world edge, so there
 * is always somewhere else to stand. It is a FRACTION, so it needs no conversion
 * and binds identically at any sampling density; on the nominal world it never
 * binds for a population at the base scale (0.35 × 2048 cells = 717 ≫ the
 * 224-cell ceiling).
 *
 * IT OUTRANKS THE FOOTPRINT SCALE, and that is the point of applying it after
 * the scale rather than before: a population that asks for three times the area
 * gets it wherever the world has room, and on a 128-unit world (512 cells) it
 * gets whatever the 0.35 leaves — 179 cells, not 388 — so "there is always
 * somewhere else to stand" survives an enlargement it never anticipated. On such
 * a world an enlarged population's band is nearly a single size (166–179 cells),
 * which is a narrower band and not a broken one.
 */
export const DISC_MAX_RADIUS_WORLD_FRACTION = 0.35;

/**
 * The strength band a mass's PEAK intensity is drawn from.
 *
 * Never below 0.45, because one that arrives at a tenth strength is one nobody
 * notices arriving — the fade already provides every value below this on the way
 * in and on the way out. The variety a player actually reads is "that one is
 * heavier than the last one", which this band delivers.
 */
export const DISC_MIN_PEAK_INTENSITY = 0.45;
export const DISC_MAX_PEAK_INTENSITY = 1;

/**
 * How far outside the world a mass may be born, as a multiple of its own radius.
 *
 * ONE radius, so a newborn can be tangent to the map edge — entirely off-world
 * but with its rim about to arrive. A mass that could only ever be born inside
 * the world would always be seen forming overhead and never seen coming in off
 * the sea.
 */
export const DISC_SPAWN_MARGIN_RADII = 1;

/**
 * How far outside the world a centre may drift before the mass is removed
 * outright, as a multiple of its radius.
 *
 * STRICTLY LARGER than the spawn margin (1.5 vs 1), and that gap is not
 * cosmetic: one born at exactly the spawn margin with the velocity blowing
 * outward would otherwise be deleted on its first tick. At 1.5 radii the whole
 * disc is half a radius clear of the map, so nothing is ever removed while a
 * cell of the world is still under it.
 *
 * Removal here is INSTANT rather than a fade, unlike a natural death: there is
 * nothing to fade in front of, because no part of the world is under it any
 * more. Fading it would be thirty seconds of updates about something nobody can
 * see.
 */
export const DISC_DESPAWN_MARGIN_RADII = 1.5;

/**
 * How many centres a sited instance may try before giving up on one birth.
 *
 * FOUR. On a world where most of the map qualifies the first attempt almost
 * always lands; where one small region qualifies the odds per attempt are that
 * region's share of the map, and four attempts is where the expected cost stays
 * trivial. Trying until success would hang the tick on a world where NOTHING
 * qualifies — which is exactly what a fresh Terrace world is for the caller that
 * needs high ground (docs/DESIGN.md: "a fresh world has no land"), so that is
 * the common case and not the pathological one.
 */
export const DISC_SITING_ATTEMPTS = 4;

// ── State ────────────────────────────────────────────────────────────────────

/** One live mass. Mutable; the tick loop writes it in place. */
export interface DiscSystem {
  readonly id: number;
  /** Cell-space centre. May be outside the world; see the margins above. */
  x: number;
  y: number;
  /** Cell-space radius. Fixed for its whole life — it moves as a whole. */
  readonly radius: number;
  /** Strength at full gather, in [DISC_MIN_PEAK_INTENSITY, 1]. */
  readonly peakIntensity: number;
  /** Gather envelope in [0, 1]. Multiplied by peakIntensity to get intensity. */
  envelope: number;
  /** True once it has begun dissipating; it never gathers again. */
  retiring: boolean;
}

/** One live mass as an observer sees it: no envelope, one strength. */
export interface DiscCell {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
}

/** Cell-space velocity, as the caller supplies it each tick. */
export interface DiscVelocity {
  readonly vx: number;
  readonly vy: number;
}

/** How one population of masses is configured. */
export interface DiscSystemsSpec {
  /**
   * The fraction of the map expected to be under one of THIS instance's masses
   * once the population has reached equilibrium. The cap is derived from it, so
   * this is the number an instance is tuned on and the population is a
   * consequence — stated as a fraction, it means the same thing on a 128-unit
   * world and on a 4096-cell one.
   *
   * AT THE BASE DISC SIZE. A population that also sets `footprintAreaScale`
   * covers this fraction times that scale, because the scale is what makes each
   * mass bigger while this number goes on deciding how many there are.
   */
  readonly coverageFraction: number;
  /**
   * How much bigger ONE of this population's masses is than the base band
   * (DISC_SYSTEM_MIN/MAX_RADIUS_CELLS), stated as a multiple of its AREA.
   * Absent or 1 is the base band, bit-for-bit.
   *
   * AN AREA AND NOT A RADIUS, because "how much sky is under one storm" is the
   * thing a caller decides and a player sees; the kit takes the square root
   * (`discRadiusFactorFor`) so no caller ever writes √3 and no caller can get
   * the power wrong.
   *
   * IT CHANGES HOW BIG, NEVER HOW MANY. `capFor` deliberately derives the
   * population from the BASE geometry, so raising this leaves the number of
   * masses in the sky exactly where it was and multiplies the share of the map
   * they cover instead — see `discActiveCapFor`, which states why that is the
   * honest derivation and not a fudge.
   */
  readonly footprintAreaScale?: number;
  /**
   * Hard ceiling on the derived cap. Every cost an instance imposes — payload
   * size, draw calls, lights — is budgeted against this rather than against the
   * coverage arithmetic, which on a large enough world asks for more than any of
   * those budgets can pay.
   */
  readonly maxActiveSystems: number;
  /** The caller's own random source, so a seeded suite drives this engine. */
  random(): number;
  /**
   * Whether a candidate centre is somewhere a mass of this kind may be born.
   * Absent means anywhere. Called with cell-space coordinates that may sit
   * outside the world (see DISC_SPAWN_MARGIN_RADII), so an implementation that
   * looks anything up must bound its own reads.
   */
  siting?(x: number, y: number, radius: number): boolean;
  /**
   * Called once when a birth is abandoned because no candidate centre was
   * accepted within DISC_SITING_ATTEMPTS. The hook exists so a caller can hand
   * the lost birth somewhere else; doing nothing is a legitimate answer and
   * simply means that roll produced nothing.
   */
  onUnsited?(): void;
}

/** One population of drifting masses. */
export interface DiscSystems {
  /** How many attempts a birth of this instance gets — DISC_SITING_ATTEMPTS. */
  readonly sitingAttempts: number;
  /** Drops every mass and rewinds the id counter. */
  reset(): void;
  /** How many masses this world gets, before the ceiling clamps it. */
  capFor(worldSize: number): number;
  /** The living masses, in birth order. */
  systems(): readonly DiscSystem[];
  /**
   * The living masses in their OBSERVABLE form — the envelope already folded
   * into one `intensity` — for a consumer that is being shown the sky rather
   * than simulating it.
   */
  cells(): readonly DiscCell[];
  /**
   * ONE TICK. Fixed order: each mass ages (its envelope moves toward 1, or
   * toward 0 once retiring), rolls for a natural death and drifts by exactly
   * `velocity × dt`; then the dead are removed — the fully dissipated and the
   * ones that have drifted clear off the map; then an arrival is rolled if there
   * is a free slot. Iterating backwards is what lets the removal splice inside
   * the same pass.
   */
  advance(worldSize: number, dt: number, velocity: DiscVelocity): void;
  /**
   * Puts ONE mass in the world at a drawn centre and returns it, or null when a
   * siting predicate refused every attempt. Ignores the cap — the caller that
   * has a cap to respect checks it (see `advance`, and the hand-off in
   * `onUnsited`).
   *
   * ORDER OF DRAWS IS FIXED — radius, centre (possibly re-drawn), peak intensity
   * — so a seeded generator produces the same mass every time. It is born at
   * envelope 0: it has to gather like everything else, so nothing ever pops into
   * existence at full strength.
   */
  spawnOne(worldSize: number): DiscSystem | null;
  /**
   * Puts one mass at a NAMED place, siting predicate and all ignored — the admin
   * panel's debug spawn. An ordinary mass in every respect but how it was drawn:
   * it gathers from envelope 0, drifts, ages and dies like the rest.
   */
  spawnAt(worldSize: number, x: number, y: number): DiscSystem;
  /**
   * THE DEV OVERRIDE. While forced, `advance` parks ONE mass over the middle of
   * the world and holds it there: it still gathers over DISC_FADE_SECONDS, but
   * it neither drifts, ages nor dies, and no second one ever arrives. Setting it
   * either way clears the population, so the parked mass is the only one.
   */
  force(forced: boolean): void;
  isForced(): boolean;
  /**
   * The strongest mass covering this cell, in [0, 1], or 0 when none does.
   *
   * STRONGEST rather than summed, because two overlapping masses do not make a
   * cell twice as covered as one can make it, and a sum would exceed 1 and break
   * every caller that treats this as a fraction. A HARD-EDGED DISC, matching how
   * a client draws the footprint and how every other query here treats a radius
   * — a soft falloff would reach further than a player can see.
   */
  intensityAt(x: number, y: number): number;
  /**
   * The masses as they go on the wire, rounded to the broadcast precision, all
   * carrying the velocity supplied for this broadcast.
   */
  states(velocity: DiscVelocity): DiscSystemState[];
}

/** The smallest radius a mass of a population at this footprint scale may have. */
export function discMinRadiusFor(
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  return DISC_SYSTEM_MIN_RADIUS_CELLS * discRadiusFactorFor(footprintAreaScale);
}

/**
 * The largest radius a mass may have on a world of this size, in cells.
 *
 * THE WORLD'S CEILING IS APPLIED LAST, after the footprint scale, so it outranks
 * it — see DISC_MAX_RADIUS_WORLD_FRACTION.
 */
export function discMaxRadiusFor(
  worldSize: number,
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  const fromWorld = worldSize * DISC_MAX_RADIUS_WORLD_FRACTION;
  // The floor keeps the band non-empty on a world so small that even the
  // minimum radius is more than a third of it; there, every mass is the minimum
  // size and the fraction has simply run out of room to bind.
  return Math.max(
    discMinRadiusFor(footprintAreaScale),
    Math.min(DISC_SYSTEM_MAX_RADIUS_CELLS * discRadiusFactorFor(footprintAreaScale), fromWorld),
  );
}

/** The middle of the radius band this world allows, in cells. */
export function discMeanRadiusFor(
  worldSize: number,
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  return (
    (discMinRadiusFor(footprintAreaScale) + discMaxRadiusFor(worldSize, footprintAreaScale)) / 2
  );
}

/**
 * Mean footprint of one BASE-SIZE mass on this world, in cells², i.e. π·E[r²]
 * over the radius band the world allows at footprint scale 1.
 *
 * BASE SIZE AND NOT THE CALLER'S, because its one consumer is the population
 * derivation below, which is deliberately blind to `footprintAreaScale` — read
 * `discActiveCapFor` for why.
 *
 * E[r²] AND NOT E[r]², because coverage is an area and the radius is a random
 * variable: using the mean radius would understate the mean area by the band's
 * variance, which on the shipped world is a 5% error in the direction that makes
 * masses rarer. For r uniform on [a, b], E[r²] = (a² + ab + b²)/3.
 *
 * (The spawn-field edge in `capFor` still uses E[r]; the true coverage is
 * E[πr²/(W+2rm)²] and this factorisation is off by ~1–2% on the shipped world —
 * stated, not corrected, review 2026-08-28.)
 */
export function discMeanFootprintCells(worldSize: number): number {
  const a = DISC_SYSTEM_MIN_RADIUS_CELLS;
  const b = discMaxRadiusFor(worldSize);
  return (Math.PI * (a * a + a * b + b * b)) / 3;
}

/**
 * HOW MANY MASSES A WORLD GETS for a given coverage share, clamped to
 * [DISC_MIN_ACTIVE_SYSTEMS, `ceiling`].
 *
 * Centres are drawn uniformly over the world square GROWN BY THE SPAWN MARGIN,
 * so the density of centres is the population divided by that larger area, not
 * by the world's — a mass whose centre sits in the margin covers only part of
 * the world, and dividing by the world square would count it as if it covered
 * all of it.
 *
 * The result is a first-order estimate (coverage = density × footprint) rather
 * than the exact 1 − e^(−density·footprint): they differ by under a tenth of the
 * target at these densities, and the target is an aesthetic number that was
 * measured, not derived, so spending precision here would be false rigour.
 *
 * IT IS COMPUTED AT THE BASE DISC SIZE, WHATEVER `footprintAreaScale` SAYS — the
 * one deliberate asymmetry in this file, and the reason it is deliberate is that
 * the two knobs answer different questions. `coverageFraction` is the number a
 * population's HOW MANY was tuned on; `footprintAreaScale` is a later decision
 * about HOW BIG each one is. Feeding the scale in here would silently convert an
 * enlargement into a thinning: the same coverage over three-times-the-area discs
 * is a third of the storms, which is the opposite of what asking for bigger
 * storms means (owner, 2026-09-04). So the enlargement lands where it was aimed
 * — the realised coverage becomes `coverageFraction × footprintAreaScale`, which
 * the spec field says out loud — and the population is untouched.
 *
 * REJECTED: deriving the cap from `coverageFraction × footprintAreaScale` over
 * the SCALED footprint, which looks like the same thing and is not. The scaled
 * band is clamped by DISC_MAX_RADIUS_WORLD_FRACTION and the scaled mean radius
 * also widens the spawn field, so the two scalings do not cancel: on a 128-unit
 * world at scale 3 it asks for 2 rain systems where the base derivation asks for
 * 1. That is a population that changed because a size changed — exactly the
 * coupling this asymmetry exists to break.
 */
export function discActiveCapFor(
  worldSize: number,
  coverageFraction: number,
  ceiling: number,
): number {
  const spawnFieldEdge =
    worldSize + 2 * discMeanRadiusFor(worldSize) * DISC_SPAWN_MARGIN_RADII;
  const perSystemCoverage = discMeanFootprintCells(worldSize) / (spawnFieldEdge * spawnFieldEdge);
  const wanted = Math.round(coverageFraction / perSystemCoverage / DISC_EQUILIBRIUM_OCCUPANCY);
  return Math.max(DISC_MIN_ACTIVE_SYSTEMS, Math.min(ceiling, wanted));
}

/** True once a centre has drifted far enough out to be removed. */
export function discHasLeftWorld(system: DiscSystem, worldSize: number): boolean {
  const margin = system.radius * DISC_DESPAWN_MARGIN_RADII;
  return (
    system.x < -margin ||
    system.y < -margin ||
    system.x > worldSize + margin ||
    system.y > worldSize + margin
  );
}

export function createDiscSystems(spec: DiscSystemsSpec): DiscSystems {
  const systems: DiscSystem[] = [];
  let nextId = 1;
  let forced = false;

  /**
   * This population's footprint scale, resolved once. Every radius drawn below
   * goes through it; the population size deliberately does not (see
   * `discActiveCapFor`).
   */
  const footprintAreaScale = spec.footprintAreaScale ?? DISC_DEFAULT_FOOTPRINT_AREA_SCALE;

  /** A centre drawn uniformly over the world square expanded by the spawn margin. */
  function randomCentre(worldSize: number, radius: number): { x: number; y: number } {
    const margin = radius * DISC_SPAWN_MARGIN_RADII;
    return {
      x: randomInRange(spec.random, -margin, worldSize + margin),
      y: randomInRange(spec.random, -margin, worldSize + margin),
    };
  }

  function birth(x: number, y: number, radius: number, peakIntensity: number): DiscSystem {
    const system: DiscSystem = {
      id: nextId++,
      x,
      y,
      radius,
      peakIntensity,
      envelope: 0,
      retiring: false,
    };
    systems.push(system);
    return system;
  }

  /**
   * One tick under the dev override: the mass neither drifts, ages nor dies, and
   * no second one ever arrives. It still GATHERS over DISC_FADE_SECONDS rather
   * than snapping to full — a screenshot of something that arrived by teleport
   * is not a screenshot of this sim.
   */
  function advanceForced(worldSize: number, dt: number): void {
    const centre = worldSize / 2;
    if (systems.length === 0) {
      // The middle of the band this world allows, so the photograph shows an
      // ordinary mass rather than the largest or smallest one.
      birth(
        centre,
        centre,
        discMeanRadiusFor(worldSize, footprintAreaScale),
        DISC_MAX_PEAK_INTENSITY,
      );
    }
    const system = systems[0]!;
    system.x = centre;
    system.y = centre;
    system.envelope = Math.min(1, system.envelope + dt / DISC_FADE_SECONDS);
  }

  function capFor(worldSize: number): number {
    return discActiveCapFor(worldSize, spec.coverageFraction, spec.maxActiveSystems);
  }

  function spawnOne(worldSize: number): DiscSystem | null {
    const radius = randomInRange(
      spec.random,
      discMinRadiusFor(footprintAreaScale),
      discMaxRadiusFor(worldSize, footprintAreaScale),
    );

    let centre = randomCentre(worldSize, radius);
    if (spec.siting !== undefined) {
      // Rejection sampling on the predicate: try a few centres, and if none of
      // them is acceptable the birth is abandoned and the caller is told.
      let sited = spec.siting(centre.x, centre.y, radius);
      for (let attempt = 1; !sited && attempt < DISC_SITING_ATTEMPTS; attempt++) {
        centre = randomCentre(worldSize, radius);
        sited = spec.siting(centre.x, centre.y, radius);
      }
      if (!sited) {
        spec.onUnsited?.();
        return null;
      }
    }

    return birth(
      centre.x,
      centre.y,
      radius,
      randomInRange(spec.random, DISC_MIN_PEAK_INTENSITY, DISC_MAX_PEAK_INTENSITY),
    );
  }

  return {
    sitingAttempts: DISC_SITING_ATTEMPTS,

    reset(): void {
      systems.length = 0;
      nextId = 1;
    },

    capFor,

    systems(): readonly DiscSystem[] {
      return systems;
    },

    cells(): readonly DiscCell[] {
      return systems.map((system) => ({
        x: system.x,
        y: system.y,
        radius: system.radius,
        intensity: system.peakIntensity * system.envelope,
      }));
    },

    spawnOne,

    spawnAt(worldSize: number, x: number, y: number): DiscSystem {
      // The middle of the band this world allows, as a debug spawn chooses: an
      // ordinary mass rather than the largest or smallest one.
      return birth(
        x,
        y,
        discMeanRadiusFor(worldSize, footprintAreaScale),
        DISC_MAX_PEAK_INTENSITY,
      );
    },

    force(next: boolean): void {
      forced = next;
      systems.length = 0;
    },

    isForced(): boolean {
      return forced;
    },

    advance(worldSize: number, dt: number, velocity: DiscVelocity): void {
      if (forced) {
        advanceForced(worldSize, dt);
        return;
      }

      const envelopeStep = dt / DISC_FADE_SECONDS;
      const deathRate = 1 / DISC_MEAN_LIFETIME_SECONDS;

      for (let index = systems.length - 1; index >= 0; index--) {
        const system = systems[index]!;

        if (!system.retiring && rollEvent(spec.random, deathRate, dt)) system.retiring = true;

        // Linear, not exponential, so the fade ARRIVES: "the envelope reached
        // zero" is the condition a mass is removed on, and an exponential
        // approach never gets there.
        system.envelope = system.retiring
          ? Math.max(0, system.envelope - envelopeStep)
          : Math.min(1, system.envelope + envelopeStep);

        system.x += velocity.vx * dt;
        system.y += velocity.vy * dt;

        const dissipated = system.retiring && system.envelope <= 0;
        if (dissipated || discHasLeftWorld(system, worldSize)) {
          systems.splice(index, 1);
        }
      }

      // ARRIVALS. One hazard per FREE SLOT, summed — see
      // DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS. Summing the rates rather than
      // rolling per slot keeps this one call into rollEvent (and therefore one
      // draw from the seeded stream per tick, whatever the cap is), which is
      // what makes a seeded run reproducible across a change of world size.
      const freeSlots = capFor(worldSize) - systems.length;
      if (freeSlots <= 0) return;
      if (!rollEvent(spec.random, freeSlots / DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS, dt)) {
        return;
      }
      spawnOne(worldSize);
    },

    intensityAt(x: number, y: number): number {
      let strongest = 0;
      for (const system of systems) {
        const dx = x - system.x;
        const dy = y - system.y;
        if (dx * dx + dy * dy > system.radius * system.radius) continue;
        const intensity = system.peakIntensity * system.envelope;
        if (intensity > strongest) strongest = intensity;
      }
      return Math.min(1, strongest);
    },

    states(velocity: DiscVelocity): DiscSystemState[] {
      const vx = roundBroadcastPosition(velocity.vx);
      const vy = roundBroadcastPosition(velocity.vy);
      return systems.map((system) => ({
        id: system.id,
        x: roundBroadcastPosition(system.x),
        y: roundBroadcastPosition(system.y),
        radius: roundBroadcastPosition(system.radius),
        intensity: roundBroadcastIntensity(system.peakIntensity * system.envelope),
        vx,
        vy,
      }));
    },
  };
}

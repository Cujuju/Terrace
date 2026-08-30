// THE VENTS THEMSELVES — the sim. Cone growth, the dormancy cycle, and the
// eruption that joins them.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CYCLE (owner, 2026-08-27, choosing between three cadences on issue #214).
//
// A vent is a two-state machine and nothing more:
//
//   dormant ──(an exponential wait elapses)──▶ erupting
//   erupting ──(ERUPTION_SECONDS elapse)────▶ dormant
//
// The wait is drawn from an exponential distribution whose MEAN is set by
// WorldApi.difficulty — the same "core publishes one neutral dial, each plugin
// picks its own anchors" contract mana established and every plugin since has
// followed. Exponential rather than fixed because a volcano whose next eruption
// can be counted down to is a timer, not a volcano: memorylessness is precisely
// the property that makes "it has been quiet a long while" carry no
// information, which is what makes living next to one a decision.
//
// A PRESSURE MODEL — accumulate per tick, erupt at a threshold, bigger pressure
// means a bigger flow — was considered and DEFERRED by the owner as a possible
// future enhancement rather than rejected. It would give cone growth a natural
// size curve, and it is a strictly larger state machine to persist and tune.
// The seam for it is `beginEruption` below: everything an eruption's size would
// scale is decided there, in one place, from the vent.
//
// ─────────────────────────────────────────────────────────────────────────────
// AN ERUPTION IS NOT RESUMED ACROSS A RESTART.
//
// ./persistence.ts saves a vent's position, its cone and its phase, and a vent
// that was mid-eruption when the snapshot was written comes back DORMANT with a
// fresh wait. This is boats' `fighting: false` rule and it is here for the same
// reason: the live half of an eruption is a front, a visited set and a
// fractional cell of travel, and restoring a front into terrain that a rollback
// may have changed underneath it would resume a flow down a hill that is no
// longer there. What survives is everything permanent — the cone, the ground,
// the crust — which is all a player can see anyway once the glow has gone.

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

// ── The numbers ─────────────────────────────────────────────────────────────

/**
 * How long one eruption lasts, in simulated seconds.
 *
 * 60 s, and the flow's length cap is what it is measured against: at
 * FLOW_SPEED_CELLS_PER_SECOND (2 cells/s) a front covers MAX_FLOW_CELLS in 32
 * seconds, so the eruption OUTLASTS its own flow by roughly the same again.
 * That ordering is deliberate — the front stops, and the vent goes on throwing
 * ash and glowing for another half minute, which is what gives a player time to
 * arrive and see one rather than only its aftermath. Reversing it (a duration
 * shorter than the flow needs) would mean no eruption ever reached its cap and
 * MAX_FLOW_CELLS would silently stop being the thing that bounds an eruption.
 */
export const ERUPTION_SECONDS = 60;

/**
 * Mean dormancy between one vent's eruptions, in simulated seconds, at the two
 * ends of WorldApi.difficulty.
 *
 * PER VENT, so a world's total rate is this divided by its vent count — at the
 * shipped four vents and difficulty 50 that is one eruption somewhere in the
 * world roughly every nine minutes, and at the MAX_VENTS_PER_WORLD ceiling with
 * difficulty 100 it is one every two and a half. Those are the two numbers the
 * anchors were picked to make reasonable; a reader retuning either end should
 * check what it does to the world rate at the vent cap, which is the case that
 * bites.
 *
 * The ends are the only fixed points and a consumer interpolates between them —
 * WorldApi.difficulty's own instruction, so that ninety-eight settings are not
 * left undefined.
 */
export const DORMANT_MEAN_SECONDS_AT_MIN_DIFFICULTY = 3600;
export const DORMANT_MEAN_SECONDS_AT_MAX_DIFFICULTY = 600;

/**
 * Mean interval between SPONTANEOUS vent births anywhere in the world, at the
 * two ends of difficulty (birth route 2 — see ./siting.ts's header).
 *
 * A WHOLE DAY of simulated time at the forgiving end, two hours at the
 * punishing one. It is meant to be rare enough that a player never attributes a
 * new mountain to it having been a Tuesday: over a long-lived world it is the
 * slow drift that makes the map's geology different from the one it was
 * generated with, not a mechanic anybody plays around.
 *
 * WORLD-LEVEL, not per vent, and gated on the vent count being below
 * MAX_VENTS_PER_WORLD — so a full world stops rolling entirely rather than
 * rolling and discarding, and a world that loses a vent (which nothing does
 * today) would resume.
 */
export const SPONTANEOUS_BIRTH_MEAN_SECONDS_AT_MIN_DIFFICULTY = 86_400;
export const SPONTANEOUS_BIRTH_MEAN_SECONDS_AT_MAX_DIFFICULTY = 7_200;

/**
 * Where the cone's ring brushes sit, relative to the mouth.
 *
 * Equal to MAX_BRUSH_RADIUS, which is relics' TERRAFORM_RING_OFFSET and its
 * argument: the centre brush at radius R touches cells out to R−1, so a ring
 * centred at R leaves neither an untouched annulus nor wasteful overlap.
 * Derived from the shared constant so the shape stays correct if the brush cap
 * is ever retuned.
 */
export const CONE_RING_OFFSET = MAX_BRUSH_RADIUS;

/** The four cardinal ring positions, in fixed order (reproducibility, tests). */
const CONE_RING_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-CONE_RING_OFFSET, 0],
  [CONE_RING_OFFSET, 0],
  [0, -CONE_RING_OFFSET],
  [0, CONE_RING_OFFSET],
];

/**
 * Cone sculpts taken off the pending queue each tick — see `raiseCone`.
 *
 * ONE, WORLD-WIDE, and the "world-wide" half is the point. A per-vent queue
 * would still put one sculpt per erupting vent into the same tick, so the cost
 * of a synchronised eruption would go on scaling with the vent count: at the
 * MAX_VENTS_PER_WORLD ceiling that is eight full-radius smooth sculpts landing
 * together, which is most of a tick budget again. One queue for the whole world
 * makes the per-tick cost of cone building a CONSTANT — one sculpt, whatever
 * the world is doing — which is the only version of this fix that cannot be
 * defeated by adding vents.
 *
 * The cost of that constant is latency: a four-vent simultaneous eruption
 * finishes its rings sixteen ticks (1.6 s) after it starts them. A cone is
 * geology growing by one band; nobody can see 1.6 s of it.
 */
export const CONE_SCULPTS_PER_TICK = 1;

/**
 * Whether a cone's ring goes into the world with its centre, or into the
 * pending queue.
 *
 * THE QUESTION IS "AM I ON THE TICK LOOP", NOT "HOW BIG IS THE CONE", and the
 * two answers are not interchangeable:
 *
 *   'immediate' — genesis siting, which runs inside `onWorldCreate`, before the
 *                 world has a tick or a player. There is no budget to overrun
 *                 there, and deferring measurably makes things WORSE: a genesis
 *                 cone is GENESIS_CONE_BANDS tall, so its ring steps are the
 *                 expensive kind (4–190 ms apiece on a 2048² world, measured),
 *                 and queueing eight vents' worth of them just moves 300 ms of
 *                 unbudgeted work onto the first thirty seconds of ticks.
 *   'deferred'  — every route that runs inside a tick: an eruption's cone
 *                 growth, a spontaneous birth, a dug vent.
 */
export type ConeRingTiming = 'immediate' | 'deferred';

/**
 * Terrace bands each eruption is meant to ADD TO THE CONE'S PEAK.
 *
 * ONE. It is the smallest unit the terrain can express, and the point is that a
 * cone grows on a GEOLOGICAL scale relative to the eruptions: after ten
 * eruptions the mountain is visibly taller than it was, and after one it is
 * not. A larger figure would make the cone the eruption's main effect, which
 * puts the drama in the wrong place — the lava is the event.
 */
export const CONE_PEAK_BANDS_PER_ERUPTION = 1;

/**
 * How many bands of BRUSH AMOUNT it takes to leave one band standing at the
 * apex of a cone whose flanks are already at the gradient limit.
 *
 * TWO, AND IT IS A PROPERTY OF THE RELAXATION, NOT A DIAL (issue #108,
 * 2026-08-29). A cone's flanks sit at the steepest slope the sim holds, so
 * every unit the brush puts on the apex is immediately over the limit against
 * its four neighbours and the relaxation moves half of it out — and since
 * 2026-08-29 relaxation CONSERVES: what leaves the apex is really gone, where
 * the old rule handed the low cell a unit the high cell never lost and the apex
 * kept the whole band it was given. Measured old vs new on a genesis cone
 * (.sim-108/plugins.mjs, `=== VOLCANOES: cone peak gain per eruption ===`), ten
 * eruptions on a GENESIS_CONE_BANDS cone:
 *
 *   rule  bands asked   mean peak gain per eruption
 *   old   1             16.0   ← one band, the intent
 *   new   1              9.0   ← 56% of it: the rest slid down the flanks
 *   new   2             15.1   ← the intent restored
 *   new   3             20.4
 *
 * (On flat ground, where the cone has slack to grow into, the same rows read
 * 16.0 / 12.1 / 17.7 / 22.9.) Two is therefore the smallest whole number of
 * bands that still leaves a band, and asking for three overshoots.
 */
export const CONE_BRUSH_BANDS_PER_PEAK_BAND = 2;

/**
 * What `raiseCone` is actually handed per eruption — the amount that DELIVERS
 * CONE_PEAK_BANDS_PER_ERUPTION at the peak.
 *
 * The heightmap clamps at MAX_HEIGHT, so an immortal world's cone stops
 * growing rather than overflowing; nothing here has to check for it.
 */
export const CONE_GROWTH_BANDS_PER_ERUPTION =
  CONE_PEAK_BANDS_PER_ERUPTION * CONE_BRUSH_BANDS_PER_PEAK_BAND;

/**
 * A vent's cone RING is raised half as much as its centre, so the mouth is a
 * peak rather than a plateau — relics' Quake rim ratio, inverted and applied to
 * a mountain. Integer division is exact at today's BAND_HEIGHT of 16; the floor
 * guards a future odd value, where a half-band rounded down is the right
 * answer (a slightly sharper cone) and a fractional `amount` is a RangeError
 * out of applyBrush.
 */
function ringAmount(bands: number): number {
  return Math.floor((bands * BAND_HEIGHT) / 2);
}

/** Interpolates between a plugin's own two difficulty anchors. */
export function byDifficulty(difficulty: number, atMin: number, atMax: number): number {
  const clamped = Math.min(100, Math.max(1, difficulty));
  return atMin + ((atMax - atMin) * (clamped - 1)) / 99;
}

// ── State ───────────────────────────────────────────────────────────────────

/** One vent, server-side. The wire shape is protocol.ts's VentState. */
export interface Vent {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  erupting: boolean;
  /** Simulated seconds left in the CURRENT phase — a dormancy or an eruption. */
  phaseSeconds: number;
  /**
   * BRUSH bands this cone has been given, in total — the sum of the `bands`
   * arguments `raiseCone` was called with, not the height the mountain gained.
   * Persisted; diagnostic, and nothing reads it back but the snapshot.
   *
   * THE DISTINCTION IS NOT PEDANTRY (issue #108, 2026-08-29). Relaxation moves
   * roughly half of what the brush puts on a cone's apex down its flanks, so
   * the two quantities differ by about a factor of two — measured, a genesis
   * cone asked for 4 bands keeps 2.75 of them on real terrain and an eruption
   * asking for CONE_GROWTH_BANDS_PER_ERUPTION = 2 leaves about 1
   * (.sim-108/plugins.mjs). `openVent` seeds this field from the bands it
   * ASKED for, so `beginEruption` adds the bands it asks for too; a counter
   * that mixed the two units would be meaningless in both.
   */
  coneBands: number;
}

/** One cell of flow, server-side. */
interface LavaCell {
  readonly x: number;
  readonly y: number;
  ageSeconds: number;
}

/**
 * The live half of an eruption — everything ./persistence.ts deliberately does
 * NOT save (see this file's header).
 */
interface Front {
  x: number;
  y: number;
  /** Fractional cells of travel carried between ticks. */
  advance: number;
  /** Cells this eruption has already laid down, against MAX_FLOW_CELLS. */
  laid: number;
  /** THIS eruption's cells, so a front can never re-enter its own path. */
  visited: Set<number>;
  /**
   * The world's fresh water AS IT STOOD WHEN THIS ERUPTION BEGAN — see
   * `beginEruption` for why it is snapshotted rather than read live.
   */
  readonly freshwater: FreshwaterMap;
}

let vents: Vent[] = [];
let nextVentId = 1;
let rng: VolcanoRng = createVolcanoRng(VOLCANO_RNG_DEFAULT_SEED);
/**
 * Whether this world has had its genesis siting. A separate flag rather than
 * "are there any vents", because a world sited under `none` correctly has zero
 * and must not be re-sited every boot once the operator turns it up.
 */
let seeded = false;

/**
 * Every tracked flow cell, keyed by cell. A Map because ITERATION ORDER IS
 * INSERTION ORDER, which is what makes the MAX_TRACKED_FLOW_CELLS eviction
 * below a one-line "drop the oldest" with no second structure to keep in step.
 */
const lava = new Map<number, LavaCell>();

/** Live fronts by vent id. Never persisted; see the header. */
const fronts = new Map<number, Front>();

/** One ring step of a cone that has not been applied to the world yet. */
interface PendingConeSculpt {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly amount: number;
}

/**
 * Cone ring steps still owed to the world, oldest first — see `raiseCone`.
 *
 * PERSISTED, unlike a front. A front is live state that a restart is entitled
 * to throw away (this file's header says why), but a queued ring step is a
 * terrain edit whose CENTRE has already been written and persisted by core: a
 * restart that dropped the queue would leave that cone lopsided forever, and
 * nothing would ever notice. Persisting four small records per erupting vent is
 * the cheap end of that trade.
 */
let pendingConeSculpts: PendingConeSculpt[] = [];

/** Test seam, and the world-close reset: drops everything. */
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

/** Every vent's site, for ./siting.ts's separation rule. */
export function ventSites(): Site[] {
  return vents.map((vent) => ({ x: vent.x, y: vent.y }));
}

export function ventCount(): number {
  return vents.length;
}

/** True while any vent is throwing lava — read by the eruption event fan-out. */
export function anyErupting(): boolean {
  return vents.some((vent) => vent.erupting);
}

// ── Cone ────────────────────────────────────────────────────────────────────

/**
 * Raises a cone at (x, y) by `bands`, as a centre brush plus a cardinal ring.
 *
 * COMPOSED FROM MAX_BRUSH_RADIUS BRUSHES, because that is the only way to
 * exceed the brush cap: WorldApi.sculpt does not clamp, it goes straight to
 * shared's applyBrush, which THROWS a RangeError on a radius outside
 * [MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS] and on a non-integer amount. A plugin
 * that passes radius 40 to make a big mountain does not get a big mountain; it
 * gets a stack trace swallowed by the host's `safely` wrapper and a mechanic
 * that silently never works. (relics/server/terraform.ts's header found this
 * the same way, and its shape is what this follows.)
 *
 * A ring step whose centre falls off the map is SKIPPED, not slid inward:
 * applyBrush throws on an out-of-bounds centre, and sliding it back would
 * silently make a cone near the border lopsided in a way that reads as a bug
 * rather than as an edge.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CENTRE IS SCULPTED NOW; THE RING IS QUEUED WHEN `ringTiming` DEFERS IT.
 *
 * All five went in on one tick, and a full-radius smooth sculpt is not cheap:
 * measured at ~0.6 ms each on a 2048² world, so one cone was ~3 ms of a 7.14 ms
 * tick and four vents erupting on the same tick was ~20 ms — three budgets, in
 * the one tick a player is most likely to be looking at the world.
 *
 * So on every route that runs inside a tick the centre — the sculpt that makes
 * the mountain visibly move at the moment the eruption is announced — is
 * applied here, and the four ring steps are queued and drained at
 * CONE_SCULPTS_PER_TICK by `drainPendingConeSculpts`. Genesis siting is the one
 * caller that still lays all five at once, because it is not on the tick loop
 * at all; ConeRingTiming has the measurement that decided it.
 * Order is FIFO over a fixed offset list, so the terrain a run produces is
 * still a pure function of its inputs.
 *
 * WHAT SPREADING IT CHANGES, since relaxation is not commutative with itself:
 * the ring steps now relax against ground that the eruption's first flow cells
 * may already have raised, so the finished cone is not bit-identical to the one
 * the single-tick version built. It is the same cone to the eye and it is
 * deterministic; it is simply a different fixed point. The eruption's other
 * timing is UNCHANGED — the front still starts on the eruption tick, beside the
 * centre sculpt, because the front descends from the mouth and the mouth is the
 * part that is already built.
 *
 * The queue is bounded by construction: `raiseCone` is called at most once per
 * vent per eruption or birth, it adds at most CONE_RING_OFFSETS.length steps,
 * and the drain runs every tick — so the standing queue cannot exceed
 * MAX_VENTS_PER_WORLD ring-fulls even if every vent in the world erupts at once.
 */
function raiseCone(
  world: WorldApi,
  x: number,
  y: number,
  bands: number,
  ringTiming: ConeRingTiming,
): void {
  const size = world.worldSize;
  world.sculpt(x, y, MAX_BRUSH_RADIUS, bands * BAND_HEIGHT);

  const rim = ringAmount(bands);
  for (const [dx, dy] of CONE_RING_OFFSETS) {
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
    if (ringTiming === 'immediate') {
      world.sculpt(cx, cy, MAX_BRUSH_RADIUS, rim);
      continue;
    }
    pendingConeSculpts.push({ x: cx, y: cy, radius: MAX_BRUSH_RADIUS, amount: rim });
  }
}

/**
 * Applies up to CONE_SCULPTS_PER_TICK of the queued ring steps.
 *
 * CALLED ON EVERY TICK, INCLUDING UNDER `none`. The queue is a debt: the centre
 * of that cone is already in the terrain, so a world that stops draining is a
 * world left with a permanently lopsided mountain — the exact defect
 * `raiseCone`'s out-of-bounds note refuses to introduce. An operator turning
 * the setting down makes the plugin inert about FUTURE volcanoes; it does not
 * abandon an edit that is half-applied.
 */
export function drainPendingConeSculpts(world: WorldApi): void {
  for (let applied = 0; applied < CONE_SCULPTS_PER_TICK; applied++) {
    const step = pendingConeSculpts.shift();
    if (step === undefined) return;
    world.sculpt(step.x, step.y, step.radius, step.amount);
  }
}

// ── Birth ───────────────────────────────────────────────────────────────────

/**
 * Adds a vent at (x, y) and builds it a cone. Returns it, or null when the
 * world is already at MAX_VENTS_PER_WORLD or something is too close.
 *
 * THE ONE WAY A VENT IS EVER CREATED — genesis, spontaneous and dug all arrive
 * here, so the cap, the separation rule, the cone and the id allocation exist
 * in exactly one place and a new route cannot forget one of them. (fire's
 * `igniteAt` is the same shape for the same reason.)
 */
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
    // A newborn vent starts its first dormancy on THIS world's difficulty,
    // like every later one (endEruption draws the same wait) — a vent that was
    // dug open is not a different kind of vent from one that was always there.
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

/**
 * Sites this world's genesis vents, once. Returns the vents created.
 *
 * IDEMPOTENT ACROSS A REOPEN AND A ROLLBACK, which the plugin contract requires
 * of everything reachable from onWorldCreate: `seeded` is persisted, so a
 * restored world skips this entirely rather than growing a second set of
 * mountains on every boot.
 */
export function seedGenesisVents(world: WorldApi): readonly Vent[] {
  if (seeded) return [];
  seeded = true;

  const wanted = genesisVentCount(world.worldSize);
  const created: Vent[] = [];
  for (let i = 0; i < wanted; i++) {
    const site = chooseVentSite(world, rng, ventSites());
    // Null means the search found nowhere — a world with no dry land at all.
    // Stopping rather than retrying: the next attempt reads the same terrain
    // and would fail the same way, having consumed VENT_SITE_ATTEMPTS again.
    if (site === null) break;
    // 'immediate': genesis is off the tick loop entirely — see ConeRingTiming.
    const vent = openVent(world, site.x, site.y, GENESIS_CONE_BANDS, 'immediate');
    if (vent !== null) created.push(vent);
  }
  return created;
}

/**
 * Rolls the world's spontaneous-birth chance for this tick and, if it fires,
 * opens a vent. Returns it, or null.
 *
 * Called only under `active` — see ./index.ts, and ./siting.ts's header for why
 * this route and not the dug one is the one dormancy suppresses.
 */
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
  // 'deferred': this runs inside a tick, and a genesis-sized cone is five
  // full-radius sculpts — far more than one tick's budget.
  return openVent(world, site.x, site.y, GENESIS_CONE_BANDS, 'deferred');
}

// ── The tick ────────────────────────────────────────────────────────────────

/** What one tick of the sim did, for ./index.ts to broadcast and announce. */
export interface VolcanoTick {
  /** Cells that went molten this tick. */
  readonly molten: LavaCellState[];
  /** Cells the tracker evicted this tick; clients forget them. */
  readonly forgotten: Array<{ x: number; y: number }>;
  /** Vents that started erupting this tick. */
  readonly erupted: Vent[];
  /** Vents that stopped. */
  readonly quieted: Vent[];
  /** True if any vent's `erupting` flag changed, i.e. the wire list moved. */
  readonly ventsChanged: boolean;
}

/** This world's mean dormancy — the one place the two anchors are read. */
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

  // THE CONE GROWS AT THE START OF AN ERUPTION, not at the end, and not spread
  // across it. At the start because that is the moment the player is told
  // something is happening, so the mountain and the announcement are one event;
  // in one step rather than per tick because CONE_GROWTH_BANDS_PER_ERUPTION is
  // a couple of bands and a couple of bands split across six hundred ticks is
  // six hundred sculpts, each running a full gradient relaxation, to produce
  // the same terrain one sculpt produces.
  raiseCone(world, vent.x, vent.y, CONE_GROWTH_BANDS_PER_ERUPTION, 'deferred');
  // BRUSH bands, matching what `openVent` puts there — see `Vent.coneBands`.
  // The PEAK gains CONE_PEAK_BANDS_PER_ERUPTION of that; this field counts
  // what was spent, not what stuck.
  vent.coneBands += CONE_GROWTH_BANDS_PER_ERUPTION;

  fronts.set(vent.id, {
    x: vent.x,
    y: vent.y,
    advance: 0,
    laid: 0,
    // The mouth itself counts as visited, so a front cannot immediately flow
    // back into the cell it came out of.
    visited: new Set<number>([lavaKey(vent.x, vent.y)]),
    // THE WATER IS SNAPSHOTTED ONCE, HERE, and the whole eruption is routed
    // against this one map.
    //
    // WHY: `WorldApi.freshwater` is a getter over World.freshwaterMap() →
    // riverNetwork(), a FULL-WORLD recompute, and every sculpt marks that
    // network stale. A front sculpts each cell it enters and then asks the
    // water question for the next one, so reading the getter per step re-ran
    // the recompute at its wall-clock throttle cap for the entire eruption —
    // measured at 40 ms on a starter unlock and 95 ms on a revealed world,
    // against a 7.14 ms tick budget. Reading it once costs one recompute per
    // eruption.
    //
    // WHAT IT CHANGES, and why it is the right semantics anyway: a front no
    // longer notices a river that APPEARS mid-eruption. That is the correct
    // way round for this fiction — lava dams rivers, rivers do not
    // retroactively stop a front that is already past them — and the river
    // that mattered, the one the front is running towards, was in the map when
    // the eruption started. A front is at most ERUPTION_SECONDS long, so the
    // snapshot is never more than a minute old.
    freshwater: world.freshwater,
  });
}

function endEruption(vent: Vent, world: WorldApi): void {
  vent.erupting = false;
  vent.phaseSeconds = exponentialWaitSeconds(rng, dormantMeanSeconds(world));
  fronts.delete(vent.id);
}

/**
 * Records a cell as molten and raises it. Returns the wire state, or null if
 * the cell was already tracked (an older flow crossing the same ground).
 *
 * RE-MELTING AN OLD CELL RESETS ITS AGE rather than being ignored, because the
 * ground really is molten again; what it does NOT do is raise it twice or
 * report it as new, since the client already has the cell and only needs to be
 * told the age — which the next keepalive carries.
 */
function meltCell(world: WorldApi, x: number, y: number): LavaCellState | null {
  world.sculpt(x, y, FLOW_BRUSH_RADIUS, FLOW_THICKNESS);

  const key = lavaKey(x, y);
  const existing = lava.get(key);
  if (existing !== undefined) {
    existing.ageSeconds = 0;
    return null;
  }
  lava.set(key, { x, y, ageSeconds: 0 });
  return { x, y, ageSeconds: 0 };
}

/** Drops the oldest tracked cells down to the cap. See MAX_TRACKED_FLOW_CELLS. */
function evictOldFlow(forgotten: Array<{ x: number; y: number }>): void {
  while (lava.size > MAX_TRACKED_FLOW_CELLS) {
    // Map iteration is insertion order, so the first entry is the oldest cell
    // this world has tracked — no separate queue, and nothing to keep in step.
    const oldest = lava.keys().next();
    if (oldest.done === true) return;
    const cell = lava.get(oldest.value);
    lava.delete(oldest.value);
    if (cell !== undefined) forgotten.push({ x: cell.x, y: cell.y });
  }
}

/**
 * Advances one erupting vent's front. Returns the cells it melted, and stops
 * the front (deleting it) on any of ./flow.ts's stop conditions.
 *
 * A STOPPED FRONT DOES NOT END THE ERUPTION — see ERUPTION_SECONDS. The vent
 * goes on glowing and throwing ash with nothing left to lay down, which is what
 * a real one does once its flow has reached the sea.
 */
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

/** The one place a front is retired. `reason` is kept for callers' logging. */
function stopFront(vent: Vent, _reason: FlowStop): void {
  fronts.delete(vent.id);
}

/**
 * One tick of the whole mechanic. `erupting` is whether this world's setting
 * permits eruptions at all (`active`); a `dormant` world still ages its crust
 * and still holds its vents, it simply never starts one.
 */
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
      // A dormant world's vents keep their clock RUNNING but never fire: the
      // wait is re-drawn so that turning `active` on later does not detonate
      // every vent in the world on the same tick, which is what a pile of
      // expired timers would do.
      vent.phaseSeconds = exponentialWaitSeconds(rng, dormantMeanSeconds(world));
      continue;
    }

    beginEruption(vent, world);
    erupted.push(vent);
  }

  // Cooling runs for every tracked cell on every tick, in a `dormant` world as
  // much as an `active` one: crust left over from before the operator turned
  // the setting down must still be allowed to go out.
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

// ── Persistence hooks (./persistence.ts owns the validation) ────────────────

export interface VolcanoSnapshot {
  readonly seeded: boolean;
  readonly nextVentId: number;
  readonly rngState: number;
  readonly vents: readonly Vent[];
  readonly lava: ReadonlyArray<{ x: number; y: number; ageSeconds: number }>;
  /** Cone ring steps not yet applied — see `pendingConeSculpts`. */
  readonly pendingConeSculpts: readonly PendingConeSculpt[];
}

export function volcanoSnapshot(): VolcanoSnapshot {
  return {
    seeded,
    nextVentId,
    rngState: rng.state(),
    // Saved DORMANT whatever they are doing now — see this file's header.
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

/** REPLACES all state — the plugin contract's re-runnable rule. */
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

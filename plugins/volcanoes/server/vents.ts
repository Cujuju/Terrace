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
 * Terrace bands each eruption adds to the cone.
 *
 * ONE. It is the smallest unit the terrain can express, and the point is that a
 * cone grows on a GEOLOGICAL scale relative to the eruptions: after ten
 * eruptions the mountain is visibly taller than it was, and after one it is
 * not. A larger figure would make the cone the eruption's main effect, which
 * puts the drama in the wrong place — the lava is the event.
 *
 * The heightmap clamps at MAX_HEIGHT, so an immortal world's cone stops
 * growing rather than overflowing; nothing here has to check for it.
 */
export const CONE_GROWTH_BANDS_PER_ERUPTION = 1;

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
  /** Bands this cone has been raised, in total. Persisted; diagnostic. */
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

/** Test seam, and the world-close reset: drops everything. */
export function resetVolcanoes(): void {
  vents = [];
  nextVentId = 1;
  rng = createVolcanoRng(VOLCANO_RNG_DEFAULT_SEED);
  seeded = false;
  lava.clear();
  fronts.clear();
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
 */
function raiseCone(world: WorldApi, x: number, y: number, bands: number): void {
  const size = world.worldSize;
  world.sculpt(x, y, MAX_BRUSH_RADIUS, bands * BAND_HEIGHT);

  const rim = ringAmount(bands);
  for (const [dx, dy] of CONE_RING_OFFSETS) {
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
    world.sculpt(cx, cy, MAX_BRUSH_RADIUS, rim);
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
export function openVent(world: WorldApi, x: number, y: number, coneBands: number): Vent | null {
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
    raiseCone(world, x, y, coneBands);
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
    const vent = openVent(world, site.x, site.y, GENESIS_CONE_BANDS);
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
  return openVent(world, site.x, site.y, GENESIS_CONE_BANDS);
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
  // a single band and a band split across six hundred ticks is six hundred
  // sculpts, each running a full gradient relaxation, to produce the same
  // terrain one sculpt produces.
  raiseCone(world, vent.x, vent.y, CONE_GROWTH_BANDS_PER_ERUPTION);
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
}

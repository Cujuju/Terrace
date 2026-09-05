// saucers — the wire contract between the plugin's two halves, and every
// measurement both halves have a stake in.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free — the plugin-local equivalent of
// @terrace/shared, exactly as tornado/protocol.ts and monsters/protocol.ts are.
//
// Namespacing: the hosts prefix `saucers:` on the wire in both directions, so
// every type here is the UN-namespaced form (see server/src/plugins/host.ts and
// client/src/plugins/host.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FICTION (owner, 2026-09-04).
//
// "Flying saucers fly into the map, dog fight, and the winner takes off while
// the loser crashes and explodes, leaving behind a crater and fire. The saucers
// should fly at high speed, like they're zooming in, battling, and then zooming
// out."
//
// AN ENCOUNTER IS THE UNIT, not a saucer. Two saucers arrive together, fight
// each other and nothing else, and the whole thing is over inside half a minute
// leaving one crater behind. There is at most one encounter in the world at a
// time (MAX_LIVING_ENCOUNTERS) — the drama is that it is an EVENT, the same
// argument monsters' per-kind singleton makes.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT TRAVELS. The two saucers' poses, the laser bolts in flight, and — for the
// second after impact — where the wreck went in. Nothing else: the hull, the
// spinning ring, the flashing lights, the bolt geometry and the fireball are all
// invented on the client out of these numbers plus the frame clock, and nothing
// in the world can observe any of them.
//
// THE BROADCAST IS FOG-OF-WAR FILTERED (WorldApi.broadcastVisible), on the same
// reasoning tornado states: a saucer only ever fights over unlocked land — the
// arena centre is chosen there — so "there are saucers here" IS a statement
// about the ground there, and so, far more strongly, is "a crater just appeared
// at (x, y)".
//
// ONE MESSAGE TYPE CARRYING FULL STATE. A dropped message costs one broadcast
// interval of staleness and there is no delta stream to desynchronise. An EMPTY
// payload is meaningful and is sent just as faithfully as a populated one: it is
// how a client learns the encounter is over (see SAUCERS_STATE_MESSAGE).

// The one import this file allows itself: every measurement below is a fact
// about the WORLD, and @terrace/shared owns the world's own scale.
import {
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  WORLD_UNITS_PER_BAND,
  cellsAcross,
  isFiniteNumber,
} from '@terrace/shared';

/** Plugin name on both sides. Also the message namespace. */
export const SAUCERS_PLUGIN_NAME = 'saucers';

/**
 * Un-namespaced type of the server → client push (`saucers:state`).
 *
 * AN EMPTY PAYLOAD — no saucers, no bolts, no crash — is the "nothing is
 * happening" signal, and the server sends exactly one of them when an encounter
 * ends. It is why this is broadcast with `skipEmpty: false`: a player whose
 * visible subset is empty must still be told, or the saucers they last saw would
 * hang in their sky forever.
 */
export const SAUCERS_STATE_MESSAGE = 'state';

/**
 * Un-namespaced type of the CRASH WORLD EVENT (`saucers:crashed`) — a
 * server-side fan-out to sibling plugins (WorldApi.emitEvent), never a client
 * message.
 *
 * NOBODY CONSUMES IT TODAY. It exists because a crater and a fire appearing out
 * of the sky is exactly the kind of fact the chronicle plugin was built to
 * notice, and emitting it costs one fan-out per encounter — which is at most one
 * every few minutes. The seam is cheaper to leave than to retrofit.
 */
export const SAUCERS_CRASHED_EVENT = 'crashed';

// ─────────────────────────────────────────────────────────────────────────────
// HEIGHT UNITS AND WORLD UNITS.

/**
 * Height units → world units (Y), DERIVED and never written by hand.
 *
 * WHY IT IS RESTATED HERE rather than imported from client/src/config.ts, which
 * has the identical definition: a plugin's SERVER half cannot import that file
 * (it drags `import.meta.env` into a node run — the reason MAX_RELIEF_WORLD_UNITS
 * moved into @terrace/shared in the first place), and this plugin's server half
 * is precisely what needs the conversion. The server decides an altitude against
 * TERRAIN, which it reads in height units, and puts it on the wire in the world
 * units the client's scene is measured in — one conversion, on the authoritative
 * side, so the two halves cannot disagree about how high a saucer is.
 */
export const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF AN ENCOUNTER, in the units both halves measure in.

/**
 * HARD SINGLETON. At most this many encounters exist in the world at once.
 *
 * ONE, and the invariant is STRUCTURAL rather than counted — server/encounter.ts
 * holds one nullable slot, so a second encounter is unrepresentable. Two
 * dogfights at once would not be twice the event; it would be ambient traffic,
 * which is the opposite of what the owner asked for.
 */
export const MAX_LIVING_ENCOUNTERS = 1;

/**
 * Saucers in an encounter. TWO: a dogfight is a duel, and the whole resolution
 * ("the winner takes off while the loser crashes") is written against exactly
 * one winner and exactly one loser.
 */
export const SAUCERS_PER_ENCOUNTER = 2;

/**
 * The saucer bodies that exist — an index into the client's model table, not a
 * name, because the difference is purely which mesh gets instanced and the
 * server has no opinion about any of it.
 *
 * THREE, matching the three authored GLBs. Ordered; index 0 is what an
 * unrecognised value on the wire resolves to (see parseSaucersPayload), so
 * reordering changes what a version-skewed client draws and nothing else.
 */
export const SAUCER_VARIANT_COUNT = 3;

/** What a saucer is when the wire says something this build does not recognise. */
export const DEFAULT_SAUCER_VARIANT = 0;

/**
 * The phases of an encounter, in the order they run. Ordered and exhaustive: the
 * client switches on this to decide what to draw, and a phase it does not know
 * is dropped with the entry rather than guessed at.
 *
 *   approach   — both saucers come in off opposite map edges at full speed;
 *   dogfight   — both weave the arena centre, firing in bursts;
 *   resolve    — the loser dives at the crash cell, the winner climbs and leaves;
 *   aftermath  — the sky is empty, the crater is in the ground and the client
 *                plays the fireball. No saucer is ever in this phase: it is the
 *                ENCOUNTER's phase, and it is carried on the payload's `crash`.
 */
export const SAUCER_PHASES = ['approach', 'dogfight', 'resolve'] as const;
export type SaucerPhase = (typeof SAUCER_PHASES)[number];

export function isSaucerPhase(value: unknown): value is SaucerPhase {
  return (SAUCER_PHASES as readonly string[]).includes(value as string);
}

/**
 * How long each phase lasts, in seconds. NAMED DURATIONS rather than derived
 * from a speed and a distance, because the pacing is the feature: the owner
 * asked for "zooming in, battling, zooming out", which is a rhythm, and a
 * rhythm written as a division by a distance changes the moment somebody
 * retunes the arena.
 *
 * APPROACH — 2.5 s. At APPROACH_SPEED that is 85 world units of run-in, most of
 * it off the map, so a player sees the pair cross the horizon and arrive rather
 * than blink into existence over their village.
 *
 * DOGFIGHT — 18 s. Long enough for LASER_BURST_INTERVAL to fire twenty bursts
 * (the outcome has to be earned, not decided in two shots) and short enough that
 * the whole encounter is under half a minute.
 *
 * RESOLVE — 3 s: the dive and the climb-out. Shorter than the approach on
 * purpose — a loser that took as long to fall as the pair took to arrive would
 * read as a landing.
 *
 * AFTERMATH — 1.5 s. Nothing flies in it; it is exactly as long as the client's
 * fireball, and its only job is to keep `crash` on the wire long enough for a
 * client that joined a beat late to see the burst. The fire and the crater
 * outlive it by minutes because they belong to other systems.
 */
export const APPROACH_SECONDS = 2.5;
export const DOGFIGHT_SECONDS = 18;
export const RESOLVE_SECONDS = 3;
export const AFTERMATH_SECONDS = 1.5;

/**
 * Speeds, in WORLD UNITS per second, written through `cellsAcross` because they
 * are lengths of GROUND and not counts of samples (the 2026-08-21 re-sample is
 * on record for what happens to distances written as raw cell counts).
 *
 * THE SCALE THEY ARE SET AGAINST: a tornado, the fastest thing in this world
 * before now, walks at 2.5 world units/s. A saucer is an order of magnitude
 * quicker, which is the entire brief — "flying at high speed, like they're
 * zooming in".
 *
 * APPROACH 34 — a default 128-unit world crossed in under four seconds.
 * DOGFIGHT 20 — slower, because a duel that kept approach speed would be two
 *   dots leaving the arena; at 20 over ARENA_RADIUS the pair lap each other
 *   about every two and a half seconds, which reads as a fight.
 * DIVE 26 and EXIT 40 — the loser accelerates into the ground and the winner
 *   outruns everything else in the encounter on the way out.
 */
export const APPROACH_SPEED_CELLS_PER_SECOND = cellsAcross(34);
export const DOGFIGHT_SPEED_CELLS_PER_SECOND = cellsAcross(20);
export const DIVE_SPEED_CELLS_PER_SECOND = cellsAcross(26);
export const EXIT_SPEED_CELLS_PER_SECOND = cellsAcross(40);

/**
 * How far out an approaching saucer starts, in cells — DERIVED from the two
 * constants that decide it, so a retune of either moves the run-in with it
 * instead of leaving a stale literal behind.
 */
export const ENTRY_DISTANCE_CELLS = APPROACH_SPEED_CELLS_PER_SECOND * APPROACH_SECONDS;

/**
 * Radius of the arena the dogfight is flown over, in cells.
 *
 * EIGHT WORLD UNITS, so the fight is sixteen across — half a chunk, which is a
 * span a player watching from a normal orbit camera can hold in view at once.
 * Bigger and the two saucers stop being in the same shot; smaller and the weave
 * has nowhere to go.
 */
export const ARENA_RADIUS_CELLS = cellsAcross(8);

/**
 * How high the saucers fly, in TERRACE BANDS above the highest ground inside the
 * arena. Bands rather than world units because relief is measured in bands here
 * and a saucer's clearance is a statement about the ground UNDER it.
 *
 * TWENTY-FOUR, which is SIX WORLD UNITS at the shipped WORLD_UNITS_PER_BAND of
 * 0.25 — the same height a tornado's funnel stands (TORNADO_HEIGHT_WORLD_UNITS),
 * chosen as the anchor because that is the established "reaches from the ground
 * to well above the highest land" measurement in this world. Against a total
 * relief of 16 world units (MAX_RELIEF_WORLD_UNITS) it clears anything a player
 * can build by a wide margin and still sits inside the sky the camera frames.
 *
 * A SANITY CHECK ON THE UNITS, because this is the number a stale "1 unit = 1
 * cell" reading gets wrong: a saucer is SAUCER_DIAMETER_CELLS (4) cells across,
 * which is ONE world unit, so the pair fly six of their own diameters above the
 * peak. Six BANDS — the first draft of this constant — would have been 1.5 world
 * units, i.e. a saucer skimming the treetops.
 */
export const CRUISE_ALTITUDE_BANDS = 24;

/** The same clearance in world units — derived, never written by hand. */
export const CRUISE_ALTITUDE_WORLD_UNITS = CRUISE_ALTITUDE_BANDS * WORLD_UNITS_PER_BAND;

// ─────────────────────────────────────────────────────────────────────────────
// THE FIGHT.

/**
 * A saucer's hit points. EIGHT, against a burst that lands at most one hit:
 * the loser has to be shot down at least eight times over DOGFIGHT_SECONDS, so
 * the outcome is the sum of twenty-odd rolls rather than one, which is what
 * keeps a near-run fight the common case.
 */
export const SAUCER_MAX_HP = 8;

/** What one landed bolt takes off. One — see SAUCER_MAX_HP. */
export const LASER_HIT_DAMAGE = 1;

/**
 * Seconds between one saucer's bursts. 0.8 s — over DOGFIGHT_SECONDS that is 22
 * bursts each, which at LASER_HIT_CHANCE is a mean of about 11 hits: comfortably
 * more than SAUCER_MAX_HP, so a fight normally ENDS in a kill rather than timing
 * out into the tie-break below.
 */
export const LASER_BURST_INTERVAL_SECONDS = 0.8;

/**
 * Chance a burst connects. HALF: the honest coin. Anything higher and the first
 * saucer to fire wins nearly every time; anything much lower and the fight runs
 * out of clock.
 */
export const LASER_HIT_CHANCE = 0.5;

/**
 * How long a bolt is on the wire and on screen, in seconds. A quarter second —
 * long enough to read as a streak at 60 fps, short enough that at most a couple
 * are ever in flight at once (which is what MAX_LASER_BOLTS is sized from).
 */
export const LASER_BOLT_LIFETIME_SECONDS = 0.25;

/**
 * The most bolts that can be on the wire at once — DERIVED, which is what makes
 * it an honest ceiling rather than a number from one measurement: each saucer
 * fires one bolt every LASER_BURST_INTERVAL_SECONDS and each lives
 * LASER_BOLT_LIFETIME_SECONDS, so the count is bounded by how many lifetimes fit
 * in an interval, rounded up, times the saucers. The client's pool is sized
 * against this and so is the payload budget.
 */
export const MAX_LASER_BOLTS =
  SAUCERS_PER_ENCOUNTER *
  Math.max(1, Math.ceil(LASER_BOLT_LIFETIME_SECONDS / LASER_BURST_INTERVAL_SECONDS));

// ─────────────────────────────────────────────────────────────────────────────
// THE CRASH.

/**
 * The crater, as one `WorldApi.sculpt`.
 *
 * RADIUS 2.5 world units, DEPTH two terrace bands. A wreck coming in at DIVE
 * speed leaves a hole a player notices from the ground and can walk out of;
 * three bands would punch through to the water table on ordinary land, which is
 * a different, permanent kind of damage than the owner asked for.
 *
 * The depth is written in BANDS and converted, because that is the unit the
 * terrain is quantised in — a crater specified in raw height units would be a
 * number whose visual depth changed the day BAND_HEIGHT did.
 */
export const CRASH_CRATER_RADIUS_CELLS = cellsAcross(2.5);
export const CRASH_CRATER_DEPTH_BANDS = 2;

/**
 * Cells the fire ring stands off the impact point.
 *
 * TWO — just outside the crater's steep wall, where burning wreckage would come
 * to rest. Inside it the fire would sit at the bottom of a hole and be invisible
 * from anywhere but directly overhead.
 */
export const CRASH_FIRE_RING_RADIUS_CELLS = 2;

/**
 * Cells lit around the impact, in FIXED ITERATION ORDER — the impact cell itself
 * plus the eight compass points of the ring. Eight and not four so the ring
 * reads as a ring rather than as a cross, and a fixed table rather than a
 * trigonometric sweep so the same crash lights the same cells on every machine.
 *
 * `igniteAt` refuses most of them in practice (bare rock, water, a world already
 * at the fire cap), which is the ordinary answer and not an error.
 */
export const CRASH_FIRE_RING_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [CRASH_FIRE_RING_RADIUS_CELLS, 0],
  [-CRASH_FIRE_RING_RADIUS_CELLS, 0],
  [0, CRASH_FIRE_RING_RADIUS_CELLS],
  [0, -CRASH_FIRE_RING_RADIUS_CELLS],
  [CRASH_FIRE_RING_RADIUS_CELLS, CRASH_FIRE_RING_RADIUS_CELLS],
  [CRASH_FIRE_RING_RADIUS_CELLS, -CRASH_FIRE_RING_RADIUS_CELLS],
  [-CRASH_FIRE_RING_RADIUS_CELLS, CRASH_FIRE_RING_RADIUS_CELLS],
  [-CRASH_FIRE_RING_RADIUS_CELLS, -CRASH_FIRE_RING_RADIUS_CELLS],
];

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRE.

/**
 * One saucer, as it appears on the wire.
 *
 * `x`/`y` are CELL space (fractional) and `alt` is WORLD-space Y — the two are
 * different spaces on purpose, because that is what each consumer needs: the
 * horizontal pair gates fog-of-war visibility and is measured against the
 * heightmap, and the vertical one is read straight into `Object3D.position.y`.
 * Mixing them into one space would force a conversion into whichever half did
 * not own the constant.
 *
 * `speed` is CELLS PER SECOND and is carried rather than derived because the
 * client banks the hull into its turns and cannot tell a fast turn from a slow
 * one out of interpolated positions alone.
 */
export interface SaucerState {
  /** Stable for the saucer's whole life; the client keys interpolation by it. */
  readonly id: number;
  /** Which of the three bodies — an index, see SAUCER_VARIANT_COUNT. */
  readonly variant: number;
  readonly x: number;
  readonly y: number;
  /** World-space Y. */
  readonly alt: number;
  /** Radians; the saucer travels toward (cos heading, sin heading) in cell space. */
  readonly heading: number;
  /** Cells per second. */
  readonly speed: number;
  readonly phase: SaucerPhase;
  readonly hp: number;
}

/**
 * One laser bolt in flight.
 *
 * `age` IS SECONDS SINCE THE SHOT, NOT A TIMESTAMP. The brief called this field
 * `t0`; a timestamp would have to be read against a clock, and the server's
 * `simMillis` and the client's frame clock are not the same clock and never
 * become one. An age is the same number in both frames of reference and needs no
 * alignment, so the client can fade a bolt correctly on the very first message
 * it ever receives.
 */
export interface LaserBolt {
  /** Id of the saucer that fired. */
  readonly from: number;
  /** Id of the saucer it was fired at. */
  readonly to: number;
  /** Seconds since the shot, on the server's own sim clock. */
  readonly age: number;
}

/**
 * Where the loser went in, present only during the aftermath.
 *
 * `age` for LaserBolt's reason, and here it is what the client keys the fireball
 * to: a client that joins mid-aftermath starts the burst part-way through rather
 * than replaying it from zero over a crater that is already cold.
 */
export interface CrashState {
  readonly x: number;
  readonly y: number;
  /** Seconds since impact. */
  readonly age: number;
}

export interface SaucersStatePayload {
  readonly saucers: readonly SaucerState[];
  readonly lasers: readonly LaserBolt[];
  /** Null outside the aftermath, and null for a player who cannot see the site. */
  readonly crash: CrashState | null;
}

/**
 * Resolves whatever arrived in a `variant` field.
 *
 * A saucer whose variant is missing or out of range is still a saucer: it
 * resolves to DEFAULT_SAUCER_VARIANT rather than causing the entry to be
 * dropped, for the reason monsters' `yetiVariantOf` gives at length — a wrong
 * hull is a cosmetic error for one client session, and a missing saucer is a lie
 * about the world (and, since an empty list is this plugin's "it's over" signal,
 * a lie that reads as the encounter having ended).
 */
export function saucerVariantOf(raw: unknown): number {
  if (!isFiniteNumber(raw)) return DEFAULT_SAUCER_VARIANT;
  const index = Math.floor(raw);
  if (index < 0 || index >= SAUCER_VARIANT_COUNT) return DEFAULT_SAUCER_VARIANT;
  return index;
}

/**
 * Defensive parse of a received payload.
 *
 * The client trusts the server, but "trusts" is not "assumes well-formed": a
 * version skew between a self-hoster's server and a cached client bundle is an
 * ordinary event, and the right failure mode is "the sky is empty this second",
 * never a thrown exception inside the render loop. Malformed entries are dropped
 * individually; a payload that is not an object with the two lists at all yields
 * null so the caller can ignore the message entirely.
 *
 * AN EMPTY PAYLOAD IS A VALID PARSE — it is the end-of-encounter signal — which
 * is exactly why "not a payload" has to be reported as null rather than as an
 * empty result.
 *
 * A BOLT WHOSE ENDPOINTS ARE NOT BOTH PRESENT IS DROPPED, and that check lives
 * here rather than in the renderer: a bolt is drawn between two saucers, so one
 * naming an id that is not in this same payload has no geometry to be, and the
 * alternative to dropping it is a renderer that has to invent a fallback
 * endpoint — which is a line pointing somewhere nothing happened.
 */
export function parseSaucersPayload(payload: unknown): SaucersStatePayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as {
    saucers?: unknown;
    lasers?: unknown;
    crash?: unknown;
  };
  if (!Array.isArray(raw.saucers)) return null;
  if (!Array.isArray(raw.lasers)) return null;

  const saucers: SaucerState[] = [];
  const ids = new Set<number>();
  for (const entry of raw.saucers) {
    const parsed = parseSaucer(entry);
    if (parsed === null) continue;
    saucers.push(parsed);
    ids.add(parsed.id);
  }

  const lasers: LaserBolt[] = [];
  for (const entry of raw.lasers) {
    const parsed = parseBolt(entry, ids);
    if (parsed === null) continue;
    lasers.push(parsed);
  }

  return { saucers, lasers, crash: parseCrash(raw.crash) };
}

function parseSaucer(entry: unknown): SaucerState | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = entry as Partial<SaucerState>;
  if (!isFiniteNumber(raw.id)) return null;
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
  if (!isFiniteNumber(raw.alt)) return null;
  if (!isFiniteNumber(raw.heading)) return null;
  if (!isFiniteNumber(raw.speed)) return null;
  if (!isFiniteNumber(raw.hp)) return null;
  if (!isSaucerPhase(raw.phase)) return null;
  return {
    id: raw.id,
    variant: saucerVariantOf(raw.variant),
    x: raw.x,
    y: raw.y,
    alt: raw.alt,
    heading: raw.heading,
    speed: raw.speed,
    phase: raw.phase,
    hp: raw.hp,
  };
}

function parseBolt(entry: unknown, ids: ReadonlySet<number>): LaserBolt | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = entry as Partial<LaserBolt>;
  if (!isFiniteNumber(raw.from) || !isFiniteNumber(raw.to)) return null;
  if (!isFiniteNumber(raw.age)) return null;
  // See the doc comment above: a bolt with no visible shooter or no visible
  // target has no geometry to be. This ALSO covers the fog-of-war case, where
  // the recipient can see one saucer and not the other.
  if (!ids.has(raw.from) || !ids.has(raw.to)) return null;
  return { from: raw.from, to: raw.to, age: raw.age };
}

function parseCrash(entry: unknown): CrashState | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = entry as Partial<CrashState>;
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
  if (!isFiniteNumber(raw.age)) return null;
  return { x: raw.x, y: raw.y, age: raw.age };
}

// Broadcast coordinate precision lives in @terrace/shared (shared/src/wire.ts) —
// re-exported here so this file stays the one wire contract this plugin's two
// halves both import.
export {
  BROADCAST_POSITION_DECIMALS,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '@terrace/shared';
export { CELL_WORLD_SIZE, WORLD_UNITS_PER_BAND } from '@terrace/shared';

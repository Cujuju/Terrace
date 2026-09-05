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
// REVISED (owner, 2026-09-04, after seeing the duel): "spawn varying sizes of
// groups to fight each other" — at least two factions and three saucers, at
// most five per faction — "they need to fly around each other at different
// angles shooting", lasers "in bursts, just like the artifact design", coloured
// to match the faction, "saucers die after five hits", a floor of three seconds
// before anyone can go down, and a larger explosion.
//
// AN ENCOUNTER IS THE UNIT, not a saucer. Several factions arrive together,
// fight each other and nothing else, and the whole thing is over inside half a
// minute leaving one crater per shot-down saucer behind. There is at most one
// encounter in the world at a time (MAX_LIVING_ENCOUNTERS) — the drama is that
// it is an EVENT, the same argument monsters' per-kind singleton makes.
//
// A FACTION IS A HULL. The three authored bodies each carry their own livery
// baked into the file — blue, amber and magenta rings and light strips — so the
// wire's `variant` is the faction and there is no second field to keep in step
// with it. Which hull a saucer wears says whose side it is on, and its bolts
// wear the same colour (client/factions.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT TRAVELS. Every saucer's pose, the laser bolts in flight, and — for a
// couple of seconds after each impact — where each wreck went in. Nothing else: the hull, the
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
 * THE ROSTER (owner, 2026-09-04): "minimum of three saucers total, minimum of
 * two groups, maximum of five saucers per group".
 *
 * The faction ceiling is the hull count, because a faction IS a hull (see the
 * header) and two factions in the same body would be a fight nobody could
 * follow. The encounter floor of three is what makes the smallest roster a
 * fight rather than a duel — one against two.
 */
export const MIN_FACTIONS_PER_ENCOUNTER = 2;
export const MIN_SAUCERS_PER_FACTION = 1;
export const MAX_SAUCERS_PER_FACTION = 5;
export const MIN_SAUCERS_PER_ENCOUNTER = 3;

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

/** One faction per hull, so this is the most factions an encounter can hold. */
export const MAX_FACTIONS_PER_ENCOUNTER = SAUCER_VARIANT_COUNT;

/**
 * The most saucers an encounter can hold — DERIVED from the roster bounds, so
 * every pool and budget sized against it (the client's views, the bolt pool,
 * the burst pool, the crash-cell search) follows a retune of the roster.
 */
export const MAX_SAUCERS_PER_ENCOUNTER = MAX_FACTIONS_PER_ENCOUNTER * MAX_SAUCERS_PER_FACTION;

/**
 * The phases of a SAUCER, in the order it runs through them. Ordered and
 * exhaustive: a phase the client does not know is dropped with the entry rather
 * than guessed at.
 *
 *   approach   — coming in off the map edge on its faction's bearing, at speed;
 *   dogfight   — flying its own path over the arena, firing in bursts;
 *   resolve    — either diving at its crash cell (shot down) or climbing away
 *                (its faction won). The client cannot tell the two apart and
 *                does not need to: both are a pose on the wire.
 *
 * PER SAUCER, NOT PER ENCOUNTER, since the 2026-09-04 revision: one saucer can
 * be diving while its wingmates are still fighting. The crash itself is not a
 * phase of anything — it is an entry in the payload's `crashes`.
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
 * it off the map, so a player sees the factions cross the horizon and arrive
 * rather than blink into existence over their village.
 *
 * DOGFIGHT_HOLD_FIRE — 3 s, the owner's floor: nobody fires, so nobody can go
 * down, for the first three seconds of the fight. The factions close, cross and
 * pick targets before the first burst, which is also what makes the smallest
 * fight (three saucers, one of them alone) last long enough to be seen.
 *
 * DOGFIGHT — 20 s, the CAP. A fight normally ends earlier, when one faction is
 * the last with anything flying (see SAUCER_MAX_HP); the cap exists so a fight
 * of two lucky misses does not orbit forever, and on it the faction with the
 * most hit points left wins.
 *
 * RESOLVE — 3 s: the dive and the climb-out. Shorter than the approach on
 * purpose — a loser that took as long to fall as it took to arrive would read
 * as a landing.
 *
 * CRASH_WIRE — 2.5 s. How long each impact stays in `crashes` after it happens:
 * longer than the client's fireball, so a client that joined a beat late still
 * sees the burst and no client has its last frames cut off by the entry
 * leaving the wire. The fire and the crater outlive it by minutes because they
 * belong to other systems.
 */
export const APPROACH_SECONDS = 2.5;
export const DOGFIGHT_HOLD_FIRE_SECONDS = 3;
export const DOGFIGHT_SECONDS = 20;
export const RESOLVE_SECONDS = 3;
export const CRASH_WIRE_SECONDS = 2.5;

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
 * DOGFIGHT 20 — slower, because a fight that kept approach speed would be
 *   dots leaving the arena; at 20 over ARENA_RADIUS a saucer laps the arena
 *   about every two and a half seconds, which reads as a fight. It is the
 *   TANGENTIAL speed each saucer's own path is scaled to (server/encounter.ts).
 * DIVE 26 and EXIT 40 — a loser accelerates into the ground and a winner
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
 * Bigger and the saucers stop being in the same shot; smaller and fifteen of
 * them have nowhere to go.
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
 * which is ONE world unit, so they fly six of their own diameters above the
 * peak. Six BANDS — the first draft of this constant — would have been 1.5 world
 * units, i.e. a saucer skimming the treetops.
 */
export const CRUISE_ALTITUDE_BANDS = 24;

/** The same clearance in world units — derived, never written by hand. */
export const CRUISE_ALTITUDE_WORLD_UNITS = CRUISE_ALTITUDE_BANDS * WORLD_UNITS_PER_BAND;

// ─────────────────────────────────────────────────────────────────────────────
// THE FIGHT.

/**
 * A saucer's hit points. FIVE (owner, 2026-09-04: "saucers die after five
 * hits"). Against a burst that lands a mean of one and a half, a saucer with
 * one enemy on it lasts about three and a half bursts — eight or nine seconds
 * after the hold-fire floor — and one with a whole faction on it goes down in
 * one or two. The outcome is the sum of many rolls, which keeps a near-run
 * fight the common case.
 */
export const SAUCER_MAX_HP = 5;

/** What one landed shot takes off. One — see SAUCER_MAX_HP. */
export const LASER_HIT_DAMAGE = 1;

/**
 * A BURST (owner, 2026-09-04: "lasers should fire in bursts, just like the
 * artifact design" — .saucer-hangar/hangar.template.html fires three shots
 * 0.09 s apart, then rests 1.6–3.0 s). THREE SHOTS, ONE TICK APART: the gap is
 * one server tick at the shipped TICK_HZ because the fight advances once per
 * tick and fires at most one shot per saucer per tick, so a gap shorter than
 * that would only ever be rounded up to it. The rest between bursts is drawn
 * from the encounter's own generator, so a fight's rhythm is reproducible.
 */
export const LASER_BURST_SHOTS = 3;
export const LASER_SHOT_GAP_SECONDS = 0.1;
export const LASER_BURST_REST_MIN_SECONDS = 1.6;
export const LASER_BURST_REST_MAX_SECONDS = 3.0;

/**
 * Chance one shot connects. HALF: the honest coin. Anything higher and the
 * first faction to fire wins nearly every time; anything much lower and the
 * fight runs out of clock.
 */
export const LASER_HIT_CHANCE = 0.5;

/**
 * A bolt is a PROJECTILE, not a beam: it leaves the muzzle and travels at
 * LASER_BOLT_SPEED for LASER_BOLT_LIFETIME, drawn LASER_BOLT_LENGTH long. The
 * hangar's numbers (60 cells/s, 2.4 cells), which the owner approved on sight.
 * The lifetime is what it takes to cross the widest gap two saucers in the
 * arena can have — a little over the arena's diameter — so a bolt reaches its
 * target and no bolt flies on past the fight.
 *
 * WHY THIS IS ON THE WIRE'S SIDE OF THE CONTRACT: the server decides the hit
 * the instant it fires and puts only `age` on the wire; the client draws the
 * bolt where a projectile of this speed would be at that age. Both halves need
 * the same speed for a bolt to arrive as the hit lands.
 */
export const LASER_BOLT_SPEED_CELLS_PER_SECOND = cellsAcross(15);
export const LASER_BOLT_LENGTH_CELLS = 2.4;
export const LASER_BOLT_LIFETIME_SECONDS = 0.4;

/**
 * The most bolts that can be on the wire at once — DERIVED, which is what makes
 * it an honest ceiling rather than a number from one measurement: a saucer's
 * burst is LASER_BURST_SHOTS bolts a gap apart, each living
 * LASER_BOLT_LIFETIME, so no more than the lesser of the burst and the
 * lifetimes-per-gap are in flight from one saucer, and the rest between bursts
 * is longer than a lifetime so bursts never overlap. The client's pool is sized
 * against this and so is the payload budget.
 */
export const MAX_LASER_BOLTS =
  MAX_SAUCERS_PER_ENCOUNTER *
  Math.min(LASER_BURST_SHOTS, Math.ceil(LASER_BOLT_LIFETIME_SECONDS / LASER_SHOT_GAP_SECONDS));

// ─────────────────────────────────────────────────────────────────────────────
// THE CRASH.

/**
 * The crater, as one `WorldApi.sculpt`.
 *
 * RADIUS 2.5 world units, DEPTH two terrace bands. A wreck coming in at DIVE
 * speed leaves a hole a player notices from the ground and can walk out of;
 * three bands would punch through to the water table on ordinary land, which is
 * a different, permanent kind of damage than the owner asked for. EVERY WRECK
 * HAS ITS OWN CELL (site.ts), so two craters never stack into that.
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
 * Where a wreck went in, present for CRASH_WIRE_SECONDS after the impact.
 *
 * `age` for LaserBolt's reason, and here it is what the client keys the fireball
 * to: a client that joins mid-burst starts it part-way through rather than
 * replaying it from zero over a crater that is already cold. `id` is the saucer
 * that went in — the client keys its burst pool by it, so two wrecks a second
 * apart each get their own fireball.
 */
export interface CrashState {
  /** Id of the saucer that crashed here. */
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Seconds since impact. */
  readonly age: number;
}

export interface SaucersStatePayload {
  readonly saucers: readonly SaucerState[];
  readonly lasers: readonly LaserBolt[];
  /** Every impact still burning, minus those on ground the player cannot see. */
  readonly crashes: readonly CrashState[];
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
    crashes?: unknown;
  };
  if (!Array.isArray(raw.saucers)) return null;
  if (!Array.isArray(raw.lasers)) return null;
  if (!Array.isArray(raw.crashes)) return null;

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

  const crashes: CrashState[] = [];
  for (const entry of raw.crashes) {
    const parsed = parseCrash(entry);
    if (parsed === null) continue;
    crashes.push(parsed);
  }

  return { saucers, lasers, crashes };
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
  if (!isFiniteNumber(raw.id)) return null;
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
  if (!isFiniteNumber(raw.age)) return null;
  return { id: raw.id, x: raw.x, y: raw.y, age: raw.age };
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

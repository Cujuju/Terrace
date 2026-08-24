// day & night — the wire contract between the plugin's two halves.
//
// Card 31: "A slow cycle: warm windows and Durand's neon at dusk, monsters
// bolder in the dark, dawn fog burning off the water. Ambience first,
// mechanics (nocturnal spawns) optional later." THIS PLUGIN IS THE AMBIENCE
// HALF ONLY — the shared clock and the sky/lighting sweep it drives. Nocturnal
// spawns and "monsters bolder in the dark" are explicitly deferred (the card's
// own words: "optional later"); nothing here reads the sky's phase into any
// spawn or aggression decision, and there is no hook by which another plugin
// could either — see server/index.ts's header for where that seam would go.
//
// Imported by BOTH server/ and client/ and therefore dependency-free (no
// three, no node builtins) and side-effect-free — the plugin-local equivalent
// of @terrace/shared, exactly like plugins/weather/protocol.ts.

/** Plugin name on both sides. Also the message namespace. */
export const DAYNIGHT_PLUGIN_NAME = 'daynight';

/**
 * Un-namespaced type of the server → client push (`daynight:clock`).
 *
 * ONE MESSAGE, CARRYING THE WHOLE CLOCK — a single number, `phase` — the same
 * full-state-not-a-delta choice weather, wildlife and monsters make, and here
 * it costs almost nothing to keep: the entire state of this plugin, at any
 * instant, IS the current phase. A dropped or reordered message costs one
 * broadcast interval of staleness and nothing else; a joining client is caught
 * up by the next broadcast, so this plugin needs no separate join-snapshot
 * path.
 */
export const DAYNIGHT_CLOCK_MESSAGE = 'clock';

/**
 * Length of one full Terrace day-night cycle, in real seconds. 1 440 = 24
 * real minutes, chosen as follows:
 *
 *   * THE CARD ASKS FOR "A SLOW CYCLE" — slow enough that the sky is a
 *     backdrop a player notices changing over a sitting, not a clock they can
 *     feel ticking. Minecraft's day (the most widely recognised reference
 *     point for "a game day-night cycle") runs 20 real minutes; 24 sits in the
 *     same order of magnitude for the same reason — long enough to read as
 *     slow, short enough that "wait for night" is a real, boundable ask
 *     rather than an evening-long commitment.
 *   * IT IS A CLEAN RATIO: exactly 1 real second per in-world minute
 *     (1 440 s × 24 in-world-hours-per-day ⁄ 24 real-minutes-per-day = 60
 *     in-world-minutes per real minute — i.e. 1 : 1 real-second-to-game-
 *     minute). That ratio is what makes every other number in this file easy
 *     to reason about (a five-second broadcast interval is five in-world
 *     minutes of staleness at worst) rather than an arbitrary fraction someone
 *     has to look up.
 *   * IT COMFORTABLY CONTAINS SEVERAL WEATHER SYSTEMS: the weather plugin's
 *     SYSTEM_MEAN_LIFETIME_SECONDS is 240 s (plugins/weather/server/
 *     systems.ts), so an average Terrace day sees roughly six weather fronts
 *     arrive and dissipate under changing light — dawn fog, a dusk storm, a
 *     clear midnight — which is the kind of crossing the card's own "dawn fog
 *     burning off the water" beat describes.
 *
 * A NAMED CONSTANT, NOT A DIFFICULTY-SCALED ONE: WorldApi.difficulty (design
 * record) is a mechanics dial, and this is ambience — every world runs the
 * same clock regardless of difficulty, exactly as weather's own timings are
 * difficulty-independent.
 *
 * IT NOW LIVES IN shared/src/calendar.ts AND IS RE-EXPORTED HERE (2026-08-23).
 * The reasoning above is unchanged and stays in this file, because it is the
 * SKY's argument for the number; what moved is the number itself, because the
 * chronicle and structures both need to agree with it and plugins may not
 * import each other. See that file's header for why one world may only have
 * one day. Every call site in this plugin keeps importing it from here.
 */
export { DAY_LENGTH_SECONDS } from '@terrace/shared';

/**
 * Decimal places kept on the broadcast phase, which is a fraction in [0, 1)
 * — the same reasoning weather's WEATHER_INTENSITY_DECIMALS gives for its own
 * [0, 1] quantity. Four places is 1/10 000 of a full cycle, i.e. ≈0.144 real
 * seconds at DAY_LENGTH_SECONDS — a small fraction of a single animation
 * frame's worth of visible sky movement, so the quantisation is not
 * observable, while keeping the payload's encoded size small and exactly
 * assertable in a test.
 */
export const DAYNIGHT_PHASE_DECIMALS = 4;

const PHASE_QUANTUM = 10 ** DAYNIGHT_PHASE_DECIMALS;

/**
 * Wraps any finite value into [0, 1) — the one place "what does the clock
 * read" is defined, so the server's elapsed-seconds accumulator and the
 * client's interpolator cannot each invent their own wrap rule.
 *
 * Total for any finite input, including a negative one — the JS `%` keeps the
 * sign of its left operand, so a negative remainder is nudged up by exactly
 * one lap, which is what stops a negative phase reading as "just before
 * midnight" becoming "just after", off by a whole lap.
 *
 * NOT WRITTEN AS `((value % 1) + 1) % 1`. That common one-liner is wrong for
 * this file's purposes: for a `value` already inside [0, 1) (the overwhelming
 * common case — every already-valid phase gets re-wrapped by every call
 * site), `value % 1 + 1` first pushes the result up near 1, and the SECOND
 * `% 1` then has to subtract that whole integer part back off in floating
 * point — e.g. 1.42 % 1 comes back 0.41999999999999993, not 0.42, because
 * 1.42 is not exactly representable in binary the way 0.42 is. Branching on
 * the sign instead means an already-non-negative remainder is returned
 * UNTOUCHED, so a value already in range round-trips bit-for-bit — which
 * matters here because a broadcast phase is parsed, quantised and re-sent
 * every cycle (server/index.ts), and a wrap that could not round-trip would
 * compound error over a long-running world.
 */
export function wrapPhase(value: number): number {
  const remainder = value % 1;
  if (remainder < 0) return remainder + 1;
  // Normalises -0 to +0: `-0 % 1` is `-0`, which is not < 0 (Object.is(-0, 0)
  // is false, but the numeric comparison -0 < 0 is false too), so it falls
  // through here rather than into the branch above.
  return remainder === 0 ? 0 : remainder;
}

/** Rounds a phase for the wire and wraps it — see wrapPhase and PHASE_QUANTUM. */
export function roundBroadcastPhase(value: number): number {
  return Math.round(wrapPhase(value) * PHASE_QUANTUM) / PHASE_QUANTUM;
}

/** One clock reading, as it appears on the wire. */
export interface DayNightClockState {
  /** Fraction of a lap through DAY_LENGTH_SECONDS, in [0, 1). 0 is dawn. */
  readonly phase: number;
  /**
   * WHICH DAY OF THE WORLD it is — 0 for the world's first day, which the
   * header renders as "Day 1". A DAY OF AGE, NOT A CALENDAR DAY: since the
   * world clock was anchored to real time (shared/src/calendar.ts) those are
   * two different numbers, and this is the one a player means by "Day 57".
   *
   * Null on a server too old to send it, which the client reads as "show the
   * time alone" — never as a reason to drop the phase and freeze the sky.
   */
  readonly day: number | null;
  /**
   * The calendar day this world's day 0 fell on — add it to `day` and the
   * calendar day is back, which is where the WEEKDAY comes from.
   *
   * THE SAME TWO FIELDS, WITH THE SAME NAMES AND THE SAME MEANINGS, THAT THE
   * CHRONICLE'S PAYLOAD ALREADY CARRIES (plugins/chronicle/protocol.ts). The
   * header and a saga heading name the same day in the same words, so they
   * derive it from the same pair of numbers through the same shared helpers
   * rather than each inventing a convention that drifts from the other.
   */
  readonly genesisDay: number | null;
}

/**
 * Defensive parse of a received payload — the same "trust but don't assume
 * well-formed" stance weather's parseSystemsPayload documents: a version skew
 * between a self-hoster's server and a cached client bundle is ordinary, and
 * the right failure mode is "the sky holds at its last known phase", never a
 * thrown exception in the render loop.
 */
export function parseClockPayload(payload: unknown): DayNightClockState | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const phase = (payload as { phase?: unknown }).phase;
  if (typeof phase !== 'number' || !Number.isFinite(phase)) return null;

  // THE CALENDAR HALF DEGRADES ON ITS OWN, and separately from the phase: a
  // payload whose day fields are absent or malformed still carries a perfectly
  // good sky, and the sky is what this plugin exists for. Both fields must
  // survive together or neither is used — a weekday computed from a day
  // without its genesis offset would be confidently wrong, which is worse than
  // a header that shows only the time.
  //
  // `day` is a world's AGE and cannot be negative; `genesisDay` is a calendar
  // day and may be, for the same reason the chronicle's parseGenesisDay
  // accepts a negative one (a world older than the clock it now runs on).
  const day = (payload as { day?: unknown }).day;
  const genesisDay = (payload as { genesisDay?: unknown }).genesisDay;
  const calendarKnown =
    Number.isInteger(day) && (day as number) >= 0 && Number.isInteger(genesisDay);

  return {
    phase: wrapPhase(phase),
    day: calendarKnown ? (day as number) : null,
    genesisDay: calendarKnown ? (genesisDay as number) : null,
  };
}

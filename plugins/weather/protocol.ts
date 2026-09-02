// weather — the wire contract between the plugin's two halves.
//
// This module is imported by BOTH server/ and client/ and must therefore stay
// dependency-free (no three, no node builtins) and side-effect-free. It is the
// plugin-local equivalent of @terrace/shared: one definition of the payload, so
// the halves cannot drift.
//
// Namespacing: the hosts prefix `weather:` on the wire in both directions, so
// every type here is the UN-namespaced form (see server/src/plugins/host.ts and
// client/src/plugins/host.ts).
//
// WHAT TRAVELS, AND WHAT DOES NOT. The server sends the SYSTEMS — a handful of
// large coherent masses, each a disc with a centre, a radius, an intensity and
// the wind it is riding. It does not send a single raindrop: every drop, flake,
// fog sheet and bolt is invented on the client out of these few numbers plus the
// frame clock (client/rig.ts). That split is the whole reason a weather system
// costs ~92 B instead of a particle stream — see the bandwidth note in
// server/index.ts.

/** Plugin name on both sides. Also the message namespace. */
export const WEATHER_PLUGIN_NAME = 'weather';

/**
 * Un-namespaced type of the server → client push (`weather:systems`).
 *
 * There is exactly one message type and it carries FULL state every time — the
 * same choice the wildlife and monsters plugins made, for the same self-healing
 * reasons, and here it is nearly free: the list holds at most
 * MAX_ACTIVE_SYSTEMS entries.
 *
 * AN EMPTY LIST IS MEANINGFUL and is broadcast just as faithfully as a populated
 * one: an empty list IS the clear/sunny sky. There is no `clear` kind and no
 * "weather ended" message, because "no system covers you" is the only definition
 * of clear that cannot disagree with the systems themselves. A despawn signalled
 * only by the absence of a message would leave a client that was watching a
 * storm rendering it forever.
 */
export const WEATHER_SYSTEMS_MESSAGE = 'systems';

/**
 * The kinds of weather system that exist. Ordered; this order is also the
 * deterministic order in which spawning considers kinds, so the draw is
 * reproducible under a seeded generator rather than depending on whichever key
 * `for…in` yielded.
 *
 * SUN/CLEAR IS DELIBERATELY NOT A KIND. Clear weather is the absence of any
 * system over you, which is what makes "the existing sun stays as-is" true by
 * construction: no system means the client renders nothing at all and the
 * scene's own lighting rig is untouched. A `clear` kind would be a system that
 * has to be positioned, sized, drifted and drawn in order to do nothing.
 *
 * `storm` is `rain` plus lightning rather than a `hasLightning` flag on rain,
 * because every consumer switches on the kind anyway (particle rig, opacity,
 * whether a bolt schedule is armed) and a boolean would make two of the four
 * rows of that table depend on two fields instead of one.
 */
export const WEATHER_KINDS = ['rain', 'storm', 'snow', 'fog'] as const;

export type WeatherKind = (typeof WEATHER_KINDS)[number];

// Broadcast coordinate precision lives in @terrace/shared (shared/src/wire.ts).
// Five plugins each carried a byte-identical copy of this rounding; see that
// file for why it moved (issue #180). Re-exported here so this file stays the
// one wire contract this plugin's server and client halves both import.
//
// The UNBOUNDED form only: a system's centre is a cloud front's, and it is born
// and dies well outside the map by design, exactly like wildlife's birds. There
// is no cell for shared's `roundBroadcastCell` to keep it inside of.
export { BROADCAST_POSITION_DECIMALS, roundBroadcastPosition } from '@terrace/shared';
import { isFiniteNumber } from '@terrace/shared';

// Broadcast INTENSITY precision lives in @terrace/shared (shared/src/wire.ts)
// alongside the position precision, for the same reason #180 put that there:
// weather and storms each carried a byte-identical copy of the constant and the
// rounding, and the precision of a wire value is a property of the protocol.
// Re-exported under this plugin's own name so nothing that reads it here moved.
export { roundBroadcastIntensity } from '@terrace/shared';
export { BROADCAST_INTENSITY_DECIMALS as WEATHER_INTENSITY_DECIMALS } from '@terrace/shared';

/** One weather system, as it appears on the wire. */
export interface WeatherSystemState {
  /** Stable for the system's whole life; the client keys interpolation by it. */
  readonly id: number;
  readonly kind: WeatherKind;
  /**
   * Cell-space centre of the mass (fractional). World X/Z, since
   * CELL_WORLD_SIZE is 1. It may legitimately sit OUTSIDE the world — a system
   * drifts in from off the map and out the other side.
   */
  readonly x: number;
  readonly y: number;
  /** Cell-space radius of the mass. Constant for a system's whole life. */
  readonly radius: number;
  /**
   * Strength in [0, 1]: 0 is nothing at all, 1 is the heaviest this kind gets.
   * It ramps up as the system gathers and back down as it dissipates, so a
   * system is never seen appearing or vanishing — which is why the client needs
   * no fade envelope of its own.
   */
  readonly intensity: number;
  /**
   * The wind this system is riding, in cells per second.
   *
   * ON THE WIRE PER SYSTEM even though today every system rides ONE shared wind
   * (server/systems.ts), for two reasons. The client uses it as a direction, not
   * only as a speed — precipitation shears downwind of the cloud it fell from
   * and the streaks lean along the drop's actual velocity (client/rig.ts) — so
   * it would have to be sent whatever the model. And a per-system drift is a
   * change the sim could plausibly make; a field that already exists absorbs it,
   * where a single global wind field on the message would have to be moved.
   */
  readonly vx: number;
  readonly vy: number;
}

export interface WeatherSystemsPayload {
  readonly systems: readonly WeatherSystemState[];
}

export function isWeatherKind(value: unknown): value is WeatherKind {
  return (WEATHER_KINDS as readonly string[]).includes(value as string);
}

/**
 * Defensive parse of a received payload.
 *
 * The client trusts the server, but "trusts" is not "assumes well-formed": a
 * version skew between a self-hoster's server and a cached client bundle is a
 * completely ordinary event, and the right failure mode is "one system is
 * missing this second", never a thrown exception inside the render loop.
 * Unknown kinds and malformed entries are dropped individually; a payload that
 * is not a list at all yields null so the caller can ignore the message
 * entirely and keep drawing the weather it already has.
 *
 * A non-positive radius is dropped rather than clamped: it is a system with no
 * extent, so there is nothing to draw and no honest value to invent for it.
 * Intensity IS clamped, because [0, 1] is a scale with two meaningful ends and
 * an out-of-range value states an intent the clamp can honour — the same rule
 * core applies to WORLD_DIFFICULTY (docs/DESIGN.md).
 */
export function parseSystemsPayload(payload: unknown): WeatherSystemState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const systems = (payload as { systems?: unknown }).systems;
  if (!Array.isArray(systems)) return null;

  const parsed: WeatherSystemState[] = [];
  for (const raw of systems) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<WeatherSystemState>;
    if (!isFiniteNumber(entry.id)) continue;
    if (!isWeatherKind(entry.kind)) continue;
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y)) continue;
    if (!isFiniteNumber(entry.radius) || entry.radius <= 0) continue;
    if (!isFiniteNumber(entry.intensity)) continue;
    if (!isFiniteNumber(entry.vx) || !isFiniteNumber(entry.vy)) continue;
    parsed.push({
      id: entry.id,
      kind: entry.kind,
      x: entry.x,
      y: entry.y,
      radius: entry.radius,
      intensity: Math.min(1, Math.max(0, entry.intensity)),
      vx: entry.vx,
      vy: entry.vy,
    });
  }
  return parsed;
}

// ────────────────────────────────────────────────────────────────────────────
// STRIKES (2026-08-24) — the one thing in this plugin that is an EVENT rather
// than a state.
//
// A system is a state: it exists, it has a position, and re-sending it is how a
// client stays right about it. A strike is an instant. It is broadcast once, on
// the tick it happens, and never re-sent — a client that missed one missed a
// flash, which is the correct amount to care.
//
// WHY IT IS ON THE WIRE AT ALL, when bolts used to be a client's own business:
// lightning now starts fires (plugins/fire), and a fire the server authorised
// under a bolt the client invented elsewhere is a forest burning under clear
// sky. See ./server/lightning.ts's header for the full argument.
// ────────────────────────────────────────────────────────────────────────────

/** Server → client, bolts that landed this tick (`weather:strikes`). */
export const WEATHER_STRIKES_MESSAGE = 'strikes';

/**
 * Hard bound on strikes in one message. MAX_ACTIVE_SYSTEMS is 3 and each rolls
 * at most one strike per tick, so 3 is the real ceiling; the constant exists so
 * the PARSER has a bound that does not depend on importing the server's sim
 * constants into the client's parse path.
 */
export const MAX_STRIKES_PER_MESSAGE = 8;

/**
 * Sentinel `systemId` for a bolt no weather system threw — a DRY strike out of
 * a clear sky (server/lightning.ts). System ids start at 1, so 0 can never
 * collide with a real one.
 *
 * On the client it is the difference between a bolt drawn as an offset from a
 * storm's rig and one drawn at a world position of its own: a dry strike has no
 * rig to belong to.
 */
export const STRIKE_NO_SYSTEM = 0;

/** One bolt: which system threw it (or STRIKE_NO_SYSTEM), and the cell it hit. */
export interface WeatherStrike {
  readonly systemId: number;
  readonly x: number;
  readonly y: number;
}

/** `weather:strikes` — flat `[systemId, x, y, …]`, msgpack's cheapest shape. */
export interface WeatherStrikesPayload {
  readonly strikes: readonly number[];
}

/** How many integers one strike occupies in the flat wire form. */
export const STRIKE_WIRE_STRIDE = 3;

export function packStrikes(strikes: Iterable<WeatherStrike>): number[] {
  const packed: number[] = [];
  for (const strike of strikes) packed.push(strike.systemId, strike.x, strike.y);
  return packed;
}

/**
 * Defensive parse, to this file's existing rule: malformed entries are dropped
 * individually, a payload that is not an array at all yields null so the caller
 * can ignore the message whole.
 */
export function parseStrikesPayload(payload: unknown): WeatherStrike[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const strikes = (payload as { strikes?: unknown }).strikes;
  if (!Array.isArray(strikes)) return null;

  const parsed: WeatherStrike[] = [];
  for (let i = 0; i + STRIKE_WIRE_STRIDE - 1 < strikes.length; i += STRIKE_WIRE_STRIDE) {
    if (parsed.length >= MAX_STRIKES_PER_MESSAGE) break;
    const systemId = strikes[i];
    const x = strikes[i + 1];
    const y = strikes[i + 2];
    if (!isFiniteNumber(systemId) || !isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) continue;
    parsed.push({ systemId, x, y });
  }
  return parsed;
}

/**
 * SUPERSEDED 2026-08-28 — kept because the reasoning below is still the reason
 * the ceiling exists, and only the NUMBER was wrong:
 *
 *   "Weather systems alive at once. THREE, and it is an aesthetic number before
 *   it is a bandwidth one — see the budget in ./index.ts, where three systems
 *   come to 2.4 kbit/s, i.e. 0.6% of what the wildlife plugin already spends.
 *   One system would make weather a single event a player either is in or is
 *   not. Three is the smallest number that can put a rain front over one coast,
 *   fog in a valley and clear sky in between — a SKY rather than an effect —
 *   while still leaving most of a 512² world clear at any moment, which is what
 *   keeps clear weather the default the owner's 'sun' asks for."
 *
 * WHAT WAS WRONG WITH IT. Three is a POPULATION, and a population says nothing
 * about whether a player sees weather; what a player experiences is COVERAGE —
 * the chance that the patch of world they are looking at is under a system —
 * and coverage is population × system area ÷ world area. Every number in the
 * paragraph above was chosen against the 128-world-unit world of 2026-08-14.
 * The shipped default is 512 world units, SIXTEEN TIMES the area, so the same
 * three discs cover a sixteenth as much of it. Measured on the sim (three
 * simulated hours, .weather-verify/sim-sweep.mjs):
 *
 *   128-unit world:  1.67 systems alive, a fixed point under weather 14.5% of
 *                    the time — the picture the paragraph above describes.
 *   512-unit world:  2.04 systems alive, a fixed point under weather  2.8% of
 *                    the time — about 100 seconds an hour, in bursts.
 *
 * 2.8% is why the owner reported seeing no weather at all (2026-08-28), and it
 * is why the 2026-08-14 retune of the spawn interval did not fix his first
 * report either: that retune moved the population, and the population was never
 * the thing that was too small.
 *
 * So the tuned quantity is coverage now (TARGET_SKY_COVERAGE_FRACTION) and the
 * population is derived from it (activeSystemCapFor). This constant keeps its
 * name and becomes what it always really was: the HARD CEILING the wire, the
 * draw calls and the storm lights are budgeted against.
 *
 * FOURTEEN. On the shipped 2048-cell world the coverage formula asks for 13.75
 * (corrected 2026-08-28 — an earlier comment said 10, before the equilibrium
 * occupancy was folded into the cap), so the ceiling sits exactly at what the
 * default world wants, with no headroom above it; every cost it caps is bounded
 * and small at 14: 14 × 97 B at 1 Hz is 11 kbit/s per client, still under 3% of
 * what the wildlife plugin spends; at most 14 particle columns and 4 fog sheets
 * each is ~70 draw calls; and lightning's photosensitivity floor is enforced by
 * ONE governor for the whole client (client/sky.ts), so more storms cannot make
 * the screen flash faster.
 *
 * RESIDUAL, NAMED: on any world larger than the shipped default the ceiling
 * binds before the coverage target is met — MAX_WORLD_SIZE is 4096 cells,
 * where the formula asks for 48 systems and gets 14, i.e. about 5% coverage
 * instead of 18% (figures corrected 2026-08-28; the earlier "24 and 10%"
 * were wrong). That is a self-hoster's deliberately huge world
 * getting a slightly emptier sky, which is a far better failure than 24 storm
 * lights; the fix if anyone ever wants it is bigger systems on bigger worlds,
 * not more of them.
 *
 * RESIDUAL, NAMED: a storm rig carries a PointLight, and adding or removing a
 * light recompiles every material's shader (see client/rig.ts). More systems
 * means more turnover, so that recompile lands more often — roughly once a
 * minute on the shipped world instead of once every three. It is a hitch, not a
 * leak, and moving the storm light out of the rig is a separate change.
 */
export const MAX_ACTIVE_SYSTEMS = 14;

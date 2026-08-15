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

/**
 * Decimal places kept on broadcast cell coordinates. 1/100 of a cell — four
 * orders of magnitude finer than the smallest system (24 cells across), far
 * below what any camera distance in this game can resolve, and it makes the
 * payload's encoded size bounded and exactly assertable in a test. Same value
 * and same reasoning as the wildlife and monsters plugins'.
 */
export const WEATHER_POSITION_DECIMALS = 2;

/**
 * Decimal places kept on broadcast intensity, which is a fraction in [0, 1]
 * rather than a distance — so 1/100 would be a visible quantisation of the
 * 30-second fade a system gathers over (0.03 of the ramp per broadcast at the
 * 1 Hz cadence). Three places is a thousandth of full strength, well under one
 * step of 8-bit alpha, so the fade reads as continuous.
 */
export const WEATHER_INTENSITY_DECIMALS = 3;

const POSITION_QUANTUM = 10 ** WEATHER_POSITION_DECIMALS;
const INTENSITY_QUANTUM = 10 ** WEATHER_INTENSITY_DECIMALS;

/** Rounds a cell-space coordinate (or a cells-per-second velocity) for the wire. */
export function roundBroadcastPosition(value: number): number {
  return Math.round(value * POSITION_QUANTUM) / POSITION_QUANTUM;
}

/** Rounds an intensity for the wire and clamps it into [0, 1]. */
export function roundBroadcastIntensity(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * INTENSITY_QUANTUM) / INTENSITY_QUANTUM;
}

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

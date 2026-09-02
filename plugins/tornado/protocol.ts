// tornado — the wire contract between the plugin's two halves, and the
// vocabulary its per-world settings are written in.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free — the plugin-local equivalent of
// @terrace/shared.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FICTION (issue #213, owner 2026-08-26).
//
// A TORNADO IS SMALL, FAST, LAND-ONLY AND OVER IN A MINUTE. It drops out of a
// thunderstorm cell, so it cannot exist where the sky is clear, and water kills
// it in about four seconds — which is what "land-only" means here, expressed as
// a rate rather than as a teleport to death.
//
// ITS SIBLING, THE CYCLONE, IS A SEPARATE PLUGIN since the 2026-09-02
// decomposition (#283). The two were one plugin over one parametric sim, and
// the sim survives — it is now core's plugin kit (server/src/plugins/kit/
// rotatingStorms.ts), which this plugin holds one instance of. What was a
// `kind` field in a shared table is now the identity of the folder.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT TRAVELS. The funnels themselves — a centre, a radius, an intensity and a
// velocity — and nothing else. No debris, no cloud, no funnel geometry: every
// one of those is invented on the client out of these few numbers plus the frame
// clock. A tornado is ~90 B on the wire and there are at most MAX_ACTIVE of
// them.
//
// THIS BROADCAST IS FOG-OF-WAR FILTERED (WorldApi.broadcastVisible), where the
// sky plugins' unfiltered system lists are not, and the difference is
// information: a front's position is a function of RNG and the shared wind
// alone, so it says nothing about locked terrain; a tornado only ever walks on
// land, so "there is a tornado at (x, y)" IS a statement about the ground there.

// The one import this file allows itself: every measurement below is a fact
// about the WORLD, and @terrace/shared owns the world's own scale.
import { cellsAcross } from '@terrace/shared';

/** Plugin name on both sides. Also the message namespace. */
export const TORNADO_PLUGIN_NAME = 'tornado';

/**
 * Un-namespaced type of the server → client push (`tornado:all`).
 *
 * ONE MESSAGE TYPE CARRYING FULL STATE, the choice every position-bearing plugin
 * here has made, for the same self-healing reason: a dropped message costs one
 * broadcast interval of staleness and there is no delta stream to desynchronise.
 *
 * AN EMPTY LIST IS MEANINGFUL and is sent just as faithfully as a populated one:
 * it is how a client learns the funnel it was watching has died, or has walked
 * out of the territory it can see. That is why the server sends this with
 * `skipEmpty: false`.
 */
export const TORNADO_ALL_MESSAGE = 'all';

/**
 * Un-namespaced type of the wind-damage WORLD EVENT (`tornado:damage`) — a
 * server-side fan-out to sibling plugins, NEVER a client message.
 *
 * WHO IS EXPECTED TO READ IT (issue #213): structures (roofs off, then walls),
 * flora (trees down), wildlife (scattered) and fire (fanned by the wind). NONE
 * OF THEM CONSUME IT TODAY — this is the seam those follow-ups attach to, and
 * emitting it costs one fan-out per funnel per second. The payload is the kit
 * engine's own damage record (RotatingStormDamage): where the funnel is, what it
 * covers, how hard it is blowing, and a bounded SAMPLE of struck cells for a
 * consumer with no spatial index.
 */
export const TORNADO_DAMAGE_EVENT = 'damage';

// ─────────────────────────────────────────────────────────────────────────────
// THE PER-WORLD SETTING.

/** Key of the frequency setting (WorldApi.setting). */
export const TORNADO_FREQUENCY_SETTING_KEY = 'tornado-frequency';

/**
 * How often tornadoes arrive, as the operator chooses it.
 *
 * A CLOSED SET, because that is what PluginSettingDeclaration is for: core
 * validates the value off the wire and renders a control for it without knowing
 * what any of these mean. `off` is a real value and not the absence of a row — a
 * self-hoster who wants a world with weather but no tornadoes says so.
 */
export const TORNADO_FREQUENCIES = ['off', 'rare', 'common'] as const;
export type TornadoFrequency = (typeof TORNADO_FREQUENCIES)[number];

/**
 * In force where the world file has no row.
 *
 * `rare`, not `common`, and not `off`: a tornado rewrites nothing permanent, so
 * shipping it on is safe, but a world that grows one every couple of minutes is
 * a world about tornadoes. Rare is the setting that makes one an event.
 */
export const DEFAULT_TORNADO_FREQUENCY: TornadoFrequency = 'rare';

/**
 * What the operator's frequency setting does to the difficulty-derived mean
 * interval.
 *
 * A MULTIPLIER ON THE INTERVAL, not a replacement for it, so the two dials
 * COMPOSE: difficulty says what kind of world this is, and the setting says how
 * much of this particular mechanic the operator wants in it. `rare` (the
 * default) doubles the wait and `common` halves it, which is a four-fold spread
 * either side of the difficulty curve — wide enough to be worth choosing,
 * narrow enough that difficulty still means something at both ends.
 *
 * `off` has no entry: it is handled before any rate arithmetic runs, because
 * "an infinitely long mean interval" is a thing this table cannot express and a
 * `0` here would read as "instantly".
 */
export const FREQUENCY_INTERVAL_MULTIPLIERS: Readonly<Record<'rare' | 'common', number>> = {
  rare: 2,
  common: 0.5,
};

/**
 * Parses a setting value the host handed back, falling back to the default for
 * an absent or unrecognised one.
 *
 * `undefined` means "this world has no opinion" (WorldApi.setting), and an
 * unrecognised STRING should be impossible — core validates against the declared
 * `values` before persisting a row — so the fallback is belt and suspenders
 * against a hand-edited world file rather than an expected path.
 */
export function parseFrequency(value: string | undefined): TornadoFrequency {
  return TORNADO_FREQUENCIES.includes(value as TornadoFrequency)
    ? (value as TornadoFrequency)
    : DEFAULT_TORNADO_FREQUENCY;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF A FUNNEL, IN THE UNITS BOTH HALVES MEASURE IN.
//
// These live here rather than beside the sim because BOTH HALVES HAVE A STAKE IN
// THEM: the server damages a disc of this radius, and the client draws a funnel
// sized against that same disc. Two copies of "how big is a tornado" would
// drift, and the way they would drift is silent — a funnel that no longer covers
// the ground the wind is flattening still renders, it just lies.

/**
 * World units one terrace band rises.
 *
 * IMPORTED, NOT RESTATED — this plugin's vertical measurements are in the same
 * units the client's relief is, and @terrace/shared owns that scale (a plugin
 * can import it from either half, where client/src/config.ts is unreachable
 * from a server file). Re-exported here so nothing that reads it from this
 * protocol has to know where it came from.
 */
export { WORLD_UNITS_PER_BAND } from '@terrace/shared';

/**
 * A tornado's radius, in cells — how much ground the funnel's damage covers.
 *
 * ONE AND A HALF WORLD UNITS, so the vortex is three across: a thing that fits
 * between two buildings, which is what makes a tornado read as a tornado rather
 * than as a small hurricane. Written through `cellsAcross` because it is a
 * length of GROUND and not a count of samples — the 2026-08-21 re-sample is on
 * record for what happens to distances written as raw cell counts.
 */
export const TORNADO_RADIUS_CELLS = cellsAcross(1.5);

/**
 * How tall a funnel stands, in world units.
 *
 * SIX, against a world whose entire relief is 16 — so a funnel reaches from the
 * ground to well above the highest land, which is where the cloud it hangs from
 * has to be for the picture to make sense. It is deliberately NOT derived from
 * the world's relief: a funnel's height is set by where the cloud base is, and
 * the cloud base does not move when somebody flattens a mountain.
 */
export const TORNADO_HEIGHT_WORLD_UNITS = 6;

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRE.
//
// The rotating-storm wire form lives in @terrace/shared (shared/src/
// rotatingStormWire.ts), where the disc-systems form went for the same reason:
// two plugins send the identical payload and neither may import the other's
// protocol. Re-exported here so this file stays the one wire contract this
// plugin's halves both import.
//
// The UNBOUNDED position form: a funnel may walk off the edge of the map, so
// there is no cell for shared's `roundBroadcastCell` to keep it inside of.
export {
  BROADCAST_POSITION_DECIMALS,
  parseRotatingStormsPayload as parseAllPayload,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type RotatingStormState as TornadoState,
  type RotatingStormsPayload as TornadoAllPayload,
} from '@terrace/shared';
export { BROADCAST_INTENSITY_DECIMALS as TORNADO_INTENSITY_DECIMALS } from '@terrace/shared';

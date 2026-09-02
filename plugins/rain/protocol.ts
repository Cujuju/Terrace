// rain — the wire contract between the plugin's two halves.
//
// This module is imported by BOTH server/ and client/ and must therefore stay
// dependency-free (no three, no node builtins) and side-effect-free.
//
// Namespacing: the hosts prefix `rain:` on the wire in both directions, so every
// name here is the UN-namespaced form (see server/src/plugins/host.ts and
// client/src/plugins/host.ts).
//
// WHAT TRAVELS, AND WHAT DOES NOT. The server sends the SYSTEMS — a handful of
// large coherent masses, each a disc with a centre, a radius, an intensity and
// the wind it is riding. It does not send a single raindrop: every drop is
// invented on the client out of these few numbers plus the frame clock
// (client/rig.ts). That split is the whole reason a system costs ~90 B instead
// of a particle stream.
//
// THE PAYLOAD SHAPE ITSELF is @terrace/shared's (shared/src/discWire.ts): four
// plugins broadcast the identical disc list, and a plugin may not import another
// plugin's protocol. Re-exported here so this file stays the one wire contract
// this plugin's two halves both import.

export {
  parseDiscSystemsPayload,
  type DiscSystemState,
  type DiscSystemsPayload,
} from '@terrace/shared';

/** Plugin name on both sides. Also the message namespace. */
export const RAIN_PLUGIN_NAME = 'rain';

/**
 * Un-namespaced type of the server → client push (`rain:systems`).
 *
 * There is exactly one message type and it carries FULL state every time — the
 * same choice the wildlife and monsters plugins made, for the same self-healing
 * reasons, and here it is nearly free: the list holds at most
 * MAX_ACTIVE_SYSTEMS entries.
 *
 * AN EMPTY LIST IS MEANINGFUL and is broadcast just as faithfully as a populated
 * one: an empty list IS the clear sky. There is no "rain ended" message, because
 * "no system covers you" is the only definition of clear that cannot disagree
 * with the systems themselves. A despawn signalled only by the absence of a
 * message would leave a client that was watching a front rendering it forever.
 */
export const RAIN_SYSTEMS_MESSAGE = 'systems';

/**
 * THE NUMBER THIS PLUGIN IS TUNED ON: the fraction of the map expected to be
 * under rain once the sky has reached equilibrium. The population is DERIVED
 * from it (server/src/plugins/kit/discSystems.ts), so a bigger world gets more
 * fronts rather than a thinner sky.
 *
 * 0.09 — rain's half of the 0.18 the one weather plugin was tuned on before the
 * 2026-09-02 split, from the kind weights it drew with (rain 5, storm 2, snow
 * 1.5, fog 1.5; total 10, so rain's share is 5/10 × 0.18 = 0.09). The four
 * shares still sum to 0.18, so the sky as a whole is the sky the owner signed
 * off on; what changed is that each kind now carries its own share, so deleting
 * one removes that kind's weather instead of redistributing it.
 */
export const RAIN_COVERAGE_FRACTION = 0.09;

/**
 * Hard ceiling on rain systems alive at once — what the wire, the draw calls and
 * the buffers are budgeted against.
 *
 * SEVEN, which is what the coverage formula asks for on the shipped 2048-cell
 * world at this share (the pre-split plugin's ceiling was 14 at 0.18 coverage,
 * and 5/10 of 13.75 rounds to 7). So the ceiling sits exactly at what the
 * default world wants, with no headroom above it, and the four kinds' ceilings
 * still add to the 14 the pre-split plugin capped the whole sky at.
 *
 * RESIDUAL, NAMED: on any world larger than the shipped default the ceiling
 * binds before the coverage target is met — the same residual the pre-split
 * plugin carried, in the same direction: a self-hoster's deliberately huge world
 * gets a slightly emptier sky.
 */
export const MAX_ACTIVE_SYSTEMS = 7;

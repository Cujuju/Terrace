// fog — the wire contract between the plugin's two halves.
//
// This module is imported by BOTH server/ and client/ and must therefore stay
// dependency-free (no three, no node builtins) and side-effect-free.
//
// Namespacing: the hosts prefix `fog:` on the wire in both directions, so every
// name here is the UN-namespaced form.
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
export const FOG_PLUGIN_NAME = 'fog';

/**
 * Un-namespaced type of the server → client push (`fog:systems`). Full state
 * every time; an EMPTY LIST IS MEANINGFUL and is the clear sky — see rain's
 * protocol for the whole argument, which is the same one.
 */
export const FOG_SYSTEMS_MESSAGE = 'systems';

/**
 * THE NUMBER THIS PLUGIN IS TUNED ON: the fraction of the map expected to be
 * under fog once the sky has reached equilibrium. The population is DERIVED from
 * it (server/src/plugins/kit/discSystems.ts).
 *
 * 0.027 — fog's share of the 0.18 the one weather plugin was tuned on before the
 * 2026-09-02 split, from the kind weights it drew with (rain 5, storm 2, snow
 * 1.5, fog 1.5; total 10, so fog's share is 1.5/10 × 0.18 = 0.027). The four
 * shares still sum to 0.18.
 */
export const FOG_COVERAGE_FRACTION = 0.027;

/**
 * Hard ceiling on fog systems alive at once — what the wire, the draw calls and
 * the buffers are budgeted against.
 *
 * TWO, which is what the coverage formula asks for on the shipped 2048-cell
 * world at this share (the pre-split plugin's ceiling was 14 at 0.18 coverage,
 * and 1.5/10 of 13.75 rounds to 2). The four kinds' ceilings still add to the 14
 * the pre-split plugin capped the whole sky at.
 */
export const MAX_ACTIVE_SYSTEMS = 2;

// snow — the wire contract between the plugin's two halves.
//
// This module is imported by BOTH server/ and client/ and must therefore stay
// dependency-free (no three, no node builtins) and side-effect-free.
//
// Namespacing: the hosts prefix `snow:` on the wire in both directions, so every
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
export const SNOW_PLUGIN_NAME = 'snow';

/**
 * Un-namespaced type of the server → client push (`snow:systems`). Full state
 * every time; an EMPTY LIST IS MEANINGFUL and is the clear sky — see rain's
 * protocol for the whole argument, which is the same one.
 */
export const SNOW_SYSTEMS_MESSAGE = 'systems';

/**
 * THE NUMBER THIS PLUGIN IS TUNED ON: the fraction of the map expected to be
 * under snow once the sky has reached equilibrium. The population is DERIVED
 * from it (server/src/plugins/kit/discSystems.ts).
 *
 * 0.027 — snow's share of the 0.18 the one weather plugin was tuned on before
 * the 2026-09-02 split, from the kind weights it drew with (rain 5, storm 2,
 * snow 1.5, fog 1.5; total 10, so snow's share is 1.5/10 × 0.18 = 0.027). The
 * four shares still sum to 0.18.
 *
 * REALISED SHARE IS LOWER ON A LOW WORLD, and always was: snow additionally has
 * to find high ground (server/siting.ts), so on a flat world this coverage is an
 * upper bound and on an alpine one it is exactly this number.
 */
export const SNOW_COVERAGE_FRACTION = 0.027;

/**
 * Hard ceiling on snow systems alive at once — what the wire, the draw calls and
 * the buffers are budgeted against.
 *
 * TWO, which is what the coverage formula asks for on the shipped 2048-cell
 * world at this share (the pre-split plugin's ceiling was 14 at 0.18 coverage,
 * and 1.5/10 of 13.75 rounds to 2). The four kinds' ceilings still add to the 14
 * the pre-split plugin capped the whole sky at.
 */
export const MAX_ACTIVE_SYSTEMS = 2;

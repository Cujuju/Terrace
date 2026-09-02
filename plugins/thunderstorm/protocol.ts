// thunderstorm — the wire contract between the plugin's two halves.
//
// This module is imported by BOTH server/ and client/ and must therefore stay
// dependency-free (no three, no node builtins) and side-effect-free.
//
// Namespacing: the hosts prefix `thunderstorm:` on the wire in both directions,
// so every name here is the UN-namespaced form.
//
// THE SYSTEMS PAYLOAD is @terrace/shared's (shared/src/discWire.ts): four plugins
// broadcast the identical disc list, and a plugin may not import another
// plugin's protocol. THE STRIKES PAYLOAD is this plugin's own — nothing else in
// the game throws lightning — and is defined below.
//
// NAMED `thunderstorm`, not `storm`: the `storms` plugin next door means
// tornadoes and cyclones, and one word for two unrelated things is how a
// consumer ends up subscribed to the wrong one.

export {
  parseDiscSystemsPayload,
  type DiscSystemState,
  type DiscSystemsPayload,
} from '@terrace/shared';

import { isFiniteNumber } from '@terrace/shared';

/** Plugin name on both sides. Also the message namespace. */
export const THUNDERSTORM_PLUGIN_NAME = 'thunderstorm';

/**
 * Un-namespaced type of the server → client push (`thunderstorm:systems`). Full
 * state every time; an EMPTY LIST IS MEANINGFUL and is the clear sky — see
 * rain's protocol for the whole argument, which is the same one.
 */
export const THUNDERSTORM_SYSTEMS_MESSAGE = 'systems';

/**
 * THE NUMBER THIS PLUGIN IS TUNED ON: the fraction of the map expected to be
 * under a thunderstorm once the sky has reached equilibrium. The population is
 * DERIVED from it (server/src/plugins/kit/discSystems.ts).
 *
 * 0.036 — the storm share of the 0.18 the one weather plugin was tuned on before
 * the 2026-09-02 split, from the kind weights it drew with (rain 5, storm 2,
 * snow 1.5, fog 1.5; total 10, so the storm share is 2/10 × 0.18 = 0.036). The
 * four shares still sum to 0.18.
 *
 * IT IS THE RAREST WETTING KIND on purpose: lightning is the one thing here with
 * a photosensitivity budget attached (client/lightning.ts).
 */
export const THUNDERSTORM_COVERAGE_FRACTION = 0.036;

/**
 * Hard ceiling on thunderstorms alive at once — what the wire, the draw calls,
 * the flash lights and the buffers are budgeted against.
 *
 * THREE, which is what the coverage formula asks for on the shipped 2048-cell
 * world at this share (the pre-split plugin's ceiling was 14 at 0.18 coverage,
 * and 2/10 of 13.75 rounds to 3). The four kinds' ceilings still add to the 14
 * the pre-split plugin capped the whole sky at.
 *
 * It is also the size of the flash-light bank (client/lightning.ts): at a
 * ceiling of 3, every storm that can exist can have a light, where the pre-split
 * plugin's bank of 4 against a ceiling of 14 left most storms unlit.
 */
export const MAX_ACTIVE_SYSTEMS = 3;

// ────────────────────────────────────────────────────────────────────────────
// STRIKES — the one thing in this plugin that is an EVENT rather than a state.
//
// A system is a state: it exists, it has a position, and re-sending it is how a
// client stays right about it. A strike is an instant. It is broadcast once, on
// the tick it happens, and never re-sent — a client that missed one missed a
// flash, which is the correct amount to care.
//
// WHY IT IS ON THE WIRE AT ALL, when bolts used to be a client's own business:
// lightning starts fires (plugins/fire), and a fire the server authorised under
// a bolt the client invented elsewhere is a forest burning under clear sky. See
// server/lightning.ts's header for the full argument.
// ────────────────────────────────────────────────────────────────────────────

/** Server → client, bolts that landed this tick (`thunderstorm:strikes`). */
export const THUNDERSTORM_STRIKES_MESSAGE = 'strikes';

/**
 * Hard bound on strikes in one message. MAX_ACTIVE_SYSTEMS is 3 and each rolls
 * at most one strike per tick, so 4 (with the dry bolt) is the real ceiling; the
 * constant exists so the PARSER has a bound that does not depend on importing
 * the server's sim constants into the client's parse path.
 */
export const MAX_STRIKES_PER_MESSAGE = 8;

/**
 * Sentinel `systemId` for a bolt no system threw — a DRY strike out of a clear
 * sky (server/lightning.ts). System ids start at 1, so 0 can never collide with
 * a real one.
 *
 * On the client it is the difference between a bolt drawn as an offset from a
 * storm's rig and one drawn at a world position of its own: a dry strike has no
 * rig to belong to.
 */
export const STRIKE_NO_SYSTEM = 0;

/** One bolt: which system threw it (or STRIKE_NO_SYSTEM), and the cell it hit. */
export interface ThunderstormStrike {
  readonly systemId: number;
  readonly x: number;
  readonly y: number;
}

/** `thunderstorm:strikes` — flat `[systemId, x, y, …]`, msgpack's cheapest shape. */
export interface ThunderstormStrikesPayload {
  readonly strikes: readonly number[];
}

/** How many integers one strike occupies in the flat wire form. */
export const STRIKE_WIRE_STRIDE = 3;

export function packStrikes(strikes: Iterable<ThunderstormStrike>): number[] {
  const packed: number[] = [];
  for (const strike of strikes) packed.push(strike.systemId, strike.x, strike.y);
  return packed;
}

/**
 * Defensive parse, to this file's existing rule: malformed entries are dropped
 * individually, a payload that is not an array at all yields null so the caller
 * can ignore the message whole.
 */
export function parseStrikesPayload(payload: unknown): ThunderstormStrike[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const strikes = (payload as { strikes?: unknown }).strikes;
  if (!Array.isArray(strikes)) return null;

  const parsed: ThunderstormStrike[] = [];
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

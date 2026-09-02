// The wire form of a DRIFTING DISC — a coherent mass with a centre, a radius, a
// strength and the velocity it is riding.
//
// WHY IT IS HERE AND NOT IN A PLUGIN'S protocol.ts. Four plugins (rain,
// thunderstorm, snow, fog) each broadcast this exact payload, and a plugin may
// not import another plugin's protocol — a plugin folder is deletable, and a
// wire contract that resolved through a neighbour would turn "I removed fog"
// into "rain no longer parses". Before the 2026-09-02 decomposition there was
// one plugin and one copy; afterwards there would have been four copies of one
// defensive parser, which is the shape #180 already moved out of five plugins
// (see ./wire.ts). The precision of a broadcast value, and the validation of
// one, are properties of the PROTOCOL — which is what this package is the
// single source of truth for.
//
// WHAT IS NOT HERE: the message NAME. That is namespaced per plugin by the host
// (`rain:systems`, `fog:systems`), so it belongs to the plugin that sends it.
// This module only says what one entry in the list looks like.

import { isFiniteNumber } from './parse.ts';

/**
 * One disc, as it appears on the wire.
 *
 * There is no `kind` field. Until 2026-09-02 one plugin carried four kinds on
 * one message and had to say which; now the message itself is namespaced by the
 * plugin that sends it, so a kind field would be a second, weaker copy of the
 * name already in the message type.
 */
export interface DiscSystemState {
  /** Stable for the disc's whole life; a client keys interpolation by it. */
  readonly id: number;
  /**
   * Cell-space centre of the mass (fractional). World X/Z, since
   * CELL_WORLD_SIZE is 1. It may legitimately sit OUTSIDE the world — a disc
   * drifts in from off the map and out the other side.
   */
  readonly x: number;
  readonly y: number;
  /** Cell-space radius of the mass. Constant for a disc's whole life. */
  readonly radius: number;
  /**
   * Strength in [0, 1]: 0 is nothing at all, 1 is the heaviest this sender
   * gets. It ramps up as the mass gathers and back down as it dissipates, so a
   * disc is never seen appearing or vanishing — which is why a client needs no
   * fade envelope of its own.
   */
  readonly intensity: number;
  /**
   * The velocity this disc is riding, in cells per second.
   *
   * ON THE WIRE PER DISC even where every disc rides one shared wind, for two
   * reasons. A client uses it as a DIRECTION, not only as a speed —
   * precipitation shears downwind and streaks lean along a drop's actual
   * velocity — so it would have to be sent whatever the model. And a per-disc
   * drift is a change a sim could plausibly make; a field that already exists
   * absorbs it, where one global velocity on the message would have to move.
   */
  readonly vx: number;
  readonly vy: number;
}

export interface DiscSystemsPayload {
  readonly systems: readonly DiscSystemState[];
}

/**
 * Defensive parse of a received disc list.
 *
 * A client trusts the server, but "trusts" is not "assumes well-formed": a
 * version skew between a self-hoster's server and a cached client bundle is a
 * completely ordinary event, and the right failure mode is "one disc is missing
 * this second", never a thrown exception inside the render loop. Malformed
 * entries are dropped individually; a payload that is not a list at all yields
 * null so the caller can ignore the message entirely and keep drawing what it
 * already has.
 *
 * A non-positive radius is dropped rather than clamped: it is a mass with no
 * extent, so there is nothing to draw and no honest value to invent for it.
 * Intensity IS clamped, because [0, 1] is a scale with two meaningful ends and
 * an out-of-range value states an intent the clamp can honour — the same rule
 * core applies to WORLD_DIFFICULTY (docs/DESIGN.md).
 */
export function parseDiscSystemsPayload(payload: unknown): DiscSystemState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const systems = (payload as { systems?: unknown }).systems;
  if (!Array.isArray(systems)) return null;

  const parsed: DiscSystemState[] = [];
  for (const raw of systems) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<DiscSystemState>;
    if (!isFiniteNumber(entry.id)) continue;
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y)) continue;
    if (!isFiniteNumber(entry.radius) || entry.radius <= 0) continue;
    if (!isFiniteNumber(entry.intensity)) continue;
    if (!isFiniteNumber(entry.vx) || !isFiniteNumber(entry.vy)) continue;
    parsed.push({
      id: entry.id,
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

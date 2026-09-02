// The wire form of a ROTATING STORM — an eye with a radius, a strength, the
// velocity it is tracking on, and sometimes a name.
//
// WHY IT IS HERE AND NOT IN A PLUGIN'S protocol.ts, which is ./discWire.ts's
// reason exactly. Two plugins (tornado, cyclone) each broadcast this same
// payload since the 2026-09-02 split, and a plugin may not import another
// plugin's protocol — a plugin folder is deletable, and a wire contract that
// resolved through a neighbour would turn "I removed cyclone" into "tornado no
// longer parses". Before the split there was one plugin and one copy;
// afterwards there would have been two copies of one defensive parser, which is
// the shape #180 already moved out of five plugins (see ./wire.ts). The
// precision of a broadcast value, and the validation of one, are properties of
// the PROTOCOL — which is what this package is the single source of truth for.
//
// WHAT IS NOT HERE: the message NAME (`tornado:all`, `cyclone:all`), which the
// host namespaces per plugin, and every measurement that differs between the
// two kinds — a funnel's height, a cyclone's eye fraction and deck height are
// each one plugin's business and live in that plugin's protocol.ts.

import { isFiniteNumber } from './parse.ts';

/**
 * One rotating storm, as it appears on the wire.
 *
 * There is no `kind` field. Until 2026-09-02 one plugin carried two kinds on one
 * message and had to say which; now the message itself is namespaced by the
 * plugin that sends it, so a kind field would be a second, weaker copy of the
 * name already in the message type.
 */
export interface RotatingStormState {
  /** Stable for the storm's whole life; the client keys its renderers by it. */
  readonly id: number;
  /**
   * Cell-space centre (fractional). It may legitimately sit OUTSIDE the world —
   * a cyclone is born over the sea beyond the coast and drifts in.
   */
  readonly x: number;
  readonly y: number;
  /** Cell-space radius. Constant for a storm's whole life. */
  readonly radius: number;
  /**
   * Strength in [0, 1]. It ramps up as the storm spins up and back down as it
   * dies, so a storm is never seen appearing or vanishing and the client needs
   * no fade envelope of its own.
   */
  readonly intensity: number;
  /** Cells per second, as a velocity — the client extrapolates between pushes. */
  readonly vx: number;
  readonly vy: number;
  /**
   * `Hurricane Ada`, for a storm whose sender names its storms; absent
   * otherwise.
   *
   * BUILT SERVER-SIDE AND SENT WHOLE rather than sent as a basin plus an index
   * for the client to join: it is a label, it is written once per storm, and the
   * alternative is two fields and a formatting rule duplicated on both sides.
   */
  readonly name?: string;
}

/** The `<plugin>:all` payload. */
export interface RotatingStormsPayload {
  readonly storms: readonly RotatingStormState[];
}

function parseOne(value: unknown): RotatingStormState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, x, y, radius, intensity, vx, vy, name } = value as Record<string, unknown>;
  if (!Number.isInteger(id)) return null;
  for (const number of [x, y, radius, intensity, vx, vy]) {
    if (!isFiniteNumber(number)) return null;
  }
  if (name !== undefined && typeof name !== 'string') return null;
  return {
    id: id as number,
    x: x as number,
    y: y as number,
    radius: radius as number,
    intensity: intensity as number,
    vx: vx as number,
    vy: vy as number,
    ...(typeof name === 'string' ? { name } : {}),
  };
}

/**
 * Defensive parse of a received storm list.
 *
 * A BAD PAYLOAD IS DROPPED WHOLE — one malformed entry rejects the message, and
 * the caller keeps rendering what it already has until the next good one, which
 * is one broadcast interval away. That is the rule this list has always been
 * parsed under, and it differs from ./discWire.ts's per-entry drop for a reason
 * worth keeping: there are at most a handful of storms and each one is a large,
 * named event, so silently rendering "the two of the three that parsed" would
 * show a world that is missing a hurricane rather than one that is a beat stale.
 */
export function parseRotatingStormsPayload(payload: unknown): RotatingStormsPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { storms } = payload as Record<string, unknown>;
  if (!Array.isArray(storms)) return null;
  const parsed: RotatingStormState[] = [];
  for (const value of storms) {
    const storm = parseOne(value);
    if (storm === null) return null;
    parsed.push(storm);
  }
  return { storms: parsed };
}

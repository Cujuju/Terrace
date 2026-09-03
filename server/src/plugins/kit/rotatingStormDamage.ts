// THE CONSUMER'S HALF of the rotating-storm damage event — one structural
// parser and one severity model, for every plugin that reacts to a storm it
// does not own.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS IN CORE'S KIT AND NOT COPIED INTO EACH CONSUMER.
//
// The repo's standing rule is that cross-plugin agreement travels as a
// DOCUMENTED COPY rather than an import (server/src/plugins/types.ts's
// emitEvent doc comment; plugins/wildlife/server/fire-event.ts is the pattern).
// That rule is about a plugin depending on a NEIGHBOUR, and it is untouched
// here: nothing below names cyclone, imports cyclone, or knows that cyclone
// exists. The EVENT NAME — the whole of the by-name coupling — stays a string
// constant in each consumer's own `cyclone-event.ts`, exactly as the rule
// requires.
//
// What is shared is the payload SHAPE, and the shape is not a neighbour's: it
// is `RotatingStormDamage`, declared in ./rotatingStorms.ts, which is core's.
// A consumer restating it would be restating CORE's type — the thing
// plugins/structures/server/rng.ts's header explicitly rules out ("the 'own
// copy per plugin' rule is about a plugin depending on a NEIGHBOUR; shared/ is
// core"). It would also be restated four times over for the two owners the kit
// already has (cyclone, tornado), which is the same field list drifting in four
// places for no gain a plugin could ever observe.
//
// A CONSUMER STILL BUILDS AND TESTS WITH EVERY OTHER PLUGIN DELETED. This file
// is deleted only when the server is.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A SEVERITY MODEL LIVES HERE AT ALL.
//
// An event carries at most ROTATING_STORM_DAMAGE_SAMPLE_CELLS struck cells,
// and that list is a SAMPLE for consumers with no spatial index, not an
// enumeration — the engine says so where it declares the constant. Every
// consumer this repo has (a forest, a board of buildings, a fleet) owns an
// index of its own and is expected to read `x`/`y`/`radius` and answer the
// question exactly. To do that it needs a severity at an arbitrary cell, and
// the emitter's own wind profile is private to the emitter.
//
// So this states the COARSEST model consistent with what the payload itself
// guarantees, and nothing beyond it:
//
//   * `intensity` is "the ceiling on any cell's severity" (the field's doc);
//   * `eyeRadius` is "the calm middle the wind does NOT cover" — zero inside;
//   * `radius` is "the disc the wind covers" — zero outside;
//   * between them the wind falls off monotonically from the eyewall to the rim.
//
// A straight ramp is the only curve those four statements pin down. It happens
// to be EXACTLY the shipped cyclone profile ((1 - r) / (1 - eye), sim.ts), so
// today this is not an approximation at all; for a future owner whose falloff
// curves differently it stays bounded by the invariants above and the error is
// in how HARD a consumer reacts, never in WHERE. That is the honest trade
// against the alternative — publishing the emitter's profile function on the
// wire so consumers could evaluate a neighbour's curve, which is the import
// coupling this whole contract exists to avoid.

import { isFiniteNumber } from '@terrace/shared';
import { ROTATING_STORM_DAMAGE_SAMPLE_CELLS } from './rotatingStorms.ts';

/**
 * Defensive bound on how many struck cells one event may carry.
 *
 * The engine sends ROTATING_STORM_DAMAGE_SAMPLE_CELLS (12) and no honest event
 * exceeds it; this is that number with two orders of magnitude of headroom, so
 * that raising the sample never silently truncates an honest payload here while
 * a malformed or hostile one still cannot make a consumer walk an unbounded
 * list. It is derived from the engine's own constant rather than written as a
 * round figure, so it tracks the sample if the sample ever moves.
 */
export const MAX_DAMAGE_SAMPLE_CELLS_PER_EVENT = ROTATING_STORM_DAMAGE_SAMPLE_CELLS * 100;

/** One cell the wind struck, as a consumer reads it. */
export interface StruckCell {
  readonly x: number;
  readonly y: number;
  readonly severity: number;
}

/**
 * A storm's wind damage, as a consumer reads it — the same fields
 * `RotatingStormDamage` declares, having survived a structural parse.
 */
export interface ParsedStormDamage {
  readonly stormId: number;
  /** The eye, in cells. */
  readonly x: number;
  readonly y: number;
  /** The disc the wind covers, in cells. */
  readonly radius: number;
  /** The calm middle the wind does not cover. 0 for a profile with no eye. */
  readonly eyeRadius: number;
  /** The storm's strength in [0, 1] — the ceiling on any cell's severity. */
  readonly intensity: number;
  /** Seconds of storm this event accounts for, so a rate can be recovered. */
  readonly durationSeconds: number;
  /** The emitter's bounded sample of struck cells. */
  readonly cells: readonly StruckCell[];
}

/** A length in cells: finite and never negative. */
function isExtent(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

/** A fraction the emitter states in [0, 1]. Out-of-range is a malformed event. */
function isFraction(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function parseStruckCells(value: unknown): StruckCell[] | null {
  if (!Array.isArray(value)) return null;
  const cells: StruckCell[] = [];
  for (const item of value) {
    if (cells.length >= MAX_DAMAGE_SAMPLE_CELLS_PER_EVENT) break;
    if (typeof item !== 'object' || item === null) continue;
    const { x, y, severity } = item as { x?: unknown; y?: unknown; severity?: unknown };
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFraction(severity)) continue;
    cells.push({ x, y, severity });
  }
  return cells;
}

/**
 * The storm behind a damage event, or null if the payload is not that shape.
 *
 * NULL AND EMPTY ARE DIFFERENT ANSWERS, on the rule every parser in this repo
 * keeps (plugins/fire/server/strike-event.ts): null means "this is not a
 * message I understand" — a version mismatch, a hostile emitter — and a struck
 * list that parses to empty means "the sample found nothing". A consumer that
 * conflated them would silently stop reacting on the day the emitter's payload
 * changed shape.
 *
 * A ZERO-RADIUS STORM IS REFUSED rather than parsed: every severity under it is
 * zero by definition, so it is an event about nothing, and letting it through
 * would put a division by zero one careless caller away.
 */
export function parseStormDamage(payload: unknown): ParsedStormDamage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { stormId, x, y, radius, eyeRadius, intensity, durationSeconds, cells } = payload as {
    stormId?: unknown;
    x?: unknown;
    y?: unknown;
    radius?: unknown;
    eyeRadius?: unknown;
    intensity?: unknown;
    durationSeconds?: unknown;
    cells?: unknown;
  };

  if (!isFiniteNumber(stormId)) return null;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (!isExtent(radius) || radius <= 0) return null;
  if (!isExtent(eyeRadius) || eyeRadius >= radius) return null;
  if (!isFraction(intensity)) return null;
  if (!isExtent(durationSeconds)) return null;

  const struck = parseStruckCells(cells);
  if (struck === null) return null;

  return { stormId, x, y, radius, eyeRadius, intensity, durationSeconds, cells: struck };
}

/**
 * How hard the wind is blowing at one cell, in [0, `intensity`] — see this
 * file's header for what this model is and is not.
 *
 * Takes a cell rather than a distance so no caller has to remember to measure
 * from the EYE rather than from the storm's bounding box.
 */
export function severityAt(damage: ParsedStormDamage, cellX: number, cellY: number): number {
  const dx = cellX - damage.x;
  const dy = cellY - damage.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance >= damage.radius) return 0;
  if (distance <= damage.eyeRadius) return 0;
  // The ramp: 1 at the eyewall, 0 at the rim. `radius > eyeRadius` is
  // guaranteed by the parse, so the denominator is never zero.
  const fallen = (damage.radius - distance) / (damage.radius - damage.eyeRadius);
  return damage.intensity * fallen;
}

/**
 * The unit vector of the storm's TANGENTIAL wind at one cell, or null at the
 * exact centre where a tangent is undefined.
 *
 * THE SENSE OF THE SPIN is (-dy, dx) — counter-clockwise in cell space, where x
 * runs east and y runs south-to-north on the grid. It is not a guess and not a
 * hemisphere convention: it is what the CLIENT DRAWS. A spiral arm's angle
 * increases with time (plugins/cyclone/client/spiral.ts, `uElapsed *
 * SPIRAL_SPIN_TURNS_PER_SECOND` added into `angle`) and a puff at that angle
 * sits at (cos·r, height, sin·r) with world z fed from the cell's y
 * (plugins/cyclone/client/index.ts: `z: centre.y * CELL_WORLD_SIZE`), so
 * increasing angle carries cloud from +x toward +y. The derivative of
 * (cos θ, sin θ) is (-sin θ, cos θ), which at an offset (dx, dy) from the eye
 * is (-dy, dx). Anything else and a boat would be pushed against the arms a
 * player can watch turning over its head.
 */
export function tangentialWindAt(
  damage: ParsedStormDamage,
  cellX: number,
  cellY: number,
): { readonly x: number; readonly y: number } | null {
  const dx = cellX - damage.x;
  const dy = cellY - damage.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance === 0) return null;
  return { x: -dy / distance, y: dx / distance };
}

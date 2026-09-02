// mudslides — the names, the settings, the wire shapes and the parsers.
//
// SHARED BY BOTH HALVES, and it is the ONLY file either half imports from the
// other's side of the tree: the server builds these payloads, the client parses
// them, and neither reaches into the other's modules. Every plugin in this repo
// is laid out this way.
//
// Nothing in here reads a clock, a socket or three.js, so a node test run can
// import it and so can the browser bundle.

import { BAND_HEIGHT, MAX_HEIGHT, MAX_STEP, RELAX_SLACK, WORLD_UNIT_CELLS } from '@terrace/shared';
import { isFiniteNumber } from '@terrace/shared';

/** The host's key for this plugin: the message and event namespace. */
export const MUDSLIDES_PLUGIN_NAME = 'mudslides';

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES (namespaced `mudslides:` by the host in both directions).

/**
 * FULL-STATE, the moving fronts only. Replaces the client's list every push, so
 * a slide that has stopped is learned by its ABSENCE — which is why the send
 * uses `skipEmpty: false` (see WorldApi.broadcastVisible's disappearance rule).
 */
export const MUDSLIDES_ACTIVE_MESSAGE = 'active';

/**
 * ADDITIVE, the debris a slide has already laid down. Sent once per deposit and
 * once more as a join snapshot; never retracted, because debris does not move
 * once it is on the ground — which is exactly the condition `skipEmpty: true`
 * is safe under (flora's grown trees, structures' founded cells).
 */
export const MUDSLIDES_DEBRIS_MESSAGE = 'debris';

// ─────────────────────────────────────────────────────────────────────────────
// WORLD EVENT.

/**
 * `mudslides:flow` — ONE SLIDE'S TICK OF MOVEMENT, for sibling server plugins.
 *
 * WHO IS EXPECTED TO READ IT (issue #212): structures (a hut on the head goes
 * with it, a hut on the run-out is buried), flora (trees are felled and carried),
 * fire (a burning cell the mud crosses is put out), and chronicle (which records
 * the slide — the one consumer that exists today, see plugins/chronicle/server).
 *
 * THE WHOLE CROSSED RUN IS LISTED, unlike storms' bounded damage sample, and the
 * difference is size: a slide's path is at most MUDSLIDE_MAX_PATH_CELLS cells
 * one cell wide, which is a small array by construction, where a cyclone's disc
 * is five figures. A consumer can therefore iterate the cells directly and does
 * not need a spatial index of its own.
 */
export const MUDSLIDES_FLOW_EVENT = 'flow';

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS.

export const MUDSLIDES_FREQUENCY_SETTING_KEY = 'mudslide-frequency';

/**
 * How often saturated ground gives way here.
 *
 * `off` STOPS THE SIM AS WELL AS THE SPAWNER, for storms' reason: a world
 * switched to `off` mid-session reopens, so a slide still running is restored
 * from the slice and would otherwise creep downhill forever with nothing to
 * finish it.
 */
export const MUDSLIDE_FREQUENCIES = ['off', 'rare', 'uncommon', 'common'] as const;
export type MudslideFrequency = (typeof MUDSLIDE_FREQUENCIES)[number];

/**
 * `uncommon`, shipped (owner, issue #231, 2026-09-01; `rare` before that). A
 * mudslide moves the ground under whatever a player built there, so the
 * default is not `common` — but a hazard nobody meets in a session is not a
 * hazard, and `rare` was that. `uncommon` is half `rare`'s wait and three times
 * `common`'s — see FREQUENCY_INTERVAL_MULTIPLIERS in server/slides.ts.
 */
export const DEFAULT_MUDSLIDE_FREQUENCY: MudslideFrequency = 'uncommon';

export function parseFrequency(value: string | undefined): MudslideFrequency {
  return MUDSLIDE_FREQUENCIES.includes(value as MudslideFrequency)
    ? (value as MudslideFrequency)
    : DEFAULT_MUDSLIDE_FREQUENCY;
}

// ─────────────────────────────────────────────────────────────────────────────
// GEOMETRY, in world units, shared by both halves.

/**
 * World units one terrace band rises.
 *
 * NOW IMPORTED, NOT RESTATED. This file used to carry `MAX_RELIEF_WORLD_UNITS =
 * 16` and this derivation as a copy of client/src/config.ts's, with the residual
 * named in the header: if the client's relief moved and this did not, every
 * vertical measurement in this plugin was wrong by that ratio and nothing failed
 * loudly. Four plugins carried that same residual. The constant moved into
 * @terrace/shared — which a plugin CAN import from either half, where
 * client/src/config.ts is unreachable from a server file — so the residual is
 * closed rather than merely named. Re-exported here so nothing that reads it
 * from this protocol moved.
 */
export { WORLD_UNITS_PER_BAND } from '@terrace/shared';

/** A length of GROUND in world units, expressed in the cells that sample it. */
export function cellsAcross(worldUnits: number): number {
  return Math.max(1, Math.round(worldUnits * WORLD_UNIT_CELLS));
}

/**
 * The span a slope is measured over, in world units.
 *
 * TWO — half a chunk's edge. Measured over ONE world unit the answer is
 * dominated by the terrace tread the sample happens to land on (a flat step
 * inside a staircase reads as flat ground); measured over eight it averages a
 * cliff together with the valley below it and reads as gentle. Two world units
 * is a slope a walker feels and a slide can start on.
 */
export const MUDSLIDE_SLOPE_SPAN_WORLD_UNITS = 2;
export const MUDSLIDE_SLOPE_SPAN_CELLS = cellsAcross(MUDSLIDE_SLOPE_SPAN_WORLD_UNITS);

/**
 * The steepest drop the terrain sim itself permits over that span, in height
 * units — the steepest LEGAL slope per cell, by definition (the relaxation will
 * not leave a neighbour pair steeper than this).
 *
 * MAX_STEP + RELAX_SLACK PER CELL, NOT MAX_STEP (issue #108, 2026-08-29). The
 * relaxation splits a pair's excess exactly in half now, which makes it
 * conserve height but leaves the odd unit standing in the pair: its trigger is
 * `|d| > MAX_STEP + RELAX_SLACK`, so a pair at MAX_STEP + 1 is AT REST and the
 * true steepest ground the sim holds is 5 units per cell, not 4
 * (shared/src/constants.ts, RELAX_SLACK). Written against the old figure this
 * constant claimed 32 over the span where the sim really permits 40, and
 * MUDSLIDE_TRIGGER_DROP — a fraction of it — was therefore 20% low: ground the
 * relaxation itself considers settled qualified as "about to give way".
 *
 * DERIVED, so the trigger threshold below is a FRACTION OF WHAT IS POSSIBLE
 * rather than an absolute number that silently becomes unreachable the next time
 * BAND_HEIGHT, WORLD_UNIT_CELLS or the relaxation rule moves. The 2026-08-20
 * re-terrace, the 2026-08-21 re-sample and the #108 split each changed one of
 * its inputs.
 */
export const MUDSLIDE_MAX_DROP_OVER_SPAN = (MAX_STEP + RELAX_SLACK) * MUDSLIDE_SLOPE_SPAN_CELLS;

/**
 * How steep is steep enough to give way, as a fraction of the steepest ground
 * the sim can hold.
 *
 * HALF. Below this the world is mostly ordinary rolling terrain and every
 * hillside in it would be a candidate; above about three quarters almost nothing
 * qualifies except a cliff a player cut deliberately, and the plugin would look
 * broken on a natural world. Measured on a default-seed world: at 0.5 roughly
 * one unlocked cell in forty is steep enough, which is enough sites for the
 * trigger to have a choice and few enough that the survey's sample finds them.
 */
export const MUDSLIDE_TRIGGER_STEEPNESS = 0.5;

/** The drop, in height units, a site must have across the span to qualify. */
export const MUDSLIDE_TRIGGER_DROP = Math.ceil(
  MUDSLIDE_MAX_DROP_OVER_SPAN * MUDSLIDE_TRIGGER_STEEPNESS,
);

/**
 * How far a slide may run, in world units.
 *
 * TWENTY-FOUR — one and a half chunks. Long enough to cross a valley floor and
 * reach the far bank (so a slide is a thing that happens TO a place rather than
 * a dimple on one hillside), short enough that the whole run is inside the
 * territory a player has usually unlocked around them, and short enough that the
 * event's cell list stays a small array.
 */
export const MUDSLIDE_MAX_PATH_WORLD_UNITS = 24;
export const MUDSLIDE_MAX_PATH_CELLS = cellsAcross(MUDSLIDE_MAX_PATH_WORLD_UNITS);

// ─────────────────────────────────────────────────────────────────────────────
// WIRE SHAPES.

/** Rounding for cell-space positions on the wire — shared's own quantum. */
export { BROADCAST_POSITION_DECIMALS, roundBroadcastPosition } from '@terrace/shared';

/**
 * Decimal places kept on a slide's `load`, which is a fraction in [0, 1] rather
 * than a distance and so is not shared's positional quantum's business.
 *
 * TWO. The client scales the moving mud by it; a hundredth of full load is far
 * under one step of the scale a viewer can resolve, so the thinning reads as
 * continuous.
 */
export const MUDSLIDE_LOAD_DECIMALS = 2;
const LOAD_QUANTUM = 10 ** MUDSLIDE_LOAD_DECIMALS;

/** Rounds a load for the wire and clamps it into [0, 1]. */
export function roundBroadcastLoad(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * LOAD_QUANTUM) / LOAD_QUANTUM;
}

/** One running slide, as the client sees it. */
/**
 * Slides running at once, world-wide.
 *
 * THREE. Each one holds a path, a visited set and an event cell list, and each
 * one sculpts a few times a second; three is enough that a world under a big
 * storm feels like it is coming apart in more than one place, and few enough that
 * the sculpt traffic stays a small fraction of what a single player's brush
 * already generates. HERE rather than in the server, because the client sizes
 * its front-instance buffer from it.
 */
export const MAX_ACTIVE_SLIDES = 3;

export interface SlideState {
  /** Stable for the slide's whole life; the client keys its renderers by it. */
  readonly id: number;
  /** Cell-space position of the moving FRONT (fractional). */
  readonly x: number;
  readonly y: number;
  /** Cells per second — the client extrapolates between pushes. */
  readonly vx: number;
  readonly vy: number;
  // THE HEAD IS DELIBERATELY NOT HERE. `broadcastVisible` filters on the front,
  // so a player who can see the valley but not the peak would otherwise be told
  // the exact cell where hidden terrain gave way — and the client never drew it
  // (review 2026-08-28). It travels in `mudslides:flow`, server-side only.
  /**
   * How much of its excavated load the front is still carrying, in [0, 1]. It
   * starts at 1 and falls as the run-out deposits; the client scales the moving
   * mud by it, so a slide thins out rather than vanishing at full size.
   */
  readonly load: number;
}

export interface MudslidesActivePayload {
  readonly slides: readonly SlideState[];
}

/** One cell of settled debris. Cell-space integers; depth in height units. */
export interface DebrisCell {
  readonly x: number;
  readonly y: number;
  /** Height units the slide added here. Always positive. */
  readonly depth: number;
}

export interface MudslidesDebrisPayload {
  readonly cells: readonly DebrisCell[];
}

/**
 * The `mudslides:flow` world-event payload. See MUDSLIDES_FLOW_EVENT above for
 * who reads it and why the whole run is listed.
 */
export interface MudslideFlowEvent {
  readonly slideId: number;
  /** Where the ground gave way. */
  readonly headX: number;
  readonly headY: number;
  /** Where it came to rest — the last cell of `cells`. */
  readonly toeX: number;
  readonly toeY: number;
  /**
   * Every cell the mud crossed this event, head first, in the order it crossed
   * them. `removed` is negative on the head cells and `added` positive on the
   * run-out; a consumer that only wants "was my thing hit" can ignore both.
   */
  readonly cells: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    /** Height units the ground here moved by. Negative = scoured away. */
    readonly delta: number;
  }>;
  /** Total height units excavated from the head. Positive. */
  readonly volumeMoved: number;
  /** Why the front stopped: a reason a consumer may want to phrase. */
  readonly stop: MudslideStop;
}

/**
 * Why a front stopped.
 *
 * `sea` is no longer produced (issue #231, 2026-09-01: mud runs on into the
 * sea) but stays in the set so a slice written before that still parses.
 */
export const MUDSLIDE_STOPS = ['water', 'sea', 'basin', 'locked', 'length', 'spent'] as const;
export type MudslideStop = (typeof MUDSLIDE_STOPS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// PARSING, for the client half.
//
// Structural, total, and a bad payload is dropped WHOLE rather than half
// applied — the rule every plugin in this repo follows. The previous state keeps
// rendering until the next good message, which is at most one broadcast away.

function parseSlide(value: unknown): SlideState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, x, y, vx, vy, load } = value as Record<string, unknown>;
  if (!Number.isInteger(id)) return null;
  for (const number of [x, y, vx, vy, load]) if (!isFiniteNumber(number)) return null;
  return {
    id: id as number,
    x: x as number,
    y: y as number,
    vx: vx as number,
    vy: vy as number,
    load: load as number,
  };
}

export function parseActivePayload(payload: unknown): MudslidesActivePayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { slides } = payload as Record<string, unknown>;
  if (!Array.isArray(slides)) return null;
  const parsed: SlideState[] = [];
  for (const value of slides) {
    const slide = parseSlide(value);
    if (slide === null) return null;
    parsed.push(slide);
  }
  return { slides: parsed };
}

function parseDebrisCell(value: unknown): DebrisCell | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, depth } = value as Record<string, unknown>;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (!isFiniteNumber(depth) || depth <= 0) return null;
  return { x: x as number, y: y as number, depth: depth as number };
}

export function parseDebrisPayload(payload: unknown): MudslidesDebrisPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { cells } = payload as Record<string, unknown>;
  if (!Array.isArray(cells)) return null;
  const parsed: DebrisCell[] = [];
  for (const value of cells) {
    const cell = parseDebrisCell(value);
    if (cell === null) return null;
    parsed.push(cell);
  }
  return { cells: parsed };
}

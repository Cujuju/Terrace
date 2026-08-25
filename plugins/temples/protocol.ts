// temples — the wire contract between the plugin's two halves.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free — the plugin-local equivalent of
// @terrace/shared, exactly as every other plugin's protocol.ts is.
//
// THE MECHANIC IN ONE PARAGRAPH (owner, 2026-08-24). The player holds a tool
// in the new bottom toolbar and puts down ONE small stone pyramid temple,
// anywhere the ground will take it. The temple is where settlers come from:
// the pilgrims plugin walks them out of its door and they found homes in the
// country around it (that half lives there, with the rest of the little
// people — see pilgrims/server/settling.ts and this plugin's
// `standingTemple`). To move a temple you knock it down and build again;
// there is never more than one.
//
// SYNC: ONE FULL-STATE MESSAGE, PUSHED ON EVERY CHANGE AND ON JOIN. Not a
// delta stream like flora's or structures' — there is at most ONE temple in
// the world, so "the whole state" is two integers or a null, and a delta
// vocabulary for a single optional cell would be pure ceremony.
//
// NO MANA PRICE, TODAY (owner, 2026-08-24: "At the moment, no cost But you
// should add a GitHub issue to address the cost later"). Nothing in this
// plugin reads the mana economy; when the price lands it belongs in the
// server half's placement path, beside the suitability check that already
// refuses a placement — see the tracking issue.

/** Plugin name on both sides. Also the message namespace. */
export const TEMPLES_PLUGIN_NAME = 'temples';

/**
 * Server → client, the whole standing-temple state (`temples:state`). Sent on
 * join, at world create, and after every successful placement or demolition.
 */
export const TEMPLE_STATE_MESSAGE = 'state';

/** Client → server, "put a temple on this cell" (`temples:place`). */
export const TEMPLE_PLACE_MESSAGE = 'place';

/** Client → server, "knock the standing temple down" (`temples:remove`). */
export const TEMPLE_REMOVE_MESSAGE = 'remove';

/**
 * How wide, in WORLD UNITS, the temple is on the ground.
 *
 * 2 — deliberately twice a settlement building's own footprint span
 * (structures' STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS = 1): a temple that read
 * as just another hut would not be worth crossing a valley to build, and a
 * terrace tread is one world unit, so this is a building that spans two of
 * them. Everything about the temple's size derives from this ONE number, on
 * both sides of the wire — the client's model is authored to it (client/
 * temple.ts) and the server surveys the ground under it from it
 * (server/suitability.ts) — which is the same drift-proofing structures'
 * footprint contract records, applied to a bigger building.
 */
export const TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS = 2;

/** The one import this dependency-free module allows itself: how many cells
 *  a span of ground is sampled at is @terrace/shared's fact, not ours. */
import { CELL_WORLD_SIZE, cellsAcross } from '@terrace/shared';

/**
 * Chebyshev radius, in CELLS, of the square of ground the server surveys
 * under a temple: every cell within it must be same-band, unlocked, dry land
 * before the temple may stand there.
 *
 * Derived from the span exactly as structures' STRUCTURE_SURVEY_RADIUS_CELLS
 * is, and for the same reason recorded there: the model reaches half the span
 * in any direction, so half the span, converted to cells, IS the radius to
 * survey. A hand-picked cell count would drift the moment the sampling
 * density changes again.
 */
export const TEMPLE_SURVEY_RADIUS_CELLS = Math.ceil(
  cellsAcross(TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS / 2),
);

/**
 * The same guarantee in WORLD UNITS: how far from the temple's origin the
 * ground is known flat, dry and unlocked. The +0.5 is the outermost surveyed
 * cell's own half-width — the guarantee covers the whole cell, not just the
 * sample at its centre (structures' STRUCTURE_SURVEYED_GROUND_RADIUS states
 * this in full).
 *
 * The client model's radial reach must stay inside this, or a temple can
 * render standing over ground nobody checked.
 */
export const TEMPLE_SURVEYED_GROUND_RADIUS =
  (TEMPLE_SURVEY_RADIUS_CELLS + 0.5) * CELL_WORLD_SIZE;

/** Where the one temple stands. */
export interface TempleCell {
  readonly x: number;
  readonly y: number;
}

/**
 * How far in front of the temple's own cell its DOOR is, in cells.
 *
 * WHY THIS EXISTS AT ALL (owner, 2026-08-24: "Are those settlers supposed to
 * come out of the temple specifically? Because they're definitely not"). They
 * are, and they were not: a settler used to be spawned at the temple's own
 * CELL — which is the centre of a building two world units across, i.e. eight
 * cells — so it began its walk buried inside four cells of solid masonry and
 * emerged by passing through the wall. From outside, a little person simply
 * appeared partway down the pyramid's flank. Nothing about that reads as
 * coming out of a temple.
 *
 * DERIVED, not chosen: half the footprint span is the front face, and the
 * extra half-cell puts the door on the ground just clear of the plinth rather
 * than inside it. The client draws its portals at the same face
 * (client/temple.ts), so the place a settler steps out of and the place that
 * looks like a doorway are one number apart by construction.
 *
 * +X, like the stair and the shrine's own doorway — the direction every model
 * in this repo faces.
 */
export const TEMPLE_DOOR_OFFSET_CELLS =
  cellsAcross(TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS / 2) + 0.5;

/**
 * How far OFF THE CENTRELINE of that face the door sits — the second half of
 * the door's position, and the half that was missing.
 *
 * THE STAIR IS ON THE CENTRELINE, AND IT JUTS. Clearing the footprint edge
 * (above) is not the same as clearing the BUILDING: the client's flight of
 * steps stands proud of the front face by half a tread, so the strip of ground
 * directly in front of the temple is solid stone for the width of the stair.
 * A door on the centreline put a settler inside the bottom step — the spawn
 * moved out of the masonry in the middle of the pyramid and into the masonry
 * on the front of it (owner, 2026-08-24: "still stuck inside the temple").
 *
 * A QUARTER OF THE SPAN, which is where the client draws its ground portals —
 * and that is not a coincidence to be maintained, it is a derivation: this
 * constant is what the model places its portals FROM (client/temple.ts), and
 * the same file clamps its stair so the stair can never reach this line. The
 * door and the doorway are one number, in one direction, rather than two
 * numbers that have to be kept in agreement.
 */
export const TEMPLE_DOOR_LATERAL_OFFSET_WORLD_UNITS = TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS / 4;
export const TEMPLE_DOOR_LATERAL_OFFSET_CELLS = cellsAcross(
  TEMPLE_DOOR_LATERAL_OFFSET_WORLD_UNITS,
);

/**
 * The temple's door, in FRACTIONAL cell coordinates — where a settler stands
 * the moment it steps outside: clear of the front face, and clear of the stair
 * that stands on it.
 */
export function templeDoorCell(temple: TempleCell): { x: number; y: number } {
  return {
    x: temple.x + TEMPLE_DOOR_OFFSET_CELLS,
    y: temple.y + TEMPLE_DOOR_LATERAL_OFFSET_CELLS,
  };
}

/**
 * `temples:state` — the standing temple as a flat `[x, y]` pair, or an empty
 * list for "there is no temple". A pair rather than an object for the reason
 * every other plugin packs its cells flat: no per-object key strings to
 * re-send under msgpack.
 */
export interface TempleStatePayload {
  readonly temple: readonly number[];
}

/**
 * Same coordinate validity rule every plugin's cell parser uses: a
 * non-negative integer inside the widest world the Int16 heightmap can
 * describe. The world's ACTUAL size is checked server-side, where it is
 * known; this is the structural bar a wire value must clear first.
 */
const MAX_CELL_COORDINATE = 65536;

function isCellCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_CELL_COORDINATE
  );
}

/** Temple → wire pair; null → the empty list. */
export function packTemple(temple: TempleCell | null): number[] {
  return temple === null ? [] : [temple.x, temple.y];
}

/**
 * Defensive parse of `temples:state`. Returns the temple, or null for "no
 * temple standing" — and null ALSO for a malformed payload, deliberately:
 * the two mean the same thing to the only consumer (draw nothing), and a
 * third answer would put a branch in the client for a case a well-behaved
 * server cannot produce.
 */
export function parseTempleStatePayload(payload: unknown): TempleCell | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const temple = (payload as { temple?: unknown }).temple;
  if (!Array.isArray(temple) || temple.length < 2) return null;
  const x = temple[0];
  const y = temple[1];
  if (!isCellCoordinate(x) || !isCellCoordinate(y)) return null;
  return { x, y };
}

/** `temples:place` — the cell the player pressed. */
export interface TemplePlacePayload {
  readonly x: number;
  readonly y: number;
}

/** Defensive parse of `temples:place`; null for anything malformed. */
export function parseTemplePlacePayload(payload: unknown): TempleCell | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { x?: unknown; y?: unknown };
  if (!isCellCoordinate(message.x) || !isCellCoordinate(message.y)) return null;
  return { x: message.x, y: message.y };
}

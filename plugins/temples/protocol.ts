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
 * Server → the pressing player only, "that press built nothing, and here is
 * why" (`temples:refused`). Sent on a refused `temples:place` and never
 * otherwise — one message, on a real press, to one player.
 *
 * WHY THIS PLUGIN NOW HAS A REFUSAL CHANNEL, having deliberately gone without
 * one (owner, 2026-08-24: "why can't the client just ask the server?"). Two of
 * the three refusals the client CAN predict, and it does — it offers no ghost
 * where the ground is wrong and none at all while a temple stands. The third
 * cannot be predicted at any price: whether a settler could ever walk out and
 * find somewhere to build is a question about a walker sim and a whole county
 * of terrain, and putting that on the client would mean shipping the sim
 * twice. So the ghost stays the fast, local, every-frame answer, and this
 * message is the slow, authoritative one that arrives only when a player has
 * actually pressed — which is exactly when a silent no-op is unacceptable.
 *
 * IT CARRIES THE CELL, because the client tracks no pending press: a press is
 * fire-and-forget, and a refusal that did not say WHERE could not be told from
 * a refusal of an older press somewhere else.
 */
export const TEMPLE_REFUSED_MESSAGE = 'refused';

/**
 * Why a placement was refused. Plain integers on the wire, and the client
 * treats an unknown code as REASON_GROUND — the conservative reading, since
 * every reason a future server adds will still mean "not here".
 */
export const TEMPLE_REFUSED_STANDING = 0;
export const TEMPLE_REFUSED_GROUND = 1;
export const TEMPLE_REFUSED_NO_SETTLERS = 2;

/** A refusal as the client understands it. */
export interface TempleRefusal {
  readonly x: number;
  readonly y: number;
  readonly reason: number;
}

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
 * THE APRON: clear ground in front of the temple, past the footprint edge, in
 * WORLD UNITS.
 *
 * A quarter of the span. It exists because the building's front face is not
 * its outermost thing — the stair stands proud of it by half a tread — and
 * because a settler has to stand SOMEWHERE when it steps out. The apron is
 * that somewhere: the strip the model may not build on and the ground the
 * survey must cover, so "in front of the steps" is a place that is known to
 * exist rather than a place that happens to be free.
 *
 * The model enforces its half of this (client/temple.ts clamps the stair's
 * tread against it); this file enforces the survey's half.
 */
export const TEMPLE_FRONT_APRON_WORLD_UNITS = TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS / 4;

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
 *
 * PLUS THE APRON. The surveyed square covers the doorstep too, because a
 * settler is spawned onto it: ground nobody checked is ground that can be a
 * cliff face or a lake, and a building that puts a person there has not
 * finished surveying itself. This is what makes the temple's ask a 13x13 of
 * flat dry land rather than a 9x9 — a stricter placement, deliberately, in
 * exchange for a doorstep that is always there.
 */
export const TEMPLE_SURVEY_RADIUS_CELLS = Math.ceil(
  cellsAcross(TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS / 2 + TEMPLE_FRONT_APRON_WORLD_UNITS),
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
export const TEMPLE_DOOR_OFFSET_CELLS = cellsAcross(
  TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS / 2 + TEMPLE_FRONT_APRON_WORLD_UNITS,
);

/**
 * The temple's door, in FRACTIONAL cell coordinates — where a settler stands
 * the moment it steps outside.
 *
 * ON THE CENTRELINE, AT THE FOOT OF THE STEPS (owner, 2026-08-24: "spawn the
 * settler outside the temple just in front of the bottom steps"). The stair is
 * the way out, so the door is where the stair lands: same axis, one apron
 * clear of the bottom tread. A settler appears at the bottom of the flight and
 * walks away from it, which is the read the whole front face was built for.
 *
 * NOT `+ 0.5`, and that is the correction. Half a cell past the footprint edge
 * cleared the PLINTH and nothing else — the bottom tread juts half a tread
 * further out still, so the old door stood inside the step (measured: door at
 * 1.125 world units, tread from 0.82 to 1.18). Clearing the footprint is not
 * clearing the building; clearing the apron is.
 */
export function templeDoorCell(temple: TempleCell): { x: number; y: number } {
  return { x: temple.x + TEMPLE_DOOR_OFFSET_CELLS, y: temple.y };
}

/**
 * `temples:refused` → the flat triple the wire carries, and back. Flat for the
 * same reason `temples:state` is: no per-object key strings to re-send.
 */
export function packTempleRefusal(refusal: TempleRefusal): number[] {
  return [refusal.x, refusal.y, refusal.reason];
}

/** Defensive parse of `temples:refused`; null for anything malformed. */
export function parseTempleRefusalPayload(payload: unknown): TempleRefusal | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const refused = (payload as { refused?: unknown }).refused;
  if (!Array.isArray(refused) || refused.length < 3) return null;
  const x = refused[0];
  const y = refused[1];
  const reason = refused[2];
  if (!isCellCoordinate(x) || !isCellCoordinate(y)) return null;
  if (typeof reason !== 'number' || !Number.isInteger(reason)) return null;
  return { x, y, reason };
}

/**
 * Every cell of the square of ground a temple standing on this cell claims —
 * flat x, y, x, y…, the packing a list of cells travels in everywhere in this
 * repo.
 *
 * THE SURVEYED SQUARE, exactly: the ground this plugin has already checked is
 * flat, dry and unlocked, doorstep included. It is the right claim precisely
 * because it is the same square — a building that surveys ground in order to
 * stand on it, and then lets somebody else build a house on that ground, has
 * surveyed it for nothing. The one consumer today is structures (see
 * server/structures-bridge.ts), which grew a house inside the temple.
 *
 * Cells that fall outside the world are simply included and dropped by the
 * consumer, which already validates coordinates defensively across the bridge;
 * clamping here would need the world size, which this dependency-free module
 * does not have.
 */
export function templeFootprintCells(temple: TempleCell): number[] {
  const cells: number[] = [];
  for (let dy = -TEMPLE_SURVEY_RADIUS_CELLS; dy <= TEMPLE_SURVEY_RADIUS_CELLS; dy++) {
    for (let dx = -TEMPLE_SURVEY_RADIUS_CELLS; dx <= TEMPLE_SURVEY_RADIUS_CELLS; dx++) {
      cells.push(temple.x + dx, temple.y + dy);
    }
  }
  return cells;
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

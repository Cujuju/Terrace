// flora → fire, READ-DIRECTION: a structural parse of fire's `cellsBurnedOut`
// world-event (plugins/fire/server/index.ts, emitted as 'fire:cellsBurnedOut'
// via WorldApi.emitEvent), scoped to exactly what this plugin needs from it —
// the ground that finished burning, whoever owned the burn.
//
// AN OWN COPY, not an import from fire's protocol.ts. Every plugin builds and
// runs with every other plugin deleted (server/src/plugins/types.ts's emitEvent
// doc comment, and the by-name subscription rule it states), so cross-plugin
// agreement travels as a documented copy rather than a dependency. Fire keeps
// its own copy of weather's strike shape for the same reason
// (plugins/fire/server/strike-event.ts), pilgrims and wildlife each keep their
// own copy of fire's `ignited` shape (their server/fire-event.ts files), and
// this file is the same copy for a second fire event — the duplication is the
// rule rather than an oversight: two plugins that may not import each other
// cannot share one.
//
// DEGRADED BEHAVIOUR when fire is absent: the event never arrives, nothing
// here ever runs, and burned ground simply never scorches — the world this
// plugin had before issue #297, in which a structure's cell came back as fuel
// a tick after it burned out.
//
// WHAT THIS FILE DELIBERATELY DOES NOT ASK: which source owned each burn. That
// is a private answer fire gives to the plugin whose stuff burned, through the
// fuel registry's `onBurnedOut` callback (./index.ts's registration), and it
// would be worthless here anyway — the scorch record is keyed on the GROUND,
// and the ground burned no matter what stood on it.

/**
 * The event's full namespaced name, as fire emits it — the whole of the
 * coupling between the two plugins, and a string rather than an import for the
 * reason this file's header states.
 */
export const FIRE_CELLS_BURNED_OUT_EVENT_NAME = 'fire:cellsBurnedOut';

/**
 * Defensive bound on how many burned-out cells one event may carry.
 *
 * Fire's own ceiling on cells alight at once is 2000 (its FIRE_CELL_CAP), so a
 * tick in which EVERY fire in a capped world burned out at once is 2000 — and
 * no honest event can exceed it. The value is restated rather than derived,
 * because deriving it would mean importing fire; being a little generous costs
 * nothing, and the bound exists to stop a malformed or hostile payload making
 * this plugin walk an unbounded list, not to police fire's arithmetic.
 *
 * IT TRACKS FIRE'S CAP AND MUST BE RAISED WITH IT. A restated bound that fell
 * BELOW fire's real ceiling would stop being defensive and start silently
 * dropping the tail of an honest event — which is why the number above is
 * spelled out rather than left at a round figure someone might not revisit.
 */
const MAX_BURNED_OUT_PER_EVENT = 2048;

/** How many numbers one burned-out cell occupies in fire's flat form: x, then y. */
const BURNED_OUT_STRIDE = 2;

/** One cell whose fire ran its full course, in integer cell coordinates. */
export interface BurnedOutCell {
  readonly x: number;
  readonly y: number;
}

/**
 * INTEGER, not fractional — a burnout is always a cell and never a creature,
 * so a whole-number test drops nothing honest. Non-negative, because a cell
 * below zero is not a cell.
 */
function isCellCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The cells whose fires finished, or null if the payload is not fire's
 * burned-out shape at all.
 *
 * Null and empty are different answers, on fire's strike-event.ts's rule: null
 * means "this is not a message I understand" (a version mismatch, a hostile
 * emitter), empty means "nothing burned out". Fire does not emit the empty
 * case, but a caller that conflated the two would silently stop scorching on
 * the day fire's payload changed shape. A malformed ENTRY is dropped on its
 * own rather than failing the whole event: one bad pair must not un-scorch
 * the rest of a burn.
 */
export function parseBurnedOutCells(payload: unknown): BurnedOutCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const cells = (payload as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return null;

  const parsed: BurnedOutCell[] = [];
  for (let i = 0; i + BURNED_OUT_STRIDE - 1 < cells.length; i += BURNED_OUT_STRIDE) {
    if (parsed.length >= MAX_BURNED_OUT_PER_EVENT) break;
    const x = cells[i];
    const y = cells[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    parsed.push({ x, y });
  }
  return parsed;
}

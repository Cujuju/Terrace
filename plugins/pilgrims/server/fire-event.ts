// pilgrims → fire, READ-DIRECTION: a structural parse of fire's `ignited`
// world-event (plugins/fire/server/index.ts, emitted as 'fire:ignited' via
// WorldApi.emitEvent), scoped to exactly what this plugin needs from it — the
// places new flames appeared.
//
// AN OWN COPY, not an import from fire's protocol.ts. Every plugin builds and
// runs with every other plugin deleted (server/src/plugins/types.ts's emitEvent
// doc comment, and the by-name subscription rule it states), so cross-plugin
// agreement travels as a documented copy rather than a dependency. Fire keeps
// its own copy of weather's strike shape for the same reason
// (plugins/fire/server/strike-event.ts), and this file is modelled on it line
// for line. wildlife/server/fire-event.ts is the same copy for the same event,
// and the duplication is the rule rather than an oversight: two plugins that
// may not import each other cannot share one.
//
// DEGRADED BEHAVIOUR when fire is absent: the event never arrives, nothing
// here ever runs, and walkers simply never react to fire — the world this
// plugin had before fire existed.
//
// WHAT THIS FILE DELIBERATELY DOES NOT ASK: which individual caught. That is a
// private answer fire gives to the plugin that OWNS the creature, through the
// fuel registry's `onIgnited` callback (./index.ts's registration), and it
// would be worthless here anyway — an id in another plugin's namespace is not
// something this plugin could match against its own walkers.

/**
 * The event's full namespaced name, as fire emits it — the whole of the
 * coupling between the two plugins, and a string rather than an import for the
 * reason this file's header states.
 */
export const FIRE_IGNITED_EVENT_NAME = 'fire:ignited';

/**
 * Defensive bound on how many ignitions one event may carry.
 *
 * Fire's own ceiling on things alight at once is 2000 cells plus 48 individuals
 * (its FIRE_CELL_CAP and FIRE_ENTITY_CAP), so a tick in which EVERY fire in a
 * capped world started at once is 2048 — and no honest event can exceed it. The
 * value is restated rather than derived, because deriving it would mean
 * importing fire; being a little generous costs nothing, and the bound exists
 * to stop a malformed or hostile payload making this plugin walk an unbounded
 * list, not to police fire's arithmetic.
 *
 * IT TRACKS FIRE'S CAP AND MUST BE RAISED WITH IT. A restated bound that fell
 * BELOW fire's real ceiling would stop being defensive and start silently
 * dropping the tail of an honest event — which is why the number above is
 * spelled out rather than left at a round figure someone might not revisit.
 */
const MAX_IGNITIONS_PER_EVENT = 2048;

/** How many numbers one ignition occupies in fire's flat form: x, then y. */
const IGNITION_STRIDE = 2;

/** Where one new flame appeared, in fractional cell coordinates. */
export interface IgnitedAt {
  readonly x: number;
  readonly y: number;
}

/**
 * FRACTIONAL, not integer — a cell fire is at its cell's integer coordinates
 * but a burning animal is wherever it was standing, so a whole-number test
 * would silently drop every entity ignition. Non-finite values are refused: a
 * NaN centre would make every squared distance below NaN, and NaN fails every
 * comparison, so the startle would silently do nothing.
 */
function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The places fire started, or null if the payload is not fire's ignition shape
 * at all.
 *
 * Null and empty are different answers, on strike-event.ts's rule: null means
 * "this is not a message I understand" (a version mismatch, a hostile emitter),
 * empty means "nothing caught". Fire does not emit the empty case, but a
 * caller that conflated the two would silently stop reacting on the day fire's
 * payload changed shape.
 */
export function parseIgnitedPositions(payload: unknown): IgnitedAt[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const ignited = (payload as { ignited?: unknown }).ignited;
  if (!Array.isArray(ignited)) return null;

  const positions: IgnitedAt[] = [];
  for (let i = 0; i + IGNITION_STRIDE - 1 < ignited.length; i += IGNITION_STRIDE) {
    if (positions.length >= MAX_IGNITIONS_PER_EVENT) break;
    const x = ignited[i];
    const y = ignited[i + 1];
    if (!isPosition(x) || !isPosition(y)) continue;
    positions.push({ x, y });
  }
  return positions;
}

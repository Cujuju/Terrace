// Structural parse of weather's `strikes` world-event (plugins/weather/server/
// index.ts, emitted as 'weather:strikes' via WorldApi.emitEvent), scoped to
// exactly what fire needs from it: the cells bolts landed on.
//
// AN OWN COPY, not an import from weather's protocol.ts — every plugin builds
// and runs with every other plugin deleted (server/src/plugins/types.ts's
// emitEvent doc comment, and the by-name subscription rule it states). flora
// keeps its own copy of structures' event shape for the same reason
// (plugins/flora/server/structures-event.ts).
//
// The system id weather puts on each strike is READ AND DISCARDED here: it
// exists so a client can find the rig to flash, and fire has no rigs. Only the
// cell matters.

/** Defensive bound on the list length, matching weather's own send-side cap. */
const MAX_STRIKES_PER_EVENT = 8;

/** How many integers one strike occupies in weather's flat wire form. */
const STRIKE_STRIDE = 3;

export interface StruckCell {
  readonly x: number;
  readonly y: number;
}

function isCellCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The cells struck, or null if the payload is not weather's strike shape at all.
 *
 * Null and empty are different answers on purpose: null means "this is not a
 * message I understand" (a version mismatch, a hostile emitter), empty means
 * "no bolts landed". A caller that conflated them would silently stop igniting
 * on the day weather's payload changed.
 */
export function parseStruckCells(payload: unknown): StruckCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const strikes = (payload as { strikes?: unknown }).strikes;
  if (!Array.isArray(strikes)) return null;

  const cells: StruckCell[] = [];
  for (let i = 0; i + STRIKE_STRIDE - 1 < strikes.length; i += STRIKE_STRIDE) {
    if (cells.length >= MAX_STRIKES_PER_EVENT) break;
    // [systemId, x, y] — the id is weather's business, not this plugin's.
    const x = strikes[i + 1];
    const y = strikes[i + 2];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

// Structural parse of structures' `changes` world-event (plugins/structures/
// server/index.ts, emitted as 'structures:changes' via WorldApi.emitEvent),
// scoped to exactly what flora needs from it: which cells a structure just
// started occupying. An own copy, not an import from structures or from
// chronicle's identically-shaped parser (plugins/chronicle/server/saga.ts) —
// every plugin builds and tests with every other plugin deleted (see
// server/src/plugins/types.ts's emitEvent doc comment, and the by-name
// subscription rule it states).
//
// WHY ONLY `seeded` AND `upgraded`, NOT EVERY NEW FOUNDING. The event's
// `seeded` list is narrower than the wire's `founded` delta
// (structures/server/index.ts's broadcastChanges): it carries only explicit
// seed-pattern placements, not ordinary B3/S23 births or stir sparks,
// because the chronicle only wants seed events as saga material — routine
// churn is deliberately excluded there. That gap does NOT leave a
// building-over-tree case uncovered for flora: every occupied cell, however
// it was founded, is caught within one survey interval by the occupancy
// check folded into Forest's own sweep (../server/forest.ts's isOccupied
// parameter, wired from ../server/index.ts's occupiedCells). This parser
// exists only to react to the two causes the event DOES name, INSTANTLY
// rather than waiting up to FLORA_SURVEY_INTERVAL_SECONDS.
//
// `died` and `cause` are not read here. Structure death does not replant —
// flora's own growth recolonizes naturally once the cell stops being
// occupied (see ../server/index.ts's module header) — so there is nothing
// for an event handler to do on death at all.

/** A cell position inside the event payload. */
export interface StructuresChangeCell {
  readonly x: number;
  readonly y: number;
}

/**
 * Defensive bound on either list's length. The largest real emitter list is
 * structures' own board cap (512, STRUCTURES_CAP); anything past this is a
 * malformed or hostile payload, not a bigger world. Matches the bound
 * chronicle's saga.ts keeps for the same event.
 */
const STRUCTURES_EVENT_LIST_CAP = 4096;

function parseCellList(value: unknown): StructuresChangeCell[] | null {
  if (!Array.isArray(value) || value.length > STRUCTURES_EVENT_LIST_CAP) return null;
  const cells: StructuresChangeCell[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { x, y } = item as { x?: unknown; y?: unknown };
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    cells.push({ x: x as number, y: y as number });
  }
  return cells;
}

/** The cells a structure now occupies, per one `structures:changes` event. */
export interface StructuresOccupationEvent {
  readonly seeded: readonly StructuresChangeCell[];
  readonly upgraded: readonly StructuresChangeCell[];
}

/**
 * Parses `structures:changes`, keeping only the two lists that name cells a
 * structure now occupies. Malformed as a whole yields null so the caller can
 * ignore the event entirely — the same contract every other world-event
 * consumer in this codebase keeps (see chronicle/server/saga.ts).
 */
export function parseStructuresOccupation(payload: unknown): StructuresOccupationEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { seeded, upgraded } = payload as { seeded?: unknown; upgraded?: unknown };

  // Absent lists are empty lists, not malformed: the sculpt-path emission
  // (structures/server/index.ts's reactToTerrain) carries only `died`.
  const seededCells = seeded === undefined ? [] : parseCellList(seeded);
  const upgradedCells = upgraded === undefined ? [] : parseCellList(upgraded);
  if (seededCells === null || upgradedCells === null) return null;

  return { seeded: seededCells, upgraded: upgradedCells };
}

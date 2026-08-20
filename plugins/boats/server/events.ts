// Structural parsers for the two world events this plugin listens to.
//
// AN OWN COPY, NEVER AN IMPORT from the emitters. Every plugin must build and
// test with every other plugin deleted (server/src/plugins/types.ts's emitEvent
// doc comment, and the by-name subscription rule it states), so a consumer
// subscribes by the emitter's NAME and validates the payload structurally —
// not because the emitter is untrusted, but because it may be a different
// version or absent entirely. plugins/flora/server/structures-event.ts is the
// same pattern against the same emitter; this file is deliberately shaped like
// it rather than cleverer than it.
//
// WHAT THIS PLUGIN NEEDS FROM EACH, AND WHY THAT IS ALL:
//
//   structures:changes — which settlements just reached a tier that keeps
//     boats, and which died. NOTE that `upgraded` alone is a COMPLETE source
//     for the roster, which is the whole reason structures needed no new event
//     for this feature: VILLAGE_MIN_TIER is 1, reaching tier 1 requires an
//     upgrade, and every upgrade is announced. Ordinary B3 births are
//     deliberately absent from this event (see the emitter's comment) and that
//     absence costs nothing here — a newborn tier-0 camp keeps no boats.
//
//   monsters:positions — where the krakens are, now. This one IS new (added to
//     the monsters plugin alongside this feature): its pre-existing events
//     announce arrival and departure only, and a fight needs a live position.
//
// A MISSING EMITTER IS A LEGAL WORLD. With structures uninstalled no village
// is ever learned and no boat is ever built; with monsters uninstalled no
// kraken is ever seen and the fleet sits at home. Neither is an error path.

import { VILLAGE_MIN_TIER } from '../protocol.ts';

/**
 * Defensive bound on any list inside a payload. Matched to the largest real
 * emitter list — structures' own board cap (512, STRUCTURES_CAP) — with room
 * to spare; past this a payload is malformed or hostile, not a bigger world.
 * The same bound flora and chronicle keep against the same event.
 */
const EVENT_LIST_CAP = 4096;

/** A cell inside an event payload. */
export interface EventCell {
  readonly x: number;
  readonly y: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseCellList(value: unknown): EventCell[] | null {
  if (!Array.isArray(value) || value.length > EVENT_LIST_CAP) return null;
  const cells: EventCell[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { x, y } = item as { x?: unknown; y?: unknown };
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    cells.push({ x: x as number, y: y as number });
  }
  return cells;
}

// ── structures:changes ───────────────────────────────────────────────────────

/** What one `structures:changes` event tells this plugin. */
export interface VillageChanges {
  /** Settlements that just reached a boat-keeping tier. */
  readonly gained: readonly EventCell[];
  /** Settlements that are gone, whatever the cause. */
  readonly lost: readonly EventCell[];
}

/**
 * Reads a `structures:changes` payload, keeping only what the roster needs.
 *
 * Returns null for anything that does not parse, and the caller then does
 * NOTHING — a malformed event must not half-update a roster. `cause` is not
 * read: a settlement demolished by a sculpt and one that died of the CA's own
 * rules are equally gone, and this plugin has no story that distinguishes them.
 */
export function parseVillageChanges(payload: unknown): VillageChanges | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { upgraded, died } = payload as { upgraded?: unknown; died?: unknown };

  // Both lists are OPTIONAL: the emitter sends `{cause, died}` on the sculpt
  // path and `{cause, seeded, upgraded, died}` on the generation path, so an
  // absent key is a normal event and only a present-but-wrong one is a fault.
  const gained: EventCell[] = [];
  if (upgraded !== undefined) {
    if (!Array.isArray(upgraded) || upgraded.length > EVENT_LIST_CAP) return null;
    for (const item of upgraded) {
      if (typeof item !== 'object' || item === null) return null;
      const { x, y, tier } = item as { x?: unknown; y?: unknown; tier?: unknown };
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(tier)) return null;
      if ((tier as number) >= VILLAGE_MIN_TIER) gained.push({ x: x as number, y: y as number });
    }
  }

  let lost: EventCell[] = [];
  if (died !== undefined) {
    const parsed = parseCellList(died);
    if (parsed === null) return null;
    lost = parsed;
  }

  return { gained, lost };
}

// ── monsters:positions ───────────────────────────────────────────────────────

/** One monster, as the positions event carries it. */
export interface MonsterSighting {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Reads a `monsters:positions` payload.
 *
 * KIND IS KEPT AS A STRING and compared against a literal here rather than
 * against an imported union: the emitter's MonsterKind is the emitter's type,
 * and a version of it that added a fourth kind must not fail to parse in a
 * consumer that only cares about one of them.
 */
export function parseMonsterSightings(payload: unknown): MonsterSighting[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { monsters } = payload as { monsters?: unknown };
  if (!Array.isArray(monsters) || monsters.length > EVENT_LIST_CAP) return null;

  const sightings: MonsterSighting[] = [];
  for (const item of monsters) {
    if (typeof item !== 'object' || item === null) return null;
    const { kind, x, y } = item as { kind?: unknown; x?: unknown; y?: unknown };
    if (typeof kind !== 'string' || !isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    sightings.push({ kind, x, y });
  }
  return sightings;
}

/** The one kind this plugin fights. */
export const KRAKEN_KIND = 'kraken';

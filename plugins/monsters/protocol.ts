// monsters — the wire contract between the plugin's two halves.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free: one definition of the payload, so the
// halves cannot drift.
//
// Namespacing: the hosts prefix `monsters:` on the wire in both directions, so
// every type here is the UN-namespaced form (see server/src/plugins/host.ts and
// client/src/plugins/host.ts).

/** Plugin name on both sides. Also the message namespace. */
export const MONSTERS_PLUGIN_NAME = 'monsters';

/**
 * Un-namespaced type of the server → client push (`monsters:state`).
 *
 * There is exactly one message type and it carries FULL state every time — the
 * same choice the wildlife plugin made, for the same self-healing reasons, and
 * here it is nearly free: the list holds at most MAX_LIVING_MONSTERS entries
 * (one per KIND since the 2026-08-19 per-kind slots, so three today — it was
 * one per habitat regime, and two, before that). See the bandwidth note in
 * server/index.ts.
 *
 * The list being EMPTY is meaningful and is broadcast just as faithfully as a
 * populated one: it is how a client learns the monster is gone. A despawn that
 * were signalled only by the absence of a message would leave a client that
 * joined mid-lull rendering nothing wrong, but a client that was watching the
 * thing rendering it forever.
 */
export const MONSTERS_STATE_MESSAGE = 'state';

/**
 * The monster kinds that exist. Ordered; this is also the deterministic order in
 * which summoning considers kinds, so the contest for a habitat's single monster
 * slot resolves predictably rather than by whichever key `for…in` yielded.
 *
 * THE ORDER IS STRICTEST HABITAT FIRST, and that is a rule for the table rather
 * than a fact about these rows. The kraken's habitat is strictly harder than
 * Cthulhu's — a deeper trench AND a bigger basin — so every world that can host
 * a kraken can also host a Cthulhu. Trying the laxer kind first would hand it
 * most of the slots in exactly the worlds that were dug for the stricter one,
 * and since Cthulhu cannot be banished (server/kinds.ts) that would be
 * permanent. Most demanding kind that the world can support gets first refusal.
 *
 * THE ORDER ONLY DECIDES CONTESTS WITHIN ONE HABITAT (2026-08-14). A monster
 * slot exists per HABITAT REGIME — one thing in the water, one thing on the
 * high snow — so the yeti's position in this list is free: it is the only land
 * kind, and it never contends with either sea kind for anything. It is last
 * because it was added last, and the day a second land kind exists the two of
 * them have to be ordered against each other by the rule above.
 *
 * SUPERSEDED 2026-08-19 — THERE IS NO CONTEST LEFT TO DECIDE. Slots became one
 * per KIND (server/summoning.ts), so every kind rolls its own arrival against
 * its own lair requirements and no kind can take another's slot; the
 * strictest-first rule above is the historical reason this order exists, not a
 * live mechanism. What the order still does is REAL and worth keeping stable:
 * it is the fixed iteration order of the summon pass, of `livingMonsters()`,
 * and therefore of the broadcast list and the client's reconcile — a list whose
 * order wobbled between ticks would be a wire payload that changed for no
 * reason. Reorder this and the payload's key order changes; nothing else does.
 */
export const MONSTER_KINDS = ['kraken', 'cthulhu', 'yeti'] as const;

export type MonsterKind = (typeof MONSTER_KINDS)[number];

// Broadcast coordinate precision lives in @terrace/shared (shared/src/wire.ts).
// Five plugins each carried a byte-identical copy of this rounding, and the
// copies are how issue #180 shipped: the bounded form did not exist, so nothing
// stopped a rounded coordinate from leaving the map, and fixing it in one
// plugin left the other four exposed. Re-exported here so this file stays the
// one wire contract this plugin's server and client halves both import.
export {
  BROADCAST_POSITION_DECIMALS,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '@terrace/shared';

/**
 * One monster, as it appears on the wire.
 *
 * DELIBERATELY ABSENT: the idle/lurking flag. The client can SEE that the thing
 * is not moving — that is what idling looks like — and the model's animation is
 * a function of elapsed time, not of gait. Putting the flag on the wire would be
 * a second source of truth for something already visible.
 */
export interface MonsterState {
  /** Stable for the monster's whole life; the client keys interpolation by it. */
  readonly id: number;
  readonly kind: MonsterKind;
  /** Cell-space position (fractional). World X/Z, since CELL_WORLD_SIZE is 1. */
  readonly x: number;
  readonly y: number;
  /** Radians; the monster moves toward (cos heading, sin heading) in cell space. */
  readonly heading: number;
}

export interface MonstersStatePayload {
  readonly monsters: readonly MonsterState[];
}

export function isMonsterKind(value: unknown): value is MonsterKind {
  return (MONSTER_KINDS as readonly string[]).includes(value as string);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Defensive parse of a received payload.
 *
 * The client trusts the server, but "trusts" is not "assumes well-formed": a
 * version skew between a self-hoster's server and a cached client bundle is an
 * ordinary event, and the right failure mode is "the monster is missing this
 * second", never a thrown exception inside the render loop. Unknown kinds and
 * malformed entries are dropped individually; a payload that is not a list at
 * all yields null so the caller can ignore the message entirely.
 *
 * An EMPTY list is a valid parse (it is the despawn signal), which is exactly
 * why "not a list" has to be reported as null rather than as an empty result.
 */
export function parseMonstersPayload(payload: unknown): MonsterState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const monsters = (payload as { monsters?: unknown }).monsters;
  if (!Array.isArray(monsters)) return null;

  const parsed: MonsterState[] = [];
  for (const raw of monsters) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<MonsterState>;
    if (!isFiniteNumber(entry.id)) continue;
    if (!isMonsterKind(entry.kind)) continue;
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y)) continue;
    if (!isFiniteNumber(entry.heading)) continue;
    parsed.push({
      id: entry.id,
      kind: entry.kind,
      x: entry.x,
      y: entry.y,
      heading: entry.heading,
    });
  }
  return parsed;
}

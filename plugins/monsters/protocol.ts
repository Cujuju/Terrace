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

/**
 * THE YETI'S VARIANTS: four different animals wearing one KIND (owner decision,
 * 2026-08-26).
 *
 * WHY ONE KIND AND NOT FOUR. Everything the server does with a monster is
 * driven by its PROFILE (server/kinds.ts) — habitat, lair size, summon rate,
 * banishability, speed, footprint — and all four of these are the same animal
 * on every one of those axes: the same snowfield qualifies them, the same
 * shovel drives them off, they amble at the same pace. Four kinds would have
 * been four identical profile rows plus a per-kind SLOT each (summoning.ts),
 * which would quietly turn "one yeti in the world" into "four yetis in the
 * world, one of each look" — a gameplay change nobody asked for, smuggled in as
 * a modelling decision. A variant is what this actually is: a choice of BODY,
 * made once at summon time, that the renderer reads and the simulation does
 * not.
 *
 * ORDERED, and the order is load-bearing exactly once: the FIRST entry is the
 * default a missing variant resolves to (see parseMonstersPayload). Reordering
 * therefore changes what a version-skewed client draws, and nothing else.
 */
export const YETI_VARIANTS = ['silverback', 'ram', 'ibex', 'fanged'] as const;

export type YetiVariant = (typeof YETI_VARIANTS)[number];

/**
 * What a yeti is when nobody said which yeti.
 *
 * Named rather than written as `YETI_VARIANTS[0]` at each of the three places
 * that need it (the wire parse, the snapshot read-back, the client's model
 * lookup), because those three must agree by construction: a build in which the
 * renderer's fallback and the parser's fallback drift apart is a build where a
 * yeti's look depends on which layer noticed the gap first.
 */
export const DEFAULT_YETI_VARIANT: YetiVariant = YETI_VARIANTS[0];

export function isYetiVariant(value: unknown): value is YetiVariant {
  return (YETI_VARIANTS as readonly string[]).includes(value as string);
}

/**
 * The variant a monster of this kind should carry, given whatever arrived in
 * the `variant` field — from the wire, or from a snapshot row.
 *
 * ONE FUNCTION FOR BOTH READERS, on purpose. The wire parse and the persistence
 * read-back are two independent defensive parsers over the same field, and the
 * version-skew rule below is a decision about the FIELD, not about either
 * transport; stating it twice is how the two come to disagree.
 *
 * THE RULE: a yeti whose variant is missing or unrecognised is still a yeti.
 * It resolves to DEFAULT_YETI_VARIANT rather than causing the entry to be
 * dropped, because the two skews this has to survive both produce exactly that
 * field — an older server that predates variants sends none, and a newer one
 * sends a name this bundle has never heard of. In both cases the honest render
 * is "some yeti", and the alternative — dropping the entry — would make a
 * client that is merely out of date show an EMPTY mountain, which is this
 * plugin's despawn signal. A wrong coat is a cosmetic error for one client
 * session; a missing monster is a lie about the world.
 *
 * Non-yeti kinds get `undefined`: the sea kinds have no variants, and writing
 * one onto them would put a field on the wire that means nothing.
 */
export function yetiVariantOf(kind: MonsterKind, raw: unknown): YetiVariant | undefined {
  if (kind !== 'yeti') return undefined;
  return isYetiVariant(raw) ? raw : DEFAULT_YETI_VARIANT;
}

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
  /**
   * WHICH yeti (2026-08-26). Present for `kind: 'yeti'`, absent for the sea
   * kinds — they have exactly one body each, and an always-undefined field on
   * them would invite a renderer to branch on something that never varies.
   *
   * OPTIONAL rather than required-with-a-default so the ABSENCE stays
   * representable on the wire: that is what an older server sends, and
   * parseMonstersPayload is the one place that decision is resolved (see
   * yetiVariantOf).
   */
  readonly variant?: YetiVariant;
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
 * AN UNKNOWN VARIANT IS NOT AN UNKNOWN KIND, and is deliberately NOT dropped —
 * see yetiVariantOf for the argument. The difference is what the client can
 * still honestly draw: nothing at all for a kind it has no model for, and a
 * yeti for a yeti whose coat it does not recognise.
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
    const variant = yetiVariantOf(entry.kind, entry.variant);
    parsed.push(
      variant === undefined
        ? {
            id: entry.id,
            kind: entry.kind,
            x: entry.x,
            y: entry.y,
            heading: entry.heading,
          }
        : {
            id: entry.id,
            kind: entry.kind,
            x: entry.x,
            y: entry.y,
            heading: entry.heading,
            variant,
          },
    );
  }
  return parsed;
}

/**
 * HARD SINGLETON, PER HABITAT REGIME. Each habitat holds at most this many
 * living monsters, of any kind that lives there, ever, at once.
 *
 * ONE PER HABITAT, NOT ONE PER WORLD (owner decision, 2026-08-14 — superseding
 * the world-wide cap of one). The owner's original brief was "no more than one
 * per map", and it was written as a single world-wide slot because every kind
 * that existed lived in the sea: two sea horrors in one ocean is a bestiary, and
 * the dramatic weight of this plugin is that the thing in the water is THE thing
 * in the water.
 *
 * A MOUNTAIN YETI DOES NOT CONTEND FOR THAT. He occupies a disjoint half of the
 * heightmap: no player can see him and the kraken in one frame without also
 * seeing the sea and a snow line, and a world where digging a trench silently
 * cost you the yeti on the peak you spent an hour building reads as a BUG rather
 * than as scarcity. Scarcity is preserved exactly where it means something — the
 * sea still holds one thing, and the snow still holds one thing.
 *
 * The invariant remains STRUCTURAL rather than counted: summoning.ts holds one
 * nullable slot per regime, so a second monster in one habitat is
 * unrepresentable (see the note at the top of that file).
 *
 * SUPERSEDED 2026-08-19 (owner decision: "let's allow multiple sea monsters to
 * spawn" — the kraken had never once appeared, because Cthulhu takes the sea
 * slot first and nothing short of his impossible banishment frees it). The
 * singleton is now PER KIND, not per habitat: the sea may hold one Cthulhu AND
 * one kraken at once. Everything the paragraphs above argue survives at the
 * kind level — an arrival is still an event, and "the thing in the water" is
 * still the only one of ITS kind in the water; what changes is that two
 * different horrors no longer contend for one slot. The structural invariant
 * moves with it: summoning.ts now holds one nullable slot per KIND (a total
 * record over MonsterKind), so two krakens stay unrepresentable.
 */
export const MAX_LIVING_MONSTERS_PER_KIND = 1;

/**
 * The world-wide ceiling, DERIVED rather than chosen: one per kind, times the
 * kinds that exist. Three today (was: one per habitat, times the habitats —
 * two — until the 2026-08-19 per-kind decision above).
 *
 * It is what the broadcast's bandwidth note and the client's reconcile are sized
 * against, and it is the name to grep for the day the shape of this changes
 * again.
 */
export const MAX_LIVING_MONSTERS = MAX_LIVING_MONSTERS_PER_KIND * MONSTER_KINDS.length;



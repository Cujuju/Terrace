// wildlife — the wire contract between the plugin's two halves.
//
// This module is imported by BOTH server/ and client/ and must therefore stay
// dependency-free (no three, no node builtins) and side-effect-free. It is the
// plugin-local equivalent of @terrace/shared: one definition of the payload, so
// the halves cannot drift.
//
// Namespacing: the hosts prefix `wildlife:` on the wire in both directions, so
// every type here is the UN-namespaced form (see server/src/plugins/host.ts and
// client/src/plugins/host.ts).

/** Plugin name on both sides. Also the message namespace. */
export const WILDLIFE_PLUGIN_NAME = 'wildlife';

/**
 * Un-namespaced type of the server → client population push (`wildlife:entities`).
 * There is exactly one message type: v1 syncs the FULL entity list every time
 * (see the cadence note in server/index.ts), so there is no spawn/despawn/move
 * message trio to keep consistent.
 */
export const WILDLIFE_ENTITIES_MESSAGE = 'entities';

/**
 * The HABITAT species: the ones the census counts, the population equilibrium
 * regulates, and the habitat/unlock steering confines. Ordered; this order is
 * also the deterministic order in which spawning considers species, so a habitat
 * that can only support a few more creatures fills predictably rather than by
 * whichever key `for…in` yielded.
 *
 * A species is in this list exactly when it has a `habitat` — a class of cell it
 * must stand in — which is what every piece of the population machinery is
 * written against. Birds are not (see WILDLIFE_FLOCK_SPECIES): the sky is not a
 * cell class, so there is nothing for a census to count.
 */
export const WILDLIFE_HABITAT_SPECIES = ['fish', 'whale', 'deepsea', 'grazer'] as const;

export type WildlifeHabitatSpecies = (typeof WILDLIFE_HABITAT_SPECIES)[number];

/**
 * The FLOCK species: transient ambience that crosses the world overhead and
 * leaves at the far side, spawned by its own lightweight timer
 * (server/flocks.ts) rather than by a habitat census.
 *
 * They are listed separately, and the two lists are separate TYPES, because the
 * split is a real one and the compiler is the right place to enforce it: a bird
 * has no habitat, no census target, and no respawn credit, so every function
 * that needs one of those takes a WildlifeHabitatSpecies and simply cannot be
 * handed a bird. Adding 'bird' to one flat list instead would have meant a
 * `habitat: never` in the profile table and a runtime skip in five loops.
 */
export const WILDLIFE_FLOCK_SPECIES = ['bird'] as const;

export type WildlifeFlockSpecies = (typeof WILDLIFE_FLOCK_SPECIES)[number];

/**
 * Every species that can appear on the wire — the client's render vocabulary.
 * Derived from the two lists above rather than typed out a third time, so a new
 * species is added in exactly one place.
 */
export const WILDLIFE_SPECIES = [
  ...WILDLIFE_HABITAT_SPECIES,
  ...WILDLIFE_FLOCK_SPECIES,
] as const;

export type WildlifeSpecies = (typeof WILDLIFE_SPECIES)[number];

/**
 * The size classes an individual can be born at, smallest first.
 *
 * Fish and whales vary (FISH_SIZE_WEIGHTS / WHALE_SIZE_WEIGHTS in
 * server/species.ts); the deep-sea creature and the grazer are always
 * DEFAULT_SIZE_CLASS. The class is drawn once at spawn and never changes, which
 * is why the client can bake it into the model at creation time instead of
 * re-reading it every frame.
 *
 * Ordered, and the ORDER IS THE WIRE FORM: an entity carries the INDEX into this
 * array, not the name. That is what keeps the field to a single msgpack byte —
 * see the bandwidth note in server/index.ts.
 */
export const WILDLIFE_SIZE_CLASSES = ['small', 'medium', 'large'] as const;

export type WildlifeSizeClass = (typeof WILDLIFE_SIZE_CLASSES)[number];

/**
 * The class everything that does not vary in size is born at, and the fallback
 * for a payload that carries no size at all (see parseEntitiesPayload). Middle
 * of the range, and its model scale is exactly 1, so "no size information" and
 * "the size this plugin has always drawn" are the same picture.
 */
export const DEFAULT_SIZE_CLASS: WildlifeSizeClass = 'medium';

export const DEFAULT_SIZE_CLASS_INDEX = WILDLIFE_SIZE_CLASSES.indexOf(DEFAULT_SIZE_CLASS);

/**
 * Uniform scale applied to a creature's model for its size class.
 *
 * Medium is 1 by definition: the models in client/models.ts are authored at
 * medium, so every existing dimension in that file (and every clearance in
 * client/placement.ts, which was sized against those dimensions) keeps meaning
 * exactly what it meant. The spread either side is ±~40%, which is the smallest
 * ratio that still reads as "that one is a bigger fish" at the distance this
 * game is played from — a 20% difference is invisible once two fish are not
 * side by side, and 2× would make a large fish compete with the deep-sea
 * silhouette for attention.
 *
 * WHAT THE CLEARANCES DO ABOUT THIS. They scale by the same factor — see
 * swimmerWorldY (client/placement.ts), which takes the model scale as a required
 * argument. An earlier version of this paragraph justified that with arithmetic
 * that was WRONG ABOUT THE FISH (corrected 2026-08-22): it read ellipsoid()'s
 * FULL height argument as a half-extent and concluded a large fish stands
 * 1.4 × 0.26 = 0.36 world units tall, outside the 0.3 minimum submergence — a
 * bug fish never had. ellipsoid() scales a sphere of radius 0.5, so its three
 * arguments are FULL extents: the fish body is ellipsoid(0.55, 0.26, 0.18),
 * its half-height is 0.13, and at 1.4× that is 0.182 against the 0.3 minimum —
 * comfortably inside, as it always was. The conclusion survives on the WHALE's
 * numbers, and they are the reason the scaling is still necessary:
 * WHALE_ENVELOPE (client/whaleSpecies.ts) IS a half-extent envelope, measured
 * from the model's bounding box (crownY 0.670, bellyY -0.575), so at the large
 * class those become 1.4 × 0.670 = 0.938 and 1.4 × 0.575 = 0.805, against the
 * whale swim profile's minSubmergence 0.7 and minClearance 0.7
 * (client/placement.ts). An unscaled clearance would have put a large whale's
 * belly ~0.1 world units into the seabed and its dorsal ~0.24 above the
 * waterline.
 */
export const WILDLIFE_SIZE_MODEL_SCALE: Readonly<Record<WildlifeSizeClass, number>> = {
  small: 0.6,
  medium: 1,
  large: 1.4,
};

/** Wire index → class, with anything out of range falling back to the default. */
export function sizeClassAt(index: number): WildlifeSizeClass {
  return WILDLIFE_SIZE_CLASSES[index] ?? DEFAULT_SIZE_CLASS;
}

/** Class → wire index. */
export function sizeClassIndex(sizeClass: WildlifeSizeClass): number {
  return WILDLIFE_SIZE_CLASSES.indexOf(sizeClass);
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

/** One creature, as it appears on the wire. */
export interface WildlifeEntityState {
  /** Stable for the creature's whole life; the client keys interpolation by it. */
  readonly id: number;
  readonly species: WildlifeSpecies;
  /** Cell-space position (fractional). World X/Z, since CELL_WORLD_SIZE is 1. */
  readonly x: number;
  readonly y: number;
  /** Radians; the creature moves toward (cos heading, sin heading) in cell space. */
  readonly heading: number;
  /**
   * Index into WILDLIFE_SIZE_CLASSES. Drives the model scale and nothing else on
   * this side; the server also uses the class to decide how strongly this
   * individual schools, but schooling itself is never sent — the client draws
   * where the server says each creature is and has no concept of a school.
   *
   * OPTIONAL ON THE WIRE, always present after parsing. A server built before
   * size classes existed omits it, and the honest reading of that payload is
   * "these are ordinary medium creatures", not "drop them all" — which is what a
   * required field would have meant for a client on a newer bundle than its
   * self-hosted server.
   */
  readonly size: number;
}

export interface WildlifeEntitiesPayload {
  readonly entities: readonly WildlifeEntityState[];
}

export function isWildlifeSpecies(value: unknown): value is WildlifeSpecies {
  return (WILDLIFE_SPECIES as readonly string[]).includes(value as string);
}

/** Narrower guard: is this one of the census-driven, habitat-bound species? */
export function isWildlifeHabitatSpecies(value: unknown): value is WildlifeHabitatSpecies {
  return (WILDLIFE_HABITAT_SPECIES as readonly string[]).includes(value as string);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Defensive parse of a received payload.
 *
 * The client trusts the server, but "trusts" is not "assumes well-formed": a
 * version skew between a self-hoster's server and a cached client bundle is a
 * completely ordinary event, and the right failure mode is "some creatures are
 * missing this frame", never a thrown exception inside the render loop. Unknown
 * species and malformed entries are dropped individually; a payload that is not
 * a list at all yields null so the caller can ignore the message entirely.
 */
export function parseEntitiesPayload(payload: unknown): WildlifeEntityState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const entities = (payload as { entities?: unknown }).entities;
  if (!Array.isArray(entities)) return null;

  const parsed: WildlifeEntityState[] = [];
  for (const raw of entities) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<WildlifeEntityState>;
    if (!isFiniteNumber(entry.id)) continue;
    if (!isWildlifeSpecies(entry.species)) continue;
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y)) continue;
    if (!isFiniteNumber(entry.heading)) continue;
    parsed.push({
      id: entry.id,
      species: entry.species,
      x: entry.x,
      y: entry.y,
      heading: entry.heading,
      // Absent or nonsense → the default class. Normalising here means every
      // consumer downstream can treat `size` as a valid index unconditionally.
      size: isFiniteNumber(entry.size)
        ? sizeClassIndex(sizeClassAt(entry.size))
        : DEFAULT_SIZE_CLASS_INDEX,
    });
  }
  return parsed;
}

/**
 * Hard ceiling on living creatures, whatever the habitat census says.
 *
 * 850 is a bandwidth number, not an ecology one (100 → 150 on 2026-08-14 with
 * the density retune in species.ts; 150 → 850 on 2026-08-23). The full-state
 * broadcast costs roughly 58 B per creature once msgpack has encoded the six
 * keys and their values — 52 B for the original five, plus 6 B for the `size`
 * key and its single-byte class index (protocol.ts) — so:
 *
 *   850 × 58 B          = 48.1 KB per message
 *   × 5 Hz              = 240.7 KB/s ≈ 1.97 Mbit/s of steady downstream PER CLIENT
 *   × ~10 players       ≈ 19.7 Mbit/s of server upstream on wildlife alone
 *
 * (The 5 Hz cadence and why it is not 10 Hz are argued in server/index.ts.)
 *
 * WHY IT MOVED, AND WHAT IT COSTS (owner, 2026-08-23: "increase the wildlife
 * population cap and restore the numbers for fish, deep sea, and whales"). The
 * grazer density was cut 27-fold the same day (species.ts), which on a fully
 * revealed world takes the total ask from 270 to 1 532 — and because this cap
 * divides the budget PROPORTIONALLY, holding it at 150 would have paid for the
 * hillside out of the sea: 72 fish down to 12, 21 whales down to 3. 850 is the
 * number that leaves fish, deepsea and whales at exactly the counts they had
 * before the grazer cut (72 / 28 / 21); anything from 845 to 853 does, and 850
 * is the round one.
 *
 * THE HONEST PRICE is the table above: 348 kbit/s per client becomes 1.97
 * Mbit/s, and ten concurrent players now cost ~19.7 Mbit/s of upstream on
 * wildlife alone. That is no longer a fraction of a modest home connection, and
 * it is what stops this going higher — a self-hoster on domestic upstream is
 * the constraint, not the client's ability to render the creatures.
 *
 * IT STILL BINDS only on a fully revealed 512-unit world, which is a
 * hypothetical: every world that exists is ocean with an island, where the
 * total ask is a handful and this number is never reached. See species.ts's
 * header table and the exact assertion in wildlife.test.ts.
 *
 * SCOPE, since 2026-08-14: this caps the HABITAT population only. Birds are not
 * censused and do not consume it (server/flocks.ts); their own hard ceiling is
 * MAX_BIRDS_ALOFT, and the two together are what the broadcast actually costs.
 * The combined arithmetic lives in server/index.ts's header, in one place, so
 * there is a single answer to "what does a full message weigh".
 */
export const WILDLIFE_POPULATION_CAP = 850;

/**
 * Birds in a flock: a uniform draw over this inclusive range.
 *
 * A range rather than a constant so no two crossings look like the same asset
 * played twice. 5 is the floor at which cohesion reads as flocking rather than
 * as a few birds that happen to be near each other (it is also the fish
 * groupSize, for the same reason); 9 is what MAX_BIRDS_ALOFT can afford twice
 * over, and past ~10 the individual birds stop being countable and the flock
 * gains nothing but payload.
 */
export const BIRDS_PER_FLOCK_MIN = 5;
export const BIRDS_PER_FLOCK_MAX = 9;

/**
 * Flocks aloft at once. TWO, and it is a bandwidth number before it is an
 * aesthetic one — see the combined budget in ./index.ts.
 *
 * Two is also the smallest number that makes the sky feel inhabited rather than
 * scripted: with one, a player who watches a flock leave knows the sky is now
 * empty until the timer fires again.
 */
export const MAX_CONCURRENT_FLOCKS = 2;

/**
 * Hard ceiling on birds on the wire. Derived, never written by hand — it is the
 * number the bandwidth arithmetic in ./index.ts consumes.
 */
export const MAX_BIRDS_ALOFT = MAX_CONCURRENT_FLOCKS * BIRDS_PER_FLOCK_MAX;

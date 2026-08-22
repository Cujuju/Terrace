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
 * argument. This paragraph used to claim the opposite: that the largest fish is
 * 1.4 × 0.26 = 0.36 world units tall and so sits "comfortably inside the 0.3
 * minimum submergence", which is arithmetic that says the exact reverse of its
 * own conclusion — 0.36 is 0.06 OUTSIDE 0.3, and a large fish's dorsal has been
 * poking through the sea surface ever since. Found 2026-08-21 while giving
 * whales size classes, where the same error is six times larger.
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

/**
 * Decimal places kept on broadcast cell coordinates. 1/100 of a cell — two
 * orders of magnitude finer than the smallest creature (a fish is 0.7 cells
 * long) and far below what any camera distance in this game can resolve, so it
 * costs nothing visible. It buys a payload whose encoded size is bounded and,
 * more usefully, one that a test can assert on exactly.
 */
export const WILDLIFE_POSITION_DECIMALS = 2;

const POSITION_QUANTUM = 10 ** WILDLIFE_POSITION_DECIMALS;

/** Rounds a cell-space coordinate to the broadcast precision. */
export function roundBroadcastPosition(value: number): number {
  return Math.round(value * POSITION_QUANTUM) / POSITION_QUANTUM;
}

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

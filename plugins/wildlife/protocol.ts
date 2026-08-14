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
 * The species that exist. Ordered; this order is also the deterministic order in
 * which spawning considers species, so a habitat that can only support a few
 * more creatures fills predictably rather than by whichever key `for…in` yielded.
 */
export const WILDLIFE_SPECIES = ['fish', 'whale', 'deepsea', 'grazer'] as const;

export type WildlifeSpecies = (typeof WILDLIFE_SPECIES)[number];

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
}

export interface WildlifeEntitiesPayload {
  readonly entities: readonly WildlifeEntityState[];
}

export function isWildlifeSpecies(value: unknown): value is WildlifeSpecies {
  return (WILDLIFE_SPECIES as readonly string[]).includes(value as string);
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
    });
  }
  return parsed;
}

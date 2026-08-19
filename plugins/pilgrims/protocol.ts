// pilgrims — the wire contract between the plugin's two halves.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free — the plugin-local equivalent of
// @terrace/shared, exactly as every other plugin's protocol.ts is.
//
// THE MECHANIC IN ONE PARAGRAPH (card 47, owner-picked 2026-08-19). When a
// monster stays put long enough, the people notice: nearby settlements each
// send one pilgrim — a little dog person from a Rudy town, a cat person from
// an Uno town — who walks to a safe viewpoint, watches a while, and walks
// home. Towns with a pilgrim on the road prosper (the structures plugin's
// route blessing). The server owns the whole simulation; this wire carries
// only "where every pilgrim is right now".
//
// SYNC: FULL STATE ON A CADENCE — wildlife's exact choice, for wildlife's
// exact reasons (self-healing, no join handshake, bounded cost; see
// wildlife/server/index.ts's header). The bound here is far smaller: at most
// PILGRIMS_CAP walkers of five short fields each.

/** Plugin name on both sides. Also the message namespace. */
export const PILGRIMS_PLUGIN_NAME = 'pilgrims';

/** Un-namespaced type of the server → client push (`pilgrims:entities`). */
export const PILGRIMS_ENTITIES_MESSAGE = 'entities';

/**
 * Hard ceiling on pilgrims abroad at once — the wire and client-instance
 * bound.
 *
 * 24: at ~50 B per entity under msgpack (five short-keyed fields) a full
 * message is ~1.2 KB; at the 5 Hz broadcast cadence that is ~48 kbit/s per
 * client, an eighth of what wildlife's population costs, so it disappears
 * into the same budget. On the world side, 24 is also plenty of road life:
 * it is more settlements than a single monster's catchment has ever held in
 * play, so the cap is a guarantee, not a queue players will notice.
 */
export const PILGRIMS_CAP = 24;

/**
 * The walker kinds this wire carries. 'pilgrim' is the original journey-to-a-
 * monster walker (card 47); 'wanderer' is ambient town-to-town strolling
 * (card 26, "Peeps", owner-picked 2026-08-19) — purely cosmetic, no blessing,
 * no gameplay effect. One wire for both: they share every field, and a second
 * message type would duplicate the interpolator and the fog plumbing for no
 * contract gain.
 */
export const WALKER_KINDS = ['pilgrim', 'wanderer'] as const;

export type WalkerKind = (typeof WALKER_KINDS)[number];

export function isWalkerKind(value: unknown): value is WalkerKind {
  return (WALKER_KINDS as readonly string[]).includes(value as string);
}

/**
 * Hard ceiling on wanderers abroad at once.
 *
 * 16 — deliberately BELOW the pilgrim cap: a pilgrimage is an event the
 * player caused (a monster settled), so it may crowd; wandering is standing
 * background and must never read as a swarm. On the wire the combined worst
 * case (24 + 16 rows, six short fields) is ~2 KB per message, ~80 kbit/s at
 * the 5 Hz cadence — still around a quarter of wildlife's budget, so both
 * walker kinds together disappear into the same allowance.
 */
export const WANDERERS_CAP = 16;

/** The most walker rows one entities message may carry (both kinds). */
export const WALKERS_WIRE_CAP = PILGRIMS_CAP + WANDERERS_CAP;

// ─────────────────────────────────────────────────────────────────────────────
// Settler races — OWN COPY of the structures plugin's derivation (its
// protocol.ts, commit 5756ef2). Copied, not imported: every plugin must build
// and test with every other plugin deleted (the rule flora/structures state
// beside their own hash copies). The two functions MUST stay byte-for-byte in
// agreement — both suites pin the same golden vectors, so a drift fails
// loudly on whichever side moved.
// ─────────────────────────────────────────────────────────────────────────────

/** The two settler races. Order is meaningful: index = the race hash bit. */
export const SETTLER_RACES = ['rudy', 'uno'] as const;

export type SettlerRace = (typeof SETTLER_RACES)[number];

/** Edge, in cells, of the square district that shares one race. */
export const SETTLER_DISTRICT_CELLS = 16;

/** 32-bit integer hash of a cell — the same function every plugin carries. */
export function hashCell(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The race of the settlement standing at cell (x, y) — structures' rule. */
export function settlementRace(x: number, y: number): SettlerRace {
  const districtX = Math.floor(x / SETTLER_DISTRICT_CELLS);
  const districtY = Math.floor(y / SETTLER_DISTRICT_CELLS);
  return SETTLER_RACES[(hashCell(districtX, districtY) >>> 24) & 1];
}

export function isSettlerRace(value: unknown): value is SettlerRace {
  return (SETTLER_RACES as readonly string[]).includes(value as string);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decimal places kept on broadcast cell coordinates — wildlife's choice
 * (1/100 cell), for the same "bounded payload, exactly assertable" reasons.
 */
export const PILGRIMS_POSITION_DECIMALS = 2;

const POSITION_QUANTUM = 10 ** PILGRIMS_POSITION_DECIMALS;

/** Rounds a cell-space coordinate to the broadcast precision. */
export function roundBroadcastPosition(value: number): number {
  return Math.round(value * POSITION_QUANTUM) / POSITION_QUANTUM;
}

/** One walker (pilgrim or wanderer), as it appears on the wire. */
export interface PilgrimEntityState {
  /** Stable for the walker's whole journey; the client keys views by it.
   *  Ids are unique ACROSS kinds (one allocator feeds both sims). */
  readonly id: number;
  /** What kind of journey this is — decides the model (pilgrims carry a
   *  staff, wanderers don't) and nothing else. */
  readonly kind: WalkerKind;
  readonly race: SettlerRace;
  /** Cell-space position (fractional). World X/Z, since CELL_WORLD_SIZE is 1. */
  readonly x: number;
  readonly y: number;
  /** Radians; the walker walks toward (cos heading, sin heading). */
  readonly heading: number;
}

export interface PilgrimsEntitiesPayload {
  readonly pilgrims: readonly PilgrimEntityState[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Defensive parse of a received payload — wildlife's contract verbatim:
 * malformed entries are dropped individually (a version-skewed self-hosted
 * server is an ordinary event, and the failure mode must be "a pilgrim is
 * missing this frame", never a throw in the render loop); a payload that is
 * not a list at all yields null so the caller ignores the message whole.
 */
export function parseEntitiesPayload(payload: unknown): PilgrimEntityState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const pilgrims = (payload as { pilgrims?: unknown }).pilgrims;
  if (!Array.isArray(pilgrims)) return null;

  const parsed: PilgrimEntityState[] = [];
  for (const raw of pilgrims) {
    if (parsed.length >= WALKERS_WIRE_CAP) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<PilgrimEntityState>;
    if (!isFiniteNumber(entry.id)) continue;
    if (!isSettlerRace(entry.race)) continue;
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y)) continue;
    if (!isFiniteNumber(entry.heading)) continue;
    // A missing kind is a row from a pre-wanderer server, which only ever
    // sent pilgrims — additive-field rule, same as the join snapshot's
    // optional fields: absent means the old meaning, never a guess. An
    // UNRECOGNIZED kind is a newer server than this client; drop the row
    // (the render loop must never meet a model it cannot build).
    let kind: WalkerKind;
    if (entry.kind === undefined) kind = 'pilgrim';
    else if (isWalkerKind(entry.kind)) kind = entry.kind;
    else continue;
    parsed.push({
      id: entry.id,
      kind,
      race: entry.race,
      x: entry.x,
      y: entry.y,
      heading: entry.heading,
    });
  }
  return parsed;
}

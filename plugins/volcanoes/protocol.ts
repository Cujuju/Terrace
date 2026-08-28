// volcanoes — the wire contract between the plugin's two halves, and the
// vocabulary its per-world setting is written in.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free — the plugin-local equivalent of
// @terrace/shared, exactly as boats/protocol.ts and structures/protocol.ts are
// for their plugins.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FICTION (issue #214, owner 2026-08-26).
//
// A VENT is a place where the world's deepest strata reach the surface. Core
// already owns the geology: below the sea column the range continues through
// basalt, obsidian and one lava band at MIN_HEIGHT (docs/DESIGN.md, Deep Strata
// 2026-08-19), and that section closes with the rule this whole plugin exists
// under — "Hazards are NOT core. Heat, eruptions, anything gamey in the deep is
// a future plugin reading these same boundary constants."
//
// So: core says where the lava band IS. This plugin says what comes out of it.
//
// A vent sits dormant, wakes, erupts, and goes back to sleep. Each eruption
// builds its cone a little higher and sends a lava front downhill, which cools
// into new rock behind it. Fresh water stops the front dead — steam, not stone.
//
// ─────────────────────────────────────────────────────────────────────────────
// COOLED LAVA IS THIS PLUGIN'S OVERLAY, NOT A NEW CORE TERRAIN BAND.
//
// Issue #214 left that open. It is not open: the Deep Strata decision already
// ruled that hazards are not core, and a "cooled lava" band would be a gameplay
// concern inside shared/'s deterministic terrain contract — the one thing
// CLAUDE.md's hard rules forbid outright. What the flow leaves behind in CORE
// terms is ordinary raised ground (the sculpt really happened, and every client
// that ever streams the chunk sees the same heights). What makes it READ as
// lava is a decal this plugin's client half draws over those cells, on the
// SAME lifetime the server broadcasts. Delete the plugin and the mountain
// stays; only the glow goes.
// ─────────────────────────────────────────────────────────────────────────────

/** Plugin name on both sides. Also the message namespace. */
export const VOLCANOES_PLUGIN_NAME = 'volcanoes';

/**
 * Server → client, EVERYTHING this plugin currently has (`volcanoes:all`).
 *
 * Sent on join and on a slow keepalive, never per tick — see
 * VOLCANOES_CHANGES_MESSAGE for why the steady state is a delta stream and
 * this one is the repair cadence. The structures/flora shape, for the same
 * reason: what this plugin draws is CONTENT THAT DOES NOT MOVE once placed.
 */
export const VOLCANOES_ALL_MESSAGE = 'all';

/**
 * Server → client, what changed (`volcanoes:changes`).
 *
 * WHY A DELTA AND NOT A FULL REPLACE, which is what weather, wildlife, monsters
 * and boats all chose. Those broadcast things that MOVE, so there is no quiet
 * steady state for a delta to exploit and a replace message is both smaller and
 * impossible to desync. A lava cell is the opposite: it appears once, never
 * moves, and then spends a minute and a half cooling on a clock the client can
 * run for itself. Replacing the whole flow at 1 Hz would put a few kilobytes a
 * second on every client's wire to re-state cells that have not changed and
 * whose only time-varying quantity — the heat — is a pure function of an age
 * the client was already told.
 *
 * `vents` is always the COMPLETE vent list rather than a delta of it: there are
 * a handful of vents in a world (MAX_VENTS_PER_WORLD), a vent's `erupting` flag
 * flips often, and a list that short is cheaper to replace than to reconcile.
 */
export const VOLCANOES_CHANGES_MESSAGE = 'changes';

/**
 * The per-world setting this plugin offers the operator, and its vocabulary
 * (issue #214: "Per-world `settings`: none | dormant | active").
 *
 *   none    — no volcanoes at all. Nothing is seeded, nothing is born, nothing
 *             erupts. A world that has already grown cones keeps the LAND it
 *             was given (the sculpts really happened) and stops being told
 *             anything about it — the plugin runs inert, exactly as if it had
 *             been uninstalled, which is what makes this setting a safe thing
 *             for an operator to reach for on a live world.
 *   dormant — vents exist as geology. Genesis sites them, and a player who digs
 *             down into the lava band opens a new one, but none of them ever
 *             erupts. Volcanic scenery with no volcanic events.
 *   active  — the whole mechanic: eruptions, lava, ash, and the rare
 *             spontaneous birth of a brand-new vent.
 */
export const VOLCANOES_ACTIVITY_SETTING_KEY = 'activity';

export type VolcanicActivity = 'none' | 'dormant' | 'active';

/** Every value the setting accepts, in the order the world panel shows them. */
export const VOLCANIC_ACTIVITIES: readonly VolcanicActivity[] = [
  'none',
  'dormant',
  'active',
];

/**
 * In force where the world file has no row.
 *
 * `dormant`, NOT `active`, and the choice is about what an operator who has
 * never heard of this plugin should wake up to. `active` means the terrain
 * rewrites itself unattended — a cone grows, a flow fills a valley — and doing
 * that to somebody's world because they happened to pull a new plugins/ folder
 * is the kind of surprise that is only ever discovered after it has landed on
 * something they built. `dormant` gives the same world the same mountains and
 * changes nothing else, and the operator turns it up when they mean to.
 */
export const DEFAULT_VOLCANIC_ACTIVITY: VolcanicActivity = 'dormant';

/** Narrows an operator's stored string, falling back to the default. */
export function parseActivity(value: string | undefined): VolcanicActivity {
  const found = VOLCANIC_ACTIVITIES.find((activity) => activity === value);
  return found ?? DEFAULT_VOLCANIC_ACTIVITY;
}

/** One vent, as broadcast. */
export interface VentState {
  /** Stable for the vent's whole life; never reused. */
  readonly id: number;
  /** Cell-space position of the vent mouth. Integers; a vent never moves. */
  readonly x: number;
  readonly y: number;
  /** True while it is throwing lava and ash. */
  readonly erupting: boolean;
}

/**
 * One cell of lava, as broadcast.
 *
 * `ageSeconds` RATHER THAN a heat scalar, deliberately: heat is a pure function
 * of age (server/flow.ts's heatFromAge, restated on the client), so sending the
 * age lets a client run the cooling curve itself between messages instead of
 * being re-told a number that only ever counts down. It is what makes the
 * keepalive a REPAIR cadence rather than a sync mechanism.
 */
export interface LavaCellState {
  readonly x: number;
  readonly y: number;
  /** Simulated seconds since this cell went molten. */
  readonly ageSeconds: number;
}

/** `volcanoes:all` — the complete state. */
export interface VolcanoesAllPayload {
  readonly vents: readonly VentState[];
  readonly lava: readonly LavaCellState[];
}

/** `volcanoes:changes` — the vent list, plus what happened to the flow. */
export interface VolcanoesChangesPayload {
  readonly vents: readonly VentState[];
  /** Cells that went molten since the last message. */
  readonly molten: readonly LavaCellState[];
  /** Cells the server has stopped tracking; the client forgets them too. */
  readonly forgotten: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

/**
 * How long a cell takes to go from molten to cold, in SIMULATED seconds.
 *
 * IN THE PROTOCOL, not in the server's ./server/flow.ts, because BOTH HALVES
 * RUN THE SAME CURVE and two copies of it would drift: the server ages a cell
 * to decide when to stop counting it hot, and the client runs the identical
 * curve between messages so that a flow keeps cooling smoothly instead of
 * stepping once per keepalive. That shared curve is the whole reason the wire
 * carries an AGE rather than a heat (see LavaCellState).
 *
 * 90 s is chosen against the eruption, not against physics: an eruption runs
 * ERUPTION_SECONDS (60) and the flow behind the front has to still be glowing
 * when the front stops, or the player never sees a lit flow — only a lit dot
 * with a dark trail, which reads as a bug rather than as lava.
 */
export const LAVA_COOL_SECONDS = 90;

/** How hot a cell of that age still is, on 0 (cold crust) … 1 (molten). */
export function heatFromAge(ageSeconds: number): number {
  if (!(ageSeconds > 0)) return 1;
  if (ageSeconds >= LAVA_COOL_SECONDS) return 0;
  return 1 - ageSeconds / LAVA_COOL_SECONDS;
}

/** Packs a cell into one integer key. */
export function lavaKey(x: number, y: number): number {
  // The same shape structures' structureKey uses. A world edge is far below
  // 2^16, so the pair fits in a safe integer with room to spare.
  return y * 0x10000 + x;
}

function isCell(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y } = value as Record<string, unknown>;
  return Number.isInteger(x) && Number.isInteger(y);
}

function parseVent(value: unknown): VentState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, x, y, erupting } = value as Record<string, unknown>;
  if (!Number.isInteger(id) || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (typeof erupting !== 'boolean') return null;
  return { id: id as number, x: x as number, y: y as number, erupting };
}

function parseLavaCell(value: unknown): LavaCellState | null {
  if (!isCell(value)) return null;
  const { ageSeconds } = value as unknown as Record<string, unknown>;
  if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds)) return null;
  if (ageSeconds < 0) return null;
  return { x: value.x, y: value.y, ageSeconds: ageSeconds as number };
}

/**
 * Parses one list, returning null if ANY member is malformed.
 *
 * ALL-OR-NOTHING, the rule every plugin's parser in this repo follows: a
 * half-applied payload leaves the client drawing a world that never existed,
 * and the next good message is at most one keepalive away.
 */
function parseList<T>(value: unknown, parseOne: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: T[] = [];
  for (const item of value) {
    const one = parseOne(item);
    if (one === null) return null;
    parsed.push(one);
  }
  return parsed;
}

export function parseAllPayload(payload: unknown): VolcanoesAllPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { vents, lava } = payload as Record<string, unknown>;
  const parsedVents = parseList(vents, parseVent);
  const parsedLava = parseList(lava, parseLavaCell);
  if (parsedVents === null || parsedLava === null) return null;
  return { vents: parsedVents, lava: parsedLava };
}

export function parseChangesPayload(payload: unknown): VolcanoesChangesPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { vents, molten, forgotten } = payload as Record<string, unknown>;
  const parsedVents = parseList(vents, parseVent);
  const parsedMolten = parseList(molten, parseLavaCell);
  const parsedForgotten = parseList(forgotten, (item) => (isCell(item) ? item : null));
  if (parsedVents === null || parsedMolten === null || parsedForgotten === null) {
    return null;
  }
  return { vents: parsedVents, molten: parsedMolten, forgotten: parsedForgotten };
}

// relics — the wire contract, shared by this plugin's server and client halves.
//
// It sits at the plugin root (not under server/ or client/) for the same reason
// @terrace/shared sits outside client/ and server/: it is the ONE definition of
// what travels between the two halves. Neither half may restate a field name, a
// message type, or a skill id — if they drift, the plugin silently stops
// working and nothing in the type system notices.
//
// Message types here are UN-namespaced. Both hosts prefix `relics:` on the
// wire (server: WorldApi.broadcast/sendTo, client: ClientPluginCtx.send), so a
// plugin can never collide with a core message or with another plugin.
//
// Everything in this file must be safe for BOTH halves to import: no node:
// builtins, no DOM, no three, no solid — plain data and pure functions.

// ────────────────────────────────────────────────────────────────────────────
// Skills
// ────────────────────────────────────────────────────────────────────────────

/**
 * The three categories a relic can grant. The category is not decoration: it
 * decides which machinery a skill runs through, and the three exist to prove
 * three different reaches of the plugin API.
 *
 *   passive — rewrites the holder's own sculpt intents in the interceptor
 *             chain (TerracePlugin.onIntent → `modify`).
 *   active  — cast from the HUD at a chosen cell, applied with WorldApi.sculpt.
 *   perk    — reaches into ANOTHER plugin (mana) through its exported perk API.
 */
export type SkillKind = 'passive' | 'active' | 'perk';

/**
 * Every skill in the game, as a closed union. Ids are lowercase-dashed like
 * plugin names because they appear in persisted data and on the wire, where a
 * casing or separator ambiguity is a silent data bug.
 */
export type SkillId =
  | 'titans-hand'
  | 'quake'
  | 'genesis'
  | 'azure-heart'
  | 'spring-of-aether';

export interface SkillInfo {
  readonly id: SkillId;
  readonly kind: SkillKind;
  /** Short display name for the HUD. */
  readonly name: string;
  /** One line of HUD copy: what holding this skill does. */
  readonly description: string;
}

/**
 * The roster, in the order relics cycle through it (see RELIC_COUNT on the
 * server: one relic per skill, so every skill is obtainable at any moment and
 * a player is never stuck waiting for the one they want to appear).
 *
 * Ordered passive → active → perk so that the HUD, which renders in this
 * order, groups "always on" skills above the buttons you press.
 */
export const SKILLS: readonly SkillInfo[] = [
  {
    id: 'titans-hand',
    kind: 'passive',
    name: "Titan's Hand",
    description: 'Your sculpt brush is one cell wider.',
  },
  {
    id: 'quake',
    kind: 'active',
    name: 'Quake',
    description: 'Collapse a wide crater at a chosen cell.',
  },
  {
    id: 'genesis',
    kind: 'active',
    name: 'Genesis',
    description: 'Raise a small island at a chosen cell.',
  },
  {
    id: 'azure-heart',
    kind: 'perk',
    name: 'Azure Heart',
    description: 'Your sculpts cost half the mana.',
  },
  {
    id: 'spring-of-aether',
    kind: 'perk',
    name: 'Spring of Aether',
    description: 'Your mana regenerates twice as fast.',
  },
];

/** Roster ids in roster order. */
export const SKILL_IDS: readonly SkillId[] = SKILLS.map((skill) => skill.id);

/** Roster lookup. Built once; the roster is a module constant. */
const SKILLS_BY_ID = new Map<string, SkillInfo>(SKILLS.map((skill) => [skill.id, skill]));

/**
 * Narrows an untrusted value to a roster skill id.
 *
 * UNTRUSTED INPUT: this is the guard the server runs on the `skill` field of a
 * cast message, and the guard the client runs on anything the server sends it.
 * A closed roster means an unknown id can never reach a lookup.
 */
export function isSkillId(value: unknown): value is SkillId {
  return typeof value === 'string' && SKILLS_BY_ID.has(value);
}

/** Roster entry for a known skill id. */
export function skillInfo(id: SkillId): SkillInfo {
  // Safe: SkillId is closed and every member is in the roster by construction.
  return SKILLS_BY_ID.get(id) as SkillInfo;
}

// ────────────────────────────────────────────────────────────────────────────
// Message types (un-namespaced; hosts add the `relics:` prefix)
// ────────────────────────────────────────────────────────────────────────────

/** server → all clients: the full list of relics currently in the world. */
export const RELICS_MESSAGE = 'relics';

/** server → one client: that player's own skills and their cooldowns. */
export const SKILLS_MESSAGE = 'skills';

/** client → server: "I clicked this relic." */
export const COLLECT_MESSAGE = 'collect';

/** client → server: "cast this skill at this cell." */
export const CAST_MESSAGE = 'cast';

/** server → one client: a cast that was refused, and why. */
export const CAST_DENIED_MESSAGE = 'denied';

// ────────────────────────────────────────────────────────────────────────────
// Payloads
// ────────────────────────────────────────────────────────────────────────────

/** One relic as clients see it. Position is a cell, not world space. */
export interface RelicView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly skill: SkillId;
}

export interface RelicsPayload {
  readonly relics: readonly RelicView[];
}

/**
 * One held skill as its owner sees it. Cooldowns travel as seconds rather than
 * as a deadline timestamp: the two clocks are unsynchronised, and a remaining-
 * seconds value is correct on arrival no matter how far apart they are.
 * Passive and perk skills report zero for both fields.
 */
export interface SkillView {
  readonly id: SkillId;
  readonly kind: SkillKind;
  /** Full cooldown length, so the HUD can draw progress without a constant. */
  readonly cooldownS: number;
  readonly cooldownRemainingS: number;
}

export interface SkillsPayload {
  readonly skills: readonly SkillView[];
}

export interface CollectPayload {
  readonly id: string;
}

export interface CastPayload {
  readonly skill: SkillId;
  readonly x: number;
  readonly y: number;
}

/** Why a cast was refused. Values are the CAST_DENIED_* constants below. */
export interface CastDeniedPayload {
  readonly skill: string;
  readonly reason: string;
}

/** The player does not hold that skill (or it is not an active skill). */
export const CAST_DENIED_UNOWNED = 'unowned';
/** The skill is still cooling down. */
export const CAST_DENIED_COOLDOWN = 'cooldown';
/** The target cell is outside the world, or in territory not yet unlocked. */
export const CAST_DENIED_TARGET = 'target';

// ────────────────────────────────────────────────────────────────────────────
// Defensive parsers
//
// Both halves parse what they receive. The server's reasons are obvious (a
// client is hostile input). The client parses too, because a client that
// throws inside a message handler while a self-hoster is running a mismatched
// server version loses its whole HUD panel — degrading to "no relics shown" is
// strictly better, and these parsers are the single place that decision lives.
// ────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A cell coordinate: a non-negative integer inside a `worldSize` grid. */
export function isCellCoordinate(value: unknown, worldSize: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < worldSize;
}

/** Parses an inbound `collect`. Returns null for anything malformed. */
export function parseCollectPayload(payload: unknown): CollectPayload | null {
  if (!isRecord(payload)) return null;
  const { id } = payload;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id };
}

/**
 * Parses an inbound `cast` against the live world size. Coordinates are bounds-
 * checked here so the caller never hands an out-of-range centre to the brush
 * math, which throws rather than clamping (shared/heightmap.ts applyBrush).
 */
export function parseCastPayload(payload: unknown, worldSize: number): CastPayload | null {
  if (!isRecord(payload)) return null;
  const { skill, x, y } = payload;
  if (!isSkillId(skill)) return null;
  if (!isCellCoordinate(x, worldSize)) return null;
  if (!isCellCoordinate(y, worldSize)) return null;
  return { skill, x, y };
}

/** Parses a server → client relic list, dropping any entry that is malformed. */
export function parseRelicsPayload(payload: unknown): RelicView[] {
  if (!isRecord(payload) || !Array.isArray(payload.relics)) return [];

  const relics: RelicView[] = [];
  for (const entry of payload.relics) {
    if (!isRecord(entry)) continue;
    const { id, x, y, skill } = entry;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (!isSkillId(skill)) continue;
    relics.push({ id, x: x as number, y: y as number, skill });
  }
  return relics;
}

/** Non-negative finite seconds, or 0 — cooldowns can never be negative. */
function asSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/** Parses a server → client skill list, dropping any entry that is malformed. */
export function parseSkillsPayload(payload: unknown): SkillView[] {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) return [];

  const skills: SkillView[] = [];
  for (const entry of payload.skills) {
    if (!isRecord(entry)) continue;
    const { id } = entry;
    if (!isSkillId(id)) continue;
    // `kind` is a property of the roster, not of the message: trusting the
    // wire for it would let a version-skewed server render a passive skill as
    // a castable button. Take it from our own roster instead.
    skills.push({
      id,
      kind: skillInfo(id).kind,
      cooldownS: asSeconds(entry.cooldownS),
      cooldownRemainingS: asSeconds(entry.cooldownRemainingS),
    });
  }
  return skills;
}

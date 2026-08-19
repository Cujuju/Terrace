// The saga voice: pure functions that turn other plugins' events into
// chronicle lines. Everything here is deterministic string-building over
// already-validated data; all state (what counts as a "first", what was
// already told today) lives in server/index.ts.
//
// PARSING IS STRUCTURAL, BY DESIGN. The chronicle subscribes to emitters by
// NAME ('structures:changes'), never by importing their code — a plugin must
// build and test with every other plugin deleted (the rule flora's test
// support states, applied to code). So each event is validated here from
// `unknown`, exactly as untrusted client messages are, and anything
// malformed is silently ignored: a missing or newer-versioned emitter must
// degrade the saga, never crash it.

import { RACE_PLURAL, RACE_SINGULAR, type SettlerRace } from './races.ts';

/** A cell position inside an event payload. */
export interface EventCell {
  readonly x: number;
  readonly y: number;
}

/** A cell with the tier it reached. */
export interface EventTierCell extends EventCell {
  readonly tier: number;
}

/**
 * Defensive bound on any event's list length. The largest real emitter list
 * is structures' board cap (512); anything past 4096 is a malformed or
 * hostile payload, not a bigger world.
 */
export const EVENT_LIST_CAP = 4096;

/**
 * Homes lost at once, in one place, before the loss is saga-worthy. Below
 * three, the chronicle would be transcribing ordinary B3/S23 churn — the CA
 * kills isolated cells every generation as a matter of routine. Three homes
 * gone together is the smallest cluster that reads as an EVENT: a hamlet
 * lost, not a shack abandoned.
 */
export const CHRONICLE_CALAMITY_MIN_HOMES = 3;

/**
 * Display names for structure tiers, BY POSITION. A COPY of the structures
 * plugin's STRUCTURE_TIERS (protocol.ts, six tiers, camp → watchtower) with
 * dashes spaced for prose, not an import — see the module header for the
 * independence rule that forbids the import. If structures someday grows a
 * seventh tier the fallback below keeps lines truthful-if-plain until this
 * list is caught up.
 */
export const STRUCTURE_TIER_NAMES = [
  'camp',
  'hut',
  'timber house',
  'longhouse',
  'stone cottage',
  'watchtower',
] as const;

export function tierName(tier: number): string {
  return STRUCTURE_TIER_NAMES[tier] ?? `hall of the ${tier}th order`;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

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

function parseTierCellList(value: unknown): EventTierCell[] | null {
  if (!Array.isArray(value) || value.length > EVENT_LIST_CAP) return null;
  const cells: EventTierCell[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { x, y, tier } = item as { x?: unknown; y?: unknown; tier?: unknown };
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (!Number.isInteger(tier) || (tier as number) < 0) return null;
    cells.push({ x: x as number, y: y as number, tier: tier as number });
  }
  return cells;
}

/** structures:changes — the emitter's cause plus the three lists the saga reads. */
export interface StructuresChangesEvent {
  readonly cause: 'generation' | 'sculpt';
  readonly seeded: readonly EventCell[];
  readonly upgraded: readonly EventTierCell[];
  readonly died: readonly EventCell[];
}

export function parseStructuresChanges(payload: unknown): StructuresChangesEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { cause, seeded, upgraded, died } = payload as {
    cause?: unknown;
    seeded?: unknown;
    upgraded?: unknown;
    died?: unknown;
  };
  if (cause !== 'generation' && cause !== 'sculpt') return null;

  // Absent lists are empty lists: the sculpt-path emission carries only `died`.
  const seededCells = seeded === undefined ? [] : parseCellList(seeded);
  const upgradedCells = upgraded === undefined ? [] : parseTierCellList(upgraded);
  const diedCells = died === undefined ? [] : parseCellList(died);
  if (seededCells === null || upgradedCells === null || diedCells === null) return null;

  return { cause, seeded: seededCells, upgraded: upgradedCells, died: diedCells };
}

/** relics:collected — who took which skill, and where the gem floated. */
export interface RelicCollectedEvent {
  readonly label: string;
  readonly player: string;
  readonly x: number;
  readonly y: number;
}

export function parseRelicCollected(payload: unknown): RelicCollectedEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { label, player, x, y } = payload as {
    label?: unknown;
    player?: unknown;
    x?: unknown;
    y?: unknown;
  };
  if (typeof label !== 'string' || label.length === 0 || label.length > 64) return null;
  if (typeof player !== 'string' || player.length === 0 || player.length > 64) return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { label, player, x: x as number, y: y as number };
}

/** monsters:arrived / monsters:departed — a kind and where it happened. */
export interface MonsterEvent {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

export function parseMonsterEvent(payload: unknown): MonsterEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { kind, x, y } = payload as { kind?: unknown; x?: unknown; y?: unknown };
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > 32) return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { kind, x: x as number, y: y as number };
}

// ── Lines ────────────────────────────────────────────────────────────────────
// Each builder returns one finished sentence. The day is not embedded — the
// entry carries it as data and the client renders the day heading. Settlement
// lines name the PEOPLE (races.ts): a district is one race by construction,
// and every builder below is called with cells from a single chunk, which is
// exactly one district — so one line is always about one people.

export function seededLine(race: SettlerRace, place: string): string {
  return `${RACE_SINGULAR[race]} settlers pitched a new camp at ${place}.`;
}

export function firstTierLine(race: SettlerRace, tier: number, place: string): string {
  return `The ${RACE_PLURAL[race]} of ${place} raised the world's first ${tierName(tier)}.`;
}

export function calamityLine(homes: number, race: SettlerRace, place: string): string {
  return `Ruin took ${homes} ${RACE_SINGULAR[race]} homes at ${place}.`;
}

export function godsHandLine(homes: number, race: SettlerRace, place: string): string {
  return `The god's hand unmade ${homes} ${RACE_SINGULAR[race]} dwellings at ${place}.`;
}

export function relicLine(player: string, label: string): string {
  return `${player} took up the ${label}.`;
}

export function monsterArrivedLine(kind: string, place: string, isFirstEver: boolean): string {
  return isFirstEver
    ? `The first ${kind} in all the world was seen near ${place}.`
    : `A ${kind} returned to the lands near ${place}.`;
}

export function monsterDepartedLine(kind: string): string {
  return `The ${kind} was driven from the world.`;
}

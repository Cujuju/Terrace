import { RACE_PLURAL, RACE_SINGULAR, type SettlerRace } from './races.ts';

export interface EventCell {
  readonly x: number;
  readonly y: number;
}

export interface EventTierCell extends EventCell {
  readonly tier: number;
}

export const EVENT_LIST_CAP = 4096;

export const CHRONICLE_CALAMITY_MIN_HOMES = 3;

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

  const seededCells = seeded === undefined ? [] : parseCellList(seeded);
  const upgradedCells = upgraded === undefined ? [] : parseTierCellList(upgraded);
  const diedCells = died === undefined ? [] : parseCellList(died);
  if (seededCells === null || upgradedCells === null || diedCells === null) return null;

  return { cause, seeded: seededCells, upgraded: upgradedCells, died: diedCells };
}

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

export function wildfireLine(consumed: number, place: string): string {
  return `Fire took ${consumed} growing things near ${place}.`;
}

export interface FireBurnedEvent {
  readonly consumed: number;
  readonly x: number;
  readonly y: number;
}

export function parseFireBurned(payload: unknown): FireBurnedEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const event = payload as { consumed?: unknown; x?: unknown; y?: unknown };
  if (typeof event.consumed !== 'number' || !Number.isFinite(event.consumed)) return null;
  if (typeof event.x !== 'number' || typeof event.y !== 'number') return null;
  if (!Number.isInteger(event.x) || !Number.isInteger(event.y)) return null;
  if (event.consumed <= 0) return null;
  return { consumed: Math.floor(event.consumed), x: event.x, y: event.y };
}

export function monsterDepartedLine(kind: string): string {
  return `The ${kind} was driven from the world.`;
}

export function mudslideLine(cells: number, place: string): string {
  return `A hillside gave way near ${place} and ran ${cells} paces downhill.`;
}

export interface MudslideFlowEvent {
  readonly headX: number;
  readonly headY: number;
  readonly cellCount: number;
}

export function parseMudslideFlow(payload: unknown): MudslideFlowEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const event = payload as { headX?: unknown; headY?: unknown; cells?: unknown };
  if (!Number.isInteger(event.headX) || !Number.isInteger(event.headY)) return null;
  if (!Array.isArray(event.cells) || event.cells.length === 0) return null;
  if (event.cells.length > EVENT_LIST_CAP) return null;
  return {
    headX: event.headX as number,
    headY: event.headY as number,
    cellCount: event.cells.length,
  };
}

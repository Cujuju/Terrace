import { VILLAGE_MIN_TIER } from '../protocol.ts';
import { isFiniteNumber } from '@terrace/shared';

export const EVENT_LIST_CAP = 4096;

export interface EventCell {
  readonly x: number;
  readonly y: number;
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

export interface VillageChanges {
  readonly gained: readonly EventCell[];
  readonly lost: readonly EventCell[];
}

export function parseVillageChanges(payload: unknown): VillageChanges | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { upgraded, died } = payload as { upgraded?: unknown; died?: unknown };

  const gained: EventCell[] = [];
  if (upgraded !== undefined) {
    if (!Array.isArray(upgraded) || upgraded.length > EVENT_LIST_CAP) return null;
    for (const item of upgraded) {
      if (typeof item !== 'object' || item === null) return null;
      const { x, y, tier } = item as { x?: unknown; y?: unknown; tier?: unknown };
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(tier)) return null;
      if ((tier as number) >= VILLAGE_MIN_TIER) gained.push({ x: x as number, y: y as number });
    }
  }

  let lost: EventCell[] = [];
  if (died !== undefined) {
    const parsed = parseCellList(died);
    if (parsed === null) return null;
    lost = parsed;
  }

  return { gained, lost };
}

export interface MonsterSighting {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

export function parseMonsterSightings(payload: unknown): MonsterSighting[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { monsters } = payload as { monsters?: unknown };
  if (!Array.isArray(monsters) || monsters.length > EVENT_LIST_CAP) return null;

  const sightings: MonsterSighting[] = [];
  for (const item of monsters) {
    if (typeof item !== 'object' || item === null) return null;
    const { kind, x, y } = item as { kind?: unknown; x?: unknown; y?: unknown };
    if (typeof kind !== 'string' || !isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    sightings.push({ kind, x, y });
  }
  return sightings;
}

export const KRAKEN_KIND = 'kraken';

const MIN_SHOAL_MEMBERS = 1;

export interface ShoalSighting {
  readonly species: string;
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

export function parseShoalSightings(payload: unknown): ShoalSighting[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { shoals } = payload as { shoals?: unknown };
  if (!Array.isArray(shoals) || shoals.length > EVENT_LIST_CAP) return null;

  const sightings: ShoalSighting[] = [];
  for (const item of shoals) {
    if (typeof item !== 'object' || item === null) return null;
    const { species, x, y, count } = item as {
      species?: unknown;
      x?: unknown;
      y?: unknown;
      count?: unknown;
    };
    if (typeof species !== 'string' || !isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    if (!Number.isInteger(count) || (count as number) < MIN_SHOAL_MEMBERS) return null;
    sightings.push({ species, x, y, count: count as number });
  }
  return sightings;
}

export const PILGRIMS_PLUGIN_NAME = 'pilgrims';

export const PILGRIMS_ENTITIES_MESSAGE = 'entities';

export const PILGRIMS_CAP = 24;

export const WALKER_KINDS = ['pilgrim', 'wanderer', 'settler'] as const;

export type WalkerKind = (typeof WALKER_KINDS)[number];

export function isWalkerKind(value: unknown): value is WalkerKind {
  return (WALKER_KINDS as readonly string[]).includes(value as string);
}

export const WANDERERS_CAP = 16;

export const SETTLERS_CAP = 6;

export const WALKERS_WIRE_CAP = PILGRIMS_CAP + WANDERERS_CAP + SETTLERS_CAP;

import {
  WORLD_UNIT_CELLS,
  cellsAcross,
} from '@terrace/shared';
import { isFiniteNumber } from '@terrace/shared';

export const SETTLER_RACES = ['rudy', 'uno'] as const;

export type SettlerRace = (typeof SETTLER_RACES)[number];

export const SETTLER_DISTRICT_CELLS = cellsAcross(16);

export function hashCell(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function settlementRace(x: number, y: number): SettlerRace {
  const districtX = Math.floor(x / SETTLER_DISTRICT_CELLS);
  const districtY = Math.floor(y / SETTLER_DISTRICT_CELLS);
  return SETTLER_RACES[(hashCell(districtX, districtY) >>> 24) & 1];
}

export function isSettlerRace(value: unknown): value is SettlerRace {
  return (SETTLER_RACES as readonly string[]).includes(value as string);
}

export {
  BROADCAST_POSITION_DECIMALS,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '@terrace/shared';

export interface PilgrimEntityState {
  readonly id: number;
  readonly kind: WalkerKind;
  readonly race: SettlerRace;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly climbHeight: number | null;
  readonly falling: boolean;
  readonly stance: number | null;
}

export interface PilgrimsEntitiesPayload {
  readonly pilgrims: readonly PilgrimEntityState[];
}

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
      climbHeight: isFiniteNumber(entry.climbHeight) ? entry.climbHeight : null,
      falling: entry.falling === true,
      stance: isFiniteNumber(entry.stance) ? entry.stance : null,
    });
  }
  return parsed;
}

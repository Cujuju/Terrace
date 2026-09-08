export const MONSTERS_PLUGIN_NAME = 'monsters';

export const MONSTERS_STATE_MESSAGE = 'state';

export const MONSTER_KINDS = ['kraken', 'cthulhu', 'yeti'] as const;

export type MonsterKind = (typeof MONSTER_KINDS)[number];

export const YETI_VARIANTS = ['silverback', 'ram', 'ibex', 'fanged'] as const;

export type YetiVariant = (typeof YETI_VARIANTS)[number];

export const DEFAULT_YETI_VARIANT: YetiVariant = YETI_VARIANTS[0];

export function isYetiVariant(value: unknown): value is YetiVariant {
  return (YETI_VARIANTS as readonly string[]).includes(value as string);
}

export function yetiVariantOf(kind: MonsterKind, raw: unknown): YetiVariant | undefined {
  if (kind !== 'yeti') return undefined;
  return isYetiVariant(raw) ? raw : DEFAULT_YETI_VARIANT;
}

export {
  BROADCAST_POSITION_DECIMALS,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '@terrace/shared';
import { isFiniteNumber } from '@terrace/shared';

export interface MonsterState {
  readonly id: number;
  readonly kind: MonsterKind;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly variant?: YetiVariant;
  readonly climbHeight?: number | null;
  readonly falling?: boolean;
  readonly stance?: number | null;
}

export interface MonstersStatePayload {
  readonly monsters: readonly MonsterState[];
}

export function isMonsterKind(value: unknown): value is MonsterKind {
  return (MONSTER_KINDS as readonly string[]).includes(value as string);
}

export function parseMonstersPayload(payload: unknown): MonsterState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const monsters = (payload as { monsters?: unknown }).monsters;
  if (!Array.isArray(monsters)) return null;

  const parsed: MonsterState[] = [];
  for (const raw of monsters) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<MonsterState>;
    if (!isFiniteNumber(entry.id)) continue;
    if (!isMonsterKind(entry.kind)) continue;
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y)) continue;
    if (!isFiniteNumber(entry.heading)) continue;
    const variant = yetiVariantOf(entry.kind, entry.variant);
    const climbHeight = isFiniteNumber(entry.climbHeight) ? entry.climbHeight : null;
    const falling = entry.falling === true;
    const stance = isFiniteNumber(entry.stance) ? entry.stance : null;
    parsed.push(
      variant === undefined
        ? {
            id: entry.id,
            kind: entry.kind,
            x: entry.x,
            y: entry.y,
            heading: entry.heading,
            climbHeight,
            falling,
            stance,
          }
        : {
            id: entry.id,
            kind: entry.kind,
            x: entry.x,
            y: entry.y,
            heading: entry.heading,
            climbHeight,
            falling,
            stance,
            variant,
          },
    );
  }
  return parsed;
}

export const MAX_LIVING_MONSTERS_PER_KIND = 1;

export const MAX_LIVING_MONSTERS = MAX_LIVING_MONSTERS_PER_KIND * MONSTER_KINDS.length;

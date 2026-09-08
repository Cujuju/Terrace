import {
  MONSTER_KINDS,
  isMonsterKind,
  yetiVariantOf,
  type MonsterKind,
  type YetiVariant,
} from '../protocol.ts';
import { newStillness } from '@terrace/shared';
import type { HabitatRegimeId } from './habitat.ts';
import {
  type Monster,
  cooldownRemainingSecondsFor,
  livingMonsters,
  nextMonsterIdValue,
  restoreSummoning,
} from './summoning.ts';

export const MONSTERS_SLICE_VERSION = 3;

export const MONSTERS_SLICE_V2_VERSION = 2;

export const MONSTERS_SLICE_LEGACY_VERSION = 1;

interface PersistedMonster {
  readonly id: number;
  readonly kind: MonsterKind;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly variant?: YetiVariant;
}

interface MonstersSlice {
  readonly version: number;
  readonly nextId: number;
  readonly monsters: readonly PersistedMonster[];
  readonly cooldownSeconds: Partial<Record<MonsterKind, number>>;
}

interface V2MonstersSlice {
  readonly version: number;
  readonly nextId: number;
  readonly monsters: readonly PersistedMonster[];
  readonly cooldownSeconds: Partial<Record<HabitatRegimeId, number>>;
}

interface LegacyMonstersSlice {
  readonly version: number;
  readonly nextId: number;
  readonly monster: unknown;
  readonly cooldownSeconds: number;
}

export function saveMonsters(): MonstersSlice {
  const cooldowns: Partial<Record<MonsterKind, number>> = {};
  for (const kind of MONSTER_KINDS) {
    const remaining = cooldownRemainingSecondsFor(kind);
    if (remaining > 0) cooldowns[kind] = remaining;
  }

  return {
    version: MONSTERS_SLICE_VERSION,
    nextId: nextMonsterIdValue(),
    monsters: livingMonsters().map((monster) => ({
      id: monster.id,
      kind: monster.kind,
      x: monster.x,
      y: monster.y,
      heading: monster.heading,
      ...(monster.variant === undefined ? {} : { variant: monster.variant }),
    })),
    cooldownSeconds: cooldowns,
  };
}

function parsePersistedMonster(raw: unknown): Monster | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Partial<PersistedMonster>;

  if (!Number.isInteger(entry.id) || (entry.id as number) <= 0) return null;
  if (!isMonsterKind(entry.kind)) return null;
  if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return null;
  if (!Number.isFinite(entry.heading)) return null;

  const variant = yetiVariantOf(entry.kind, entry.variant);

  return {
    id: entry.id as number,
    kind: entry.kind,
    x: entry.x as number,
    y: entry.y as number,
    heading: entry.heading as number,
    climb: null,
    idle: false,
    ...newStillness(entry.x as number, entry.y as number),
    ...(variant === undefined ? {} : { variant }),
  };
}

function parseCooldown(raw: unknown): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw as number);
}

function parseCooldowns(raw: unknown): Partial<Record<MonsterKind, number>> {
  const cooldowns: Partial<Record<MonsterKind, number>> = {};
  if (typeof raw !== 'object' || raw === null) return cooldowns;
  const map = raw as Partial<Record<MonsterKind, unknown>>;
  for (const kind of MONSTER_KINDS) {
    const parsed = parseCooldown(map[kind]);
    if (parsed > 0) cooldowns[kind] = parsed;
  }
  return cooldowns;
}

function migrateV2Cooldowns(
  raw: Partial<Record<HabitatRegimeId, unknown>> | undefined,
): Partial<Record<MonsterKind, number>> {
  const cooldowns: Partial<Record<MonsterKind, number>> = {};
  if (typeof raw !== 'object' || raw === null) return cooldowns;
  const water = parseCooldown(raw.water);
  const land = parseCooldown(raw.land);
  if (water > 0) cooldowns.kraken = water;
  if (land > 0) cooldowns.yeti = land;
  return cooldowns;
}

function migrateLegacySlice(slice: Partial<LegacyMonstersSlice>): {
  monsters: Monster[];
  cooldowns: Partial<Record<MonsterKind, number>>;
} {
  const monster = parsePersistedMonster(slice.monster);
  const cooldown = parseCooldown(slice.cooldownSeconds);
  const cooldowns: Partial<Record<MonsterKind, number>> = {};
  if (cooldown > 0) cooldowns.kraken = cooldown;
  return { monsters: monster === null ? [] : [monster], cooldowns };
}

export function loadMonsters(data: unknown): void {
  let monsters: Monster[] = [];
  let cooldowns: Partial<Record<MonsterKind, number>> = {};
  let nextId = 0;

  if (typeof data === 'object' && data !== null) {
    const version = (data as { version?: unknown }).version;
    const known =
      version === MONSTERS_SLICE_VERSION ||
      version === MONSTERS_SLICE_V2_VERSION ||
      version === MONSTERS_SLICE_LEGACY_VERSION;

    if (version === MONSTERS_SLICE_VERSION || version === MONSTERS_SLICE_V2_VERSION) {
      const slice = data as Partial<MonstersSlice>;
      if (Array.isArray(slice.monsters)) {
        for (const raw of slice.monsters) {
          const monster = parsePersistedMonster(raw);
          if (monster !== null) monsters.push(monster);
        }
      }
      cooldowns =
        version === MONSTERS_SLICE_VERSION
          ? parseCooldowns(slice.cooldownSeconds)
          : migrateV2Cooldowns(
              (data as Partial<V2MonstersSlice>).cooldownSeconds as
                | Partial<Record<HabitatRegimeId, unknown>>
                | undefined,
            );
    } else if (version === MONSTERS_SLICE_LEGACY_VERSION) {
      const migrated = migrateLegacySlice(data as Partial<LegacyMonstersSlice>);
      monsters = migrated.monsters;
      cooldowns = migrated.cooldowns;
    }

    if (known) {
      const { nextId: persisted } = data as Partial<MonstersSlice>;
      if (Number.isInteger(persisted)) nextId = persisted as number;
    }
  }

  let highestRestoredId = 0;
  for (const monster of monsters) highestRestoredId = Math.max(highestRestoredId, monster.id);

  restoreSummoning(monsters, Math.max(nextId, highestRestoredId + 1, 1), cooldowns);
}

// The on-disk shape of the world's monsters, and the defensive read-back.
//
// Separate from summoning.ts on purpose: that module owns LIVE state and its
// rules, this one owns the SERIALIZED format and its validation. Keeping them
// apart is what stops a future field being added to the live monster and
// silently becoming part of the snapshot contract.
//
// WHY THIS SLICE EXISTS AT ALL: without it, a restart is a duplication machine.
// A monster would vanish on shutdown, the cooldown with it, and the very next
// tick after boot would start rolling for a fresh arrival — so a server that
// restarts every night hands out one monster per restart, and a player who
// banished one gets it back early for free. Persisting the slots AND the
// cooldowns makes a restart invisible to the singleton.

import {
  MONSTER_KINDS,
  isMonsterKind,
  yetiVariantOf,
  type MonsterKind,
  type YetiVariant,
} from '../protocol.ts';
import type { HabitatRegimeId } from './habitat.ts';
import {
  type Monster,
  cooldownRemainingSecondsFor,
  livingMonsters,
  nextMonsterIdValue,
  restoreSummoning,
} from './summoning.ts';

/**
 * Schema version of this plugin's persistence slice.
 *
 * BUMPED 1 → 2 when monster slots became per-habitat (the yeti). The change is
 * not additive: version 1 stored ONE monster and ONE cooldown as scalars, and
 * this version stores a list and a per-habitat map. It is bumped rather than
 * hidden behind optional fields because the two shapes disagree about what a
 * bare `cooldownSeconds` MEANS — under per-habitat slots there is no such thing
 * as "the world's cooldown", so a v1 field read by v2 logic would have to be
 * assigned a habitat somewhere, and the honest place for that decision is a
 * migration (see below) rather than a defaulted field.
 *
 * FORWARD compatibility, stated: a self-hoster who rolls BACK to a build that
 * predates this reads a version it does not recognise and degrades to "a world
 * with no monster in it, which will roll for one" — the same outcome that build
 * already produces for a corrupt slice. Nothing else in the snapshot is
 * affected; this slice is the plugin's own.
 *
 * BUMPED 2 → 3 when the slots (and with them the cooldowns) became per KIND
 * (2026-08-19, "allow multiple sea monsters"). Same reasoning as 1 → 2: the
 * change is not additive — a per-habitat cooldown key and a per-kind cooldown
 * key disagree about what the map MEANS, and the honest place to assign a v2
 * habitat's cooldown to a kind is a migration. That assignment is exact, not
 * guessed: a cooldown only ever exists for a BANISHABLE kind, and each v2
 * habitat contains exactly one — water's is the kraken (Cthulhu cannot be
 * banished and so can never have written a cooldown), land's is the yeti.
 *
 * NOT BUMPED 3 → 4 for the yeti's VARIANT (2026-08-26), and that is the
 * documented exception rather than an oversight. The two bumps above were both
 * forced by a field CHANGING MEANING — a scalar cooldown becoming a map, a
 * habitat key becoming a kind key — where a v-old value read by v-new logic
 * would have to be reinterpreted, and the honest place for a reinterpretation
 * is a migration. `variant` changes nothing that already exists: it is a new
 * optional key on the monster row, every other field means exactly what it
 * meant, and a v3 row written before variants existed reads back correctly by
 * the ONE rule the wire already uses for the same gap — a yeti with no variant
 * is DEFAULT_YETI_VARIANT (see yetiVariantOf). Bumping would have cost a
 * migration path, a v3 shape kept for reading, and two more branches in
 * loadMonsters, all to express "the field was absent" — which the absent field
 * already expresses. A rollback is equally quiet: an older build reads the row,
 * ignores a key it does not know, and gets the world it expects.
 */
export const MONSTERS_SLICE_VERSION = 3;

/** Per-habitat-cooldown era (the yeti), still readable and migrated forward. */
export const MONSTERS_SLICE_V2_VERSION = 2;

/** The oldest version this file can still READ, and migrate forward. */
export const MONSTERS_SLICE_LEGACY_VERSION = 1;

/**
 * The persisted monster. Deliberately NOT the live Monster: it omits `idle`,
 * because an idle beat is a few seconds of a memoryless process and has no
 * meaning across a restart. A restored monster starts moving, which is also the
 * state that shows a returning player it is alive.
 */
interface PersistedMonster {
  readonly id: number;
  readonly kind: MonsterKind;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  /**
   * WHICH yeti (2026-08-26). Absent for the sea kinds, and absent from every
   * row written before this field existed — see MONSTERS_SLICE_VERSION for why
   * that absence needed no version bump.
   *
   * It IS persisted rather than re-rolled on boot, because a restart must be
   * invisible to the world (the reason this whole slice exists): a player who
   * left a horned yeti on his mountain and came back to a fanged one would have
   * been shown a new monster wearing the old one's id and position.
   */
  readonly variant?: YetiVariant;
}

interface MonstersSlice {
  readonly version: number;
  /** High-water mark of the id counter, so a restore never reuses an id. */
  readonly nextId: number;
  /** The world's monsters: at most one per KIND. See summoning.ts. */
  readonly monsters: readonly PersistedMonster[];
  /** Simulated seconds of banishment left to serve, per KIND (v3). */
  readonly cooldownSeconds: Partial<Record<MonsterKind, number>>;
}

/** The version-2 shape (per-habitat cooldowns), kept for migration. */
interface V2MonstersSlice {
  readonly version: number;
  readonly nextId: number;
  readonly monsters: readonly PersistedMonster[];
  readonly cooldownSeconds: Partial<Record<HabitatRegimeId, number>>;
}

/** The version-1 shape, kept only so `loadMonsters` can migrate one. */
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
    // Only kinds actually serving a banishment are written. A zero is the
    // absence of a cooldown, and writing it would grow the row for nothing.
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
      // Spread, so a kind with no variant writes no key — the same shape a
      // pre-variant row has, which is what keeps the absence meaningful.
      ...(monster.variant === undefined ? {} : { variant: monster.variant }),
    })),
    cooldownSeconds: cooldowns,
  };
}

/** Validates one persisted monster, or returns null if it is not usable. */
function parsePersistedMonster(raw: unknown): Monster | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Partial<PersistedMonster>;

  if (!Number.isInteger(entry.id) || (entry.id as number) <= 0) return null;
  if (!isMonsterKind(entry.kind)) return null;
  if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return null;
  if (!Number.isFinite(entry.heading)) return null;

  // A yeti row with no variant — every row written before 2026-08-26 — resolves
  // to the default here, by the same one rule the wire parse uses. Sea kinds
  // get undefined and so keep no key.
  const variant = yetiVariantOf(entry.kind, entry.variant);

  return {
    id: entry.id as number,
    kind: entry.kind,
    x: entry.x as number,
    y: entry.y as number,
    heading: entry.heading as number,
    idle: false,
    ...(variant === undefined ? {} : { variant }),
  };
}

/**
 * A cooldown value from disk, or 0 if it is not usable.
 *
 * A negative or non-finite cooldown must not become an infinite banishment or a
 * negative one that never counts down.
 */
function parseCooldown(raw: unknown): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw as number);
}

/** Reads the per-KIND cooldown map of a version-3 slice. */
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

/**
 * Migrates a version-2 slice's per-HABITAT cooldowns to per-KIND ones.
 *
 * EXACT, NOT GUESSED (same standard the v1 migration set): a cooldown is only
 * ever written after a banishment, and each v2 habitat holds exactly one
 * banishable kind — the kraken in the water (Cthulhu cannot be banished, so a
 * water cooldown cannot be his), the yeti on land. The monsters list needs no
 * migration: it already carried kinds.
 */
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

/**
 * Migrates a version-1 slice: one monster, one world-wide cooldown.
 *
 * THE COOLDOWN'S KIND IS EXACT, NOT GUESSED. Version 1 predates the land
 * habitat entirely — every kind it could name (cthulhu, kraken) lives in the
 * water — and of those only the kraken can be banished, so a cooldown it
 * recorded is a KRAKEN cooldown by construction. (Written "water" in the v2
 * era for the same reason; the per-kind slots of 2026-08-19 just sharpen the
 * same fact.)
 */
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

/**
 * Restores the slice defensively, in this repo's house style: the row comes from
 * the server's own SQLite file, but a truncated or hand-edited one must degrade
 * to "a world with no monster in it, which will roll for one" and never crash a
 * boot.
 *
 * A restored monster is trusted to be where it was; the first tick's habitat
 * check (summoning.enforceHabitat) banishes it if the terrain has since stopped
 * being its habitat there, so a snapshot restored onto a changed world
 * self-corrects rather than needing a validating world argument here.
 *
 * FAILURE MODE CHOSEN DELIBERATELY: a monster that fails validation is dropped
 * WITHOUT starting a cooldown, so the world simply becomes eligible again and
 * waits out the ordinary summon roll. The alternative — inventing a cooldown for
 * a monster we cannot prove existed — would silently suppress arrivals for ten
 * minutes because of a bad byte.
 */
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

  // Ids must never be reused, even if the persisted counter was garbage: a
  // client still interpolating a previous monster would otherwise blend a new
  // one out of the old one's position.
  let highestRestoredId = 0;
  for (const monster of monsters) highestRestoredId = Math.max(highestRestoredId, monster.id);

  restoreSummoning(monsters, Math.max(nextId, highestRestoredId + 1, 1), cooldowns);
}

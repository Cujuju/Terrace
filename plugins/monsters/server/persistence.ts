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

import { isMonsterKind, type MonsterKind } from '../protocol.ts';
import { HABITAT_REGIMES, type HabitatRegimeId } from './habitat.ts';
import {
  type Monster,
  cooldownRemainingSeconds,
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
 */
export const MONSTERS_SLICE_VERSION = 2;

/** The version this file can still READ, and migrate forward. */
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
}

interface MonstersSlice {
  readonly version: number;
  /** High-water mark of the id counter, so a restore never reuses an id. */
  readonly nextId: number;
  /** The world's monsters: at most one per habitat. See summoning.ts. */
  readonly monsters: readonly PersistedMonster[];
  /** Simulated seconds of banishment left to serve, per habitat. */
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
  const cooldowns: Partial<Record<HabitatRegimeId, number>> = {};
  for (const regime of HABITAT_REGIMES) {
    const remaining = cooldownRemainingSeconds(regime);
    // Only habitats actually serving a banishment are written. A zero is the
    // absence of a cooldown, and writing it would grow the row for nothing.
    if (remaining > 0) cooldowns[regime.id] = remaining;
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

  return {
    id: entry.id as number,
    kind: entry.kind,
    x: entry.x as number,
    y: entry.y as number,
    heading: entry.heading as number,
    idle: false,
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

/** Reads the per-habitat cooldown map of a version-2 slice. */
function parseCooldowns(raw: unknown): Partial<Record<HabitatRegimeId, number>> {
  const cooldowns: Partial<Record<HabitatRegimeId, number>> = {};
  if (typeof raw !== 'object' || raw === null) return cooldowns;
  const map = raw as Partial<Record<HabitatRegimeId, unknown>>;
  for (const regime of HABITAT_REGIMES) {
    const parsed = parseCooldown(map[regime.id]);
    if (parsed > 0) cooldowns[regime.id] = parsed;
  }
  return cooldowns;
}

/**
 * Migrates a version-1 slice: one monster, one world-wide cooldown.
 *
 * THE COOLDOWN'S HABITAT IS EXACT, NOT GUESSED. Version 1 predates the land
 * habitat entirely — every kind it could name (cthulhu, kraken) lives in the
 * water — so a cooldown it recorded is a WATER cooldown by construction, and a
 * restored v1 world therefore keeps the sea empty for exactly as long as it was
 * going to and has never had anything to say about the mountain.
 */
function migrateLegacySlice(slice: Partial<LegacyMonstersSlice>): {
  monsters: Monster[];
  cooldowns: Partial<Record<HabitatRegimeId, number>>;
} {
  const monster = parsePersistedMonster(slice.monster);
  const cooldown = parseCooldown(slice.cooldownSeconds);
  const cooldowns: Partial<Record<HabitatRegimeId, number>> = {};
  if (cooldown > 0) cooldowns.water = cooldown;
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
  let cooldowns: Partial<Record<HabitatRegimeId, number>> = {};
  let nextId = 0;

  if (typeof data === 'object' && data !== null) {
    const version = (data as { version?: unknown }).version;
    const known =
      version === MONSTERS_SLICE_VERSION || version === MONSTERS_SLICE_LEGACY_VERSION;

    if (version === MONSTERS_SLICE_VERSION) {
      const slice = data as Partial<MonstersSlice>;
      if (Array.isArray(slice.monsters)) {
        for (const raw of slice.monsters) {
          const monster = parsePersistedMonster(raw);
          if (monster !== null) monsters.push(monster);
        }
      }
      cooldowns = parseCooldowns(slice.cooldownSeconds);
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

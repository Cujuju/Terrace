// The on-disk shape of the world's monster, and the defensive read-back.
//
// Separate from summoning.ts on purpose: that module owns LIVE state and its
// rules, this one owns the SERIALIZED format and its validation. Keeping them
// apart is what stops a future field being added to the live monster and
// silently becoming part of the snapshot contract.
//
// WHY THIS SLICE EXISTS AT ALL: without it, a restart is a duplication machine.
// The monster would vanish on shutdown, the cooldown with it, and the very next
// tick after boot would start rolling for a fresh arrival — so a server that
// restarts every night hands out one monster per restart, and a player who
// banished it gets it back early for free. Persisting the slot AND the cooldown
// makes a restart invisible to the singleton.

import { isMonsterKind, type MonsterKind } from '../protocol.ts';
import {
  type Monster,
  cooldownRemainingSeconds,
  livingMonster,
  nextMonsterIdValue,
  restoreSummoning,
} from './summoning.ts';

/** Schema version of this plugin's persistence slice. */
export const MONSTERS_SLICE_VERSION = 1;

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
  /** The world's ONE monster, or null. Not a list — see summoning.ts. */
  readonly monster: PersistedMonster | null;
  /** Simulated seconds of banishment left to serve. */
  readonly cooldownSeconds: number;
}

export function saveMonsters(): MonstersSlice {
  const monster = livingMonster();
  return {
    version: MONSTERS_SLICE_VERSION,
    nextId: nextMonsterIdValue(),
    monster:
      monster === null
        ? null
        : {
            id: monster.id,
            kind: monster.kind,
            x: monster.x,
            y: monster.y,
            heading: monster.heading,
          },
    cooldownSeconds: cooldownRemainingSeconds(),
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
 * Restores the slice defensively, in this repo's house style: the row comes from
 * the server's own SQLite file, but a truncated or hand-edited one must degrade
 * to "a world with no monster in it, which will roll for one" and never crash a
 * boot.
 *
 * A restored monster is trusted to be where it was; the first tick's habitat
 * check (summoning.enforceHabitat) banishes it if the terrain has since stopped
 * being deep water there, so a snapshot restored onto a changed world
 * self-corrects rather than needing a validating world argument here.
 *
 * FAILURE MODE CHOSEN DELIBERATELY: a monster that fails validation is dropped
 * WITHOUT starting a cooldown, so the world simply becomes eligible again and
 * waits out the ordinary summon roll. The alternative — inventing a cooldown for
 * a monster we cannot prove existed — would silently suppress arrivals for ten
 * minutes because of a bad byte.
 */
export function loadMonsters(data: unknown): void {
  let monster: Monster | null = null;
  let nextId = 0;
  let cooldown = 0;

  if (typeof data === 'object' && data !== null) {
    const slice = data as Partial<MonstersSlice>;
    if (slice.version === MONSTERS_SLICE_VERSION) {
      monster = parsePersistedMonster(slice.monster);
      if (Number.isInteger(slice.nextId)) nextId = slice.nextId as number;
      // A negative or non-finite cooldown must not become an infinite
      // banishment or a negative one that never counts down.
      if (Number.isFinite(slice.cooldownSeconds)) {
        cooldown = Math.max(0, slice.cooldownSeconds as number);
      }
    }
  }

  // Ids must never be reused, even if the persisted counter was garbage: a
  // client still interpolating the previous monster would otherwise blend the
  // new one out of the old one's position.
  const restoredId = monster === null ? 0 : monster.id;
  restoreSummoning(monster, Math.max(nextId, restoredId + 1, 1), cooldown);
}

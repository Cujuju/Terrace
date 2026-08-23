// BOOT-TIME WORLD SETUP — migration, then deciding what to load.
//
// Split out of index.ts because it is the one part of boot with a policy worth
// stating on its own, and the policy is: THIS SERVER NEVER SILENTLY REPLACES A
// WORLD.
//
// The failure it exists to prevent, in the words of the incident that produced
// it (2026-08-22): a world called Frostwick Hollows lost 298 of its 308
// snapshots, and the mechanism was a boot path that treated "I cannot find the
// world I expected" as "make a new one". Two rules follow, and both are
// enforced here rather than trusted to callers:
//
//   1. MIGRATION COPIES, NEVER MOVES. The legacy `DB_PATH` file stays exactly
//      where it is. If this build's copy is wrong, the original is untouched.
//   2. A FRESH WORLD IS CREATED ONLY WHEN THERE IS GENUINELY NOTHING — no
//      worlds directory, no worlds in it, nothing archived. A stale active
//      pointer, an unreadable file, a world that fails to open: none of those
//      produce fresh terrain. They produce a server with no world loaded and a
//      log line saying which world it could not open.

import { logInfo, logWarn } from '../log.ts';
import type { ServerConfig } from '../config.ts';
import type { WorldRegistry } from '../persistence/world-registry.ts';
import type { WorldManager } from '../world/world-manager.ts';
import { generateWorldName } from '../world/world-name.ts';

/** What boot did, for the log and for the tests. */
export interface WorldBootOutcome {
  /** Worlds adopted from outside the worlds folder on this boot. */
  readonly adopted: readonly string[];
  /** True when a world was created because the server had none at all. */
  readonly createdFirstWorld: boolean;
  /** The world that ended up loaded, or null. */
  readonly loadedId: string | null;
}

/**
 * Brings the legacy single-world database into the worlds folder.
 *
 * Runs on EVERY boot and is idempotent: once a world of that name is present,
 * `adopt` finds the id taken and does nothing. That is deliberate — a
 * migration that only runs "once" needs somewhere to record that it ran, and
 * that record is one more thing that can be lost or disagree with the disk.
 */
function migrateLegacyWorld(config: ServerConfig, registry: WorldRegistry): string | null {
  const adopted = registry.adopt(config.dbPath, null);
  if (adopted !== null) {
    logInfo(
      `migrated the legacy world at ${config.dbPath} into ${registry.worldsDir} ` +
        `as "${adopted}" — the original file was COPIED, not moved, and is still there`,
    );
  }
  return adopted;
}

/**
 * Decides what world (if any) is live when the server starts listening.
 *
 * Order, and each step's reason:
 *   1. Migrate the legacy database, so an upgrading self-hoster's world is
 *      present before anything looks for worlds to load.
 *   2. Follow the active pointer. This is the ordinary case: come back to the
 *      world we were in.
 *   3. If there is no pointer but worlds exist, load the most recently played
 *      one. A self-hoster who deleted `.active` (or upgraded into this build)
 *      means "the world I was in", and the newest snapshot is the best
 *      available statement of which that was.
 *   4. Only if there are NO worlds at all — none live, none archived — create
 *      one. This is first-run, and nothing can be lost by it.
 */
export function openWorlds(
  config: ServerConfig,
  registry: WorldRegistry,
  manager: WorldManager,
): WorldBootOutcome {
  const adopted: string[] = [];
  const legacy = migrateLegacyWorld(config, registry);
  if (legacy !== null) adopted.push(legacy);

  // STEP 2 — the pointer.
  if (manager.loadFromPointer()) {
    return { adopted, createdFirstWorld: false, loadedId: manager.activeId };
  }

  // STEP 3 — no usable pointer; fall back to the most recently played world.
  const worlds = registry.list(null);
  const readable = worlds.filter((world) => world.unreadable === undefined);
  if (readable.length > 0) {
    const newest = readable[0]; // registry.list sorts newest-played first
    logInfo(`no active world recorded; loading the most recent one ("${newest.id}")`);
    const outcome = manager.requestLoad(newest.id);
    if (typeof outcome !== 'string') {
      return { adopted, createdFirstWorld: false, loadedId: manager.activeId };
    }
    // Refused or failed. Say which world and why, and load nothing — see this
    // file's rule 2. The operator can pick another from the panel.
    logWarn(`could not load "${newest.id}" (${outcome}); no world is loaded`);
    return { adopted, createdFirstWorld: false, loadedId: null };
  }

  // A world that exists but cannot be READ is still a world. Creating a fresh
  // one beside it would look, to its owner, exactly like it had been replaced.
  if (worlds.length > 0 || registry.listArchived().length > 0) {
    logWarn(
      `${worlds.length} world file(s) present but none could be read; refusing to ` +
        'create a replacement. Fix or move the file(s), then load a world from the panel.',
    );
    return { adopted, createdFirstWorld: false, loadedId: null };
  }

  // STEP 4 — genuinely nothing. First run.
  const name = generateWorldName();
  const id = manager.createWorld(name, config.worldSize, config.difficulty);
  if (id === null) {
    logWarn(`could not create a first world called "${name}"`);
    return { adopted, createdFirstWorld: false, loadedId: null };
  }
  logInfo(`no worlds found — created "${name}" (${config.worldSize}²)`);
  const outcome = manager.requestLoad(id);
  if (typeof outcome === 'string') {
    logWarn(`created "${id}" but could not load it (${outcome})`);
    return { adopted, createdFirstWorld: true, loadedId: null };
  }
  return { adopted, createdFirstWorld: true, loadedId: manager.activeId };
}

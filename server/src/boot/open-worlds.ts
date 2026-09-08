import { logInfo, logWarn } from '../log.ts';
import type { ServerConfig } from '../config.ts';
import type { WorldRegistry } from '../persistence/world-registry.ts';
import type { WorldManager } from '../world/world-manager.ts';
import { generateWorldName } from '../world/world-name.ts';

export interface WorldBootOutcome {
  readonly adopted: readonly string[];
  readonly createdFirstWorld: boolean;
  readonly loadedId: string | null;
}

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

export function openWorlds(
  config: ServerConfig,
  registry: WorldRegistry,
  manager: WorldManager,
): WorldBootOutcome {
  const adopted: string[] = [];
  const legacy = migrateLegacyWorld(config, registry);
  if (legacy !== null) adopted.push(legacy);

  if (manager.loadFromPointer()) {
    return { adopted, createdFirstWorld: false, loadedId: manager.activeId };
  }

  const worlds = registry.list(null);
  const readable = worlds.filter((world) => world.unreadable === undefined);
  if (readable.length > 0) {
    const newest = readable[0];
    logInfo(`no active world recorded; loading the most recent one ("${newest.id}")`);
    const outcome = manager.requestLoad(newest.id);
    if (typeof outcome !== 'string') {
      return { adopted, createdFirstWorld: false, loadedId: manager.activeId };
    }
    logWarn(`could not load "${newest.id}" (${outcome}); no world is loaded`);
    return { adopted, createdFirstWorld: false, loadedId: null };
  }

  if (worlds.length > 0 || registry.listArchived().length > 0) {
    logWarn(
      `${worlds.length} world file(s) present but none could be read; refusing to ` +
        'create a replacement. Fix or move the file(s), then load a world from the panel.',
    );
    return { adopted, createdFirstWorld: false, loadedId: null };
  }

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

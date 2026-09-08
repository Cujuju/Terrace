import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_NAME_PATTERN } from '@terrace/shared';
import { logInfo, logWarn } from '../log.ts';
import {
  createPluginVersionContext,
  pluginVersionStamp,
  type PluginVersionContext,
} from './plugin-version.ts';
import type { LoadedPlugin, TerracePlugin } from './types.ts';

const PLUGIN_SERVER_ENTRY_CANDIDATES = ['server/index.ts', 'server/index.js'] as const;

const PLUGIN_EXPORT_NAME = 'plugin';

export { PLUGIN_NAME_PATTERN };

export class PluginLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PluginLoadError';
  }
}

async function isPluginDirectory(root: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(join(root, entry.name))).isDirectory();
  } catch (error) {
    throw new PluginLoadError(`plugins/${entry.name}: symlink cannot be followed`, {
      cause: error,
    });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function findServerEntry(pluginDir: string): Promise<string | null> {
  for (const candidate of PLUGIN_SERVER_ENTRY_CANDIDATES) {
    const path = join(pluginDir, candidate);
    if (await fileExists(path)) return path;
  }
  return null;
}

function looksLikePlugin(value: unknown): value is TerracePlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

function selectPluginExport(module: Record<string, unknown>, entryPath: string): TerracePlugin {
  const preferred = module[PLUGIN_EXPORT_NAME];
  if (preferred !== undefined) {
    if (!looksLikePlugin(preferred)) {
      throw new PluginLoadError(
        `${entryPath}: export "${PLUGIN_EXPORT_NAME}" is not a TerracePlugin (needs a string "name")`,
      );
    }
    return preferred;
  }

  const candidates = Object.entries(module).filter(([, value]) => looksLikePlugin(value));
  if (candidates.length === 1) return candidates[0][1] as TerracePlugin;

  if (candidates.length === 0) {
    throw new PluginLoadError(
      `${entryPath}: no TerracePlugin export found (expected "export const ${PLUGIN_EXPORT_NAME}")`,
    );
  }
  throw new PluginLoadError(
    `${entryPath}: ambiguous plugin exports [${candidates.map(([key]) => key).join(', ')}] — ` +
      `name one of them "${PLUGIN_EXPORT_NAME}"`,
  );
}

export function pluginFromModule(
  module: Record<string, unknown>,
  entryPath: string,
): TerracePlugin {
  const plugin = selectPluginExport(module, entryPath);
  if (!PLUGIN_NAME_PATTERN.test(plugin.name)) {
    throw new PluginLoadError(
      `${entryPath}: plugin name "${plugin.name}" must match ${PLUGIN_NAME_PATTERN}`,
    );
  }
  return plugin;
}

async function loadPlugin(
  pluginsDir: string,
  directory: string,
  versions: PluginVersionContext,
): Promise<LoadedPlugin | null> {
  const pluginDir = join(pluginsDir, directory);
  const entryPath = await findServerEntry(pluginDir);
  if (entryPath === null) {
    logInfo(`plugin "${directory}" has no server entry — skipped`);
    return null;
  }

  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new PluginLoadError(`failed to import ${entryPath}`, { cause: error });
  }

  const plugin = pluginFromModule(module, entryPath);

  return {
    plugin,
    directory,
    entryPath,
    version: pluginVersionStamp(versions, directory),
    exports: module,
  };
}

export async function discoverPlugins(pluginsDir: string): Promise<LoadedPlugin[]> {
  const root = resolve(pluginsDir);

  let directories: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    directories = [];
    for (const entry of entries) {
      if (await isPluginDirectory(root, entry)) directories.push(entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logInfo(`no plugins directory at ${root} — running with core only`);
      return [];
    }
    throw error;
  }

  directories.sort();

  const versions = createPluginVersionContext(root);

  const loaded: LoadedPlugin[] = [];
  const seenNames = new Map<string, string>();

  for (const directory of directories) {
    const result = await loadPlugin(root, directory, versions);
    if (result === null) continue;

    const previousDirectory = seenNames.get(result.plugin.name);
    if (previousDirectory !== undefined) {
      throw new PluginLoadError(
        `duplicate plugin name "${result.plugin.name}" in plugins/${previousDirectory} and plugins/${directory}`,
      );
    }
    seenNames.set(result.plugin.name, directory);
    loaded.push(result);
  }

  if (loaded.length === 0) {
    logWarn(`no plugins loaded from ${root} — core ships no game mechanics of its own`);
  } else {
    logInfo(`loaded ${loaded.length} plugin(s): ${loaded.map((p) => p.plugin.name).join(', ')}`);
    for (const entry of loaded) {
      logInfo(`plugin "${entry.plugin.name}" v${entry.version}`);
    }
  }
  return loaded;
}

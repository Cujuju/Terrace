// Folder-based plugin discovery (design §3.5: "plugins/ folder, auto-discovered
// at boot — v1, friendliest for self-hosters"). npm-package plugins come later;
// nothing here forecloses that, because the loader's product is a plain
// TerracePlugin object and its input is just a module specifier.
//
// The convention, deliberately singular:
//
//   plugins/<name>/server/index.ts   (or .js for a pre-built plugin)
//
// exporting a TerracePlugin — preferably as `export const plugin`.

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logInfo, logWarn } from '../log.ts';
import type { LoadedPlugin, TerracePlugin } from './types.ts';

/**
 * Server entry points tried in order. `.ts` first because Node 24 runs
 * TypeScript directly via type stripping, which is how a plugin author works;
 * `.js` covers plugins shipped pre-compiled.
 */
export const PLUGIN_SERVER_ENTRY_CANDIDATES = ['server/index.ts', 'server/index.js'] as const;

/** Preferred export name for the plugin object. */
export const PLUGIN_EXPORT_NAME = 'plugin';

/**
 * Plugin names are message namespaces and snapshot keys, so they are restricted
 * to lowercase alphanumerics and inner dashes — no separators (':'), no case
 * ambiguity, no whitespace.
 */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Thrown for any malformed plugin; boot aborts (see discoverPlugins). */
export class PluginLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PluginLoadError';
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** First existing server entry inside a plugin directory, or null. */
async function findServerEntry(pluginDir: string): Promise<string | null> {
  for (const candidate of PLUGIN_SERVER_ENTRY_CANDIDATES) {
    const path = join(pluginDir, candidate);
    if (await fileExists(path)) return path;
  }
  return null;
}

/** Structural check — the only thing every plugin must have is a name. */
function looksLikePlugin(value: unknown): value is TerracePlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

/**
 * Picks the plugin object out of a loaded module: `plugin` if present,
 * otherwise the single plugin-shaped export. Ambiguity is an error rather than
 * a guess — silently loading the wrong export would be very hard to debug.
 */
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

async function loadPlugin(pluginsDir: string, directory: string): Promise<LoadedPlugin | null> {
  const pluginDir = join(pluginsDir, directory);
  const entryPath = await findServerEntry(pluginDir);
  if (entryPath === null) {
    // A plugin may legitimately be client-only (design §3.5 allows client-side
    // HUD/scene plugins), so a missing server half is a note, not an error.
    logInfo(`plugin "${directory}" has no server entry — skipped`);
    return null;
  }

  let module: Record<string, unknown>;
  try {
    // pathToFileURL matters on Windows, where a bare path is not a valid URL.
    module = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new PluginLoadError(`failed to import ${entryPath}`, { cause: error });
  }

  const plugin = selectPluginExport(module, entryPath);
  if (!PLUGIN_NAME_PATTERN.test(plugin.name)) {
    throw new PluginLoadError(
      `${entryPath}: plugin name "${plugin.name}" must match ${PLUGIN_NAME_PATTERN}`,
    );
  }

  return { plugin, directory, entryPath };
}

/**
 * Loads every plugin under `pluginsDir`, in DETERMINISTIC ORDER: directories
 * sorted by their raw name (UTF-16 code-unit order — locale-independent, unlike
 * localeCompare). Load order is intent-interceptor order, so it must not depend
 * on the filesystem's readdir order or on the machine's locale.
 *
 * A missing plugins/ directory is normal (core runs fine with no plugins). A
 * malformed plugin, however, aborts boot: a world that silently comes up
 * without its reveal or economy plugin is a worse outcome for a self-hoster
 * than a server that refuses to start and says why.
 */
export async function discoverPlugins(pluginsDir: string): Promise<LoadedPlugin[]> {
  const root = resolve(pluginsDir);

  let directories: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    // ENOENT (directory genuinely absent) is the one expected failure — core
    // runs fine with no plugins. Anything else (EACCES on a misconfigured
    // mount, ENOTDIR, ...) is a real I/O problem: it must abort boot rather
    // than be reported as "no plugins directory", or a self-hoster gets the
    // silently-degraded world the malformed-plugin policy above exists to rule
    // out.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logInfo(`no plugins directory at ${root} — running with core only`);
      return [];
    }
    throw error;
  }

  directories.sort();

  const loaded: LoadedPlugin[] = [];
  const seenNames = new Map<string, string>();

  for (const directory of directories) {
    const result = await loadPlugin(root, directory);
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
  }
  return loaded;
}

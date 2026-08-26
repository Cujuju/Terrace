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
 *
 * DEFINED IN shared/, not here: the world panel sends a plugin name over the
 * wire (issue #168) and the same pattern has to validate it there, and a rule
 * about a protocol namespace written down twice is a rule that drifts.
 */
export { PLUGIN_NAME_PATTERN };

/** Thrown for any malformed plugin; boot aborts (see discoverPlugins). */
export class PluginLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PluginLoadError';
  }
}

/**
 * Whether a plugins/ entry is a directory, FOLLOWING SYMLINKS (issue #182).
 * readdir's Dirent reports a symlinked plugin as a symlink, not a directory,
 * so `isDirectory()` alone dropped it without a word and a self-hoster who
 * symlinked a plugin in got the silently plugin-less world discoverPlugins'
 * policy exists to rule out. Following the link is safe here: plugins/ is
 * operator-controlled and everything in it is already code the server runs.
 *
 * A dangling link or a link loop fails `stat` (ENOENT / ELOOP); that is a
 * malformed plugin and aborts boot like any other, rather than being skipped.
 */
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

/**
 * First existing server entry inside a plugin directory, or null.
 *
 * EXPORTED for the in-process reload (issue #198), which resolves the entry of
 * ONE plugin the same way boot resolved it. A second copy of the candidate
 * order is a second thing to keep in step.
 */
export async function findServerEntry(pluginDir: string): Promise<string | null> {
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

/**
 * The plugin object a loaded module offers, checked.
 *
 * EXPORTED for the in-process reload (issue #198): a re-imported module has to
 * clear exactly the same bar as one imported at boot — the right export, and a
 * name that is a legal message namespace — and a second implementation of that
 * bar is how a reload would come to accept what boot would have rejected.
 */
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

  const plugin = pluginFromModule(module, entryPath);

  return {
    plugin,
    directory,
    entryPath,
    version: pluginVersionStamp(versions, directory),
    // The namespace this import produced, held for the host's sibling lookup
    // (issue #196): one import per plugin per process, and every consumer of
    // this plugin is handed THIS object.
    exports: module,
  };
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
    directories = [];
    for (const entry of entries) {
      if (await isPluginDirectory(root, entry)) directories.push(entry.name);
    }
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

  // Gathered once for the whole pass — one git scan rather than one per plugin
  // (see createPluginVersionContext).
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
    // ONE LINE PER PLUGIN, with its stamp: the log is where an operator who
    // just updated a plugin confirms the new code is the code that booted.
    for (const entry of loaded) {
      logInfo(`plugin "${entry.plugin.name}" v${entry.version}`);
    }
  }
  return loaded;
}

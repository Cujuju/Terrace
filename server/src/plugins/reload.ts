// RE-IMPORTING ONE PLUGIN: the loader half of the in-process reload (issue
// #198, docs/plans/plugin-hot-unload.md §6 Option B).
//
// This module produces a NEW `LoadedPlugin` for a plugin that is already
// installed, and nothing else: it does not install it, does not run a hook, and
// does not know a world exists. Deciding whether the new module is fit to keep
// — and putting the old one back when it is not — is WorldManager.reloadPlugin's
// (world/world-manager.ts), because only the manager can rebuild the session
// that would run it.
//
// THE LEAK IS REAL AND ACCEPTED. Node's ESM module map has no eviction, so the
// PREVIOUS generation's namespace can never be collected: every reload adds one
// plugin's module subtree to the process for good. It is bounded (a plugin's own
// code, once per reload), operator-triggered, and measured — see DESIGN's
// "known residual" note for the per-reload number from the rig. That cost is
// the whole reason this path is admin-gated and a restart is still the
// recommended way to update a plugin.

import { register } from 'node:module';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginLoadError, findServerEntry, pluginFromModule } from './discovery.ts';
import { createPluginVersionContext, reloadedVersionStamp } from './plugin-version.ts';
import { PLUGIN_RELOAD_GENERATION_PARAM, PLUGIN_RELOAD_ROOT_PARAM } from './reload-hooks.ts';
import type { LoadedPlugin } from './types.ts';

/**
 * Reload generation, counting from the first one this process performs.
 *
 * PROCESS-WIDE AND MONOTONIC, never per plugin: it only has to make a URL
 * unique among the URLs this process has already imported, and one counter
 * cannot be advanced for plugin A while plugin B is still on a number A used.
 */
let generation = 0;

/** Whether the resolve hook has been registered; see registerReloadHooks. */
let hooksRegistered = false;

/**
 * Registers the generation-tagged resolve hook, once.
 *
 * LAZY, at the first reload rather than at boot: the hook is stateless and only
 * acts on a URL that already carries a tag (see reload-hooks.ts), so modules
 * imported before it was registered are unaffected — and a process that never
 * reloads anything never pays for it.
 */
function registerReloadHooks(): void {
  if (hooksRegistered) return;
  register('./reload-hooks.ts', import.meta.url);
  hooksRegistered = true;
}

/**
 * Imports the current code of one installed plugin as a FRESH module subtree,
 * and returns it as a LoadedPlugin ready to be installed.
 *
 * Throws (PluginLoadError, or whatever the module itself threw on evaluation)
 * when the plugin's entry is gone, will not import, or does not export a usable
 * TerracePlugin. The caller keeps running the old module on any of those.
 *
 * `directory`, not the plugin NAME: the directory is what the loader resolves
 * and what the stamp is derived from, and the two only coincide by convention.
 * The plugin's own declared name is whatever the re-imported module says — and
 * the caller checks it still matches what it is replacing, because a module
 * that renamed itself mid-life is not a new build of the same plugin.
 */
export async function reimportPlugin(
  pluginsDir: string,
  directory: string,
): Promise<LoadedPlugin> {
  const root = resolve(pluginsDir);
  const pluginDir = join(root, directory);
  const entryPath = await findServerEntry(pluginDir);
  if (entryPath === null) {
    throw new PluginLoadError(`plugins/${directory} has no server entry to reload`);
  }

  registerReloadHooks();
  generation++;

  // THE REAL PATH, because that is the form a resolved URL takes: Node resolves
  // symlinks when it loads an ES module, so a symlinked plugin (supported — see
  // discovery.ts) would never match a root expressed as the link's own path,
  // and its second file would silently come back from the old generation.
  const realPluginDir = await realpath(pluginDir);
  // Trailing separator so the root cannot prefix-match a sibling directory.
  const rootUrl = pathToFileURL(join(realPluginDir, '/')).href;

  const entryUrl = new URL(pathToFileURL(await realpath(entryPath)).href);
  entryUrl.searchParams.set(PLUGIN_RELOAD_GENERATION_PARAM, String(generation));
  entryUrl.searchParams.set(PLUGIN_RELOAD_ROOT_PARAM, rootUrl);

  let module: Record<string, unknown>;
  try {
    module = (await import(entryUrl.href)) as Record<string, unknown>;
  } catch (error) {
    throw new PluginLoadError(`failed to re-import ${entryPath}`, { cause: error });
  }

  return {
    plugin: pluginFromModule(module, entryPath),
    directory,
    entryPath,
    // A FRESH version context, gathered now rather than reused from boot: the
    // whole point of a reload is that the working tree changed since then.
    version: reloadedVersionStamp(createPluginVersionContext(root), directory, generation),
    exports: module,
  };
}

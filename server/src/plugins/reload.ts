import { register } from 'node:module';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginLoadError, findServerEntry, pluginFromModule } from './discovery.ts';
import { createPluginVersionContext, reloadedVersionStamp } from './plugin-version.ts';
import { PLUGIN_RELOAD_GENERATION_PARAM, PLUGIN_RELOAD_ROOT_PARAM } from './reload-hooks.ts';
import type { LoadedPlugin } from './types.ts';

let generation = 0;

let hooksRegistered = false;

function registerReloadHooks(): void {
  if (hooksRegistered) return;
  register('./reload-hooks.ts', import.meta.url);
  hooksRegistered = true;
}

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

  const realPluginDir = await realpath(pluginDir);
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
    version: reloadedVersionStamp(createPluginVersionContext(root), directory, generation),
    exports: module,
  };
}

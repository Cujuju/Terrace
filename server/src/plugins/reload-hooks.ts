// THE GENERATION-TAGGED LOADER HOOK: how a re-import of one plugin yields a
// FRESH module subtree instead of the one already in the ESM module map
// (issue #198, docs/plans/plugin-hot-unload.md §1.2, §6 Option B).
//
// THE PROBLEM. Node's module map has no eviction: `import()`ing the same URL
// twice returns the same namespace forever. Adding a query string to the entry
// URL busts that for the ENTRY ALONE — its own `import './state.ts'` still
// resolves to the un-tagged URL, so a two-file plugin would come back half new
// and half old, holding the old file's module-scope state. The subtree has to
// be re-resolved with it.
//
// THE GENERATION TRAVELS IN THE URL, so this hook keeps NO STATE. Node runs
// resolve hooks on their own thread, and a counter here would have to be
// messaged across it and kept in step with the main thread's idea of which
// generation is current. Instead the reload tags the entry URL, and this hook's
// whole job is to carry the tag from a parent to the children it imports.
// Stateless also means it can be registered LAZILY — at the first reload, long
// after boot imported every plugin untagged — because a module with no tag on
// its URL never reaches the interesting branch.
//
// IT ONLY EVER TAGS THE ONE PLUGIN BEING RELOADED. The parent URL carries the
// plugin's own root as well as the generation, and a resolved URL outside that
// root is returned untouched. That bound is not cosmetic: several plugins
// import `server/src/config.ts` and `server/src/plugins/types.ts` by relative
// path, and re-importing CORE under a tag would give the process a second copy
// of core's module-scope state. The root is the plugin directory's REAL path
// (symlinked plugins are supported — see discovery.ts), which is what a
// resolved URL is expressed in.
//
// SECURITY: this hook rewrites nothing but a search string, and only for a URL
// already under a root the server itself chose. It cannot redirect a specifier
// anywhere.

/** Search parameter carrying the reload generation. */
export const PLUGIN_RELOAD_GENERATION_PARAM = 'terraceReload';

/** Search parameter carrying the plugin root the generation applies within. */
export const PLUGIN_RELOAD_ROOT_PARAM = 'terraceReloadRoot';

/** The shape of the resolve hook's context, as Node calls it. */
interface ResolveContext {
  readonly parentURL?: string | undefined;
}

/** What a resolve hook returns; passed through with only `url` rewritten. */
interface ResolveResult {
  readonly url: string;
}

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: (specifier: string, context: ResolveContext) => Promise<ResolveResult>,
): Promise<ResolveResult> {
  const result = await nextResolve(specifier, context);
  const parent = context.parentURL;
  // Cheap string test before any URL parsing: this hook is consulted for EVERY
  // specifier the process ever resolves, and all but a handful are imports by
  // modules that carry no tag at all.
  if (parent === undefined || !parent.includes(PLUGIN_RELOAD_GENERATION_PARAM)) return result;

  const parentUrl = new URL(parent);
  const generation = parentUrl.searchParams.get(PLUGIN_RELOAD_GENERATION_PARAM);
  const root = parentUrl.searchParams.get(PLUGIN_RELOAD_ROOT_PARAM);
  if (generation === null || root === null) return result;
  // `root` ends in a slash (see reload.ts), so "…/plugins/fire/" cannot match
  // a sibling directory whose name merely starts with "fire".
  if (!result.url.startsWith(root)) return result;

  const tagged = new URL(result.url);
  tagged.searchParams.set(PLUGIN_RELOAD_GENERATION_PARAM, generation);
  tagged.searchParams.set(PLUGIN_RELOAD_ROOT_PARAM, root);
  return { ...result, url: tagged.href };
}

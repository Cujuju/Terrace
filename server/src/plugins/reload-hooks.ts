export const PLUGIN_RELOAD_GENERATION_PARAM = 'terraceReload';

export const PLUGIN_RELOAD_ROOT_PARAM = 'terraceReloadRoot';

interface ResolveContext {
  readonly parentURL?: string | undefined;
}

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
  if (parent === undefined || !parent.includes(PLUGIN_RELOAD_GENERATION_PARAM)) return result;

  const parentUrl = new URL(parent);
  const generation = parentUrl.searchParams.get(PLUGIN_RELOAD_GENERATION_PARAM);
  const root = parentUrl.searchParams.get(PLUGIN_RELOAD_ROOT_PARAM);
  if (generation === null || root === null) return result;
  if (!result.url.startsWith(root)) return result;

  const tagged = new URL(result.url);
  tagged.searchParams.set(PLUGIN_RELOAD_GENERATION_PARAM, generation);
  tagged.searchParams.set(PLUGIN_RELOAD_ROOT_PARAM, root);
  return { ...result, url: tagged.href };
}

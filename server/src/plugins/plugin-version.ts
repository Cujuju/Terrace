// PER-PLUGIN BUILD IDENTITY: "which version of this plugin am I running?"
//
// WHY IT EXISTS. Until now there was ONE stamp for the whole stack
// (SERVER_VERSION / __CLIENT_VERSION__), derived from git HEAD, and nothing
// per plugin — so an operator who updated one plugin had no way to confirm the
// new code was live, and nothing downstream could tell one build from another
// finely enough to decide whether a client needs a fresh bundle. Research:
// docs/plans/plugin-hot-unload.md §1.4, §3.6.
//
// THE STAMP IS DERIVED, NEVER HAND-BUMPED, exactly like SERVER_VERSION and for
// the same reason: a number a human has to remember to change is a number that
// will be wrong. Format:
//
//   <package version>+<tree hash>            committed, clean
//   <package version>+<tree hash>-dirty.<d>  uncommitted edits present
//   <package version>+env.<stamp>            no git; TERRACE_VERSION is the basis
//   <package version>+boot.<nonce>           no git and no TERRACE_VERSION
//
// Any of the four may carry a trailing `-reload.<n>` when the plugin has been
// re-imported in this process (issue #198) — see RELOAD_STAMP_MARKER.
//
// THE TREE HASH, NOT THE LAST COMMIT THAT TOUCHED THE DIRECTORY. `git rev-parse
// HEAD:./` inside a plugin gives the hash of that directory's TREE OBJECT,
// which is a hash of its CONTENT: two checkouts with identical plugin bytes
// stamp identically even if their histories differ, and a revert back to older
// bytes stamps as those bytes. "The last commit that touched it" has neither
// property, and both matter for a consumer deciding "did this actually change?".
//
// THE DIRTY MARKER CARRIES CONTENT, not just a flag. A bare `-dirty` suffix
// would make two DIFFERENT uncommitted edits stamp the same, so the second edit
// would be invisible — which is precisely the dev loop this stamp exists to
// serve. `.<d>` is a short digest of that directory's `git status --porcelain`
// lines plus its `git diff HEAD`, so every distinct working tree of tracked
// files gets a distinct stamp.
//
// RESIDUAL, DOCUMENTED: an UNTRACKED file shows in `status` (so the stamp is
// marked dirty) but not in `diff HEAD`, so editing an untracked file's contents
// without renaming it does not move the stamp. `git add -N <file>` — or just
// committing — makes it visible. Every file a plugin author edits in an
// existing plugin is tracked, which is why this is a note rather than a hole.
//
// THE NO-GIT FALLBACKS. A docker image ships no `.git` (issue #8), so the git
// path is dead there. `TERRACE_VERSION` is the documented override for exactly
// that case and must be injected at image build; it is stable for the life of
// an image, which is the correct granularity — a new image is a new stamp.
// Failing even that, a per-BOOT nonce: conservative (every restart looks like
// every plugin changed) but never silently wrong, which is the right way round
// for something a reload decision is built on.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { logWarn } from '../log.ts';

/** Package version used when a plugin has no package.json, or an unusable one. */
const UNKNOWN_PACKAGE_VERSION = '0.0.0';

/**
 * Characters of a digest kept in a stamp.
 *
 * Seven, matching git's own default short-hash length, so a dirty digest reads
 * as the same kind of token as the tree hash beside it. The stamp is compared
 * for equality, never used as a security boundary, so collision resistance
 * only has to beat "two working trees of one plugin in one dev session".
 */
const STAMP_DIGEST_LENGTH = 7;

/**
 * Distinguishes one boot from another when nothing else can — see the no-git
 * fallbacks in this file's header. Computed ONCE per process, and shared by
 * every plugin in it, so the fallback says "this boot" and never implies that
 * one plugin changed while another did not.
 */
const BOOT_NONCE = createHash('sha256')
  .update(`${process.pid}:${Date.now()}:${Math.random()}`)
  .digest('hex')
  .slice(0, STAMP_DIGEST_LENGTH);

function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, STAMP_DIGEST_LENGTH);
}

/** Runs git in `cwd`, or null if git is absent, errored, or said nothing usable. */
function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A diff can be large; the default 1 MB buffer would throw on a big edit
      // and demote a perfectly good stamp to the boot nonce.
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
}

/** The plugin's own declared version, or UNKNOWN_PACKAGE_VERSION. */
function packageVersion(pluginDir: string): string {
  try {
    const raw = readFileSync(join(pluginDir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      // Non-empty string only: a package.json with `"version": 1` would
      // otherwise stamp as "1", and one with none as "undefined".
      if (typeof version === 'string' && version.trim() !== '') return version.trim();
    }
  } catch {
    // No package.json, unreadable, or not JSON. All the same thing here: the
    // plugin declares no version, which is a note in the stamp, not an error.
  }
  return UNKNOWN_PACKAGE_VERSION;
}

/**
 * Every plugin directory under `pluginsDir` with uncommitted changes.
 *
 * ONE `git status` FOR THE WHOLE TREE, bucketed by the first path segment
 * below `pluginsDir`, rather than one call per plugin: on the WSL2 drvfs mount
 * this repo lives on, a status scan costs ~0.65 s and sixteen of them would be
 * ten seconds of boot for an answer one call already holds.
 *
 * Returns null when git could not answer at all — which is NOT the same as "no
 * plugin is dirty", and callers must not conflate them. Otherwise each dirty
 * directory maps to its own status lines, which feed the marker's digest.
 */
function dirtyPluginDirectories(pluginsDir: string): Map<string, string[]> | null {
  const output = git(pluginsDir, ['status', '--porcelain', '--', '.']);
  if (output === null) return null;
  const dirty = new Map<string, string[]>();
  const pluginsName = resolve(pluginsDir).split(sep).at(-1);
  for (const line of output.split('\n')) {
    // Porcelain v1: two status characters, a space, then the path — relative to
    // the repository root, which is why the plugin directory is recovered by
    // matching the tail rather than by splitting from the front.
    const path = line.slice(3).trim();
    if (path === '') continue;
    // A rename reads "old -> new"; the new side is the one that exists.
    const candidate = path.includes(' -> ') ? path.slice(path.indexOf(' -> ') + 4) : path;
    const segments = candidate.replace(/^"|"$/g, '').split('/');
    // plugins/<name>/... — the segment after the plugins directory's own name.
    const at = segments.indexOf(pluginsName ?? '');
    const name = at >= 0 ? segments[at + 1] : segments[0];
    if (name === undefined || name === '') continue;
    const lines = dirty.get(name);
    if (lines === undefined) dirty.set(name, [line]);
    else lines.push(line);
  }
  return dirty;
}

/** A stamp source shared by every plugin in one discovery pass. */
export interface PluginVersionContext {
  /** Absolute plugins directory, used as git's working directory. */
  readonly pluginsDir: string;
  /**
   * Directories with uncommitted changes, each mapped to its own porcelain
   * status lines; null when git could not answer at all.
   */
  readonly dirty: Map<string, string[]> | null;
}

/** Gathers the once-per-boot facts every stamp is derived from. */
export function createPluginVersionContext(pluginsDir: string): PluginVersionContext {
  const resolved = resolve(pluginsDir);
  const dirty = dirtyPluginDirectories(resolved);
  if (dirty === null) {
    const fromEnv = process.env['TERRACE_VERSION'];
    if (fromEnv === undefined || fromEnv.trim() === '') {
      logWarn(
        'plugin version stamps have no git and no TERRACE_VERSION to derive from — ' +
          'every restart will look like every plugin changed. Set TERRACE_VERSION ' +
          '(a docker image should inject it at build) to make the stamps stable.',
      );
    }
  }
  return { pluginsDir: resolved, dirty };
}

/**
 * The stamp for one plugin directory. See this file's header for the format and
 * for why each fallback is where it is.
 */
export function pluginVersionStamp(context: PluginVersionContext, directory: string): string {
  const pluginDir = join(context.pluginsDir, directory);
  const version = packageVersion(pluginDir);

  const tree = git(pluginDir, ['rev-parse', '--short', 'HEAD:./']);
  if (tree !== null && /^[0-9a-f]+$/.test(tree.trim())) {
    const hash = tree.trim();
    const status = context.dirty?.get(directory);
    if (status === undefined) return `${version}+${hash}`;
    // Dirty: the tree hash describes the COMMIT, so on its own it would claim
    // the edit does not exist. The status lines name WHAT changed and the diff
    // says HOW — together they make the marker content-derived.
    const diff = git(pluginDir, ['diff', 'HEAD', '--', '.']) ?? '';
    return `${version}+${hash}-dirty.${shortDigest([...status, diff].join('\n'))}`;
  }

  const fromEnv = process.env['TERRACE_VERSION'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    // Stable for the life of an image, which is the right granularity for a
    // deployment that ships no .git — see this file's header.
    return `${version}+env.${shortDigest(`${fromEnv.trim()}:${directory}`)}`;
  }

  return `${version}+boot.${BOOT_NONCE}`;
}

/**
 * Marker appended to the stamp of a plugin that was RE-IMPORTED in this process
 * (issue #198), with the reload's generation.
 *
 * WHY THE CONTENT STAMP ALONE IS NOT ENOUGH. A reload replaces a module, and the
 * client's one-shot page reload fires on a build identity built from these
 * stamps — so the identity has to move whenever the running code does. The
 * content stamp moves only when git can SEE the change: a deployment with no
 * .git (docker, a tarball self-host) stamps every plugin `+boot.<nonce>`, which
 * is fixed for the life of the process, and there an operator who edited a
 * plugin and reloaded it would get a server on new code and clients on old.
 * The generation says what the content digest cannot: this is not the module
 * that was imported before.
 */
const RELOAD_STAMP_MARKER = 'reload';

/**
 * The stamp for a plugin directory as re-imported under `generation` — the
 * ordinary content-derived stamp with the reload marker on the end, in the same
 * `-<marker>.<value>` shape as the dirty marker beside it.
 */
export function reloadedVersionStamp(
  context: PluginVersionContext,
  directory: string,
  generation: number,
): string {
  return `${pluginVersionStamp(context, directory)}-${RELOAD_STAMP_MARKER}.${generation}`;
}

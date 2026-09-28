// Terrace's one version, derived from git so every build of a commit agrees:
// a `feat` commit bumps the minor number and resets the patch; any other commit bumps the patch.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Pre-1.0: breaking changes bump minor, like any feature. */
const MAJOR = 0;
/** Conventional-commit feature subject, scoped or not; `feat!:` counts. */
const FEATURE_SUBJECT = /^feat(\([^)]*\))?!?:/;
/** Docker images ship no `.git`; the image build injects the version here instead. */
const VERSION_OVERRIDE_ENV = 'TERRACE_VERSION';
/** No repository and no override: an image built without TERRACE_VERSION (restart-and-persistence decisions). */
export const UNVERSIONED = 'unversioned';

function git(repoDir: string, args: string[], input?: string): string {
  // Output grows with history; no cap.
  return execFileSync('git', args, { cwd: repoDir, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: Infinity }).trim();
}

/**
 * `0.<feat commits>.<non-feat commits not reachable from any feat>`, merges excluded.
 * Every new commit raises it; a shallow clone undercounts.
 */
export function appVersion(repoDir: string): string {
  let log: string;
  try {
    log = git(repoDir, ['log', '--no-merges', '--format=%H %s', 'HEAD']);
  } catch (err) {
    throw new Error(`Terrace's version comes from git history; build from a git checkout with at least one commit. ${String(err)}`);
  }
  const features = log
    .split('\n')
    .map((line) => ({ hash: line.slice(0, line.indexOf(' ')), subject: line.slice(line.indexOf(' ') + 1) }))
    .filter((c) => FEATURE_SUBJECT.test(c.subject));
  const revs = ['HEAD', ...features.map((c) => `^${c.hash}`)].join('\n');
  const patches = git(repoDir, ['rev-list', '--no-merges', '--count', '--stdin'], `${revs}\n`);
  return `${MAJOR}.${features.length}.${patches}`;
}

/** The version client and server both stamp: TERRACE_VERSION, else {@link appVersion} of `repoRoot`. */
export function resolveAppVersion(repoRoot: string): string {
  const override = process.env[VERSION_OVERRIDE_ENV]?.trim();
  if (override !== undefined && override !== '') return override;
  if (!existsSync(join(repoRoot, '.git'))) return UNVERSIONED;
  return appVersion(repoRoot);
}

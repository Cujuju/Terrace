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
/** Trailer on a root commit that replaced earlier history: the version reached before it, e.g. `Version-Baseline: 0.632.5`. */
const BASELINE_TRAILER = 'Version-Baseline';
const BASELINE_VALUE = /^(\d+)\.(\d+)\.(\d+)$/;

function git(repoDir: string, args: string[], input?: string): string {
  // Output grows with history; no cap.
  return execFileSync('git', args, { cwd: repoDir, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: Infinity }).trim();
}

/** Feature and patch counts the root commit's baseline trailer carries over; zero without one. */
function baseline(repoDir: string): { features: number; patches: number } {
  const declared = git(repoDir, ['log', '--max-parents=0', `--format=%(trailers:key=${BASELINE_TRAILER},valueonly)`, 'HEAD'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (declared.length === 0) return { features: 0, patches: 0 };
  const match = declared.length === 1 ? BASELINE_VALUE.exec(declared[0]) : null;
  if (match === null || Number(match[1]) !== MAJOR) {
    throw new Error(`Expected one root-commit ${BASELINE_TRAILER} trailer of the form ${MAJOR}.<features>.<patches>; found ${JSON.stringify(declared)}.`);
  }
  return { features: Number(match[2]), patches: Number(match[3]) };
}

/**
 * `0.<feat commits>.<non-feat commits not reachable from any feat>`, merges excluded,
 * counted on from the root commit's {@link BASELINE_TRAILER} when it has one.
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
  const patches = Number(git(repoDir, ['rev-list', '--no-merges', '--count', '--stdin'], `${revs}\n`));
  const base = baseline(repoDir);
  // The baseline's patches precede this history's first feature, which resets them like any other.
  const carriedPatches = features.length === 0 ? base.patches : 0;
  return `${MAJOR}.${base.features + features.length}.${carriedPatches + patches}`;
}

/** The version client and server both stamp: TERRACE_VERSION, else {@link appVersion} of `repoRoot`. */
export function resolveAppVersion(repoRoot: string): string {
  const override = process.env[VERSION_OVERRIDE_ENV]?.trim();
  if (override !== undefined && override !== '') return override;
  if (!existsSync(join(repoRoot, '.git'))) return UNVERSIONED;
  return appVersion(repoRoot);
}

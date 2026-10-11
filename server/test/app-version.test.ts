import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNVERSIONED, appVersion, resolveAppVersion } from '../src/app-version.ts';

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
const commit = (subject: string): string => git('commit', '-q', '--allow-empty', '--no-verify', '-m', subject);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'terrace-version-'));
  git('init', '-q', '-b', 'main');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(repo, { recursive: true, force: true });
});

describe('appVersion', () => {
  it('bumps patch for non-feature commits', () => {
    commit('fix: a');
    commit('docs: b');
    expect(appVersion(repo)).toBe('0.0.2');
  });

  it('bumps minor for a feature and resets patch', () => {
    commit('fix: a');
    commit('feat: b');
    expect(appVersion(repo)).toBe('0.1.0');
    commit('style(ui): c');
    expect(appVersion(repo)).toBe('0.1.1');
  });

  it('counts scoped and breaking features', () => {
    commit('feat(ui): a');
    commit('feat!: b');
    commit('feature: not conventional');
    expect(appVersion(repo)).toBe('0.2.1');
  });

  it('keeps rising across a merge of patches, and ignores the merge commit', () => {
    commit('feat: base');
    git('checkout', '-q', '-b', 'side');
    commit('fix: side');
    git('checkout', '-q', 'main');
    commit('fix: main');
    expect(appVersion(repo)).toBe('0.1.1');
    git('merge', '-q', '--no-ff', '--no-edit', 'side');
    expect(appVersion(repo)).toBe('0.1.2');
  });

  it('refuses a checkout without commits', () => {
    expect(() => appVersion(repo)).toThrow(/git history/);
  });
});

describe('resolveAppVersion', () => {
  it('derives from git when TERRACE_VERSION is unset or blank', () => {
    commit('feat: a');
    vi.stubEnv('TERRACE_VERSION', ' ');
    expect(resolveAppVersion(repo)).toBe('0.1.0');
  });

  it('prefers TERRACE_VERSION', () => {
    commit('feat: a');
    vi.stubEnv('TERRACE_VERSION', ' 0.9.9 ');
    expect(resolveAppVersion(repo)).toBe('0.9.9');
  });

  it('is unversioned without a repository or override, and still refuses an empty one', () => {
    vi.stubEnv('TERRACE_VERSION', '');
    const bare = mkdtempSync(join(tmpdir(), 'terrace-version-bare-'));
    try {
      expect(resolveAppVersion(bare)).toBe(UNVERSIONED);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    expect(() => resolveAppVersion(repo)).toThrow(/git history/);
  });
});

import { execSync, type ExecSyncOptions } from 'node:child_process';

function deriveGitVersion(): string | null {
  try {
    const opts: ExecSyncOptions = { stdio: ['ignore', 'pipe', 'ignore'] };
    const count = execSync('git rev-list --count HEAD', opts).toString().trim();
    const hash = execSync('git rev-parse --short HEAD', opts).toString().trim();
    if (/^\d+$/.test(count) && /^[0-9a-f]+$/.test(hash)) {
      return `${count}.${hash}`;
    }
    return null;
  } catch {
    return null;
  }
}

const fromEnv = process.env['TERRACE_VERSION'];

export const SERVER_VERSION: string =
  fromEnv !== undefined && fromEnv.trim() !== ''
    ? fromEnv.trim()
    : (deriveGitVersion() ?? 'unversioned');

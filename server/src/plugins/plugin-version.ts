import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { logWarn } from '../log.ts';

const STAMP_DIGEST_LENGTH = 7;

const BOOT_NONCE = createHash('sha256')
  .update(`${process.pid}:${Date.now()}:${Math.random()}`)
  .digest('hex')
  .slice(0, STAMP_DIGEST_LENGTH);

function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, STAMP_DIGEST_LENGTH);
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
}

function dirtyPluginDirectories(pluginsDir: string): Map<string, string[]> | null {
  const output = git(pluginsDir, ['status', '--porcelain', '--', '.']);
  if (output === null) return null;
  const dirty = new Map<string, string[]>();
  const pluginsName = resolve(pluginsDir).split(sep).at(-1);
  for (const line of output.split('\n')) {
    const path = line.slice(3).trim();
    if (path === '') continue;
    const candidate = path.includes(' -> ') ? path.slice(path.indexOf(' -> ') + 4) : path;
    const segments = candidate.replace(/^"|"$/g, '').split('/');
    const at = segments.indexOf(pluginsName ?? '');
    const name = at >= 0 ? segments[at + 1] : segments[0];
    if (name === undefined || name === '') continue;
    const lines = dirty.get(name);
    if (lines === undefined) dirty.set(name, [line]);
    else lines.push(line);
  }
  return dirty;
}

export interface PluginVersionContext {
  readonly pluginsDir: string;
  readonly dirty: Map<string, string[]> | null;
}

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

export function pluginVersionStamp(context: PluginVersionContext, directory: string): string {
  const pluginDir = join(context.pluginsDir, directory);

  const tree = git(pluginDir, ['rev-parse', '--short', 'HEAD:./']);
  if (tree !== null && /^[0-9a-f]+$/.test(tree.trim())) {
    const hash = tree.trim();
    const status = context.dirty?.get(directory);
    if (status === undefined) return hash;
    const diff = git(pluginDir, ['diff', 'HEAD', '--', '.']) ?? '';
    return `${hash}-dirty.${shortDigest([...status, diff].join('\n'))}`;
  }

  const fromEnv = process.env['TERRACE_VERSION'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return `env.${shortDigest(`${fromEnv.trim()}:${directory}`)}`;
  }

  return `boot.${BOOT_NONCE}`;
}

const RELOAD_STAMP_MARKER = 'reload';

export function reloadedVersionStamp(
  context: PluginVersionContext,
  directory: string,
  generation: number,
): string {
  return `${pluginVersionStamp(context, directory)}-${RELOAD_STAMP_MARKER}.${generation}`;
}

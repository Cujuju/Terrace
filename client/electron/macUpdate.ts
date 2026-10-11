// macOS updates without Apple signing, which Electron's own updater requires.
// Reads latest-mac.yml, downloads and checks the zip, and swaps the bundle after exit.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, constants, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { APP_NAME } from './appEnv.ts';

const run = promisify(execFile);

/** The release file electron-builder writes for macOS: the version, and each download with its hash. */
const LATEST_MAC_FILE = 'latest-mac.yml';
/** macOS' archiver: unpacks a zip keeping the bundle's links and attributes. */
const DITTO = '/usr/bin/ditto';
/** Where macOS runs a downloaded app it has not been moved from: a read-only copy. */
const TRANSLOCATED = '/AppTranslocation/';
/** The folder in the app profile that the download and the unpacked update use. */
export const UPDATES_DIR = 'updates';
const HTTP_NOT_FOUND = 404;
const PERCENT = 100;
const PROCESS_POLL_S = 0.2;

interface MacUpdateFile {
  url: string;
  sha512: string;
  size: number;
}

interface MacRelease {
  version: string;
  files: MacUpdateFile[];
}

/** latest-mac.yml as electron-builder writes it: `version:` and a `files:` list of url, sha512 and size. */
function parseLatestMac(yml: string): MacRelease | null {
  const version = /^version:\s*['"]?([^\s'"]+)['"]?\s*$/m.exec(yml)?.[1];
  if (!version) return null;
  const files: MacUpdateFile[] = [];
  let item: Record<string, string> | null = null;
  const keep = (): void => {
    const size = Number(item?.['size']);
    if (item?.['url'] && item['sha512'] && Number.isFinite(size)) {
      files.push({ url: item['url'], sha512: item['sha512'], size });
    }
  };
  let inFiles = false;
  for (const line of yml.split(/\r?\n/)) {
    // A top-level key: the files list is the lines indented under `files:`.
    if (/^\S/.test(line)) {
      inFiles = /^files:\s*$/.test(line);
      continue;
    }
    if (!inFiles) continue;
    const starts = /^\s*-\s+(.*)$/.exec(line);
    if (starts) {
      keep();
      item = {};
    }
    const field = /^([A-Za-z0-9]+):\s*['"]?([^\s'"]+)['"]?\s*$/.exec(starts?.[1] ?? line.trim());
    if (field?.[1] !== undefined && field[2] !== undefined && item) item[field[1]] = field[2];
  }
  keep();
  return { version, files };
}

/** Whether version `a` is newer than `b`; both are dotted numbers. */
function isNewerVersion(a: string, b: string): boolean {
  const parts = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** The .app bundle `exe` (the running program's path) is in; null when it is not in one. */
function appBundleOf(exe: string): string | null {
  const at = exe.indexOf('.app/Contents/MacOS/');
  return at < 0 ? null : exe.slice(0, at + '.app'.length);
}

/** Why the bundle at `appPath` cannot be replaced where it is; null when it can. */
async function replaceRefusal(appPath: string): Promise<string | null> {
  if (appPath.includes(TRANSLOCATED)) {
    return `Move ${APP_NAME} to the Applications folder, then open it from there: macOS runs it from a read-only copy until it is moved.`;
  }
  try {
    await access(dirname(appPath), constants.W_OK);
    return null;
  } catch {
    return `${APP_NAME} can’t write to ${dirname(appPath)}; move it to a folder you can change.`;
  }
}

const quoted = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/** Shell script installing `staged` over `appPath` once `pid` has exited; the old bundle is put back if the move fails. */
function swapScript(pid: number, appPath: string, staged: string, relaunch: boolean): string {
  const old = `${appPath}.old`;
  return [
    `while kill -0 ${pid} 2>/dev/null; do sleep ${PROCESS_POLL_S}; done`,
    `rm -rf ${quoted(old)}`,
    `mv ${quoted(appPath)} ${quoted(old)} || exit 1`,
    `if mv ${quoted(staged)} ${quoted(appPath)}; then rm -rf ${quoted(old)}; else mv ${quoted(old)} ${quoted(appPath)}; fi`,
    ...(relaunch ? [`open ${quoted(appPath)}`] : []),
  ].join('\n');
}

export interface MacUpdaterOptions {
  /** `owner/name` of the GitHub repo whose latest release is the update. */
  repo: string;
  currentVersion: string;
  arch: string;
  /** The running program's path (process.execPath). */
  exe: string;
  /** The app profile's updates folder. */
  dir: string;
  /** Electron's net.fetch: the system's proxy and certificates. */
  fetch: (url: string) => Promise<Response>;
  onProgress(percent: number): void;
}

/** A downloaded, unpacked update, ready to be swapped in. */
export interface StagedUpdate {
  version: string;
  /** The new .app bundle, in the updates folder. */
  staged: string;
  /** The bundle it replaces. */
  appPath: string;
}

/** Checks the repo's latest release and stages a newer build. */
export class MacUpdater {
  constructor(private readonly o: MacUpdaterOptions) {}

  private releaseUrl(file: string): string {
    return `https://github.com/${this.o.repo}/releases/latest/download/${file}`;
  }

  /** The latest release when it is newer than this build and has a zip for this Mac; null when up to date. */
  async newer(): Promise<{ version: string; file: MacUpdateFile } | null> {
    const r = await this.o.fetch(this.releaseUrl(LATEST_MAC_FILE));
    // A release whose macOS build has not been uploaded yet: it follows the Windows one.
    if (r.status === HTTP_NOT_FOUND) return null;
    if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${LATEST_MAC_FILE}.`);
    const release = parseLatestMac(await r.text());
    if (!release) throw new Error(`${LATEST_MAC_FILE} couldn’t be read.`);
    if (!isNewerVersion(release.version, this.o.currentVersion)) return null;
    // electron-builder.ts names each zip `…-<arch>-mac.zip`.
    const file = release.files.find((f) => f.url.endsWith(`-${this.o.arch}-mac.zip`));
    if (!file) throw new Error(`Release ${release.version} has no build for this Mac (${this.o.arch}).`);
    return { version: release.version, file };
  }

  /** Downloads, checks and unpacks `file`; rejects with why this install cannot be updated in place. */
  async stage(version: string, file: MacUpdateFile): Promise<StagedUpdate> {
    const appPath = appBundleOf(this.o.exe);
    if (!appPath) throw new Error(`${APP_NAME} isn’t running from an app bundle.`);
    const refusal = await replaceRefusal(appPath);
    if (refusal) throw new Error(refusal);
    await rm(this.o.dir, { recursive: true, force: true });
    await mkdir(this.o.dir, { recursive: true });
    const zip = join(this.o.dir, 'update.zip');
    await this.download(file, zip);
    const unpacked = join(this.o.dir, 'unpacked');
    await run(DITTO, ['-x', '-k', zip, unpacked]);
    await rm(zip, { force: true });
    const staged = join(unpacked, basename(appPath));
    // The zip holds the bundle under the name this one has; anything else is not this app's update.
    await access(join(staged, 'Contents', 'MacOS', basename(this.o.exe)));
    const info = await readFile(join(staged, 'Contents', 'Info.plist'), 'utf8').catch(() => '');
    if (!info.includes(`<string>${version}</string>`)) throw new Error(`The download isn’t ${APP_NAME} ${version}.`);
    return { version, staged, appPath };
  }

  private async download(file: MacUpdateFile, dest: string): Promise<void> {
    const r = await this.o.fetch(this.releaseUrl(file.url));
    if (!r.ok || !r.body) throw new Error(`GitHub answered ${r.status} for ${file.url}.`);
    const hash = createHash('sha512');
    let received = 0;
    let shown = -1;
    const counted = Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]).on('data', (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      const percent = Math.min(PERCENT, Math.floor((received / file.size) * PERCENT));
      // Whole-percent steps only: chunks arrive many times a second.
      if (percent !== shown) this.o.onProgress((shown = percent));
    });
    await pipeline(counted, createWriteStream(dest));
    if (hash.digest('base64') !== file.sha512) {
      await rm(dest, { force: true });
      throw new Error('The download didn’t match the release’s checksum.');
    }
  }
}

/** Starts the swap, which waits for this process to exit. Call while quitting: nothing else may touch the bundle after. */
export function installStaged(update: StagedUpdate, relaunch: boolean): void {
  spawn('/bin/sh', ['-c', swapScript(process.pid, update.appPath, update.staged, relaunch)], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

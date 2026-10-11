// Checks public releases at startup and periodically, downloads in the background, installs on quit.
// Windows uses electron-updater; macOS builds are unsigned and use macUpdate.ts. Dev runs skip updates.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, net } from 'electron';
import electronUpdater from 'electron-updater';
import { IS_MAC } from './appEnv.ts';
import type { UpdateStatus } from './contract.ts';
import { installStaged, MacUpdater, UPDATES_DIR, type StagedUpdate } from './macUpdate.ts';
import { installOnRestart, restartApp } from './restart.ts';
import { profilePath } from './settingsFile.ts';

const { autoUpdater } = electronUpdater;

const MS_PER_HOUR = 3_600_000;
/** Releases are occasional: a few checks a day find one the day it ships. */
const CHECK_EVERY_MS = 6 * MS_PER_HOUR;
/** The public repo whose releases are the updates (electron-builder.ts publishes there). */
const RELEASE_REPO = 'Cujuju/Terrace';
const BUSY_PHASES: readonly UpdateStatus['phase'][] = ['unsupported', 'checking', 'downloading', 'ready'];

/** electron-builder writes electron-updater's feed here for installers only; an unpacked build has none. */
const WINDOWS_FEED = join(process.resourcesPath, 'app-update.yml');
/** Only an installed build can update: macOS reads the releases itself, Windows needs its feed file. */
const CAN_UPDATE = app.isPackaged && (IS_MAC || existsSync(WINDOWS_FEED));

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Updates {
  private status: UpdateStatus = CAN_UPDATE ? { phase: 'idle' } : { phase: 'unsupported' };
  /** macOS' updater; undefined on other systems and in dev. */
  private mac: MacUpdater | undefined;
  /** The update macOS has unpacked, waiting for a quit to swap it in. */
  private staged: StagedUpdate | undefined;
  /** The quit under way is a restart: the installed update opens again. */
  private reopen = false;

  constructor(private readonly onChange: (status: UpdateStatus) => void) {
    if (!CAN_UPDATE) return;
    if (IS_MAC) {
      this.mac = new MacUpdater({
        repo: RELEASE_REPO,
        currentVersion: app.getVersion(),
        arch: process.arch,
        exe: process.execPath,
        dir: profilePath(UPDATES_DIR),
        fetch: (url) => net.fetch(url),
        onProgress: (percent) => {
          if (this.status.phase === 'downloading') this.set({ ...this.status, percent });
        },
      });
      // At 'quit', after every 'will-quit' listener: one swap starts, knowing whether it reopens.
      app.on('quit', () => {
        if (this.staged) installStaged(this.staged, this.reopen);
      });
    } else {
      // A quit with an update downloaded installs it silently; a restart, through installOnRestart.
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking' }));
      autoUpdater.on('update-not-available', () => this.set({ phase: 'current' }));
      autoUpdater.on('update-available', (info) => this.set({ phase: 'downloading', version: info.version, percent: 0 }));
      autoUpdater.on('download-progress', (p) => {
        const percent = Math.floor(p.percent);
        // Progress arrives many times a second; the page hears of whole-percent steps only.
        if (this.status.phase === 'downloading' && percent !== this.status.percent) this.set({ ...this.status, percent });
      });
      autoUpdater.on('update-downloaded', (info) => {
        installOnRestart(() => autoUpdater.quitAndInstall(true, true));
        this.set({ phase: 'ready', version: info.version });
      });
      autoUpdater.on('error', (err) => this.set({ phase: 'failed', message: messageOf(err) }));
    }
    void this.check();
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  current(): UpdateStatus {
    return this.status;
  }

  /** Looks for a newer release; nothing while one is being checked, downloaded or waits to be installed. */
  async check(): Promise<void> {
    if (BUSY_PHASES.includes(this.status.phase)) return;
    if (this.mac) return this.checkMac(this.mac);
    // Failures arrive as 'error' events too, which set the status.
    const result = await autoUpdater.checkForUpdates().catch(() => null);
    void result?.downloadPromise?.catch(() => undefined);
  }

  /** Restarts, which installs the downloaded update and opens the app again. */
  install(): void {
    if (this.status.phase === 'ready') restartApp();
  }

  private async checkMac(mac: MacUpdater): Promise<void> {
    this.set({ phase: 'checking' });
    try {
      const found = await mac.newer();
      if (!found) return this.set({ phase: 'current' });
      this.set({ phase: 'downloading', version: found.version, percent: 0 });
      this.staged = await mac.stage(found.version, found.file);
      installOnRestart(() => void (this.reopen = true));
      this.set({ phase: 'ready', version: found.version });
    } catch (err) {
      this.set({ phase: 'failed', message: messageOf(err) });
    }
  }

  private set(status: UpdateStatus): void {
    this.status = status;
    this.onChange(status);
  }
}

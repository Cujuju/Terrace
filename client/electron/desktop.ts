// The desktop shell's state in main: settings, the embedded server, what the window shows, the tray, the hotkey and updates.
import { app, dialog, globalShortcut, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { APP_NAME, IS_WINDOWS, appIconPath, devServerUrl, envDataDir, fixedPort } from './appEnv.ts';
import {
  DEFAULT_SERVER_PORT,
  DESKTOP_INVOKE_CHANNEL,
  DESKTOP_STATE_CHANNEL,
  GUEST_METHODS,
  MAX_PORT,
  MIN_OPERATOR_KEY_LENGTH,
  MIN_PORT,
  SERVER_SETTING_KEYS,
  desktopPlatform,
  normalizeDesktopSettings,
  type DesktopMethod,
  type DesktopSettings,
  type DesktopState,
  type DesktopView,
  type FailedJoin,
  type JoinFailure,
} from './contract.ts';
import type { TrayChoices } from './mainWindow.ts';
import { restartApp } from './restart.ts';
import { ServerSupervisor, type ServerLaunch } from './serverChild.ts';
import { freePortFrom, loopbackOrigin, portFree, probeServer } from './serverProbe.ts';
import { readDesktopSettings, writeDesktopSettings } from './settingsFile.ts';
import { AppTray } from './tray.ts';
import { Updates } from './updates.ts';
import { raiseWindow } from './windowState.ts';

declare const __CLIENT_VERSION__: string;

/** Passed by Windows' sign-in entry, so a start at sign-in can stay in the tray. */
const AT_LOGIN_ARG = '--at-login';
/** The sign-in entry's registry value name; build/installer.nsh removes it on uninstall. */
const LOGIN_ITEM_NAME = APP_NAME;
const HTTP_ERROR_STATUS = 400;
const CONNECT_BUTTON = 0;
const USE_FREE_PORT_BUTTON = 0;
const QUIT_BUTTON = 1;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));


/** Whether the system started this run at sign-in. Windows passes the entry's argument; macOS says so itself. */
const startedAtLogin = (): boolean =>
  process.argv.includes(AT_LOGIN_ARG) || (!IS_WINDOWS && app.getLoginItemSettings().wasOpenedAtLogin);

/** Reports whether the system starts the app at sign-in; null for dev runs. */
function openAtLogin(): boolean | null {
  if (!app.isPackaged) return null;
  // Windows' Startup apps switch can turn the entry off without removing it.
  if (IS_WINDOWS) return app.getLoginItemSettings({ args: [AT_LOGIN_ARG] }).executableWillLaunchAtLogin;
  return app.getLoginItemSettings().openAtLogin;
}

/** A typed server address as a URL: http and the default port unless it says otherwise. */
function remoteUrl(address: string): URL | null {
  const typed = address.trim();
  if (typed === '') return null;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed);
    const url = new URL(hasScheme ? typed : `http://${typed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!hasScheme && url.port === '') url.port = String(DEFAULT_SERVER_PORT);
    return url;
  } catch {
    return null;
  }
}

/** Throws with what is wrong about `patch`; a bad key must be refused, never read as "no key". */
function checkPatch(patch: Partial<DesktopSettings>): void {
  for (const name of ['rollbackKey', 'worldAdminKey'] as const) {
    const key = patch[name];
    if (key !== undefined && key !== '' && key.length < MIN_OPERATOR_KEY_LENGTH) {
      throw new Error(`A key needs at least ${MIN_OPERATOR_KEY_LENGTH} characters, or none at all.`);
    }
  }
  const port = patch.port;
  if (port !== undefined && (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT)) {
    throw new Error(`The port must be between ${MIN_PORT} and ${MAX_PORT}.`);
  }
}

export class Desktop {
  private settings = readDesktopSettings();
  private view: DesktopView = { kind: 'home' };
  /** A join is loading: its redirects may leave the address typed. */
  private joining = false;
  /** False when another process held the port and the window shows that server instead. */
  private hosting = true;
  private failed = false;
  private joinFailure: FailedJoin | null = null;
  private bound: string | null = null;
  private hotkeyTaken = false;
  private win: BrowserWindow | undefined;
  private tray: AppTray | undefined;
  private updates: Updates | undefined;
  private readonly supervisor = new ServerSupervisor(
    () => this.launch(),
    (logPath) => this.fail(`The world server keeps stopping. Its log is at ${logPath}`),
  );
  private readonly trayAvailable = appIconPath() !== null;

  /** `onFatal` reports why the app cannot go on, then ends it. */
  constructor(private readonly onFatal: (message: string) => void) {}

  readonly trayChoices: TrayChoices = {
    startHidden: this.trayAvailable && startedAtLogin() && this.settings.startHidden,
    minimizeToTray: () => this.tray !== undefined && this.settings.minimizeToTray,
    closeToTray: () => this.tray !== undefined && this.settings.closeToTray,
  };

  dataDir(): string | null {
    return envDataDir() ?? this.settings.dataDir;
  }

  private port(): number {
    return fixedPort() ?? this.settings.port;
  }

  private homeUrl(): string {
    return devServerUrl ?? loopbackOrigin(this.port());
  }

  private launch(): ServerLaunch {
    const dataDir = this.dataDir();
    if (dataDir === null) throw new Error('The server was started before a data folder was chosen.');
    const { rollbackKey, worldAdminKey } = this.settings;
    return { port: this.port(), dataDir, rollbackKey, worldAdminKey };
  }

  /** Whether the window may show `url`: this machine's page, or the server joined. */
  allows(url: string): boolean {
    if (this.joining) return true;
    const origin = new URL(url).origin;
    if (origin === new URL(this.homeUrl()).origin) return true;
    return this.view.kind === 'remote' && origin === this.view.origin;
  }

  /** Asks for the data folder when none is set; false when the owner declines. */
  async ensureDataDir(): Promise<boolean> {
    return this.dataDir() !== null || (await this.pickDataDir());
  }

  private async pickDataDir(): Promise<boolean> {
    const options: Electron.OpenDialogOptions = {
      title: `Choose where ${APP_NAME} keeps its worlds`,
      defaultPath: this.dataDir() ?? app.getPath('documents'),
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    const picked = this.win ? await dialog.showOpenDialog(this.win, options) : await dialog.showOpenDialog(options);
    const dir = picked.filePaths[0];
    if (picked.canceled || dir === undefined) return false;
    await this.set({ dataDir: dir });
    return true;
  }

  /** Starts the embedded server and waits for it; false when the app should quit instead. */
  async host(): Promise<boolean> {
    const port = this.port();
    if (await portFree(port)) return this.startServer();
    // The window loads this exact origin, so that is where the holder must prove it is Terrace.
    const holder = await probeServer(loopbackOrigin(port));
    if (holder.kind === 'terrace') return this.offerRunningServer(port, holder.identity.version);
    return this.offerOtherPort(port);
  }

  /** Another Terrace server holds the port: show it instead, or quit. */
  private async offerRunningServer(port: number, version: string): Promise<boolean> {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `A ${APP_NAME} server (version ${version}) is already running on port ${port}.`,
      detail: `${APP_NAME} can show it instead of starting its own.`,
      buttons: ['Connect to it', `Quit ${APP_NAME}`],
      defaultId: CONNECT_BUTTON,
      cancelId: QUIT_BUTTON,
    });
    this.hosting = false;
    return response === CONNECT_BUTTON;
  }

  /** Another program holds the port: move this server to a free one with the owner's consent, or quit. */
  private async offerOtherPort(port: number): Promise<boolean> {
    // A failed bind can also be a system reservation (Windows excluded port ranges).
    const message = `Port ${port} is held by another program or reserved by the system.`;
    if (fixedPort() !== null) {
      await dialog.showMessageBox({
        type: 'error',
        message,
        detail: `This run's port is fixed by its environment. Close the other program, or start ${APP_NAME} with a different port.`,
        buttons: [`Quit ${APP_NAME}`],
      });
      return false;
    }
    const free = await freePortFrom(port + 1);
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message,
      detail: `${APP_NAME} can host on port ${free} instead and keep it. Players joining you need the new port; you can change it in Settings.`,
      buttons: [`Use port ${free}`, `Quit ${APP_NAME}`],
      defaultId: USE_FREE_PORT_BUTTON,
      cancelId: QUIT_BUTTON,
    });
    if (response !== USE_FREE_PORT_BUTTON) return false;
    await this.set({ port: free });
    return this.startServer();
  }

  /** Starts the embedded server with no window to show it in. */
  async startServer(): Promise<boolean> {
    this.supervisor.start();
    if (await this.supervisor.ready()) return true;
    this.fail('The world server did not start in time.');
    return false;
  }

  async stopServer(): Promise<void> {
    await this.supervisor.stop();
    this.supervisor.close();
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.onFatal(message);
  }

  /** Adds the tray, hotkey, updates and the page's calls for the main window. */
  attach(win: BrowserWindow): void {
    this.win = win;
    const icon = appIconPath();
    if (icon !== null) {
      this.tray = new AppTray(icon, {
        open: () => raiseWindow(win),
        goHome: () => {
          this.showHome();
          raiseWindow(win);
        },
        restart: () => restartApp(),
        quit: () => app.quit(),
      });
    }
    this.updates = new Updates((status) => {
      this.tray?.setUpdate(status.phase === 'ready' ? status.version : null);
      this.changed();
    });
    this.bindHotkey();
    app.on('will-quit', () => globalShortcut.unregisterAll());
    ipcMain.handle(DESKTOP_INVOKE_CHANNEL, (e, method: DesktopMethod, ...args: unknown[]) => this.invoke(e, method, args));
  }

  showHome(): void {
    this.view = { kind: 'home' };
    void this.win?.loadURL(this.homeUrl());
    this.changed();
  }

  private changed(): void {
    this.tray?.setRemote(this.view.kind === 'remote');
    // No payload: each page asks for the state it is allowed to see.
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(DESKTOP_STATE_CHANNEL);
  }

  private state(trusted: boolean): DesktopState {
    if (!trusted) return { trusted: false, view: this.view };
    return {
      trusted: true,
      view: this.view,
      platform: desktopPlatform(process.platform),
      settings: this.settings,
      dataDir: this.dataDir(),
      port: this.port(),
      dataDirLocked: envDataDir() !== null,
      portLocked: fixedPort() !== null,
      hosting: this.hosting,
      joinFailure: this.joinFailure,
      openAtLogin: openAtLogin(),
      hotkeyTaken: this.hotkeyTaken,
      trayAvailable: this.tray !== undefined,
      update: this.updates?.current() ?? { phase: 'unsupported' },
      version: __CLIENT_VERSION__,
    };
  }

  private async set(patch: Partial<DesktopSettings>): Promise<void> {
    checkPatch(patch);
    const before = this.settings;
    this.settings = normalizeDesktopSettings({ ...before, ...patch });
    writeDesktopSettings(this.settings);
    this.bindHotkey();
    this.changed();
    const serverChanged = SERVER_SETTING_KEYS.some((key) => before[key] !== this.settings[key]);
    // Before the first start there is no server to restart: host() reads the new settings.
    if (!serverChanged || !this.hosting || this.win === undefined) return;
    await this.supervisor.restart();
    if (!(await this.supervisor.ready())) return this.fail('The world server did not come back after the change.');
    if (this.view.kind === 'home') this.showHome();
  }

  private setOpenAtLogin(on: boolean): void {
    if (!app.isPackaged) throw new Error(`Starting at sign-in needs an installed ${APP_NAME}.`);
    // `enabled` also sets Windows' Startup apps switch. Only Windows' entries carry arguments and a name.
    app.setLoginItemSettings(
      IS_WINDOWS ? { openAtLogin: on, enabled: on, args: [AT_LOGIN_ARG], name: LOGIN_ITEM_NAME } : { openAtLogin: on },
    );
    this.changed();
  }

  /** Kept in state, not returned: a failure after navigating reloads the home page that asked. */
  private failJoin(address: string, failure: JoinFailure, navigated: boolean): void {
    this.joinFailure = { address: address.trim(), failure };
    if (navigated) this.showHome();
    else this.changed();
  }

  private async join(address: string): Promise<void> {
    const win = this.win;
    if (win === undefined) return;
    this.joinFailure = null;
    const url = remoteUrl(address);
    if (url === null) return this.failJoin(address, { kind: 'badAddress' }, false);
    const target = await probeServer(url.origin);
    if (target.kind === 'unreachable') {
      return this.failJoin(address, { kind: 'unreachable', host: url.host, cause: target.cause, detail: target.detail }, false);
    }
    if (target.kind === 'other') return this.failJoin(address, { kind: 'notTerrace', host: url.host }, false);
    let status = 0;
    win.webContents.once('did-navigate', (_e, _url, httpStatus) => (status = httpStatus));
    this.joining = true;
    try {
      await win.loadURL(url.href);
    } catch (err) {
      this.joining = false;
      return this.failJoin(address, { kind: 'unreachable', host: url.host, cause: 'other', detail: messageOf(err) }, true);
    }
    this.joining = false;
    if (status >= HTTP_ERROR_STATUS) return this.failJoin(address, { kind: 'noClient', host: url.host, status }, true);
    // Redirects during the load may land elsewhere; that origin must be Terrace too.
    const landed = new URL(win.webContents.getURL());
    if (landed.origin !== url.origin && (await probeServer(landed.origin)).kind !== 'terrace') {
      return this.failJoin(address, { kind: 'notTerrace', host: landed.host }, true);
    }
    this.view = { kind: 'remote', origin: landed.origin };
    await this.set({ lastServer: address.trim() });
  }

  private dismissJoinFailure(): void {
    this.joinFailure = null;
    this.changed();
  }

  /** Shows the main window, or hides it to the tray when it is the one in front. */
  private toggleWindow(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (this.tray !== undefined && win.isVisible() && !win.isMinimized() && win.isFocused()) win.hide();
    else raiseWindow(win);
  }

  private bindHotkey(): void {
    const wanted = this.settings.hotkey;
    if (wanted === this.bound && !this.hotkeyTaken) return;
    if (this.bound) globalShortcut.unregister(this.bound);
    this.bound = null;
    this.hotkeyTaken = false;
    if (!wanted) return;
    // False when another app holds the shortcut.
    if (globalShortcut.register(wanted, () => this.toggleWindow())) this.bound = wanted;
    else this.hotkeyTaken = true;
  }

  private invoke(e: IpcMainInvokeEvent, method: DesktopMethod, args: unknown[]): unknown {
    // Another server's page runs in this window too; it gets the way home and nothing else.
    const fromHome = e.sender === this.win?.webContents && e.senderFrame?.origin === new URL(this.homeUrl()).origin;
    if (!fromHome && !GUEST_METHODS.includes(method)) throw new Error(`${method} is not available to this page.`);
    switch (method) {
      case 'state':
        return this.state(fromHome);
      case 'set':
        return this.set(args[0] as Partial<DesktopSettings>);
      case 'setOpenAtLogin':
        return this.setOpenAtLogin(args[0] === true);
      case 'chooseDataDir':
        return this.pickDataDir().then(() => undefined);
      case 'join':
        return this.join(String(args[0]));
      case 'dismissJoinFailure':
        return this.dismissJoinFailure();
      case 'goHome':
        return this.showHome();
      case 'checkForUpdate':
        return this.updates?.check();
      case 'installUpdate':
        return this.updates?.install();
    }
  }
}

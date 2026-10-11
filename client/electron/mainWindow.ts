// The game window: its placement, where its close and minimize send it, and which pages it may show.
import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { IS_WINDOWS, appIconPath, isPackaged } from './appEnv.ts';
import { manageWindowState, raiseWindow, savedWindowState } from './windowState.ts';

/** dist-electron/, where vite-plugin-electron writes main.js; the preload is shipped as written. */
const PRELOAD = join(import.meta.dirname, '..', 'electron', 'preload.cjs');
/** First-run size, before any placement is saved. */
const DEFAULT_SIZE = { width: 1440, height: 960 } as const;
/** The game's own background, so the window never flashes white. */
const BACKGROUND_COLOR = '#0b1016';

/** Shown while the embedded server loads its world. */
const STARTING_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<body style="margin:0;height:100vh;display:grid;place-items:center;background:${BACKGROUND_COLOR};color:#9fb0c0;font:16px system-ui">Starting the world…</body>`,
)}`;

const fromCode = new WeakSet<BrowserWindow>();

/** Closes `win` from code (the tray's Quit, a restart), so it closes rather than going to the tray. */
export function closeFromCode(win: BrowserWindow): void {
  fromCode.add(win);
  win.close();
}

/** Read at each close and minimize, so a changed setting applies at once. */
export interface TrayChoices {
  startHidden: boolean;
  minimizeToTray(): boolean;
  closeToTray(): boolean;
}

/** Decides whether the window may show `url`; everything else opens in the system browser. */
export type PageGuard = (url: string) => boolean;

const WM_SYSCOMMAND = 0x0112;
const SC_CLOSE = 0xf060;
/** WM_SYSCOMMAND's low four bits are Windows' own; the command is the rest. */
const SYSCOMMAND_MASK = 0xfff0;
const POINTER_BYTES = 8;

/** The WM_SYSCOMMAND command in a hooked message's wParam (pointer-sized). */
const sysCommand = (wParam: Buffer): number =>
  (wParam.length >= POINTER_BYTES ? Number(wParam.readBigUInt64LE()) : wParam.readUInt32LE()) & SYSCOMMAND_MASK;

const openExternally = (url: string): void => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
};

function guardPages(win: BrowserWindow, allowed: PageGuard): void {
  const permits = (url: string): boolean => {
    try {
      return allowed(url);
    } catch {
      return false;
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  const keepOnAllowedPages = (e: Electron.Event, url: string): void => {
    if (permits(url)) return;
    e.preventDefault();
    openExternally(url);
  };
  win.webContents.on('will-navigate', keepOnAllowedPages);
  win.webContents.on('will-redirect', keepOnAllowedPages);
}

/** Only the owner's own close command may hide the window to the tray; a close from code or a quit closes it. */
export function createMainWindow(tray: TrayChoices, allowed: PageGuard): BrowserWindow {
  const saved = savedWindowState();
  const devIcon = isPackaged ? null : appIconPath();
  const win = new BrowserWindow({
    ...(saved?.bounds ?? DEFAULT_SIZE),
    // A packaged build takes its icon from the executable.
    ...(devIcon === null ? {} : { icon: devIcon }),
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  manageWindowState(win, saved, tray.startHidden);
  guardPages(win, allowed);
  void win.loadURL(STARTING_PAGE);

  // Set by SC_CLOSE, which Windows turns into the 'close' below before the hook returns.
  let closeCommand = false;
  // Set while the app itself quits, which closes the window without it being the owner's close.
  let appQuitting = false;
  if (IS_WINDOWS) {
    win.hookWindowMessage(WM_SYSCOMMAND, (wParam) => {
      if (sysCommand(wParam) !== SC_CLOSE) return;
      closeCommand = true;
      // A refused close command must not mark a later close from code as the owner's.
      setImmediate(() => (closeCommand = false));
    });
  } else {
    // No window message tells the close button from a close in code here: code marks its own.
    const onBeforeQuit = (): void => void (appQuitting = true);
    const onActivate = (): void => void raiseWindow(win);
    app.on('before-quit', onBeforeQuit);
    app.on('activate', onActivate);
    win.on('closed', () => {
      app.off('before-quit', onBeforeQuit);
      app.off('activate', onActivate);
    });
  }
  win.on('minimize', () => {
    if (tray.minimizeToTray()) win.hide();
  });
  win.on('close', (e) => {
    const byCode = fromCode.delete(win);
    const ownerClose = IS_WINDOWS ? closeCommand : !byCode && !appQuitting;
    closeCommand = false;
    if (!ownerClose || !tray.closeToTray()) return;
    e.preventDefault();
    win.hide();
  });
  return win;
}

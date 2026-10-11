// Desktop entry: identity, one instance, the embedded server, then the window. `--headless` runs the server alone.
import { app, dialog } from 'electron';
import { APP_ID, APP_NAME, IS_MAC, appIconPath, isHeadless, isPackaged } from './appEnv.ts';
import { installAppMenu } from './appMenu.ts';
import { Desktop } from './desktop.ts';
import { createMainWindow } from './mainWindow.ts';
import { raiseWindow } from './windowState.ts';

declare const __CLIENT_VERSION__: string;
/** Internal: Electron's own dev loader sets the version from package.json this way. */
type AppWithSetVersion = typeof app & { setVersion(version: string): void };

const FAILURE_EXIT_CODE = 1;

// A dev run keeps its own profile, so it never shares settings with an installed build.
app.setName(isPackaged ? APP_NAME : `${APP_NAME}-Dev`);
// Dev loads package.json, which has no version; packaged builds carry it (electron-builder.ts).
if (!isPackaged) (app as AppWithSetVersion).setVersion(__CLIENT_VERSION__);

let serverStopped = false;
let stopping = false;

/** Holds every quit until the embedded server has written its shutdown snapshot and exited. */
function stopServerBeforeQuit(desktop: Desktop): void {
  app.on('before-quit', (e) => {
    if (serverStopped) return;
    e.preventDefault();
    if (stopping) return;
    stopping = true;
    void desktop.stopServer().then(() => {
      serverStopped = true;
      app.quit();
    });
  });
}

async function runHeadless(): Promise<void> {
  await app.whenReady();
  if (IS_MAC) app.dock?.hide();
  const desktop = new Desktop((message) => {
    console.error(`[desktop] ${message}`);
    app.exit(FAILURE_EXIT_CODE);
  });
  if (desktop.dataDir() === null) {
    console.error('[desktop] No data folder: set TERRACE_DATA_DIR, or choose one in the app first.');
    app.exit(FAILURE_EXIT_CODE);
    return;
  }
  stopServerBeforeQuit(desktop);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());
  await desktop.startServer();
}

async function runWindowed(): Promise<void> {
  await app.whenReady();
  app.setAppUserModelId(isPackaged ? APP_ID : `${APP_ID}.dev`);
  // A dev run is Electron's own bundle, so the dock shows Electron's icon unless told.
  const devIcon = isPackaged ? null : appIconPath();
  if (IS_MAC && devIcon !== null) app.dock?.setIcon(devIcon);
  installAppMenu();
  const desktop = new Desktop((message) => {
    dialog.showErrorBox(APP_NAME, message);
    app.exit(FAILURE_EXIT_CODE);
  });
  if (!(await desktop.ensureDataDir())) return app.quit();

  const win = createMainWindow(desktop.trayChoices, (url) => desktop.allows(url));
  app.on('second-instance', () => raiseWindow(win));
  app.on('window-all-closed', () => app.quit());
  stopServerBeforeQuit(desktop);
  // A sign-out or shutdown waits for the same graceful stop; a critical one cannot.
  win.on('query-session-end', (e) => {
    if (serverStopped) return;
    if (!e.reasons.includes('critical')) e.preventDefault();
    app.quit();
  });
  if (!(await desktop.host())) return app.quit();
  desktop.attach(win);
  desktop.showHome();
}

if (isHeadless) {
  void runHeadless();
} else if (app.requestSingleInstanceLock()) {
  void runWindowed();
} else {
  // The running instance raises its window.
  app.quit();
}

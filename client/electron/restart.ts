// Restarting the app through its normal quit, so the embedded server stops gracefully first.
import { app } from 'electron';

/** What a restart runs while quitting: a relaunch, or a downloaded update's install. */
let atQuit: () => void = () => app.relaunch();
let armed = false;

/** Makes every restart install the downloaded update (updates.ts), so no relaunch races its installer. */
export function installOnRestart(install: () => void): void {
  atQuit = install;
}

export function restartApp(): void {
  if (!armed) {
    armed = true;
    app.once('will-quit', () => atQuit());
  }
  app.quit();
}

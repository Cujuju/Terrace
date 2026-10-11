// Where the window was last placed, so it reopens that way.
import { readFileSync, writeFileSync } from 'node:fs';
import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { profilePath } from './settingsFile.ts';

const STATE_FILE = 'main-window.json';

/** `bounds` are the un-maximized bounds, so un-maximizing after a restore lands there. */
export interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
}

const RECT_KEYS = ['x', 'y', 'width', 'height'] as const;

function asRect(v: unknown): Rectangle | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!RECT_KEYS.every((k) => Number.isFinite(o[k]))) return undefined;
  return { x: o['x'] as number, y: o['y'] as number, width: o['width'] as number, height: o['height'] as number };
}

/** False when no connected display overlaps `b` (a monitor may have been unplugged). */
function onScreen(b: Rectangle): boolean {
  const area = screen.getDisplayMatching(b).workArea;
  return b.x < area.x + area.width && b.x + b.width > area.x && b.y < area.y + area.height && b.y + b.height > area.y;
}

/** The saved state, unless missing, malformed, or off every connected display. */
export function savedWindowState(): WindowState | undefined {
  try {
    const o = JSON.parse(readFileSync(profilePath(STATE_FILE), 'utf8')) as Record<string, unknown>;
    const bounds = asRect(o['bounds']);
    if (!bounds || !onScreen(bounds)) return undefined;
    return { bounds, maximized: o['maximized'] === true, fullScreen: o['fullScreen'] === true };
  } catch {
    // First open, or an unreadable file: default placement.
    return undefined;
  }
}

/** How each managed window is shown: in its saved state the first time, and only once it is ready. */
const showers = new WeakMap<BrowserWindow, () => void>();

/** Shows `win` once ready unless `startHidden`, in its saved state, and saves that state on each close after it was shown. */
export function manageWindowState(win: BrowserWindow, saved: WindowState | undefined, startHidden: boolean): void {
  let ready = false;
  let wanted = !startHidden;
  let shown = false;
  // Tracked from events: a minimized or hidden window reports neither as it was.
  let maximized = saved?.maximized ?? false;
  let fullScreen = saved?.fullScreen ?? false;
  const show = (): void => {
    if (!shown) {
      shown = true;
      if (fullScreen) win.setFullScreen(true);
      else if (maximized) win.maximize();
    }
    win.show();
  };
  showers.set(win, () => {
    if (ready) show();
    else wanted = true;
  });
  win.once('ready-to-show', () => {
    ready = true;
    if (wanted) show();
  });
  win.on('maximize', () => (maximized = true));
  win.on('unmaximize', () => (maximized = false));
  win.on('enter-full-screen', () => (fullScreen = true));
  win.on('leave-full-screen', () => (fullScreen = false));
  win.on('close', () => {
    if (!shown) return;
    const state: WindowState = { bounds: win.getNormalBounds(), maximized, fullScreen };
    try {
      writeFileSync(profilePath(STATE_FILE), JSON.stringify(state));
    } catch (err) {
      console.error('[desktop] window placement not saved:', err);
    }
  });
}

/** Brings `win` to the front, out of the tray or restored when minimized; false once it is gone. */
export function raiseWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  (showers.get(win) ?? (() => win.show()))();
  win.focus();
  return true;
}

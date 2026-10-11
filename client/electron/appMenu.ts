// The macOS menu bar's menus. Windows and Linux keep Electron's own, hidden in the window (autoHideMenuBar).
import { Menu, app, type MenuItemConstructorOptions } from 'electron';
import { IS_MAC } from './appEnv.ts';

/** Reloading and the inspector, for dev runs only. */
const DEV_VIEW_ITEMS: MenuItemConstructorOptions[] = [
  { role: 'reload' },
  { role: 'toggleDevTools' },
  { type: 'separator' },
];

/** Replaces Electron's default menus (whose Help opens Electron's site) with the system's standard roles. */
export function installAppMenu(): void {
  if (!IS_MAC) return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          ...(app.isPackaged ? [] : DEV_VIEW_ITEMS),
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

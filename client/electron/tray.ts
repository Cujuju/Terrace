// The notification-area icon (macOS: the menu-bar icon): opens the window, returns to the local world, restarts and quits.
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { APP_NAME } from './appEnv.ts';

/** Small-icon size in DIPs: the tray icon at 100%. */
const SMALL_ICON_DIP = 16;
/** Display scales drawn ahead, so the system picks a sharp copy instead of stretching one. */
const DRAWN_SCALES = [1, 1.25, 1.5, 2] as const;

function smallIcon(icon: NativeImage): NativeImage {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of DRAWN_SCALES) {
    const px = Math.round(SMALL_ICON_DIP * scaleFactor);
    const scaled = icon.resize({ width: px, height: px, quality: 'best' });
    image.addRepresentation({ scaleFactor, width: px, height: px, buffer: scaled.toBitmap() });
  }
  return image;
}

export interface TrayActions {
  open(): void;
  goHome(): void;
  restart(): void;
  quit(): void;
}

export class AppTray {
  private readonly tray: Tray;
  /** The downloaded update's version, while one waits to be installed. */
  private update: string | null = null;
  private remote = false;

  constructor(iconPath: string, private readonly actions: TrayActions) {
    this.tray = new Tray(smallIcon(nativeImage.createFromPath(iconPath)));
    this.tray.setToolTip(APP_NAME);
    this.tray.on('click', () => actions.open());
    this.render();
  }

  setUpdate(version: string | null): void {
    if (version === this.update) return;
    this.update = version;
    this.render();
  }

  /** Whether the window shows another server, so the menu offers the way back. */
  setRemote(remote: boolean): void {
    if (remote === this.remote) return;
    this.remote = remote;
    this.render();
  }

  private render(): void {
    const home: MenuItemConstructorOptions[] = this.remote
      ? [{ label: 'Return to my world', click: () => this.actions.goHome() }]
      : [];
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${APP_NAME}`, click: () => this.actions.open() },
        ...home,
        { type: 'separator' },
        {
          label: this.update ? `Restart to update to ${this.update}` : `Restart ${APP_NAME}`,
          click: () => this.actions.restart(),
        },
        { label: `Quit ${APP_NAME}`, click: () => this.actions.quit() },
      ]),
    );
  }
}

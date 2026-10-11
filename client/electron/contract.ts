// What the desktop main process and the game page agree on. Pure: both sides import it.

/** Channel names; electron/preload.cjs repeats these two strings. */
export const DESKTOP_INVOKE_CHANNEL = 'desktop:invoke';
export const DESKTOP_STATE_CHANNEL = 'desktop:state';

export const DEFAULT_SERVER_PORT = 2567;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;
/** The server refuses a shorter operator key (server/src/config.ts). */
export const MIN_OPERATOR_KEY_LENGTH = 8;

export interface DesktopSettings {
  /** Folder holding worlds/, logs/ and the server's own settings; null until the owner picks one. */
  dataDir: string | null;
  port: number;
  /** Empty means the gate is open to anyone who can reach the server. */
  rollbackKey: string;
  worldAdminKey: string;
  minimizeToTray: boolean;
  /** The window's own close command hides it to the tray; the tray's Quit exits. */
  closeToTray: boolean;
  /** Started by the system at sign-in: stays in the tray until opened. */
  startHidden: boolean;
  /** System-wide shortcut that shows or hides the window (an Electron accelerator). */
  hotkey: string | null;
  /** The last remote server joined, offered again. */
  lastServer: string | null;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  dataDir: null,
  port: DEFAULT_SERVER_PORT,
  rollbackKey: '',
  worldAdminKey: '',
  minimizeToTray: false,
  closeToTray: true,
  startHidden: true,
  hotkey: null,
  lastServer: null,
};

/** Settings whose change restarts the embedded server. */
export const SERVER_SETTING_KEYS = ['dataDir', 'port', 'rollbackKey', 'worldAdminKey'] as const;

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super'] as const;
/** Shift alone would swallow typed characters system-wide. */
const TAKING_MODIFIERS = new Set<string>(['Ctrl', 'Alt', 'Super']);
const HOTKEY_KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space)$/;

/** Whether `v` is modifiers in MODIFIERS order (one of Ctrl, Alt or Super), then one key. */
export function isHotkey(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const parts = v.split('+');
  const key = parts.pop() ?? '';
  const order = parts.map((m) => MODIFIERS.indexOf(m as (typeof MODIFIERS)[number]));
  return (
    HOTKEY_KEY.test(key) &&
    order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] ?? -1))) &&
    parts.some((m) => TAKING_MODIFIERS.has(m))
  );
}

/** A pressed key as a keydown event reports it. */
export interface KeyChord {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The hotkey a key press makes, or null when it cannot be one. */
export function hotkeyOf(e: KeyChord): string | null {
  const key =
    /^Key([A-Z])$/.exec(e.code)?.[1] ??
    /^Digit(\d)$/.exec(e.code)?.[1] ??
    (HOTKEY_KEY.test(e.code) ? e.code : null);
  if (key === null) return null;
  const held = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Super: e.metaKey };
  const hotkey = [...MODIFIERS.filter((m) => held[m]), key].join('+');
  return isHotkey(hotkey) ? hotkey : null;
}

const isOperatorKey = (v: unknown): v is string =>
  typeof v === 'string' && (v === '' || v.length >= MIN_OPERATOR_KEY_LENGTH);

const isPort = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= MIN_PORT && v <= MAX_PORT;

const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** `v` as settings: any field of the wrong shape takes its default. */
export function normalizeDesktopSettings(v: unknown): DesktopSettings {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const d = DEFAULT_DESKTOP_SETTINGS;
  const text = (key: 'dataDir' | 'lastServer'): string | null => {
    const raw = o[key];
    return typeof raw === 'string' && raw !== '' ? raw : d[key];
  };
  return {
    dataDir: text('dataDir'),
    port: isPort(o['port']) ? o['port'] : d.port,
    rollbackKey: isOperatorKey(o['rollbackKey']) ? o['rollbackKey'] : d.rollbackKey,
    worldAdminKey: isOperatorKey(o['worldAdminKey']) ? o['worldAdminKey'] : d.worldAdminKey,
    minimizeToTray: flag(o['minimizeToTray'], d.minimizeToTray),
    closeToTray: flag(o['closeToTray'], d.closeToTray),
    startHidden: flag(o['startHidden'], d.startHidden),
    hotkey: isHotkey(o['hotkey']) ? o['hotkey'] : d.hotkey,
    lastServer: text('lastServer'),
  };
}

export type DesktopPlatform = 'windows' | 'mac' | 'linux';

export const desktopPlatform = (nodePlatform: string): DesktopPlatform =>
  nodePlatform === 'win32' ? 'windows' : nodePlatform === 'darwin' ? 'mac' : 'linux';

/** Where updating stands. Dev runs cannot update. */
export type UpdateStatus =
  | { phase: 'unsupported' }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current' }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; message: string };

/** What the window shows: this machine's world, or another server's page. */
export type DesktopView = { kind: 'home' } | { kind: 'remote'; origin: string };

/** What a page served by another server learns: only how to leave. */
export interface GuestDesktopState {
  trusted: false;
  view: DesktopView;
}

export interface HostDesktopState {
  trusted: true;
  view: DesktopView;
  platform: DesktopPlatform;
  settings: DesktopSettings;
  /** The data folder in use; an environment override wins over the setting. */
  dataDir: string | null;
  port: number;
  /** The environment fixes the data folder or port, so the setting cannot change it. */
  dataDirLocked: boolean;
  portLocked: boolean;
  /** False when another process already held the port and the window joined it instead. */
  hosting: boolean;
  /** Whether the system starts the app at sign-in; null in dev. */
  openAtLogin: boolean | null;
  /** The hotkey is set but another app holds it. */
  hotkeyTaken: boolean;
  /** Close and minimize can only hide the window when a tray icon exists to bring it back. */
  trayAvailable: boolean;
  update: UpdateStatus;
  version: string;
}

export type DesktopState = GuestDesktopState | HostDesktopState;

/** Calls the game page may make; each returns a promise through the bridge. */
export interface DesktopMethods {
  state(): DesktopState;
  set(patch: Partial<DesktopSettings>): void;
  setOpenAtLogin(on: boolean): void;
  /** Opens the folder picker; the embedded server restarts in the folder picked. */
  chooseDataDir(): void;
  /** Shows the server at `address`; resolves to why it could not, or null. */
  join(address: string): string | null;
  goHome(): void;
  checkForUpdate(): void;
  installUpdate(): void;
}

export type DesktopMethod = keyof DesktopMethods;

/** Methods a page from another server may call. */
export const GUEST_METHODS: readonly DesktopMethod[] = ['state', 'goHome'];

/** `window.terraceDesktop`, set by the preload script; absent in a browser. */
export interface DesktopBridge {
  invoke<M extends DesktopMethod>(
    method: M,
    ...args: Parameters<DesktopMethods[M]>
  ): Promise<ReturnType<DesktopMethods[M]>>;
  /** Runs `listener` on each state change; returns its unsubscribe. */
  onState(listener: (state: DesktopState) => void): () => void;
}

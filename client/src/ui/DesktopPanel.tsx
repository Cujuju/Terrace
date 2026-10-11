import { Show, createSignal, type JSX } from 'solid-js';
import {
  hotkeyOf,
  type DesktopPlatform,
  type DesktopSettings,
  type HostDesktopState,
  type UpdateStatus,
} from '../../electron/contract.ts';
import { desktopBridge, desktopErrorMessage } from '../state/desktopState.ts';

const trayWord = (platform: DesktopPlatform): string => (platform === 'mac' ? 'menu bar' : 'tray');

function updateText(update: UpdateStatus): string {
  switch (update.phase) {
    case 'unsupported':
      return 'Updates need an installed build.';
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking…';
    case 'current':
      return 'Up to date.';
    case 'downloading':
      return `Downloading ${update.version}: ${String(update.percent)}%`;
    case 'ready':
      return `${update.version} is ready to install.`;
    case 'failed':
      return `Update failed: ${update.message}`;
  }
}

function CheckRow(props: {
  label: string;
  title: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    <div class="hud-row controls-row">
      <span class="controls-label">{props.label}</span>
      <input
        type="checkbox"
        class="controls-check"
        aria-label={props.label}
        title={props.title}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </div>
  );
}

function TextRow(props: {
  label: string;
  title: string;
  type: 'password' | 'number';
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}): JSX.Element {
  return (
    <div class="hud-row controls-row">
      <span class="controls-label">{props.label}</span>
      <input
        class="restore-key-input desktop-input"
        type={props.type}
        autocomplete="off"
        aria-label={props.label}
        title={props.title}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onCommit(e.currentTarget.value)}
      />
    </div>
  );
}

/** The settings a page served by this machine's own server may change. */
export function DesktopPanel(props: { host: HostDesktopState }): JSX.Element {
  const [error, setError] = createSignal<string | null>(null);
  const [address, setAddress] = createSignal(props.host.settings.lastServer ?? '');
  const [capturing, setCapturing] = createSignal(false);

  const call = (run: Promise<unknown> | undefined): void => {
    setError(null);
    void run?.catch((err: unknown) => setError(desktopErrorMessage(err)));
  };
  const set = (patch: Partial<DesktopSettings>): void => call(desktopBridge?.invoke('set', patch));
  const join = (): void => {
    setError(null);
    void desktopBridge?.invoke('join', address()).then(setError, (err: unknown) => setError(desktopErrorMessage(err)));
  };

  return (
    <div class="desktop-panel">
      <p class="desktop-heading">World server</p>
      <Show when={!props.host.hosting}>
        <p class="hud-hint">
          Port {props.host.port} was already in use, so this window shows the server running there.
        </p>
      </Show>
      <div class="hud-row controls-row">
        <span class="controls-label">Data folder</span>
        <button
          type="button"
          class="controls-reset"
          title="Data folder: where worlds, logs and server settings are kept"
          disabled={props.host.dataDirLocked}
          onClick={() => call(desktopBridge?.invoke('chooseDataDir'))}
        >
          Change…
        </button>
      </div>
      <p class="hud-hint desktop-path">{props.host.dataDir ?? 'Not chosen'}</p>
      <TextRow
        label="Port"
        title="Port: where this machine's server listens"
        type="number"
        value={String(props.host.port)}
        disabled={props.host.portLocked}
        onCommit={(value) => set({ port: Number(value) })}
      />
      <TextRow
        label="Rollback key"
        title="Rollback key: gates restore points. Empty leaves them open to anyone who can reach the server."
        type="password"
        placeholder="none"
        value={props.host.settings.rollbackKey}
        onCommit={(value) => set({ rollbackKey: value })}
      />
      <TextRow
        label="World admin key"
        title="World admin key: gates world management. Empty leaves it open to anyone who can reach the server."
        type="password"
        placeholder="none"
        value={props.host.settings.worldAdminKey}
        onCommit={(value) => set({ worldAdminKey: value })}
      />
      <p class="hud-hint">
        A change here restarts the world server. Worlds in the old folder stay there.
      </p>

      <p class="desktop-heading">Join a server</p>
      <form
        class="restore-key-row"
        onSubmit={(event) => {
          event.preventDefault();
          join();
        }}
      >
        <input
          class="restore-key-input"
          type="text"
          autocomplete="off"
          aria-label="Server address"
          placeholder="host or host:port"
          value={address()}
          onInput={(event) => setAddress(event.currentTarget.value)}
        />
        <button type="submit" class="chart-button">
          Join
        </button>
      </form>

      <p class="desktop-heading">Window</p>
      <CheckRow
        label={`Close to the ${trayWord(props.host.platform)}`}
        title="The window's close button hides it; the server keeps running until you quit."
        checked={props.host.settings.closeToTray}
        disabled={!props.host.trayAvailable}
        onChange={(on) => set({ closeToTray: on })}
      />
      <CheckRow
        label={`Minimize to the ${trayWord(props.host.platform)}`}
        title="Minimizing hides the window instead of leaving it on the taskbar."
        checked={props.host.settings.minimizeToTray}
        disabled={!props.host.trayAvailable}
        onChange={(on) => set({ minimizeToTray: on })}
      />
      <CheckRow
        label="Start at sign-in"
        title="Start Terrace, and its server, when you sign in to this computer."
        checked={props.host.openAtLogin === true}
        disabled={props.host.openAtLogin === null}
        onChange={(on) => call(desktopBridge?.invoke('setOpenAtLogin', on))}
      />
      <CheckRow
        label="Stay hidden at sign-in"
        title="A start at sign-in keeps the window hidden until you open it."
        checked={props.host.settings.startHidden}
        disabled={!props.host.trayAvailable}
        onChange={(on) => set({ startHidden: on })}
      />
      <div class="hud-row controls-row">
        <span class="controls-label">Show/hide shortcut</span>
        <button
          type="button"
          class="controls-reset"
          title="Press this, then the shortcut: Ctrl, Alt or the system key with a letter, digit or F-key"
          onClick={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          onKeyDown={(event) => {
            if (!capturing()) return;
            event.preventDefault();
            event.stopPropagation();
            const hotkey = hotkeyOf(event);
            if (hotkey === null) return;
            setCapturing(false);
            set({ hotkey });
          }}
        >
          {capturing() ? 'Press keys…' : (props.host.settings.hotkey ?? 'None')}
        </button>
        <Show when={props.host.settings.hotkey !== null}>
          <button type="button" class="controls-reset" title="Remove the shortcut" onClick={() => set({ hotkey: null })}>
            Clear
          </button>
        </Show>
      </div>
      <Show when={props.host.hotkeyTaken}>
        <p class="hud-hint">Another app holds that shortcut.</p>
      </Show>

      <p class="desktop-heading">Updates · {props.host.version}</p>
      <div class="hud-row controls-row">
        <span class="controls-label desktop-status">{updateText(props.host.update)}</span>
        <Show
          when={props.host.update.phase === 'ready'}
          fallback={
            <button
              type="button"
              class="controls-reset"
              disabled={props.host.update.phase === 'unsupported'}
              onClick={() => call(desktopBridge?.invoke('checkForUpdate'))}
            >
              Check
            </button>
          }
        >
          <button type="button" class="controls-reset" onClick={() => call(desktopBridge?.invoke('installUpdate'))}>
            Restart to update
          </button>
        </Show>
      </div>

      <Show when={error()}>{(message) => <p class="hud-hint desktop-error">{message()}</p>}</Show>
    </div>
  );
}

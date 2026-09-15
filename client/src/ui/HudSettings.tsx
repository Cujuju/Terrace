import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { pluginHudPanels } from '../plugins/hudPanels.ts';
import { restorePanelOpen, setRestorePanelOpen } from '../state/rollbackState.ts';
import {
  adminPanelOpen,
  armedAction,
  setAdminPanelOpen,
  setArmedAction,
  worldPanelOpen,
  setWorldPanelOpen,
  worldAdminKey,
  worldViewScope,
} from '../state/worldsState.ts';
import {
  connectionStatus,
  setShowControls,
  showControls,
  perfOpen,
  setPerfOpen,
} from '../state/hudState.ts';
import { chartOpen, setChartOpen } from './Cartographer.tsx';
import type { WorldActions } from './WorldManager.tsx';
import { AudioSettingsPanel } from './AudioSettingsPanel.tsx';
import { ControlsPanel } from './ControlsPanel.tsx';
import type { ConnectionStatus } from '../net/connection.ts';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  offline: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
};

const STATUS_TITLE: Record<ConnectionStatus, string> = {
  offline: 'Offline: nothing is saved or shared',
  connecting: 'Connecting: waiting for the server',
  connected: 'Connected: edits saved and shared',
  reconnecting: 'Reconnecting: edits now may be lost',
};

export function HudSettings(props: {
  worlds: WorldActions;
  restartStack: () => void;
}): JSX.Element {
  let settingsRoot: HTMLDivElement | undefined;

  const [showConnection, setShowConnection] = createSignal(false);

  const openConnection = (open: boolean): void => {
    setShowConnection(open);
    if (open) setShowControls(false);
  };
  const openControls = (open: boolean): void => {
    setShowControls(open);
    if (open) setShowConnection(false);
  };

  const onWindowKeyDown = (event: KeyboardEvent): void => {
    if (chartOpen()) return;
    if (event.key !== 'Escape') return;
    if (armedAction() !== null) {
      setArmedAction(null);
      return;
    }
    if (showControls()) setShowControls(false);
    if (showConnection()) setShowConnection(false);
  };
  const onWindowPointerDown = (event: PointerEvent): void => {
    if (!showControls() && !showConnection()) return;
    if (settingsRoot !== undefined && event.target instanceof Node && settingsRoot.contains(event.target)) {
      return;
    }
    setShowControls(false);
    setShowConnection(false);
  };
  window.addEventListener('keydown', onWindowKeyDown);
  window.addEventListener('pointerdown', onWindowPointerDown);
  onCleanup(() => {
    window.removeEventListener('keydown', onWindowKeyDown);
    window.removeEventListener('pointerdown', onWindowPointerDown);
  });

  return (
    <div class="hud-settings hud-anchor-bottom-right" ref={settingsRoot}>
      <Show when={showControls()}>
        <div
          class="hud-panel hud-settings-popup"
          role="dialog"
          aria-label="Control settings"
        >
          <ControlsPanel />
          {
}
          <AudioSettingsPanel />
          {
}
          <For each={pluginHudPanels().filter((p) => p.placement === 'settings')}>
            {(panel) => <Dynamic component={panel.component} />}
          </For>
        </div>
      </Show>

      {
}
      <Show when={showConnection()}>
        <div
          class="hud-panel hud-settings-popup hud-connection-popup"
          role="dialog"
          aria-label="Connection"
        >
          <div class="hud-row">
            <span
              class="status-dot"
              classList={{ [`status-${connectionStatus()}`]: true }}
            />
            <span class="status-label">{STATUS_LABEL[connectionStatus()]}</span>
          </div>
          <p class="hud-hint">{STATUS_TITLE[connectionStatus()]}</p>
          {
}
          <For each={pluginHudPanels().filter((p) => p.placement === 'connection')}>
            {(panel) => <Dynamic component={panel.component} />}
          </For>
        </div>
      </Show>

      {
}
      <button
        type="button"
        class="hud-panel hud-settings-button hud-connection-button"
        classList={{ open: showConnection() }}
        aria-expanded={showConnection()}
        aria-haspopup="dialog"
        aria-label={`Connection: ${STATUS_LABEL[connectionStatus()]}`}
        title={STATUS_TITLE[connectionStatus()]}
        onClick={() => openConnection(!showConnection())}
      >
        <span
          class="status-dot"
          classList={{ [`status-${connectionStatus()}`]: true }}
        />
      </button>
      {
}
      <button
        type="button"
        class="hud-panel hud-settings-button"
        classList={{ open: chartOpen() }}
        aria-expanded={chartOpen()}
        aria-haspopup="dialog"
        aria-label="Chart of the known world"
        title="Chart: your known world, inked"
        onClick={() => setChartOpen(!chartOpen())}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z" />
          <path d="M9 4v14M15 6v14" />
        </svg>
      </button>
      {

}
      <button
        type="button"
        class="hud-panel hud-settings-button"
        classList={{ open: worldViewScope() === 'all' }}
        aria-pressed={worldViewScope() === 'all'}
        aria-label={
          worldViewScope() === 'all' ? 'Show only my territory' : 'Show the whole world'
        }
        title={
          worldViewScope() === 'all'
            ? 'Showing the whole world — press to see only your own territory'
            : 'Show the whole world (operator view)'
        }
        onClick={() =>
          props.worlds.send({
            type: 'worldView',
            key: worldAdminKey(),
            scope: worldViewScope() === 'all' ? 'mine' : 'all',
          })
        }
      >
        {
}
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
        </svg>
      </button>
      {
}
      <button
        type="button"
        class="hud-panel hud-settings-button"
        classList={{ open: worldPanelOpen() }}
        aria-expanded={worldPanelOpen()}
        aria-haspopup="dialog"
        aria-label="Worlds"
        title="Worlds: create, load and archive"
        onClick={() => setWorldPanelOpen(!worldPanelOpen())}
      >
        {}
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
          <path d="m3 12 9 4.5L21 12" />
          <path d="m3 16.5 9 4.5 9-4.5" />
        </svg>
      </button>
      <button
        type="button"
        class="hud-panel hud-settings-button"
        classList={{ open: restorePanelOpen() }}
        aria-expanded={restorePanelOpen()}
        aria-haspopup="dialog"
        aria-label="Restore points"
        title="Restore: put the world back"
        onClick={() => setRestorePanelOpen(!restorePanelOpen())}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
      <button
        type="button"
        class="hud-panel hud-settings-button"
        classList={{ open: showControls() }}
        aria-expanded={showControls()}
        aria-haspopup="dialog"
        aria-label="Control settings"
        title="Settings: mouse, touch and scroll"
        onClick={() => openControls(!showControls())}
      >
        ⚙
      </button>
      {
}
      <button
        type="button"
        class="hud-panel hud-settings-button"
        aria-label="Restart client and server"
        title="Restart: make changed code live"
        onClick={() => props.restartStack()}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18.4 6.6A9 9 0 1 1 5.6 6.6" />
          <path d="M12 3v8" />
        </svg>
      </button>
      {

}
      <button
        type="button"
        class="hud-panel hud-settings-button"
        classList={{ open: perfOpen() }}
        aria-pressed={perfOpen()}
        aria-label="Performance meter"
        title="Performance: frame time, resource counts (`)"
        onClick={() => setPerfOpen(!perfOpen())}
      >
        {
}
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12h3.5l2.5-6 4 12 2.5-6H21" />
        </svg>
      </button>
      {
}
      <button
        type="button"
        class="hud-panel hud-settings-button"
        classList={{ open: adminPanelOpen() }}
        aria-expanded={adminPanelOpen()}
        aria-haspopup="dialog"
        aria-label="Admin: world events"
        title="Admin: fire disasters on demand"
        onClick={() => setAdminPanelOpen(!adminPanelOpen())}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 3h6" />
          <path d="M10 3v6.5L4.6 18.2A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.8L14 9.5V3" />
          <path d="M7.5 15h9" />
        </svg>
      </button>
    </div>
  );
}

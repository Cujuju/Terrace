import { Show, createSignal, onCleanup, type JSX } from 'solid-js';
import { desktopBridge, desktopState } from '../state/desktopState.ts';
import { DesktopPanel } from './DesktopPanel.tsx';

/** The desktop app's settings button and popup; renders nothing in a browser. */
export function DesktopButton(props: { onOpen: () => void }): JSX.Element {
  let root: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);

  const onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setOpen(false);
  };
  const onWindowPointerDown = (event: PointerEvent): void => {
    if (!open()) return;
    if (root !== undefined && event.target instanceof Node && root.contains(event.target)) return;
    setOpen(false);
  };
  window.addEventListener('keydown', onWindowKeyDown);
  window.addEventListener('pointerdown', onWindowPointerDown);
  onCleanup(() => {
    window.removeEventListener('keydown', onWindowKeyDown);
    window.removeEventListener('pointerdown', onWindowPointerDown);
  });

  return (
    <Show when={desktopState()}>
      {(state) => (
        <div class="desktop-settings" ref={root}>
          <Show when={open()}>
            <div class="hud-panel hud-settings-popup desktop-popup" role="dialog" aria-label="Desktop app">
              <Show
                when={((s) => (s.trusted ? s : null))(state())}
                fallback={
                  <>
                    <p class="hud-hint">This page comes from another server, so it cannot change this app.</p>
                    <button type="button" class="chart-button" onClick={() => void desktopBridge?.invoke('goHome')}>
                      Return to my world
                    </button>
                  </>
                }
              >
                {(host) => (
                  <>
                    <Show when={host().view.kind === 'remote'}>
                      <button type="button" class="chart-button" onClick={() => void desktopBridge?.invoke('goHome')}>
                        Return to my world
                      </button>
                    </Show>
                    <DesktopPanel host={host()} />
                  </>
                )}
              </Show>
            </div>
          </Show>
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: open() }}
            aria-expanded={open()}
            aria-haspopup="dialog"
            aria-label="Desktop app"
            title="Desktop: data folder, joining a server, tray and updates"
            onClick={() => {
              if (!open()) props.onOpen();
              setOpen(!open());
            }}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="12" rx="1.5" />
              <path d="M8 20h8M12 16v4" />
            </svg>
          </button>
        </div>
      )}
    </Show>
  );
}

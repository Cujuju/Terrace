import { Show, type JSX } from 'solid-js';
import { pendingRestartSeconds, pendingSwitch, worldLoaded } from '../state/worldsState.ts';

export function WorldSwitchBanner(): JSX.Element {
  return (
    <>
      <Show when={pendingSwitch()}>
        {(pending) => (
          <div class="world-banner" role="status" aria-live="polite">
            Moving to <strong>{pending().toName}</strong> in {pending().secondsRemaining}s
          </div>
        )}
      </Show>

      {
}
      <Show when={pendingRestartSeconds() !== null}>
        <div class="world-banner world-banner-restart" role="status" aria-live="polite">
          {pendingRestartSeconds() === 0
            ? 'The server is restarting — you will be reconnected.'
            : `The server restarts in ${pendingRestartSeconds()}s — you will be reconnected.`}
        </div>
      </Show>

      {
}
      <Show when={!worldLoaded() && pendingSwitch() === null && pendingRestartSeconds() === null}>
        <div class="world-banner" role="status" aria-live="polite">
          No world is loaded on this server.
        </div>
      </Show>
    </>
  );
}

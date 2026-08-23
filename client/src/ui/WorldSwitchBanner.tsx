// The world-switch banner — what a player who did NOT press the button sees.
//
// Two states, both server-driven, both shown to every client regardless of
// whether it holds an operator key:
//
//   COUNTING DOWN  an operator is moving everyone to another world. This is
//                  the whole reason the countdown exists: the swap is
//                  instant for a lone operator, and announced when anybody
//                  else is present, so nobody has the ground pulled out from
//                  under them mid-sculpt.
//   NO WORLD       the server has no world loaded. A player is told this
//                  plainly instead of staring at an empty sea wondering
//                  whether they have lost their map — which is exactly the
//                  confusion this whole arc exists to end.
//
// NOT AN ERROR UI. Neither state offers a retry button: there is nothing for
// the player to retry, the server will send a snapshot when there is one to
// send, and the project's rule is that a retry button beside "something
// broke" is a capitulation. This states a fact and gets out of the way.

import { Show, type JSX } from 'solid-js';
import { pendingSwitch, worldLoaded } from '../state/worldsState.ts';

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

      {/* Suppressed while a switch is counting down: during those seconds the
          two banners would say "no world" and "moving to a world" at once, and
          the countdown is the one that tells the player what is happening. */}
      <Show when={!worldLoaded() && pendingSwitch() === null}>
        <div class="world-banner" role="status" aria-live="polite">
          No world is loaded on this server.
        </div>
      </Show>
    </>
  );
}

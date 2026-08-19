// The invite HUD panel: the address friends should open, with a copy button.
//
// SOLID REACTIVITY: accessors are called at the point of use, per the client's
// standing rule — no reactive read is ever frozen in a component-body const.

import { Show, type JSX } from 'solid-js';
import { copy } from './copy.ts';
import { deriveLocalShareUrl } from './derive.ts';
import { justCopied, serverShareUrl } from './state.ts';

/**
 * Server-configured URL first; the visitor's own origin as the fallback.
 * location is read inside the accessor, but it is effectively static — a page
 * cannot change origin without a navigation.
 */
function shareUrl(): string | null {
  return (
    serverShareUrl() ??
    deriveLocalShareUrl(window.location.hostname, window.location.origin)
  );
}

export function InvitePanel(): JSX.Element {
  return (
    <Show when={shareUrl() !== null}>
      {/* One title for the label + URL; the button carries its own below. */}
      <div
        class="hud-row"
        title="Anyone who opens this address joins the world you are sculpting."
      >
        <span class="hud-label">Invite</span>
        <span class="invite-url">{shareUrl()}</span>
        <button
          type="button"
          class="invite-copy"
          aria-label="Copy invite address"
          title="Copies the address above, ready to paste to a friend."
          onClick={() => {
            const url = shareUrl();
            if (url !== null) copy(url);
          }}
        >
          {justCopied() ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Show>
  );
}

// The invite HUD panel: the address friends should open, with a copy button.
//
// SOLID REACTIVITY: accessors are called at the point of use, per the client's
// standing rule — no reactive read is ever frozen in a component-body const.

import { Show, type JSX } from 'solid-js';
import { deriveLocalShareUrl } from './derive.ts';
import { justCopied, serverShareUrl, setJustCopied } from './state.ts';

/** How long the Copy button acknowledges a click before reverting. */
const COPIED_FLASH_MS = 1500;

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

function copy(url: string): void {
  // Clipboard access needs a secure context or localhost; over plain LAN http
  // the API is absent. Selecting-and-copying by hand still works — the URL is
  // rendered as text — so failure here is silently tolerated.
  void navigator.clipboard?.writeText(url).then(() => {
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), COPIED_FLASH_MS);
  });
}

export function InvitePanel(): JSX.Element {
  return (
    <Show when={shareUrl() !== null}>
      <div class="hud-row">
        <span class="hud-label">Invite</span>
        <span class="invite-url">{shareUrl()}</span>
        <button
          type="button"
          class="invite-copy"
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

import { Show, type JSX } from 'solid-js';
import { copy } from './copy.ts';
import { deriveLocalShareUrl } from './derive.ts';
import { justCopied, serverShareUrl } from './state.ts';

function shareUrl(): string | null {
  return (
    serverShareUrl() ??
    deriveLocalShareUrl(window.location.hostname, window.location.origin)
  );
}

export function InvitePanel(): JSX.Element {
  return (
    <Show when={shareUrl() !== null}>
      {}
      <div
        class="hud-row"
        title="Invite: this address joins your world"
      >
        <span class="hud-label">Invite</span>
        <span class="invite-url">{shareUrl()}</span>
        <button
          type="button"
          class="invite-copy"
          aria-label="Copy invite address"
          title="Copy: address ready to paste"
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

import { Match, Show, Switch, createSignal, type JSX } from 'solid-js';
import type { HostDesktopState } from '../../electron/contract.ts';
import { desktopBridge, desktopErrorMessage } from '../state/desktopState.ts';

/** How long "Copied" shows after a copy. */
const COPIED_NOTICE_MS = 1_500;

/** Sharing this machine's world over tailcat: the switch, the address to hand out, and replacing it. */
export function TailcatSharePanel(props: { host: HostDesktopState }): JSX.Element {
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const ready = (): { address: string } | null => {
    const share = props.host.tailcat;
    return share.phase === 'ready' ? share : null;
  };
  const failed = (): { message: string } | null => {
    const share = props.host.tailcat;
    return share.phase === 'failed' ? share : null;
  };

  const call = (run: Promise<unknown> | undefined): void => {
    setError(null);
    void run?.catch((err: unknown) => setError(desktopErrorMessage(err)));
  };
  const copy = (address: string): void => {
    call(navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    }));
  };

  return (
    <>
      <p class="desktop-heading">Share over tailcat</p>
      <div class="hud-row controls-row">
        <span class="controls-label">Share this world</span>
        <input
          type="checkbox"
          class="controls-check"
          aria-label="Share this world over tailcat"
          title="Players join with an address instead of an open port. Connections go through Tailscale's relays until a direct path is found."
          checked={props.host.settings.shareOverTailcat}
          disabled={!props.host.hosting}
          onChange={(e) => call(desktopBridge?.invoke('set', { shareOverTailcat: e.currentTarget.checked }))}
        />
      </div>
      <Switch>
        <Match when={props.host.tailcat.phase === 'starting'}>
          <p class="hud-hint">Getting an address…</p>
        </Match>
        <Match when={ready()}>
          {(share) => (
            <>
              <input
                class="restore-key-input desktop-input"
                type="text"
                readOnly
                aria-label="Tailcat address"
                value={share().address}
                onFocus={(e) => e.currentTarget.select()}
              />
              <div class="hud-row controls-row">
                <button type="button" class="controls-reset" onClick={() => copy(share().address)}>
                  {copied() ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  class="controls-reset"
                  title="Anyone holding the current address can no longer join."
                  onClick={() => call(desktopBridge?.invoke('newTailcatAddress'))}
                >
                  New address
                </button>
              </div>
              <p class="hud-hint">Anyone with this address can join and sculpt. Share it privately.</p>
            </>
          )}
        </Match>
        <Match when={failed()}>
          {(share) => <p class="hud-hint desktop-error">{share().message}</p>}
        </Match>
      </Switch>
      <Show when={error()}>{(message) => <p class="hud-hint desktop-error">{message()}</p>}</Show>
    </>
  );
}

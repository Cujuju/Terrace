import { For, Show, onMount, type JSX } from 'solid-js';
import { DEFAULT_SERVER_PORT, type FailedJoin, type JoinFailure } from '../../electron/contract.ts';

type Tone = 'warn' | 'stop' | 'neutral';
type Emblem = 'link' | 'stranger' | 'empty' | 'address';

interface Story {
  tone: Tone;
  emblem: Emblem;
  title: string;
  lead: string;
  checks: string[];
  detail: string | null;
}

const PORT_CHECK = `Is the port right? Terrace uses ${DEFAULT_SERVER_PORT} unless its owner changed it.`;

function story(failure: JoinFailure): Story {
  switch (failure.kind) {
    case 'badAddress':
      return {
        tone: 'neutral',
        emblem: 'address',
        title: 'That isn’t a server address',
        lead: `Type a computer name or IP address, adding :port if it isn’t ${DEFAULT_SERVER_PORT}.`,
        checks: ['For example: play.example.com', 'Or on your network: 192.168.1.20:2600'],
        detail: null,
      };
    case 'unreachable':
      return {
        tone: 'warn',
        emblem: 'link',
        title: 'Can’t reach the server',
        lead: {
          refused: 'The computer is there, but nothing is accepting connections on that port.',
          timeout: 'Nothing answered in time.',
          notFound: 'No computer by that name could be found.',
          other: 'The connection failed before the server could answer.',
        }[failure.cause],
        checks: {
          refused: ['Is the Terrace server running?', PORT_CHECK],
          timeout: ['Check the address for typos.', 'A firewall or router may be blocking the port.'],
          notFound: ['Check the spelling of the address.', 'Is this computer online?'],
          other: ['Check the address and try again.', PORT_CHECK],
        }[failure.cause],
        detail: failure.detail,
      };
    case 'notTerrace':
      return {
        tone: 'stop',
        emblem: 'stranger',
        title: 'That isn’t a Terrace server',
        lead: 'Something answered there, but not a Terrace world, or one running a version too old to identify itself.',
        checks: [PORT_CHECK, 'If it’s a friend’s server, ask them to update Terrace.'],
        detail: null,
      };
    case 'noClient':
      return {
        tone: 'warn',
        emblem: 'empty',
        title: 'This server has no world to show',
        lead: 'It’s a Terrace server, but it has no game files to send this window.',
        checks: ['Ask its owner to run the Terrace app, or to build the client for their server.'],
        detail: `The page answered HTTP ${failure.status}.`,
      };
  }
}

const EMBLEM_PATHS: Record<Emblem, () => JSX.Element> = {
  link: () => (
    <>
      <path d="M6 19a26 26 0 0 1 36 0M12 26a17 17 0 0 1 24 0M18 33a8 8 0 0 1 12 0" />
      <circle cx="24" cy="39" r="1.6" fill="currentColor" />
      <path d="M9 7l30 34" class="join-emblem-break" />
    </>
  ),
  stranger: () => (
    <>
      <path d="M3 43h32M6 43v-8h26v8M10 35v-8h18v8M14 27v-8h10v8" class="join-emblem-faint" />
      <circle cx="35" cy="13" r="9" />
      <path d="M31.8 10.6a3.3 3.3 0 1 1 4.6 3c-.9.4-1.4 1.1-1.4 2v.5M35 19.8v.1" />
    </>
  ),
  empty: () => (
    <>
      <path d="M4 43h40M8 43v-9h32v9M13 34v-9h22v9M18 25v-9h12v9" />
      <path d="M24 4v7M20.5 7.5h7" class="join-emblem-break" />
    </>
  ),
  address: () => (
    <>
      <rect x="6" y="16" width="36" height="16" rx="4" />
      <path d="M14 21v6" />
      <path d="M18 36c3-2 6 2 9 0s6 2 9 0" class="join-emblem-break" />
    </>
  ),
};

/** A failed join, drawn over the world: what happened, what to check, and the way back to the form. */
export function JoinResult(props: {
  failed: FailedJoin;
  retrying: boolean;
  onRetry: () => void;
  onEdit: () => void;
}): JSX.Element {
  let card: HTMLElement | undefined;
  let edit: HTMLButtonElement | undefined;
  let retry: HTMLButtonElement | undefined;
  const told = (): Story => story(props.failed.failure);
  const canRetry = (): boolean => props.failed.failure.kind !== 'badAddress';
  /** The host with its port as dialled; what was typed when it never became an address. */
  const where = (): string => {
    const failure = props.failed.failure;
    return failure.kind === 'badAddress' ? props.failed.address : failure.host;
  };
  onMount(() => (retry ?? edit)?.focus());

  /** Escape goes back to the form; Tab cycles inside the card, since it is modal. */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onEdit();
      return;
    }
    if (event.key !== 'Tab' || card === undefined) return;
    const stops = [...card.querySelectorAll<HTMLElement>('button:not(:disabled), summary')];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div class="restore-overlay join-overlay" onKeyDown={onKeyDown}>
      <section
        ref={card}
        class={`join-card join-tone-${told().tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="join-title"
        aria-describedby="join-lead"
      >
        <div class="join-emblem" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            {EMBLEM_PATHS[told().emblem]()}
          </svg>
        </div>
        <p class="join-eyebrow">Join a server</p>
        <h2 id="join-title" class="join-title">
          {told().title}
        </h2>
        <Show when={where()}>{(at) => <p class="join-address">{at()}</p>}</Show>
        <p id="join-lead" class="join-lead">
          {told().lead}
        </p>
        <ul class="join-checks">
          <For each={told().checks}>{(check) => <li>{check}</li>}</For>
        </ul>
        <Show when={told().detail}>
          {(detail) => (
            <details class="join-detail">
              <summary>Details</summary>
              <code>{detail()}</code>
            </details>
          )}
        </Show>
        <div class="join-actions">
          <button type="button" class="join-button" ref={edit} onClick={() => props.onEdit()}>
            Change address
          </button>
          <Show when={canRetry()}>
            <button
              type="button"
              class="join-button join-button-primary"
              ref={retry}
              disabled={props.retrying}
              onClick={() => props.onRetry()}
            >
              {props.retrying ? 'Checking…' : 'Try again'}
            </button>
          </Show>
        </div>
      </section>
    </div>
  );
}

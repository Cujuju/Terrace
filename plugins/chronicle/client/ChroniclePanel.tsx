import { weekdayOf } from '@terrace/shared';
import { For, Show, createEffect, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ChronicleEntry } from '../protocol.ts';
import { entries, genesisDay, readerOpen, setReaderOpen } from './state.ts';

function dayBlocks(all: readonly ChronicleEntry[]): Array<{ day: number; texts: string[] }> {
  const blocks: Array<{ day: number; texts: string[] }> = [];
  for (const entry of all) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.day === entry.day) last.texts.push(entry.text);
    else blocks.push({ day: entry.day, texts: [entry.text] });
  }
  return blocks;
}

function Reader(): JSX.Element {
  let scrollBox: HTMLDivElement | undefined;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    setReaderOpen(false);
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  onCleanup(() => window.removeEventListener('keydown', onKeyDown, { capture: true }));

  createEffect(() => {
    entries();
    if (scrollBox !== undefined) scrollBox.scrollTop = scrollBox.scrollHeight;
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="The Chronicle"
      style={{
        position: 'fixed',
        inset: '0',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        background: 'rgba(0, 0, 0, 0.45)',
        'z-index': '30',
      }}
      onClick={() => setReaderOpen(false)}
    >
      <div
        style={{
          background: 'var(--hud-bg)',
          border: '1px solid var(--hud-border)',
          'border-radius': '10px',
          color: 'var(--hud-text)',
          width: 'min(34rem, calc(100vw - 2rem))',
          'max-height': 'min(70vh, 40rem)',
          display: 'flex',
          'flex-direction': 'column',
          'backdrop-filter': 'blur(6px)',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'baseline',
            gap: '0.6rem',
            padding: '10px 14px',
            'border-bottom': '1px solid var(--hud-border)',
          }}
        >
          {
}
          <span
            style={{
              'font-weight': '650',
              'font-size': '0.95rem',
              'white-space': 'nowrap',
              color: 'var(--hud-text)',
            }}
          >
            The Chronicle
          </span>
          <span style={{ color: 'var(--hud-muted)', 'font-size': '0.8rem', flex: '1 1 auto' }}>
            as the world remembers it
          </span>
          <button
            type="button"
            class="brush-button"
            style={{ width: 'auto', padding: '0 10px' }}
            aria-label="Close the chronicle"
            onClick={() => setReaderOpen(false)}
          >
            Close
          </button>
        </div>

        <div ref={scrollBox} style={{ overflow: 'auto', padding: '8px 14px 14px' }}>
          <For each={dayBlocks(entries())}>
            {(block) => (
              <div style={{ 'margin-top': '8px' }}>
                <div
                  style={{
                    color: 'var(--hud-muted)',
                    'font-size': '0.72rem',
                    'letter-spacing': '0.08em',
                    'text-transform': 'uppercase',
                  }}
                >
                  {

}
                  {weekdayOf(block.day + genesisDay())} · Day {block.day + 1}
                </div>
                <For each={block.texts}>
                  {(text) => (
                    <p style={{ margin: '4px 0 0', 'font-size': '0.9rem', 'line-height': '1.45' }}>
                      {text}
                    </p>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export function BookIcon(): JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

export function ChronicleReaderHost(): JSX.Element {
  return (
    <Show when={readerOpen()}>
      <Portal mount={document.body}>
        <Reader />
      </Portal>
    </Show>
  );
}

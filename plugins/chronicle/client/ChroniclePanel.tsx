// The chronicle's HUD presence: one corner-panel row showing the latest line
// of history, and a "Read" button that raises the full scroll as an overlay.
//
// SOLID REACTIVITY, THE SAME DISCIPLINE AS EVERY PANEL HERE: the component
// body runs once; every reactive value is read through an accessor at its use
// site, never stashed in a plain const.
//
// Styling: a plugin cannot add to client/src/ui/hud.css, so the row reuses
// the core classes (hud-row, hud-label, hud-hint, brush-button) and the
// overlay carries its chrome inline, built from the HUD's own custom
// properties so it follows the core theme.

import { For, Show, createEffect, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ChronicleEntry } from '../protocol.ts';
import { entries, readerOpen, setReaderOpen } from './state.ts';

/** The scroll grouped for display: one block per day, oldest first. */
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

  // Escape closes THIS overlay only: capture phase + stopImmediatePropagation,
  // so no other layer's Escape listener also fires on the same press (the
  // Cartographer overlay owns Escape the same exclusive way).
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    setReaderOpen(false);
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  onCleanup(() => window.removeEventListener('keydown', onKeyDown, { capture: true }));

  // A saga reads oldest → newest; the reader opens at "now".
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
          <span class="hud-label" style={{ 'font-size': '0.95rem' }}>The Chronicle</span>
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
                  Day {block.day + 1}
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

export function ChroniclePanel(): JSX.Element {
  const latest = (): string => {
    const all = entries();
    return all.length === 0 ? 'Nothing has happened yet.' : all[all.length - 1].text;
  };

  return (
    <>
      <div class="hud-row" title="The world's history, written by the world itself.">
        <span class="hud-label">Chronicle</span>
        <button
          type="button"
          class="brush-button"
          style={{ width: 'auto', padding: '0 8px', 'margin-left': 'auto' }}
          aria-haspopup="dialog"
          aria-expanded={readerOpen()}
          aria-label="Read the chronicle"
          title="Open the full scroll of the world's history."
          onClick={() => setReaderOpen(!readerOpen())}
        >
          Read
        </button>
      </div>
      <p class="hud-hint" style={{ 'font-style': 'italic' }}>
        {latest()}
      </p>

      {/* Portal to <body>: the HUD panel's backdrop-filter makes it a
          containing block for fixed-position descendants, so a reader
          rendered in place would be trapped inside the corner panel. */}
      <Show when={readerOpen()}>
        <Portal mount={document.body}>
          <Reader />
        </Portal>
      </Show>
    </>
  );
}

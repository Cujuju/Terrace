// The chronicle's HUD presence: the top-centre world banner is its entry
// point (owner move, 2026-08-19 — the info-panel row and latest-line preview
// are gone). index.ts claims the core world-header action with the book icon
// and label below; this file keeps the reader overlay and its always-mounted
// host.
//
// SOLID REACTIVITY, THE SAME DISCIPLINE AS EVERY PANEL HERE: the component
// body runs once; every reactive value is read through an accessor at its use
// site, never stashed in a plain const.
//
// Styling: a plugin cannot add to client/src/ui/hud.css, so the overlay
// carries its chrome inline, built from the HUD's own custom properties so it
// follows the core theme; the icon inherits currentColor so core's banner
// styles own its colour.

import { weekdayOf } from '@terrace/shared';
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
          {/* A plain styled span, NOT .hud-label: that class carries the HUD
              row's fixed label width, which wraps or overlaps a modal title. */}
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
                  {/*
                    THE WEEKDAY IS THE HEADING'S POINT, not decoration (owner,
                    2026-08-23): settlers arrive on Mondays, so a reader who can
                    see which day is which can see the rhythm. `day` is the world
                    day counted from genesis and genesis is a Monday, so the name
                    needs no epoch — see shared/src/calendar.ts.

                    Displayed 1-based, as it always was: the world's first day
                    reads "Day 1", not "Day 0".
                  */}
                  {weekdayOf(block.day)} · Day {block.day + 1}
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

/**
 * The open-book glyph the banner shows right of the world name. Same inline-
 * SVG idiom as the HUD's own icon buttons (stroke currentColor, aria-hidden);
 * sized a step under the name's 17px type so it reads as a suffix, not a
 * second title.
 */
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

/**
 * The reader's mount. The banner action that OPENS the reader has no mounted
 * component of its own, so this host carries the overlay: registered
 * 'top-center' (children there render bare and are never unmounted by the
 * info panel's collapse — 'panel' placement would wrap it in visible chrome
 * and disappear with a collapsed panel on phones), and it renders nothing at
 * all while the reader is closed.
 *
 * Portal to <body>: the HUD containers' backdrop-filter makes them containing
 * blocks for fixed-position descendants, so a reader rendered in place would
 * be trapped inside its host's box.
 */
export function ChronicleReaderHost(): JSX.Element {
  return (
    <Show when={readerOpen()}>
      <Portal mount={document.body}>
        <Reader />
      </Portal>
    </Show>
  );
}

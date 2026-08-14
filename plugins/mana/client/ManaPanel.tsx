// The mana HUD panel: a bar plus numbers, flashing red when a sculpt is
// denied — the visible half of "the brush stopped because you ran dry".
//
// SOLID REACTIVITY: accessors called at point of use only (client rule).
// Styling is inline where it is data-driven (the bar's width IS the state);
// static chrome reuses the HUD's own classes so the panel matches the theme
// without the core stylesheet having to know this plugin exists.

import { Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import { deniedCount, manaPool } from './state.ts';

/** How long the denial flash lasts. Matches the HUD's other transient cues. */
const DENIAL_FLASH_MS = 600;

const BAR_WIDTH_PX = 120;
const BAR_HEIGHT_PX = 8;

/** Pool colour, and the flash colour a denial swaps in. */
const BAR_COLOR = '#5a9bd4';
const BAR_DENIED_COLOR = '#d9584a';

export function ManaPanel(): JSX.Element {
  const [flashing, setFlashing] = createSignal(false);

  // A denial (the COUNT changing, see state.ts) starts/restarts the flash.
  createEffect<number>((previous) => {
    const count = deniedCount();
    if (previous !== undefined && count !== previous) {
      setFlashing(true);
      const timer = setTimeout(() => setFlashing(false), DENIAL_FLASH_MS);
      onCleanup(() => clearTimeout(timer));
    }
    return count;
  });

  return (
    <Show when={manaPool() !== null}>
      <div class="hud-row">
        <span class="hud-label">Mana</span>
        <span
          style={{
            display: 'inline-block',
            width: `${BAR_WIDTH_PX}px`,
            height: `${BAR_HEIGHT_PX}px`,
            'border-radius': '4px',
            background: 'rgba(255, 255, 255, 0.10)',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'block',
              height: '100%',
              width: `${(100 * manaPool()!.balance) / manaPool()!.capacity}%`,
              background: flashing() ? BAR_DENIED_COLOR : BAR_COLOR,
              transition: 'width 120ms linear, background 120ms linear',
            }}
          />
        </span>
        <span class="status-label">
          {manaPool()!.balance}/{manaPool()!.capacity}
        </span>
      </div>
    </Show>
  );
}

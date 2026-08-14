// The HUD. Solid owns this and nothing else — the canvas underneath belongs to
// the imperative renderer (design doc §3.1).
//
// SOLID REACTIVITY: every reactive value below is read by CALLING its accessor
// at the point of use, inside JSX or inside an event handler. A component body
// runs exactly once, so a `const status = connectionStatus()` here would freeze
// the dot on whatever the status happened to be at mount. There are no such
// consts in this file, by construction.

import { For, type JSX } from 'solid-js';
import {
  BRUSH_RADII,
  brushRadius,
  connectionStatus,
  sculptMode,
  setBrushRadius,
} from '../state/hudState.ts';
import type { ConnectionStatus } from '../net/connection.ts';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  offline: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
};

export function Hud(): JSX.Element {
  return (
    <div class="hud">
      <div class="hud-panel">
        <div class="hud-row hud-status">
          {/* classList keeps the reactive read inline rather than in a const. */}
          <span
            class="status-dot"
            classList={{ [`status-${connectionStatus()}`]: true }}
          />
          <span class="status-label">{STATUS_LABEL[connectionStatus()]}</span>
        </div>

        <div class="hud-row">
          <span class="hud-label">Brush</span>
          <div class="brush-picker">
            <For each={BRUSH_RADII}>
              {(radius) => (
                <button
                  type="button"
                  class="brush-button"
                  classList={{ active: brushRadius() === radius }}
                  onClick={() => setBrushRadius(radius)}
                >
                  {radius}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="hud-row">
          <span class="hud-label">Mode</span>
          <span class="mode-value" classList={{ lower: sculptMode() === 'lower' }}>
            {sculptMode() === 'lower' ? 'Lower' : 'Raise'}
          </span>
        </div>

        <p class="hud-hint">
          Left-drag sculpts · Shift lowers · Right-drag orbits · Middle-drag pans
        </p>
      </div>
    </div>
  );
}

// The HUD. Solid owns this and nothing else — the canvas underneath belongs to
// the imperative renderer (design doc §3.1).
//
// SOLID REACTIVITY: every reactive value below is read by CALLING its accessor
// at the point of use, inside JSX or inside an event handler. A component body
// runs exactly once, so a `const status = connectionStatus()` here would freeze
// the dot on whatever the status happened to be at mount. There are no such
// consts in this file, by construction.

import { createSignal, For, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { pluginHudPanels } from '../plugins/hudPanels.ts';
import {
  BRUSH_PROFILES,
  BRUSH_RADII,
  BRUSH_TOOLS,
  brushProfile,
  brushRadius,
  brushTool,
  connectionStatus,
  sculptMode,
  setBrushProfile,
  setBrushRadius,
  setBrushTool,
  setSculptMode,
} from '../state/hudState.ts';
import {
  ACTION_PRECEDENCE,
  controlBindings,
  twoFingerGesture,
  type ControlAction,
  type ControlBindings,
} from '../state/controlPrefs.ts';
import { ControlsPanel } from './ControlsPanel.tsx';
import type { ConnectionStatus } from '../net/connection.ts';
import type { SculptProfile, SculptTool } from '@terrace/shared';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  offline: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
};

const HINT_VERB: Record<ControlAction, string> = {
  raise: 'raises',
  lower: 'lowers',
  orbit: 'orbits',
  pan: 'pans',
};

const HINT_BUTTON: Record<string, string> = {
  left: 'Left',
  middle: 'Middle',
  right: 'Right',
};

/** Button captions for the brush-shape toggles (decision 2026-08-14). */
const TOOL_LABEL: Record<SculptTool, string> = {
  stamp: 'Stamp',
  smooth: 'Smooth',
};

const PROFILE_LABEL: Record<SculptProfile, string> = {
  soft: 'Soft',
  hard: 'Hard',
};

const HINT_MODIFIER: Record<string, string> = {
  none: '',
  shift: 'Shift+',
  ctrl: 'Ctrl+',
  alt: 'Alt+',
};

/** "Left-drag raises · Shift+Left-drag lowers · …" from the live bindings. */
function hintText(bindings: ControlBindings): string {
  const parts = ACTION_PRECEDENCE.map((action) => {
    const b = bindings[action];
    return `${HINT_MODIFIER[b.modifier]}${HINT_BUTTON[b.button]}-drag ${HINT_VERB[action]}`;
  });
  return `${parts.join(' · ')} · Wheel zooms`;
}

export function Hud(): JSX.Element {
  // Panel visibility is pure UI state local to this component; nothing
  // imperative reads it, so a component-scoped signal is the right home.
  const [showControls, setShowControls] = createSignal(false);

  return (
    <div class="hud">
      {/* Top-centre plugin stack: at-a-glance status (mana gauge etc). */}
      <div class="hud-top-center">
        <For each={pluginHudPanels().filter((p) => p.placement === 'top-center')}>
          {(panel) => <Dynamic component={panel.component} />}
        </For>
      </div>

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

        {/* Brush SHAPE: which tool, and how its edge falls off. Orthogonal by
            design — hard+smooth stamps a plateau and lets it slump. Every
            reactive value is read by calling its accessor inline, per the file
            header; the labels are static maps, so they need no accessor. */}
        <div class="hud-row">
          <span class="hud-label">Tool</span>
          <div class="brush-picker">
            <For each={BRUSH_TOOLS}>
              {(tool) => (
                <button
                  type="button"
                  class="brush-button brush-button-wide"
                  classList={{ active: brushTool() === tool }}
                  onClick={() => setBrushTool(tool)}
                >
                  {TOOL_LABEL[tool]}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="hud-row">
          <span class="hud-label">Edge</span>
          <div class="brush-picker">
            <For each={BRUSH_PROFILES}>
              {(profile) => (
                <button
                  type="button"
                  class="brush-button brush-button-wide"
                  classList={{ active: brushProfile() === profile }}
                  onClick={() => setBrushProfile(profile)}
                >
                  {PROFILE_LABEL[profile]}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="hud-row">
          <span class="hud-label">Mode</span>
          {/* A button, not a label: on touch there are no modifier keys, so
              tapping this is how one-finger sculpting switches direction. */}
          <button
            type="button"
            class="mode-value"
            classList={{ lower: sculptMode() === 'lower' }}
            onClick={() =>
              setSculptMode(sculptMode() === 'lower' ? 'raise' : 'lower')
            }
          >
            {sculptMode() === 'lower' ? 'Lower' : 'Raise'}
          </button>
        </div>

        <div class="hud-row">
          <button
            type="button"
            class="controls-toggle"
            classList={{ open: showControls() }}
            onClick={() => setShowControls(!showControls())}
          >
            Controls {showControls() ? '▾' : '▸'}
          </button>
        </div>

        <Show when={showControls()}>
          <ControlsPanel />
        </Show>

        {/* Plugin panels (design §3.5): each client plugin may register
            components; 'panel'-placed ones stack under the core controls. */}
        <For each={pluginHudPanels().filter((p) => p.placement === 'panel')}>
          {(panel) => (
            <div class="hud-plugin-panel">
              <Dynamic component={panel.component} />
            </div>
          )}
        </For>

        <p class="hud-hint">{hintText(controlBindings())}</p>
        {/* Touch capability is static per device, so the guard can be a plain
            expression — it never needs to re-run. */}
        <Show when={navigator.maxTouchPoints > 0}>
          <p class="hud-hint">
            1-finger sculpts (tap Mode to switch) · 2-finger{' '}
            {twoFingerGesture() === 'orbit' ? 'orbits' : 'pans'} + pinch zooms
          </p>
        </Show>
      </div>
    </div>
  );
}

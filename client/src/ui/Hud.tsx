// The HUD. Solid owns this and nothing else — the canvas underneath belongs to
// the imperative renderer (design doc §3.1).
//
// SOLID REACTIVITY: every reactive value below is read by CALLING its accessor
// at the point of use, inside JSX or inside an event handler. A component body
// runs exactly once, so a `const status = connectionStatus()` here would freeze
// the dot on whatever the status happened to be at mount. There are no such
// consts in this file, by construction.

import { For, Show, type JSX } from 'solid-js';
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
  panelOpen,
  sculptMode,
  setBrushProfile,
  setBrushRadius,
  setBrushTool,
  setPanelOpen,
  setSculptMode,
  setShowControls,
  showControls,
  type SculptMode,
} from '../state/hudState.ts';
import {
  ACTION_PRECEDENCE,
  controlBindings,
  twoFingerGesture,
  wheelBehaviour,
  type ControlAction,
  type ControlBindings,
  type WheelBehaviour,
} from '../state/controlPrefs.ts';
import { ControlsPanel } from './ControlsPanel.tsx';
import { WorldHeader } from './WorldHeader.tsx';
import type { ConnectionStatus } from '../net/connection.ts';
import type { SculptProfile, SculptTool } from '@terrace/shared';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  offline: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
};

/**
 * Tooltip copy, in one place per control (native `title`, no tooltip widget).
 *
 * The standard every string below is held to: ONE sentence, plain language,
 * stating the CONSEQUENCE for the player rather than the implementation — the
 * relaxation pass is "drags neighbouring terrain along", not "relaxation".
 * Anything that depends on live state (the bound lower chord, the status) is
 * built from the same accessors the control itself reads, so a title can never
 * go stale against the control it explains.
 */
const STATUS_TITLE: Record<ConnectionStatus, string> = {
  offline: 'No link to the server — nothing you sculpt now is saved or shared.',
  connecting: 'Opening the link to the server — the world arrives once it is up.',
  connected: 'Live with the server — your edits are saved and everyone sees them.',
  reconnecting: 'The link dropped and is being retried — edits made now may be lost.',
};

const TOOL_TITLE: Record<SculptTool, string> = {
  stamp: 'Moves exactly the ground under the brush — spires, pits and sheer cliffs.',
  smooth: 'Drags neighbouring terrain along, like pulling fabric — blends shapes.',
};

const PROFILE_TITLE: Record<SculptProfile, string> = {
  soft: 'Strongest at the centre and fading to nothing at the rim — a rounded hill.',
  hard: 'The same height change across the whole brush — a plateau with sheer edges.',
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
function hintText(bindings: ControlBindings, wheel: WheelBehaviour): string {
  const parts = ACTION_PRECEDENCE.map((action) => {
    const b = bindings[action];
    return `${HINT_MODIFIER[b.modifier]}${HINT_BUTTON[b.button]}-drag ${HINT_VERB[action]}`;
  });
  // The wheel verb follows the preference (input/wheelCamera.ts) — it is the
  // one modifier-free gesture the user can change. Pinch and Alt+scroll are
  // fixed in both modes, so they are stated flatly.
  const wheelVerb = wheel === 'zoom' ? 'zooms' : 'pans';
  return `${parts.join(' · ')} · Wheel ${wheelVerb} · Pinch zooms · Alt+scroll orbits`;
}

/**
 * The Mode button's tooltip. It names the LIVE lower binding rather than a
 * hardcoded "Shift", because that binding is user-editable in the Controls
 * panel — a fixed "Shift lowers" would start lying the moment it is rebound.
 * Touch gets the same sentence: tapping is how a device with no modifier keys
 * switches direction.
 */
function modeTitle(mode: SculptMode, bindings: ControlBindings): string {
  // The chord quoted is the one that does the OPPOSITE of the current mode —
  // that is the escape hatch the sentence is offering.
  const opposite = mode === 'lower' ? bindings.raise : bindings.lower;
  const chord = `${HINT_MODIFIER[opposite.modifier]}${HINT_BUTTON[opposite.button]}`;
  return mode === 'lower'
    ? `Drags dig land down — click or tap to go back to raising, or ${chord}-drag to raise.`
    : `Drags pile land up — click or tap to switch to lowering, or ${chord}-drag to lower.`;
}

export function Hud(): JSX.Element {
  // Panel visibility used to be a component-local signal. It now lives in
  // hudState.ts so it is persisted with the rest of the HUD — an expanded
  // Controls panel survives a reload like every other choice made here. It is
  // still read by calling the accessor inline, exactly as before.
  return (
    <div class="hud">
      {/* Top centre, top to bottom: the world header (core — whose world this
          is), then the plugin stack (at-a-glance status: the mana gauge etc).
          The header is first in source order and the container is a column, so
          it sits ABOVE anything a plugin places here, whatever plugins are
          installed. */}
      <div class="hud-top-center">
        <WorldHeader />
        <For each={pluginHudPanels().filter((p) => p.placement === 'top-center')}>
          {(panel) => <Dynamic component={panel.component} />}
        </For>
      </div>

      {/* Bottom centre: persistent instruments (the mana gauge), kept along
          the bottom edge so the world's centre stays clear. */}
      <div class="hud-bottom-center">
        <For each={pluginHudPanels().filter((p) => p.placement === 'bottom-center')}>
          {(panel) => <Dynamic component={panel.component} />}
        </For>
      </div>

      {/* The whole tools panel collapses to a tab (owner, 2026-08-14: on a
          phone the open panel hides half the world). The status dot lives on
          BOTH faces, so the connection stays glanceable while collapsed. */}
      <Show
        when={panelOpen()}
        fallback={
          <button
            type="button"
            class="hud-panel hud-panel-tab"
            aria-expanded={false}
            title="Open the brush and camera menu."
            onClick={() => setPanelOpen(true)}
          >
            <span
              class="status-dot"
              classList={{ [`status-${connectionStatus()}`]: true }}
            />
            Menu ▸
          </button>
        }
      >
      <div class="hud-panel">
        {/* The status row doubles as the collapse control — it is the panel's
            first row on every device, so open and closed toggle in the same
            place. Its title stays the STATUS meaning (the row is a readout
            first); the chevron and aria-expanded carry the collapse affordance. */}
        <button
          type="button"
          class="hud-row hud-status panel-header"
          aria-expanded={true}
          title={STATUS_TITLE[connectionStatus()]}
          onClick={() => setPanelOpen(false)}
        >
          {/* classList keeps the reactive read inline rather than in a const. */}
          <span
            class="status-dot"
            classList={{ [`status-${connectionStatus()}`]: true }}
          />
          <span class="status-label">{STATUS_LABEL[connectionStatus()]}</span>
          <span class="panel-chevron">▴</span>
        </button>

        <div class="hud-row">
          <span class="hud-label">Brush</span>
          <div class="brush-picker">
            <For each={BRUSH_RADII}>
              {(radius) => (
                <button
                  type="button"
                  class="brush-button"
                  classList={{ active: brushRadius() === radius }}
                  aria-label={`Brush radius ${radius}`}
                  title={`Brush radius ${radius} — a wider brush moves more land and costs more mana.`}
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
                  aria-label={`${TOOL_LABEL[tool]} tool`}
                  title={TOOL_TITLE[tool]}
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
                  aria-label={`${PROFILE_LABEL[profile]} edge`}
                  title={PROFILE_TITLE[profile]}
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
            aria-label={`Sculpt direction: ${sculptMode() === 'lower' ? 'Lower' : 'Raise'}`}
            title={modeTitle(sculptMode(), controlBindings())}
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
            aria-expanded={showControls()}
            title="Show or hide the mouse, touch and scroll settings."
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

        <p class="hud-hint">{hintText(controlBindings(), wheelBehaviour())}</p>
        {/* Touch capability is static per device, so the guard can be a plain
            expression — it never needs to re-run. */}
        <Show when={navigator.maxTouchPoints > 0}>
          <p class="hud-hint">
            1-finger sculpts (tap Mode to switch) · 2-finger{' '}
            {twoFingerGesture() === 'orbit' ? 'orbits' : 'pans'} + pinch zooms
          </p>
        </Show>
      </div>
      </Show>
    </div>
  );
}

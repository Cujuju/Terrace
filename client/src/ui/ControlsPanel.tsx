// The control-bindings editor inside the HUD panel.
//
// SOLID REACTIVITY: reactive values are read by calling their accessor at the
// point of use, never stored in a component-body const (project rule).

import { For, Show, type JSX } from 'solid-js';
import {
  ACTION_PRECEDENCE,
  controlBindings,
  resetBindings,
  setBinding,
  setTwoFingerGesture,
  setWheelBehaviour,
  shadowedActions,
  twoFingerGesture,
  wheelBehaviour,
  type BindingModifier,
  type ControlAction,
  type ControlBindings,
  type MouseButtonName,
  type TwoFingerGesture,
  type WheelBehaviour,
} from '../state/controlPrefs.ts';
import {
  VOID_ANCHORS,
  VOID_STYLES,
  setVoidAnchor,
  setVoidStyle,
  voidAnchor,
  voidStyle,
  type VoidAnchor,
  type VoidStyle,
} from '../state/voidPrefs.ts';

/** Panel copy for each celestial-void look (state/voidPrefs.ts owns the set). */
const VOID_STYLE_LABEL: Record<VoidStyle, string> = {
  wheel: 'Star wheel',
  nebula: 'Nebula',
};

/** Panel copy for each celestial-void anchor (state/voidPrefs.ts owns the set). */
const VOID_ANCHOR_LABEL: Record<VoidAnchor, string> = {
  view: 'Follows the camera',
  world: 'Locked to the world',
};

const ACTION_LABEL: Record<ControlAction, string> = {
  raise: 'Raise land',
  lower: 'Lower land',
  orbit: 'Orbit',
  pan: 'Pan',
};

/**
 * What each action DOES, phrased to drop into a sentence ("Mouse button dragged
 * to orbit the camera"). The row's own label is a noun; a tooltip needs a verb,
 * and 'Pan' on its own does not tell a new player what moves.
 */
const ACTION_EFFECT: Record<ControlAction, string> = {
  raise: 'pile land up',
  lower: 'dig land down',
  orbit: 'swing the camera around the world',
  pan: 'slide the view sideways',
};

const HINT_VERB: Record<ControlAction, string> = {
  raise: 'raises',
  lower: 'lowers',
  orbit: 'orbits',
  pan: 'pans',
};

/** "Left-drag raises · Shift+Left-drag lowers · …" from the live bindings. */
function hintText(bindings: ControlBindings, wheel: WheelBehaviour): string {
  const parts = ACTION_PRECEDENCE.map((action) => {
    const b = bindings[action];
    return `${HINT_MODIFIER[b.modifier]}${BUTTON_LABEL[b.button]}-drag ${HINT_VERB[action]}`;
  });
  // The wheel verb follows the preference (input/wheelCamera.ts) — it is the
  // one modifier-free gesture the user can change. Pinch and Alt+scroll are
  // fixed in both modes, so they are stated flatly.
  const wheelVerb = wheel === 'zoom' ? 'zooms' : 'pans';
  return `${parts.join(' · ')} · Wheel ${wheelVerb} · Pinch zooms · Alt+scroll orbits`;
}

const HINT_MODIFIER: Record<BindingModifier, string> = {
  none: '',
  shift: 'Shift+',
  ctrl: 'Ctrl+',
  alt: 'Alt+',
};

/** Button captions reused by the hint text above. */
const BUTTON_LABEL: Record<MouseButtonName, string> = {
  left: 'Left',
  middle: 'Middle',
  right: 'Right',
};

const BUTTON_OPTIONS: readonly { value: MouseButtonName; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'middle', label: 'Middle' },
  { value: 'right', label: 'Right' },
];

const MODIFIER_OPTIONS: readonly { value: BindingModifier; label: string }[] = [
  { value: 'none', label: '—' },
  { value: 'shift', label: 'Shift' },
  { value: 'ctrl', label: 'Ctrl' },
  { value: 'alt', label: 'Alt' },
];

export function ControlsPanel(): JSX.Element {
  return (
    <div class="controls-panel">
      <For each={ACTION_PRECEDENCE}>
        {(action) => (
          <div class="hud-row controls-row">
            <span class="controls-label">{ACTION_LABEL[action]}</span>
            <select
              class="controls-select"
              aria-label={`${ACTION_LABEL[action]}: modifier key`}
              title={`Key to hold to ${ACTION_EFFECT[action]}; "—" means no key at all.`}
              value={controlBindings()[action].modifier}
              onChange={(e) =>
                setBinding(action, {
                  ...controlBindings()[action],
                  modifier: e.currentTarget.value as BindingModifier,
                })
              }
            >
              <For each={MODIFIER_OPTIONS}>
                {(opt) => <option value={opt.value}>{opt.label}</option>}
              </For>
            </select>
            <select
              class="controls-select"
              aria-label={`${ACTION_LABEL[action]}: mouse button`}
              title={`Mouse button to drag to ${ACTION_EFFECT[action]}.`}
              value={controlBindings()[action].button}
              onChange={(e) =>
                setBinding(action, {
                  ...controlBindings()[action],
                  button: e.currentTarget.value as MouseButtonName,
                })
              }
            >
              <For each={BUTTON_OPTIONS}>
                {(opt) => <option value={opt.value}>{opt.label}</option>}
              </For>
            </select>
          </div>
        )}
      </For>

      {/* Touch: one finger always sculpts; only the two-finger drag varies. */}
      <div class="hud-row controls-row">
        <span class="controls-label">2-finger drag</span>
        <select
          class="controls-select"
          aria-label="Two-finger drag gesture"
          title="What dragging two fingers does; pinching them always zooms, either way."
          value={twoFingerGesture()}
          onChange={(e) =>
            setTwoFingerGesture(e.currentTarget.value as TwoFingerGesture)
          }
        >
          <option value="pan">Pan</option>
          <option value="orbit">Orbit</option>
        </select>
      </div>

      {/* Wheel: scrolling pans the map by default (a trackpad's two-finger
          scroll must not dolly); mouse users can put zoom back on the wheel.
          A pinch always zooms, whichever is chosen. */}
      <div class="hud-row controls-row">
        <span class="controls-label">Scroll wheel</span>
        <select
          class="controls-select"
          aria-label="Scroll wheel behaviour"
          title="Whether scrolling slides the view or zooms it; a pinch always zooms and Alt+scroll always orbits."
          value={wheelBehaviour()}
          onChange={(e) =>
            setWheelBehaviour(e.currentTarget.value as WheelBehaviour)
          }
        >
          <option value="pan">Pan</option>
          <option value="zoom">Zoom</option>
        </select>
      </div>

      {/* What is drawn outside the map (render/celestialVoid.ts, issue #326).
          A look, not a control — but this is the panel a player already opens
          to make the view theirs, and it is where the reset button reaches. */}
      <div class="hud-row controls-row">
        <span class="controls-label">Beyond the map</span>
        <select
          class="controls-select"
          aria-label="Look of the space outside the map"
          title="What fills the space outside the world. Purely a look — it never changes with the time of day."
          value={voidStyle()}
          onChange={(e) => setVoidStyle(e.currentTarget.value as VoidStyle)}
        >
          <For each={VOID_STYLES}>
            {(style) => <option value={style}>{VOID_STYLE_LABEL[style]}</option>}
          </For>
        </select>
      </div>

      <div class="hud-row controls-row">
        <span class="controls-label">Void position</span>
        <select
          class="controls-select"
          aria-label="What the space outside the map is fixed to"
          title="Follows the camera: the void stays put while you orbit and pan. Locked to the world: it lies in the world's plane under the map and moves with it."
          value={voidAnchor()}
          onChange={(e) => setVoidAnchor(e.currentTarget.value as VoidAnchor)}
        >
          <For each={VOID_ANCHORS}>
            {(anchor) => <option value={anchor}>{VOID_ANCHOR_LABEL[anchor]}</option>}
          </For>
        </select>
      </div>

      <Show when={shadowedActions(controlBindings()).length > 0}>
        <p class="controls-warning">
          {/* Same binding twice: only the first (by precedence) ever fires. */}
          Duplicate binding —{' '}
          {shadowedActions(controlBindings())
            .map((a) => ACTION_LABEL[a])
            .join(', ')}{' '}
          will never trigger.
        </p>
      </Show>

      {/* The interface summary that used to head the info panel: what the
          live (possibly rebound) gestures do. It lives here, next to the very
          controls it describes, so changing a binding updates the sentence
          beside it rather than somewhere across the screen. */}
      <p class="hud-hint">{hintText(controlBindings(), wheelBehaviour())}</p>
      {/* Touch capability is static per device, so the guard can be a plain
          expression — it never needs to re-run. */}
      <Show when={navigator.maxTouchPoints > 0}>
        <p class="hud-hint">
          1-finger sculpts (tap Mode to switch) · 2-finger{' '}
          {twoFingerGesture() === 'orbit' ? 'orbits' : 'pans'} + pinch zooms
        </p>
      </Show>

      {/* resetBindings clears the buttons, the touch gesture, the wheel AND
          the celestial void's look — every setting on this panel — so the
          tooltip promises exactly that. */}
      <button
        type="button"
        class="controls-reset"
        title="Puts every setting on this panel back to how it started."
        onClick={resetBindings}
      >
        Reset to defaults
      </button>
    </div>
  );
}

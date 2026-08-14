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
  shadowedActions,
  twoFingerGesture,
  type BindingModifier,
  type ControlAction,
  type MouseButtonName,
  type TwoFingerGesture,
} from '../state/controlPrefs.ts';

const ACTION_LABEL: Record<ControlAction, string> = {
  raise: 'Raise land',
  lower: 'Lower land',
  orbit: 'Orbit',
  pan: 'Pan',
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
          value={twoFingerGesture()}
          onChange={(e) =>
            setTwoFingerGesture(e.currentTarget.value as TwoFingerGesture)
          }
        >
          <option value="pan">Pan</option>
          <option value="orbit">Orbit</option>
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

      <button type="button" class="controls-reset" onClick={resetBindings}>
        Reset to defaults
      </button>
    </div>
  );
}

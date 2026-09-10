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
  FRONTIER_MIST_MODES,
  frontierMistMode,
  setFrontierMistMode,
  type FrontierMistMode,
} from '../state/frontierMistPrefs.ts';
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
import {
  FRAME_RATE_TARGETS,
  frameRateTarget,
  setFrameRateTarget,
  type FrameRateTarget,
} from '../state/frameRatePrefs.ts';
import {
  LAYER_EDGE_STYLES,
  layerEdgeStyle,
  setLayerEdgeStyle,
  type LayerEdgeStyle,
} from '../state/layerEdgePrefs.ts';

const FRONTIER_MIST_LABEL: Record<FrontierMistMode, string> = {
  off: 'None',
  line: 'Red boundary line',
  waterline: 'Flat over the sea',
};

const VOID_STYLE_LABEL: Record<VoidStyle, string> = {
  wheel: 'Star wheel',
  nebula: 'Nebula',
};

const VOID_ANCHOR_LABEL: Record<VoidAnchor, string> = {
  view: 'Follows the camera',
  world: 'Locked to the world',
};

const LAYER_EDGE_STYLE_LABEL: Record<LayerEdgeStyle, string> = {
  normal: 'Normal',
  crease: 'Crease lines',
  debug: 'Debug (cyan lines)',
};

const FRAME_RATE_LABEL: Record<FrameRateTarget, string> = {
  unlimited: 'Unlimited (display refresh)',
  '144': '144 fps',
  '120': '120 fps',
  '90': '90 fps',
  '60': '60 fps',
  '30': '30 fps',
};

const ACTION_LABEL: Record<ControlAction, string> = {
  raise: 'Raise land',
  lower: 'Lower land',
  orbit: 'Orbit',
  pan: 'Pan',
};

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

function hintText(bindings: ControlBindings, wheel: WheelBehaviour): string {
  const parts = ACTION_PRECEDENCE.map((action) => {
    const b = bindings[action];
    return `${HINT_MODIFIER[b.modifier]}${BUTTON_LABEL[b.button]}-drag ${HINT_VERB[action]}`;
  });
  const wheelVerb = wheel === 'zoom' ? 'zooms' : 'pans';
  return `${parts.join(' · ')} · Wheel ${wheelVerb} · Pinch zooms · Alt+scroll orbits`;
}

const HINT_MODIFIER: Record<BindingModifier, string> = {
  none: '',
  shift: 'Shift+',
  ctrl: 'Ctrl+',
  alt: 'Alt+',
};

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
              title={`${ACTION_LABEL[action]} key: hold it to ${ACTION_EFFECT[action]}`}
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
              title={`${ACTION_LABEL[action]} button: drag it to ${ACTION_EFFECT[action]}`}
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

      {}
      <div class="hud-row controls-row">
        <span class="controls-label">2-finger drag</span>
        <select
          class="controls-select"
          aria-label="Two-finger drag gesture"
          title="Two fingers: drag does this, pinch zooms"
          value={twoFingerGesture()}
          onChange={(e) =>
            setTwoFingerGesture(e.currentTarget.value as TwoFingerGesture)
          }
        >
          <option value="pan">Pan</option>
          <option value="orbit">Orbit</option>
        </select>
      </div>

      {
}
      <div class="hud-row controls-row">
        <span class="controls-label">Scroll wheel</span>
        <select
          class="controls-select"
          aria-label="Scroll wheel behaviour"
          title="Scroll: slide or zoom the view"
          value={wheelBehaviour()}
          onChange={(e) =>
            setWheelBehaviour(e.currentTarget.value as WheelBehaviour)
          }
        >
          <option value="pan">Pan</option>
          <option value="zoom">Zoom</option>
        </select>
      </div>

      {
}
      <div class="hud-row controls-row">
        <span class="controls-label">Beyond the map</span>
        <select
          class="controls-select"
          aria-label="Look of the space outside the map"
          title="Beyond the map: a look, nothing more"
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
          title="Void position: fixed to camera or world"
          value={voidAnchor()}
          onChange={(e) => setVoidAnchor(e.currentTarget.value as VoidAnchor)}
        >
          <For each={VOID_ANCHORS}>
            {(anchor) => <option value={anchor}>{VOID_ANCHOR_LABEL[anchor]}</option>}
          </For>
        </select>
      </div>

      {
}
      <div class="hud-row controls-row">
        <span class="controls-label">Map edge</span>
        <select
          class="controls-select"
          aria-label="What marks the edge of the revealed map"
          title="Map edge: nothing, a red boundary line, or mist over sea"
          value={frontierMistMode()}
          onChange={(e) =>
            setFrontierMistMode(e.currentTarget.value as FrontierMistMode)
          }
        >
          <For each={FRONTIER_MIST_MODES}>
            {(mode) => <option value={mode}>{FRONTIER_MIST_LABEL[mode]}</option>}
          </For>
        </select>
      </div>

      {
}
      <div class="hud-row controls-row">
        <span class="controls-label">Terrain edges</span>
        <select
          class="controls-select"
          aria-label="How terrain layer edges are drawn"
          title="Normal: the terrain draws its own terraces. Crease lines: every layer edge is shaded in as a dark crease. Debug: the same edges outlined in cyan. The edge under the cursor lights up in all three."
          value={layerEdgeStyle()}
          onChange={(e) => setLayerEdgeStyle(e.currentTarget.value as LayerEdgeStyle)}
        >
          <For each={LAYER_EDGE_STYLES}>
            {(style) => <option value={style}>{LAYER_EDGE_STYLE_LABEL[style]}</option>}
          </For>
        </select>
      </div>

      {
}
      <div class="hud-row controls-row">
        <span class="controls-label">Frame rate</span>
        <select
          class="controls-select"
          aria-label="Frame rate target"
          title="Unlimited renders every display refresh. A fixed target skips frames to hold that rate and saves power; it never exceeds the display refresh."
          value={frameRateTarget()}
          onChange={(e) => setFrameRateTarget(e.currentTarget.value as FrameRateTarget)}
        >
          <For each={FRAME_RATE_TARGETS}>
            {(target) => <option value={target}>{FRAME_RATE_LABEL[target]}</option>}
          </For>
        </select>
      </div>

      <Show when={shadowedActions(controlBindings()).length > 0}>
        <p class="controls-warning">
          {}
          Duplicate binding —{' '}
          {shadowedActions(controlBindings())
            .map((a) => ACTION_LABEL[a])
            .join(', ')}{' '}
          will never trigger.
        </p>
      </Show>

      {
}
      <p class="hud-hint">{hintText(controlBindings(), wheelBehaviour())}</p>
      {
}
      <Show when={navigator.maxTouchPoints > 0}>
        <p class="hud-hint">
          1-finger sculpts (tap Mode to switch) · 2-finger{' '}
          {twoFingerGesture() === 'orbit' ? 'orbits' : 'pans'} + pinch zooms
        </p>
      </Show>

      {
}
      <button
        type="button"
        class="controls-reset"
        title="Reset: every setting back to start"
        onClick={resetBindings}
      >
        Reset to defaults
      </button>
    </div>
  );
}

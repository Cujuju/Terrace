import { smoothTerrainBands, setSmoothTerrainBands, terrainSurfaceRebuilding } from '../state/terrainSurfacePrefs.ts';
import { For, Show, type JSX } from 'solid-js';
import {
  ACTION_PRECEDENCE,
  controlBindings,
  resetBindings,
  setBinding,
  setTwoFingerGesture,
  setWheelBehaviour,
  setPointerLock,
  shadowedActions,
  twoFingerGesture,
  wheelBehaviour,
  pointerLock,
  type BindingModifier,
  type CameraAction,
  type ControlAction,
  type ControlBinding,
  type ControlBindings,
  type MouseButtonName,
  type SculptAction,
  type AltAction,
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
  MULTISAMPLE_SETTINGS,
  multisampleSetting,
  setMultisampleSetting,
  type MultisampleSetting,
} from '../state/multisamplePrefs.ts';
import {
  CREASE_OPACITY_STEP,
  LAYER_EDGE_STYLES,
  MAX_CREASE_OPACITY,
  MIN_CREASE_OPACITY,
  CELL_OPACITY_STEP,
  MAX_CELL_OPACITY,
  MIN_CELL_OPACITY,
  bandGridVisible,
  cellLinesVisible,
  cellLook,
  creaseColorHex,
  creaseLook,
  layerEdgeStyle,
  lipHighlight,
  setCellColor,
  setCellLinesVisible,
  setCellOpacity,
  setBandGridVisible,
  setSmoothLinesEnabled,
  smoothLinesEnabled,
  setCreaseColor,
  setCreaseOpacity,
  setLayerEdgeStyle,
  setLipHighlight,
  type LayerEdgeStyle,
} from '../state/layerEdgePrefs.ts';
import {
  TERRAIN_MESHERS,
  setTerrainMesher,
  terrainMesher,
  type TerrainMesher,
} from '../state/terrainMesherPrefs.ts';
import { perfLoggingEnabled, setPerfLogging } from '../state/perfLoggingPrefs.ts';

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

const PERCENT_SCALE = 100;

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

const MULTISAMPLE_LABEL: Record<MultisampleSetting, string> = {
  '4x': '4x MSAA',
  off: 'Off',
};

const TERRAIN_MESHER_LABEL: Record<TerrainMesher, string> = {
  auto: 'Auto (GPU when available)',
  gpu: 'GPU compute',
  cpu: 'CPU workers',
};

const CAMERA_LABEL: Record<CameraAction, string> = {
  orbit: 'Orbit',
  pan: 'Pan',
};

const CAMERA_EFFECT: Record<CameraAction, string> = {
  orbit: 'swing the camera around the world',
  pan: 'slide the view sideways',
};

const HINT_VERB: Record<CameraAction, string> = {
  orbit: 'orbits',
  pan: 'pans',
};

const isSculpt = (action: ControlAction): action is SculptAction | AltAction =>
  action === 'raise' || action === 'lower' || action === 'alt';

/** A sculpt press is named by its role, since no binding names a direction. */
function actionLabel(action: ControlAction, binding: ControlBinding): string {
  if (!isSculpt(action)) return CAMERA_LABEL[action];
  if (action === 'alt') return 'Sculpt, alt';
  return binding.modifier === 'none' ? 'Sculpt' : 'Sculpt, inverted';
}

function actionEffect(action: ControlAction, binding: ControlBinding): string {
  if (!isSculpt(action)) return CAMERA_EFFECT[action];
  if (action === 'alt') return 'drag only the grabbed band whichever way the HUD toggle points';
  return binding.modifier === 'none'
    ? 'sculpt whichever way the HUD toggle points'
    : 'sculpt the other way';
}

/** Neither sculpt binding names a direction: the HUD toggle does, chords invert it. Alt narrows the drag to one band. */
function sculptHint(action: ControlAction, b: ControlBinding): string {
  const press = `${HINT_MODIFIER[b.modifier]}${BUTTON_LABEL[b.button]}-drag`;
  if (action === 'alt') return `${press} sculpts the HUD direction, current band only`;
  return b.modifier === 'none'
    ? `${press} sculpts the HUD direction`
    : `${press} sculpts the other way`;
}

/** Names the alt+lower chord while it stays distinct, else null. */
function altLowerComboHint(bindings: ControlBindings): string | null {
  const lower = bindings.lower;
  const alt = bindings.alt.modifier;
  if (alt === 'none' || lower.modifier === 'none' || alt === lower.modifier) return null;
  const rank = (m: BindingModifier): number => (m === 'ctrl' ? 0 : m === 'shift' ? 1 : 2);
  const first = rank(lower.modifier) <= rank(alt) ? lower.modifier : alt;
  const second = first === lower.modifier ? alt : lower.modifier;
  return `${HINT_MODIFIER[first]}${HINT_MODIFIER[second]}${BUTTON_LABEL[lower.button]}-drag sculpts the other way, current band only`;
}

function hintText(bindings: ControlBindings, wheel: WheelBehaviour): string {
  const parts = ACTION_PRECEDENCE.map((action) => {
    const b = bindings[action];
    if (isSculpt(action)) return sculptHint(action, b);
    return `${HINT_MODIFIER[b.modifier]}${BUTTON_LABEL[b.button]}-drag ${HINT_VERB[action]}`;
  });
  const combo = altLowerComboHint(bindings);
  if (combo !== null) parts.push(combo);
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
            <span class="controls-label">
              {actionLabel(action, controlBindings()[action])}
            </span>
            <select
              class="controls-select"
              aria-label={`${actionLabel(action, controlBindings()[action])}: modifier key`}
              title={`${actionLabel(action, controlBindings()[action])} key: hold it to ${actionEffect(action, controlBindings()[action])}`}
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
              aria-label={`${actionLabel(action, controlBindings()[action])}: mouse button`}
              title={`${actionLabel(action, controlBindings()[action])} button: drag it to ${actionEffect(action, controlBindings()[action])}`}
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

      <div class="hud-row controls-row">
        <span class="controls-label">Pointer lock</span>
        <input
          type="checkbox"
          class="controls-check"
          aria-label="Lock the pointer during camera drags"
          title="Pointer lock: the cursor stays where a pan or rotate begins instead of travelling with the drag. Off by default."
          checked={pointerLock()}
          onChange={(e) => setPointerLock(e.currentTarget.checked)}
        />
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

      <Show when={layerEdgeStyle() === 'crease'}>
        <div class="hud-row controls-row">
          <span class="controls-label">Crease colour</span>
          <input
            type="color"
            class="controls-color"
            aria-label="Crease line colour"
            title="Crease colour: the colour every layer edge is drawn in"
            value={creaseColorHex(creaseLook().color)}
            onInput={(e) => setCreaseColor(e.currentTarget.value)}
          />
        </div>
        <div class="hud-row controls-row">
          <span class="controls-label">Crease opacity</span>
          <input
            type="range"
            class="controls-slider"
            aria-label="Crease line opacity"
            title="Crease opacity: how strongly the lines show over the terrain"
            min={MIN_CREASE_OPACITY}
            max={MAX_CREASE_OPACITY}
            step={CREASE_OPACITY_STEP}
            value={creaseLook().opacity}
            onInput={(e) => setCreaseOpacity(e.currentTarget.valueAsNumber)}
          />
          <span class="controls-readout">
            {Math.round(creaseLook().opacity * PERCENT_SCALE)}%
          </span>
        </div>
      </Show>

      <div class="hud-row controls-row">
        <span class="controls-label">Lip line</span>
        <input
          type="checkbox"
          class="controls-check"
          aria-label="Draw the lip line over the highlighted riser"
          title="Lip line: a bright line along the top edge of the highlighted riser. The riser face itself always shows."
          checked={lipHighlight()}
          onChange={(e) => setLipHighlight(e.currentTarget.checked)}
        />
      </div>

      <div class="hud-row controls-row">
        <span class="controls-label">Cell lines</span>
        <input
          type="checkbox"
          class="controls-check"
          aria-label="Draw a crease line on every cell"
          title="Cell lines: a thin crease line along every cell boundary, hugging the terrain. Off by default."
          checked={cellLinesVisible()}
          onChange={(e) => setCellLinesVisible(e.currentTarget.checked)}
        />
      </div>

      <Show when={cellLinesVisible()}>
        <div class="hud-row controls-row">
          <span class="controls-label">Cell colour</span>
          <input
            type="color"
            class="controls-color"
            aria-label="Cell line colour"
            title="Cell colour: the colour every cell boundary is drawn in"
            value={creaseColorHex(cellLook().color)}
            onInput={(e) => setCellColor(e.currentTarget.value)}
          />
        </div>
        <div class="hud-row controls-row">
          <span class="controls-label">Cell opacity</span>
          <input
            type="range"
            class="controls-slider"
            aria-label="Cell line opacity"
            title="Cell opacity: how strongly the lines show over the terrain"
            min={MIN_CELL_OPACITY}
            max={MAX_CELL_OPACITY}
            step={CELL_OPACITY_STEP}
            value={cellLook().opacity}
            onInput={(e) => setCellOpacity(e.currentTarget.valueAsNumber)}
          />
          <span class="controls-readout">
            {Math.round(cellLook().opacity * PERCENT_SCALE)}%
          </span>
        </div>
      </Show>

      <div class="hud-row controls-row">
        <span class="controls-label">Band grid</span>
        <input
          type="checkbox"
          class="controls-check"
          aria-label="Draw the band pipeline lattice"
          title="Band grid: the quarter-cell lattice the band pipeline resolves, in the Cell colour. Heavy while sculpting; look, then switch off."
          checked={bandGridVisible()}
          onChange={(e) => setBandGridVisible(e.currentTarget.checked)}
        />
      </div>

      <label class="hud-row controls-row">
        <span class="controls-label">Smooth terrain bands</span>
        <input type="checkbox" class="controls-check" checked={smoothTerrainBands()}
          title="Applies a gentle averaging filter to terrain contours. Rebuilds the visible terrain."
          onChange={(event) => setSmoothTerrainBands(event.currentTarget.checked)} />
      </label>
      <Show when={terrainSurfaceRebuilding()}>
        <p class="hud-hint" role="status">Rebuilding terrain…</p>
      </Show>
      <div class="hud-row controls-row">
        <span class="controls-label">Smooth lines</span>
        <input
          type="checkbox"
          class="controls-check"
          aria-label="Smooth the band boundary lines"
          title="Smooth lines: rounds the sharp corners off every band boundary line. Lines only; fills keep their edges."
          checked={smoothLinesEnabled()}
          onChange={(e) => setSmoothLinesEnabled(e.currentTarget.checked)}
        />
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

      {
}
      <div class="hud-row controls-row">
        <span class="controls-label">Anti-aliasing</span>
        <select
          class="controls-select"
          aria-label="Anti-aliasing"
          title="4x MSAA smooths terrace and cliff edges. Off saves GPU time and power at the cost of jagged edges."
          value={multisampleSetting()}
          onChange={(e) => setMultisampleSetting(e.currentTarget.value as MultisampleSetting)}
        >
          <For each={MULTISAMPLE_SETTINGS}>
            {(setting) => <option value={setting}>{MULTISAMPLE_LABEL[setting]}</option>}
          </For>
        </select>
      </div>

      {
}
      <div class="hud-row controls-row">
        <span class="controls-label">Terrain mesher</span>
        <select
          class="controls-select"
          aria-label="Which mesher builds the terrain"
          title="Which mesher turns heights into terrain: Auto picks GPU compute when the renderer runs WebGPU, otherwise CPU workers. Applies immediately and rebuilds the terrain."
          value={terrainMesher()}
          onChange={(e) => setTerrainMesher(e.currentTarget.value as TerrainMesher)}
        >
          <For each={TERRAIN_MESHERS}>
            {(mesher) => <option value={mesher}>{TERRAIN_MESHER_LABEL[mesher]}</option>}
          </For>
        </select>
      </div>

      {
}
      <div class="hud-row controls-row">
        <span class="controls-label">Performance logging</span>
        <select
          class="controls-select"
          aria-label="Performance logging"
          title="On: the browser console logs each frame hitch and the server marks each main-thread stall, both with a local time stamp. Both go to the server's data/perf.log. Applies immediately on both sides."
          value={perfLoggingEnabled() ? 'on' : 'off'}
          onChange={(e) => setPerfLogging(e.currentTarget.value === 'on')}
        >
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </div>
      <Show when={shadowedActions(controlBindings()).length > 0}>
        <p class="controls-warning">
          {}
          Duplicate binding —{' '}
          {shadowedActions(controlBindings())
            .map((a) => actionLabel(a, controlBindings()[a]))
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

import { For, Show, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import {
  BRUSH_PROFILES,
  BRUSH_ANCHOR_RADII,
  BRUSH_RADII,
  brushNominalWidthWorldUnits,
  brushWidthWorldUnits,
  BRUSH_TOOLS,
  brushProfile,
  brushRadius,
  brushTool,
  carveDepthBands,
  denialHint,
  effectiveSculptMode,
  sculptAlt,
  sculptMode,
  setBrushProfile,
  setBrushRadius,
  setBrushTool,
  setCarveDepthBands,
  setSculptMode,
  setSmoothFeather,
  setSmoothLambda,
  setSmoothRim,
  smoothFeather,
  smoothLambda,
  smoothRim,
  type DenialHint,
  type SculptMode,
} from '../state/hudState.ts';
import {
  controlBindings,
  type ControlBindings,
} from '../state/controlPrefs.ts';
import {
  CarveIcon,
  HardIcon,
  LowerIcon,
  DragIcon,
  RaiseIcon,
  SmoothIcon,
  SoftIcon,
  StampIcon,
} from './BrushIcons.tsx';
import { TOOLS_WITHOUT_DIRECTION, TOOLS_WITHOUT_EDGE_PROFILE } from '@terrace/shared';
import {
  CARVE_MAX_DEPTH_BANDS,
  CARVE_MIN_DEPTH_BANDS,
  SMOOTH_FEATHER_MAX,
  SMOOTH_FEATHER_MIN,
  SMOOTH_LAMBDA_MAX,
  SMOOTH_LAMBDA_MIN,
  SMOOTH_RIM_MAX,
  SMOOTH_RIM_MIN,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';

const TOOL_TITLE: Record<SculptTool, string> = {
  stamp: 'Stamp: raise or lower brushed ground',
  smooth: 'Smooth: blend ground with its neighbours',
  drag: 'Drag: drag a terrace edge outward',
  carve: 'Carve: cut a tunnel, roof intact',
};

/** One short line per denial the server can send, shown under the brush. */
const DENIAL_TEXT: Record<DenialHint, string> = {
  locked: 'This ground is locked',
  nest: 'A monster nests here',
  ward: 'Bedrock is warded here',
  'mana-with-cost': 'Not enough mana',
  refused: 'The stroke did not land',
};

const PROFILE_TITLE: Record<SculptProfile, string> = {
  soft: 'Soft: rounded hill fading to nothing',
  hard: 'Hard: one terrace at a time',
};

const HINT_BUTTON: Record<string, string> = {
  left: 'Left',
  middle: 'Middle',
  right: 'Right',
};

const TOOL_LABEL: Record<SculptTool, string> = {
  stamp: 'Stamp',
  smooth: 'Smooth',
  drag: 'Drag',
  carve: 'Carve',
};

const PROFILE_LABEL: Record<SculptProfile, string> = {
  soft: 'Soft',
  hard: 'Hard',
};

const TOOL_ICON: Record<SculptTool, Component> = {
  stamp: StampIcon,
  smooth: SmoothIcon,
  drag: DragIcon,
  carve: CarveIcon,
};

const PROFILE_ICON: Record<SculptProfile, Component> = {
  soft: SoftIcon,
  hard: HardIcon,
};

const BRUSH_RUNG_MAX = BRUSH_RADII.length - 1;

function brushRungIndex(): number {
  return Math.max(0, BRUSH_RADII.indexOf(brushRadius()));
}

const BRUSH_WIDTH_DECIMALS = 2;

function brushWidthLabel(radius: number): string {
  return brushNominalWidthWorldUnits(radius).toFixed(BRUSH_WIDTH_DECIMALS);
}

const HINT_MODIFIER: Record<string, string> = {
  none: '',
  shift: 'Shift+',
  ctrl: 'Ctrl+',
  alt: 'Alt+',
};

const SMOOTH_LAMBDA_DETENTS: readonly number[] = [25, 50, 75, 100];

/** The marked depths: one slab, an overhang's two, then five and the ceiling. */
const CARVE_DEPTH_DETENTS: readonly number[] = [
  CARVE_MIN_DEPTH_BANDS,
  2,
  5,
  CARVE_MAX_DEPTH_BANDS,
];

/** The chord that overrides the mode — none, when no chord names the other way. */
function overrideChord(mode: SculptMode, bindings: ControlBindings): string | null {
  const opposite = mode === 'lower' ? bindings.raise : bindings.lower;
  if (opposite.modifier === 'none') return null;
  return `${HINT_MODIFIER[opposite.modifier]}${HINT_BUTTON[opposite.button]}`;
}

function modeTitle(mode: SculptMode, bindings: ControlBindings): string {
  const base = mode === 'lower' ? 'Lower: drag digs land' : 'Raise: drag piles land';
  const chord = overrideChord(mode, bindings);
  if (chord === null) return base;
  return `${base} (${chord}-drag ${mode === 'lower' ? 'raises' : 'lowers'})`;
}

/** Edge badge naming the live alt mode. A letter today, digits if modes multiply. */
const DRAG_ALT_BADGE = 'A';

export function BrushModeler(): JSX.Element {
  return (
    <div
      class="hud-modeler hud-anchor-bottom-left"
      role="group"
      aria-label="Brush"
    >
      {
}
      <div class="hud-row">
        <div class="brush-picker">
          <For each={BRUSH_TOOLS}>
            {(tool) => (
              <button
                type="button"
                class="brush-button"
                classList={{ active: brushTool() === tool }}
                aria-label={`${TOOL_LABEL[tool]} tool`}
                title={TOOL_TITLE[tool]}
                onClick={() => setBrushTool(tool)}
              >
                <Dynamic component={TOOL_ICON[tool]} />
              </button>
            )}
          </For>
        </div>

        {
}
        <Show when={!TOOLS_WITHOUT_EDGE_PROFILE.includes(brushTool())}>
          <div class="brush-picker">
            <For each={BRUSH_PROFILES}>
              {(profile) => (
                <button
                  type="button"
                  class="brush-button"
                  classList={{ active: brushProfile() === profile }}
                  aria-label={`${PROFILE_LABEL[profile]} edge`}
                  title={PROFILE_TITLE[profile]}
                  onClick={() => setBrushProfile(profile)}
                >
                  <Dynamic component={PROFILE_ICON[profile]} />
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={!TOOLS_WITHOUT_DIRECTION.includes(brushTool())}>
          {
}
          <button
            type="button"
            class="mode-value"
            classList={{ lower: effectiveSculptMode() === 'lower' }}
            aria-label={`Sculpt direction: ${effectiveSculptMode() === 'lower' ? 'Lower' : 'Raise'}${sculptAlt() && brushTool() === 'drag' ? ', alt' : ''}`}
            title={
              sculptAlt() && brushTool() === 'drag'
                ? `${modeTitle(sculptMode(), controlBindings())} · Alt: current band only`
                : modeTitle(sculptMode(), controlBindings())
            }
            onClick={() =>
              setSculptMode(sculptMode() === 'lower' ? 'raise' : 'lower')
            }
          >
            <Dynamic
              component={effectiveSculptMode() === 'lower' ? LowerIcon : RaiseIcon}
            />
            <Show when={sculptAlt() && brushTool() === 'drag'}>
              <span class="mode-alt-badge" aria-hidden="true">
                {DRAG_ALT_BADGE}
              </span>
            </Show>
          </button>
        </Show>
      </div>

      {

}
      <div class="hud-row brush-slider">
        <span class="brush-slider__end">
          {brushWidthLabel(BRUSH_RADII[0])}
        </span>
        <div
          class="brush-slider__track"
          style={{
            '--brush-rung': String(brushRungIndex()),
            '--brush-slider-rungs': String(BRUSH_RUNG_MAX),
          }}
        >
          <span class="brush-slider__rail" />
          <span class="brush-slider__fill" />
          {
}
          <For each={BRUSH_ANCHOR_RADII}>
            {(radius, anchor) => (
              <span
                class="brush-slider__detent"
                classList={{ on: brushRadius() >= radius }}
                style={{
                  '--brush-detent': String(BRUSH_RADII.indexOf(radius)),
                  '--brush-anchor': String(anchor()),
                }}
              />
            )}
          </For>
          <input
            type="range"
            class="brush-slider__input"
            min="0"
            max={BRUSH_RUNG_MAX}
            step="1"
            value={brushRungIndex()}
            aria-label="Brush width"
            aria-valuetext={`${brushWidthWorldUnits(brushRadius())} world units`}
            onInput={(event) =>
              setBrushRadius(BRUSH_RADII[event.currentTarget.valueAsNumber])
            }
          />
          <span class="brush-slider__value">
            {brushWidthLabel(brushRadius())}
          </span>
        </div>
        <span class="brush-slider__end">
          {brushWidthLabel(BRUSH_RADII[BRUSH_RUNG_MAX])}
        </span>
      </div>
      <Show when={brushTool() === 'smooth'}>
        <div class="hud-row brush-slider">
          <span class="brush-slider__end">{SMOOTH_LAMBDA_MIN}%</span>
          <div
            class="brush-slider__track"
            style={{
              '--brush-rung': String(smoothLambda() - SMOOTH_LAMBDA_MIN),
              '--brush-slider-rungs': String(SMOOTH_LAMBDA_MAX - SMOOTH_LAMBDA_MIN),
            }}
          >
            <span class="brush-slider__rail" />
            <span class="brush-slider__fill" />
            <For each={SMOOTH_LAMBDA_DETENTS}>
              {(detent, anchor) => (
                <span
                  class="brush-slider__detent"
                  classList={{ on: smoothLambda() >= detent }}
                  style={{
                    '--brush-detent': String(detent - SMOOTH_LAMBDA_MIN),
                    '--brush-anchor': String(anchor()),
                  }}
                />
              )}
            </For>
            <input
              type="range"
              class="brush-slider__input"
              min={SMOOTH_LAMBDA_MIN}
              max={SMOOTH_LAMBDA_MAX}
              step="1"
              value={smoothLambda()}
              aria-label="Smooth strength"
              aria-valuetext={`${smoothLambda()} percent`}
              title="Smooth strength: how far each cell moves toward its neighbours per stroke"
              onInput={(event) =>
                setSmoothLambda(event.currentTarget.valueAsNumber)
              }
            />
            <span class="brush-slider__value">{smoothLambda()}%</span>
          </div>
          <span class="brush-slider__end">{SMOOTH_LAMBDA_MAX}%</span>
        </div>
        <div class="hud-row brush-slider">
          <span class="controls-label">Feather</span>
          <input
            type="checkbox"
            class="controls-check"
            aria-label="Feather the smooth edge"
            title="Feather edge: full strength across the brush, fading over the outer rim. Off by default."
            checked={smoothFeather() > 0}
            onChange={(event) =>
              setSmoothFeather(
                event.currentTarget.checked
                  ? (smoothFeather() > 0 ? smoothFeather() : 50)
                  : 0,
              )
            }
          />
          <div
            class="brush-slider__track"
            style={{
              '--brush-rung': String(smoothFeather()),
              '--brush-slider-rungs': String(SMOOTH_FEATHER_MAX),
            }}
          >
            <span class="brush-slider__rail" />
            <span class="brush-slider__fill" />
            <input
              type="range"
              class="brush-slider__input"
              min={SMOOTH_FEATHER_MIN}
              max={SMOOTH_FEATHER_MAX}
              step="1"
              value={smoothFeather()}
              aria-label="Feather width"
              aria-valuetext={`${smoothFeather()} percent of reach`}
              title="Feather width: percent of the brush reach that fades to the rim"
              onInput={(event) =>
                setSmoothFeather(event.currentTarget.valueAsNumber)
              }
            />
            <span class="brush-slider__value">{smoothFeather()}%</span>
          </div>
        </div>
        <div class="hud-row brush-slider">
          <span class="controls-label">Rim</span>
          <input
            type="checkbox"
            class="controls-check"
            aria-label="Tighten the smooth rim clamp"
            title="Rim: tighten how far the outer rim may travel, from the full band down to frozen at the reach. Off by default."
            checked={smoothRim() > 0}
            onChange={(event) =>
              setSmoothRim(
                event.currentTarget.checked
                  ? (smoothRim() > 0 ? smoothRim() : 50)
                  : 0,
              )
            }
          />
          <div
            class="brush-slider__track"
            style={{
              '--brush-rung': String(smoothRim()),
              '--brush-slider-rungs': String(SMOOTH_RIM_MAX),
            }}
          >
            <span class="brush-slider__rail" />
            <span class="brush-slider__fill" />
            <input
              type="range"
              class="brush-slider__input"
              min={SMOOTH_RIM_MIN}
              max={SMOOTH_RIM_MAX}
              step="1"
              value={smoothRim()}
              aria-label="Rim clamp width"
              aria-valuetext={`${smoothRim()} percent of reach`}
              title="Rim width: percent of the brush reach whose clamp tightens to the edge"
              onInput={(event) =>
                setSmoothRim(event.currentTarget.valueAsNumber)
              }
            />
            <span class="brush-slider__value">{smoothRim()}%</span>
          </div>
        </div>
      </Show>
      <Show when={brushTool() === 'carve'}>
        <div class="hud-row brush-slider">
          <span class="brush-slider__end">{CARVE_MIN_DEPTH_BANDS}</span>
          <div
            class="brush-slider__track"
            style={{
              '--brush-rung': String(carveDepthBands() - CARVE_MIN_DEPTH_BANDS),
              '--brush-slider-rungs': String(CARVE_MAX_DEPTH_BANDS - CARVE_MIN_DEPTH_BANDS),
            }}
          >
            <span class="brush-slider__rail" />
            <span class="brush-slider__fill" />
            <For each={CARVE_DEPTH_DETENTS}>
              {(detent, anchor) => (
                <span
                  class="brush-slider__detent"
                  classList={{ on: carveDepthBands() >= detent }}
                  style={{
                    '--brush-detent': String(detent - CARVE_MIN_DEPTH_BANDS),
                    '--brush-anchor': String(anchor()),
                  }}
                />
              )}
            </For>
            <input
              type="range"
              class="brush-slider__input"
              min={CARVE_MIN_DEPTH_BANDS}
              max={CARVE_MAX_DEPTH_BANDS}
              step="1"
              value={carveDepthBands()}
              aria-label="Carve depth"
              aria-valuetext={`${carveDepthBands()} bands`}
              title="Carve depth: how many terraces one cut opens, upward from the grasped band"
              onInput={(event) =>
                setCarveDepthBands(event.currentTarget.valueAsNumber)
              }
            />
            <span class="brush-slider__value">{carveDepthBands()}</span>
          </div>
          <span class="brush-slider__end">{CARVE_MAX_DEPTH_BANDS}</span>
        </div>
      </Show>
      <Show when={denialHint()}>
        {(hint) => (
          <p class="hud-hint" role="status">
            {DENIAL_TEXT[hint()]}
          </p>
        )}
      </Show>
    </div>
  );
}

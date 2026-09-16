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
  denialHint,
  sculptMode,
  setBrushProfile,
  setBrushRadius,
  setBrushTool,
  setSculptMode,
  setSmoothLambda,
  smoothLambda,
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
  SMOOTH_LAMBDA_MAX,
  SMOOTH_LAMBDA_MIN,
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

function modeTitle(mode: SculptMode, bindings: ControlBindings): string {
  const opposite = mode === 'lower' ? bindings.raise : bindings.lower;
  const chord = `${HINT_MODIFIER[opposite.modifier]}${HINT_BUTTON[opposite.button]}`;
  return mode === 'lower'
    ? `Lower: drag digs land (${chord}-drag raises)`
    : `Raise: drag piles land (${chord}-drag lowers)`;
}

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
            classList={{ lower: sculptMode() === 'lower' }}
            aria-label={`Sculpt direction: ${sculptMode() === 'lower' ? 'Lower' : 'Raise'}`}
            title={modeTitle(sculptMode(), controlBindings())}
            onClick={() =>
              setSculptMode(sculptMode() === 'lower' ? 'raise' : 'lower')
            }
          >
            <Dynamic
              component={sculptMode() === 'lower' ? LowerIcon : RaiseIcon}
            />
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

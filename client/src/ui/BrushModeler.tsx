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
  nudgeStrength,
  setCarveDepthBands,
  setNudgeStrength,
  setSculptMode,
  setSmoothKinkHalfCells,
  smoothKinkHalfCells,
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
  NudgeIcon,
  RaiseIcon,
  SmoothIcon,
  SoftIcon,
  StampIcon,
  SteppedIcon,
} from './BrushIcons.tsx';
import {
  STEPPED_RING_WIDTH_CELLS,
  TOOLS_WITHOUT_DIRECTION,
  TOOLS_WITHOUT_EDGE_PROFILE,
} from '@terrace/shared';
import {
  CARVE_MAX_DEPTH_BANDS,
  CARVE_MIN_DEPTH_BANDS,
  NUDGE_STRENGTH_MAX,
  NUDGE_STRENGTH_MIN,
  SMOOTH_KINK_HALF_CELLS_MAX,
  SMOOTH_KINK_HALF_CELLS_MIN,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';

const TOOL_TITLE: Record<SculptTool, string> = {
  stamp: 'Stamp: raise or lower brushed ground',
  smooth: 'Smooth: straighten kinks in terrace edges, keeping real curves',
  nudge: 'Nudge: push terraces apart, or draw them together the other way',
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
  stepped: `Stepped: each lower terrace reaches ${STEPPED_RING_WIDTH_CELLS} cells further out`,
};

const HINT_BUTTON: Record<string, string> = {
  left: 'Left',
  middle: 'Middle',
  right: 'Right',
};

const TOOL_LABEL: Record<SculptTool, string> = {
  stamp: 'Stamp',
  smooth: 'Smooth',
  nudge: 'Nudge',
  drag: 'Drag',
  carve: 'Carve',
};

const PROFILE_LABEL: Record<SculptProfile, string> = {
  soft: 'Soft',
  hard: 'Hard',
  stepped: 'Stepped',
};

const TOOL_ICON: Record<SculptTool, Component> = {
  stamp: StampIcon,
  smooth: SmoothIcon,
  nudge: NudgeIcon,
  drag: DragIcon,
  carve: CarveIcon,
};

const PROFILE_ICON: Record<SculptProfile, Component> = {
  soft: SoftIcon,
  hard: HardIcon,
  stepped: SteppedIcon,
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

const NUDGE_STRENGTH_DETENTS: readonly number[] = [25, 50, 75, 100];

/** Kink sizes worth marking, in half cells: a stair's half cell, then one, two and four cells. */
const SMOOTH_KINK_DETENTS: readonly number[] = [SMOOTH_KINK_HALF_CELLS_MIN, 2, 4, SMOOTH_KINK_HALF_CELLS_MAX];

/** Half cells shown as cells: 1 → 0.5. */
function kinkCellsLabel(halfCells: number): string {
  return (halfCells / 2).toFixed(1);
}

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
const ALT_BADGE = 'A';

/** The alt smooth's added title: stacked walls smooth as one. */
const SMOOTH_ALT_TITLE = 'Alt: bands sharing a wall smooth it as one';

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
                aria-label={`${TOOL_LABEL[tool]} tool${tool === 'smooth' && brushTool() === 'smooth' && sculptAlt() ? ', alt' : ''}`}
                title={
                  tool === 'smooth' && brushTool() === 'smooth' && sculptAlt()
                    ? `${TOOL_TITLE[tool]} · ${SMOOTH_ALT_TITLE}`
                    : TOOL_TITLE[tool]
                }
                onClick={() => setBrushTool(tool)}
              >
                <Dynamic component={TOOL_ICON[tool]} />
                <Show when={tool === 'smooth' && brushTool() === 'smooth' && sculptAlt()}>
                  <span class="mode-alt-badge" aria-hidden="true">
                    {ALT_BADGE}
                  </span>
                </Show>
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
                {ALT_BADGE}
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
          <span class="brush-slider__end">{kinkCellsLabel(SMOOTH_KINK_HALF_CELLS_MIN)}</span>
          <div
            class="brush-slider__track"
            style={{
              '--brush-rung': String(smoothKinkHalfCells() - SMOOTH_KINK_HALF_CELLS_MIN),
              '--brush-slider-rungs': String(SMOOTH_KINK_HALF_CELLS_MAX - SMOOTH_KINK_HALF_CELLS_MIN),
            }}
          >
            <span class="brush-slider__rail" />
            <span class="brush-slider__fill" />
            <For each={SMOOTH_KINK_DETENTS}>
              {(detent, anchor) => (
                <span
                  class="brush-slider__detent"
                  classList={{ on: smoothKinkHalfCells() >= detent }}
                  style={{
                    '--brush-detent': String(detent - SMOOTH_KINK_HALF_CELLS_MIN),
                    '--brush-anchor': String(anchor()),
                  }}
                />
              )}
            </For>
            <input
              type="range"
              class="brush-slider__input"
              min={SMOOTH_KINK_HALF_CELLS_MIN}
              max={SMOOTH_KINK_HALF_CELLS_MAX}
              step="1"
              value={smoothKinkHalfCells()}
              aria-label="Kink size"
              aria-valuetext={`${kinkCellsLabel(smoothKinkHalfCells())} cells`}
              title="Kink size in cells: how far a smooth may move a terrace edge; shallower bumps go, deeper bends stay"
              onInput={(event) =>
                setSmoothKinkHalfCells(event.currentTarget.valueAsNumber)
              }
            />
            <span class="brush-slider__value">{kinkCellsLabel(smoothKinkHalfCells())}</span>
          </div>
          <span class="brush-slider__end">{kinkCellsLabel(SMOOTH_KINK_HALF_CELLS_MAX)}</span>
        </div>
      </Show>
      <Show when={brushTool() === 'nudge'}>
        <div class="hud-row brush-slider">
          <span class="brush-slider__end">{NUDGE_STRENGTH_MIN}%</span>
          <div
            class="brush-slider__track"
            style={{
              '--brush-rung': String(nudgeStrength() - NUDGE_STRENGTH_MIN),
              '--brush-slider-rungs': String(NUDGE_STRENGTH_MAX - NUDGE_STRENGTH_MIN),
            }}
          >
            <span class="brush-slider__rail" />
            <span class="brush-slider__fill" />
            <For each={NUDGE_STRENGTH_DETENTS}>
              {(detent, anchor) => (
                <span
                  class="brush-slider__detent"
                  classList={{ on: nudgeStrength() >= detent }}
                  style={{
                    '--brush-detent': String(detent - NUDGE_STRENGTH_MIN),
                    '--brush-anchor': String(anchor()),
                  }}
                />
              )}
            </For>
            <input
              type="range"
              class="brush-slider__input"
              min={NUDGE_STRENGTH_MIN}
              max={NUDGE_STRENGTH_MAX}
              step="1"
              value={nudgeStrength()}
              aria-label="Nudge strength"
              aria-valuetext={`${nudgeStrength()} percent`}
              title="Nudge strength: how far terraces move apart or together per stroke"
              onInput={(event) =>
                setNudgeStrength(event.currentTarget.valueAsNumber)
              }
            />
            <span class="brush-slider__value">{nudgeStrength()}%</span>
          </div>
          <span class="brush-slider__end">{NUDGE_STRENGTH_MAX}%</span>
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

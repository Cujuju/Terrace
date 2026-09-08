import {
  For,
  Show,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { pluginHudPanels, type PluginHudPanel } from '../plugins/hudPanels.ts';
import { VersionWatermark } from './VersionWatermark.tsx';
import { RestorePoints, type RollbackActions } from './RestorePoints.tsx';
import { restorePanelOpen, setRestorePanelOpen } from '../state/rollbackState.ts';
import { WorldManager, type WorldActions } from './WorldManager.tsx';
import { AdminPanel } from './AdminPanel.tsx';
import { AdminAim } from './AdminAim.tsx';
import { WorldSwitchBanner } from './WorldSwitchBanner.tsx';
import {
  adminPanelOpen,
  armedAction,
  setAdminPanelOpen,
  setArmedAction,
  worldPanelOpen,
  setWorldPanelOpen,
  worldAdminKey,
  worldViewScope,
} from '../state/worldsState.ts';
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
  connectionStatus,
  panelOpen,
  perfOpen,
  sculptMode,
  setBrushProfile,
  setBrushRadius,
  setBrushTool,
  setPanelOpen,
  setPerfOpen,
  setSculptMode,
  setShowControls,
  showControls,
  type SculptMode,
} from '../state/hudState.ts';
import {
  controlBindings,
  type ControlBindings,
} from '../state/controlPrefs.ts';
import { AudioSettingsPanel } from './AudioSettingsPanel.tsx';
import { ControlsPanel } from './ControlsPanel.tsx';
import { WorldHeader } from './WorldHeader.tsx';
import { Toolbar } from './Toolbar.tsx';
import { SCULPT_TOOL_ID, activeToolId } from '../plugins/toolbar.ts';
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
import { Cartographer, chartOpen, setChartOpen } from './Cartographer.tsx';
import type { ChartSource } from '../terrain/chart.ts';
import type { ConnectionStatus } from '../net/connection.ts';
import { TOOLS_WITHOUT_DIRECTION, TOOLS_WITHOUT_EDGE_PROFILE } from '@terrace/shared';
import type { SculptProfile, SculptTool } from '@terrace/shared';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  offline: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
};

const STATUS_TITLE: Record<ConnectionStatus, string> = {
  offline: 'Offline: nothing is saved or shared',
  connecting: 'Connecting: waiting for the server',
  connected: 'Connected: edits saved and shared',
  reconnecting: 'Reconnecting: edits now may be lost',
};

const TOOL_TITLE: Record<SculptTool, string> = {
  stamp: 'Stamp: raise or lower brushed ground',
  smooth: 'Smooth: blend ground with its neighbours',
  drag: 'Drag: drag a terrace edge outward',
  carve: 'Carve: cut a tunnel, roof intact',
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

function modeTitle(mode: SculptMode, bindings: ControlBindings): string {
  const opposite = mode === 'lower' ? bindings.raise : bindings.lower;
  const chord = `${HINT_MODIFIER[opposite.modifier]}${HINT_BUTTON[opposite.button]}`;
  return mode === 'lower'
    ? `Lower: drag digs land (${chord}-drag raises)`
    : `Raise: drag piles land (${chord}-drag lowers)`;
}

function cornerTabName(): string {
  const first = pluginHudPanels().find((p) => p.placement === 'panel');
  if (first === undefined) return 'Info';
  return first.tabSummary?.() ?? first.pluginName.charAt(0).toUpperCase() + first.pluginName.slice(1);
}

function cornerBodies(): PluginHudPanel[] {
  return pluginHudPanels().filter((p) => p.placement === 'panel' && (p.hasBody?.() ?? true));
}

function cornerHeaders(): PluginHudPanel[] {
  return pluginHudPanels().filter((p) => p.placement === 'panel' && p.headerSummary);
}

export function Hud(props: {
  worlds: WorldActions;
  chartSource: () => ChartSource | null;
  rollback: RollbackActions;
  restartStack: () => void;
}): JSX.Element {
  let settingsRoot: HTMLDivElement | undefined;

  const [showConnection, setShowConnection] = createSignal(false);

  const openConnection = (open: boolean): void => {
    setShowConnection(open);
    if (open) setShowControls(false);
  };
  const openControls = (open: boolean): void => {
    setShowControls(open);
    if (open) setShowConnection(false);
  };

  const onWindowKeyDown = (event: KeyboardEvent): void => {
    if (chartOpen()) return;
    if (event.key !== 'Escape') return;
    if (armedAction() !== null) {
      setArmedAction(null);
      return;
    }
    if (showControls()) setShowControls(false);
    if (showConnection()) setShowConnection(false);
  };
  const onWindowPointerDown = (event: PointerEvent): void => {
    if (!showControls() && !showConnection()) return;
    if (settingsRoot !== undefined && event.target instanceof Node && settingsRoot.contains(event.target)) {
      return;
    }
    setShowControls(false);
    setShowConnection(false);
  };
  window.addEventListener('keydown', onWindowKeyDown);
  window.addEventListener('pointerdown', onWindowPointerDown);
  onCleanup(() => {
    window.removeEventListener('keydown', onWindowKeyDown);
    window.removeEventListener('pointerdown', onWindowPointerDown);
  });

  return (
    <div class="hud">
      {
}
      <div class="hud-top-center">
        <WorldHeader />
        {
}
        <AdminAim />
        <For each={pluginHudPanels().filter((p) => p.placement === 'top-center')}>
          {(panel) => <Dynamic component={panel.component} />}
        </For>
      </div>

      {
}
      <VersionWatermark />

      {
}
      <div class="hud-bottom-strip">
        {

}
        <Show when={activeToolId() === SCULPT_TOOL_ID}>
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
          </div>
        </Show>

        {
}
        <div class="hud-bottom-center">
          <Toolbar />
          <For each={pluginHudPanels().filter((p) => p.placement === 'bottom-center')}>
            {(panel) => <Dynamic component={panel.component} />}
          </For>
        </div>

        {
}
        <div class="hud-bottom-right">
        <For each={pluginHudPanels().filter((p) => p.placement === 'bottom-right')}>
          {(panel) => <Dynamic component={panel.component} />}
        </For>
        <div class="hud-settings hud-anchor-bottom-right" ref={settingsRoot}>
          <Show when={showControls()}>
            <div
              class="hud-panel hud-settings-popup"
              role="dialog"
              aria-label="Control settings"
            >
              <ControlsPanel />
              {
}
              <AudioSettingsPanel />
              {
}
              <For each={pluginHudPanels().filter((p) => p.placement === 'settings')}>
                {(panel) => <Dynamic component={panel.component} />}
              </For>
            </div>
          </Show>

          {
}
          <Show when={showConnection()}>
            <div
              class="hud-panel hud-settings-popup hud-connection-popup"
              role="dialog"
              aria-label="Connection"
            >
              <div class="hud-row">
                <span
                  class="status-dot"
                  classList={{ [`status-${connectionStatus()}`]: true }}
                />
                <span class="status-label">{STATUS_LABEL[connectionStatus()]}</span>
              </div>
              <p class="hud-hint">{STATUS_TITLE[connectionStatus()]}</p>
              {
}
              <For each={pluginHudPanels().filter((p) => p.placement === 'connection')}>
                {(panel) => <Dynamic component={panel.component} />}
              </For>
            </div>
          </Show>

          {
}
          <button
            type="button"
            class="hud-panel hud-settings-button hud-connection-button"
            classList={{ open: showConnection() }}
            aria-expanded={showConnection()}
            aria-haspopup="dialog"
            aria-label={`Connection: ${STATUS_LABEL[connectionStatus()]}`}
            title={STATUS_TITLE[connectionStatus()]}
            onClick={() => openConnection(!showConnection())}
          >
            <span
              class="status-dot"
              classList={{ [`status-${connectionStatus()}`]: true }}
            />
          </button>
          {
}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: chartOpen() }}
            aria-expanded={chartOpen()}
            aria-haspopup="dialog"
            aria-label="Chart of the known world"
            title="Chart: your known world, inked"
            onClick={() => setChartOpen(!chartOpen())}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z" />
              <path d="M9 4v14M15 6v14" />
            </svg>
          </button>
          {

}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: worldViewScope() === 'all' }}
            aria-pressed={worldViewScope() === 'all'}
            aria-label={
              worldViewScope() === 'all' ? 'Show only my territory' : 'Show the whole world'
            }
            title={
              worldViewScope() === 'all'
                ? 'Showing the whole world — press to see only your own territory'
                : 'Show the whole world (operator view)'
            }
            onClick={() =>
              props.worlds.send({
                type: 'worldView',
                key: worldAdminKey(),
                scope: worldViewScope() === 'all' ? 'mine' : 'all',
              })
            }
          >
            {
}
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18" />
              <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
            </svg>
          </button>
          {
}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: worldPanelOpen() }}
            aria-expanded={worldPanelOpen()}
            aria-haspopup="dialog"
            aria-label="Worlds"
            title="Worlds: create, load and archive"
            onClick={() => setWorldPanelOpen(!worldPanelOpen())}
          >
            {}
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
              <path d="m3 12 9 4.5L21 12" />
              <path d="m3 16.5 9 4.5 9-4.5" />
            </svg>
          </button>
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: restorePanelOpen() }}
            aria-expanded={restorePanelOpen()}
            aria-haspopup="dialog"
            aria-label="Restore points"
            title="Restore: put the world back"
            onClick={() => setRestorePanelOpen(!restorePanelOpen())}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: showControls() }}
            aria-expanded={showControls()}
            aria-haspopup="dialog"
            aria-label="Control settings"
            title="Settings: mouse, touch and scroll"
            onClick={() => openControls(!showControls())}
          >
            ⚙
          </button>
          {
}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            aria-label="Restart client and server"
            title="Restart: make changed code live"
            onClick={() => props.restartStack()}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18.4 6.6A9 9 0 1 1 5.6 6.6" />
              <path d="M12 3v8" />
            </svg>
          </button>
          {

}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: perfOpen() }}
            aria-pressed={perfOpen()}
            aria-label="Performance meter"
            title="Performance: frame time, resource counts (`)"
            onClick={() => setPerfOpen(!perfOpen())}
          >
            {
}
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12h3.5l2.5-6 4 12 2.5-6H21" />
            </svg>
          </button>
          {
}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: adminPanelOpen() }}
            aria-expanded={adminPanelOpen()}
            aria-haspopup="dialog"
            aria-label="Admin: world events"
            title="Admin: fire disasters on demand"
            onClick={() => setAdminPanelOpen(!adminPanelOpen())}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 3h6" />
              <path d="M10 3v6.5L4.6 18.2A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.8L14 9.5V3" />
              <path d="M7.5 15h9" />
            </svg>
          </button>
        </div>
        </div>
      </div>

      {
}
      <Show
        when={cornerBodies().length > 0}
        fallback={
          <div class="hud-panel hud-panel--compact hud-anchor-top-left">
            <div class="hud-row panel-header panel-header--static">
              <For each={cornerHeaders()}>
                {(panel) => <Dynamic component={panel.headerSummary} />}
              </For>
            </div>
          </div>
        }
      >
      <Show
        when={panelOpen()}
        fallback={
          <button
            type="button"
            class="hud-panel hud-anchor-top-left hud-panel-tab"
            aria-expanded={false}
            title={`${cornerTabName()}: open the panel`}
            onClick={() => setPanelOpen(true)}
          >
            {
}
            {cornerTabName()}
          </button>
        }
      >
        <div class="hud-panel hud-anchor-top-left">
          {
}
          <button
            type="button"
            class="hud-row panel-header"
            aria-expanded={true}
            title={`${cornerTabName()}: collapse the panel`}
            onClick={() => setPanelOpen(false)}
          >
            <For each={cornerHeaders()}>
              {(panel) => <Dynamic component={panel.headerSummary} />}
            </For>
            <span class="panel-chevron">▴</span>
          </button>

          {
}
          <For each={cornerBodies()}>
            {(panel) => (
              <div class="hud-plugin-panel">
                <Dynamic component={panel.component} />
              </div>
            )}
          </For>
        </div>
      </Show>
      </Show>

      {
}
      <Show when={chartOpen()}>
        <Cartographer source={props.chartSource} />
      </Show>

      {
}
      <Show when={restorePanelOpen()}>
        <RestorePoints actions={props.rollback} />
      </Show>

      {
}
      <Show when={worldPanelOpen()}>
        <WorldManager actions={props.worlds} />
      </Show>

      {
}
      <Show when={adminPanelOpen()}>
        <AdminPanel actions={props.worlds} />
      </Show>

      {
}
      <WorldSwitchBanner />

    </div>
  );
}

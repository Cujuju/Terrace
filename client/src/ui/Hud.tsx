// The HUD. Solid owns this and nothing else — the canvas underneath belongs to
// the imperative renderer (design doc §3.1).
//
// LAYOUT (owner redesign, 2026-08-19): three sections in three corners —
//   * TOP LEFT      the info panel: 'panel'-placed plugin panels (relics'
//                    skills, the invite link) and the control hint text.
//                    Collapsible to a tab, as the old all-in-one panel was.
//   * BOTTOM LEFT   the brush panel: radius, tool, edge, mode — the things a
//                    sculpting hand actually reaches for, always visible.
//   * BOTTOM RIGHT  a column of equal-sized icon buttons, each opening one
//                    thing: connection status, the Cartographer, and the
//                    control-bindings editor.
// Top CENTRE stays what it was: world header + top-center plugin stack.
//
// WHERE THE CONNECTION LIVES (owner, 2026-08-19, superseding the above): the
// link status moved OUT of the top-left panel and into the bottom-right button
// column, as a button the same size as the gear and the chart. Two reasons it
// belongs there and not where it was. First, the top-left panel is a stack of
// PLUGIN panels; a core readout sitting at the top of it made every plugin
// panel below read as part of the connection, which is what put the relic
// skills under a "Connected" heading they had nothing to do with. Second, the
// status is a one-glance fact with one sentence of detail behind it — exactly
// the shape of the two buttons it now sits with, and unlike them it needs no
// room at all until it is asked for.
//
// THE INVITE LIVES IN THE CONNECTION POPUP (owner, 2026-08-21, superseding
// the top-left listing above): the invite address moved out of the info panel
// and into the connection popup, rendered below the status row and its hint
// sentence. The plugin owns its markup — core only renders panels registered
// with the 'connection' placement here — so the info panel is purely plugin
// content again, and the address sits next to the one thing it is about: the
// link a friend joins through.
//
// THE BOTTOM EDGE IS ONE STRIP (owner refinement, same day): brush panel,
// bottom-center instruments (mana gauge) and the gear live in one grid row —
// `minmax(0,1fr) auto minmax(0,1fr)` — so a desktop keeps the gauge
// dead-centre while a phone shrinks the side cells and everything flows along
// the bottom instead of the three absolutely-anchored pieces colliding. On
// narrow screens the brush rows drop their text labels (hud.css) — every
// button keeps its title and aria-label — and coarse pointers get larger
// touch targets. All three sections must stay visible AND operable at iPhone
// portrait width; that is the requirement this strip exists to meet.
//
// SOLID REACTIVITY: every reactive value below is read by CALLING its accessor
// at the point of use, inside JSX or inside an event handler. A component body
// runs exactly once, so a `const status = connectionStatus()` here would freeze
// the dot on whatever the status happened to be at mount. There are no such
// consts in this file, by construction.

import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { pluginHudPanels } from '../plugins/hudPanels.ts';
import { VersionWatermark } from './VersionWatermark.tsx';
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
import { Cartographer, chartOpen, setChartOpen } from './Cartographer.tsx';
import type { ChartSource } from '../terrain/chart.ts';
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

// The `hard` title states the level fill (shared/heightmap.ts,
// applyLevelFillBrush) because that is what the player will actually see with
// the default Stamp tool; the trailing clause is the Smooth pairing, which
// keeps the plain flat lift. A tooltip that still promised "the same height
// change across the whole brush" would be describing the old brush.
const PROFILE_TITLE: Record<SculptProfile, string> = {
  soft: 'Strongest at the centre and fading to nothing at the rim — a rounded hill.',
  hard: 'One terrace at a time: levels the lowest ground under the brush before starting the next. With Smooth, one flat lift that then slumps.',
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

export function Hud(props: {
  /** Window onto the terrain mirror for the Cartographer; null pre-snapshot. */
  chartSource: () => ChartSource | null;
}): JSX.Element {
  // The button column's container, for the click-outside dismissal below. A
  // plain let-ref (Solid idiom); assigned once when the section renders.
  let settingsRoot: HTMLDivElement | undefined;

  // The connection popup's open state. Component-local rather than in
  // hudState.ts — unlike showControls (persisted, because a player who opened
  // the bindings editor should find it open next session), a status readout
  // answers a question asked in the moment and should never be waiting on the
  // screen after a reload.
  const [showConnection, setShowConnection] = createSignal(false);

  // ONE POPUP AT A TIME. Both popups grow upward from the same point at the
  // top of the button column (hud.css), so two open at once would overlap.
  // Rather than give them separate anchors and a narrower column, opening
  // either closes the other — which is also what a player expects from a row
  // of buttons where each opens one thing.
  const openConnection = (open: boolean): void => {
    setShowConnection(open);
    if (open) setShowControls(false);
  };
  const openControls = (open: boolean): void => {
    setShowControls(open);
    if (open) setShowConnection(false);
  };

  // DISMISSAL: Escape and click-outside both close whichever popup is open — a
  // popup that only its own button can close feels stuck. Registered once (the
  // component body runs once) on window, reading the accessors at EVENT time
  // rather than tracking them. Neither handler claims the event: a click that
  // dismisses the popup still reaches whatever it landed on (canvas included),
  // matching how every native popover behaves.
  const onWindowKeyDown = (event: KeyboardEvent): void => {
    // The chart overlay owns Escape while it is open (Cartographer.tsx has its
    // own listener); one press must close one layer, not both.
    if (chartOpen()) return;
    if (event.key !== 'Escape') return;
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
      {/* Top centre, top to bottom: the world header (core — whose world this
          is), then the plugin stack (at-a-glance status). The header is first
          in source order and the container is a column, so it sits ABOVE
          anything a plugin places here, whatever plugins are installed. */}
      <div class="hud-top-center">
        <WorldHeader />
        <For each={pluginHudPanels().filter((p) => p.placement === 'top-center')}>
          {(panel) => <Dynamic component={panel.component} />}
        </For>
      </div>

      {/* TOP RIGHT: the build-identity watermark — core diagnostic chrome,
          outside every panel so it stays readable however the HUD is
          collapsed (see VersionWatermark.tsx for the 2026-08-19 skew story
          it exists to expose). */}
      <VersionWatermark />

      {/* THE BOTTOM STRIP (owner refinement, 2026-08-19): brush panel, the
          bottom-centre instruments and the settings gear share ONE grid row —
          `minmax(0,1fr) auto minmax(0,1fr)` — so the gauge stays dead-centre
          on a desktop while a phone-width screen shrinks the side cells and
          the three sections flow along the bottom edge instead of colliding.
          The strip itself never takes pointer events; each section does. */}
      <div class="hud-bottom-strip">
        {/* BOTTOM LEFT — the BRUSH panel: what a playing hand reaches for.
            Always visible; collapsing the info panel never takes the tools
            away. On narrow screens its row labels hide (every button keeps
            its title and aria-label) so the whole panel fits beside the
            gauge and the gear. */}
        <div class="hud-panel hud-anchor-bottom-left">
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

          {/* Brush SHAPE: which tool, and how its edge falls off. Orthogonal
              by design — hard+smooth stamps a plateau and lets it slump.
              Every reactive value is read by calling its accessor inline, per
              the file header; the labels are static maps, so they need no
              accessor. */}
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
        </div>

        {/* Bottom centre: persistent instruments (the mana gauge), the
            strip's middle cell so the world's centre stays clear above it. */}
        <div class="hud-bottom-center">
          <For each={pluginHudPanels().filter((p) => p.placement === 'bottom-center')}>
            {(panel) => <Dynamic component={panel.component} />}
          </For>
        </div>

        {/* BOTTOM RIGHT — the BUTTON COLUMN: three equal icon buttons, each
            opening exactly one thing, and the popups that grow upward from
            the top of the column so no button ever moves under the pointer.
            Everything shares one container so the click-outside dismissal
            (top of the component) can treat it as one region. Icon-only
            (owner, 2026-08-19); the aria-label and title carry the words the
            faces no longer do. */}
        <div class="hud-settings hud-anchor-bottom-right" ref={settingsRoot}>
          <Show when={showControls()}>
            <div
              class="hud-panel hud-settings-popup"
              role="dialog"
              aria-label="Control settings"
            >
              <ControlsPanel />
            </div>
          </Show>

          {/* The connection popup: the same status row that used to head the
              top-left panel, plus the sentence that was only ever a hover
              title. Stating it in the popup is the point — a touch device has
              no hover, so on a phone that sentence was previously unreachable
              text. */}
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
              {/* Plugin panels registered with the 'connection' placement
                  (the invite link) render here, under the status row and its
                  sentence — same filter pattern as the bottom-centre stack. */}
              <For each={pluginHudPanels().filter((p) => p.placement === 'connection')}>
                {(panel) => <Dynamic component={panel.component} />}
              </For>
            </div>
          </Show>

          {/* The connection button. Its face is the status dot and nothing
              else, so the link stays glanceable at all times without the
              popup — including its pulse while connecting or reconnecting
              (hud.css animates the dot by status class). */}
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
          {/* The Cartographer's door: stacked ABOVE the gear so the bottom
              strip gains no width — the phone-width flow (file header) is
              untouched. Icon-only like the gear; an inline stroke SVG rather
              than an emoji so it takes the HUD's muted colour. */}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: chartOpen() }}
            aria-expanded={chartOpen()}
            aria-haspopup="dialog"
            aria-label="Chart of the known world"
            title="Open the chart: your known world as an inked map, exportable as an image."
            onClick={() => setChartOpen(!chartOpen())}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z" />
              <path d="M9 4v14M15 6v14" />
            </svg>
          </button>
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: showControls() }}
            aria-expanded={showControls()}
            aria-haspopup="dialog"
            aria-label="Control settings"
            title="Show or hide the mouse, touch and scroll settings."
            onClick={() => openControls(!showControls())}
          >
            ⚙
          </button>
        </div>
      </div>

      {/* TOP LEFT — the INFO panel: plugin 'panel' panels and the control
          descriptions. Collapses to a tab exactly as the old all-in-one panel
          did (owner, 2026-08-14: on a phone the open panel hides half the
          world). The connection no longer rides on either face — it is its own
          button in the bottom-right column now (see this file's header), which
          is what stops the plugin panels below from reading as part of it. */}
      <Show
        when={panelOpen()}
        fallback={
          <button
            type="button"
            class="hud-panel hud-anchor-top-left hud-panel-tab"
            aria-expanded={false}
            title="Open the help panel."
            onClick={() => setPanelOpen(true)}
          >
            Info ▸
          </button>
        }
      >
        <div class="hud-panel hud-anchor-top-left">
          {/* The header row IS the collapse control — the panel's first row on
              every device, so open and closed toggle in the same place. */}
          <button
            type="button"
            class="hud-row panel-header"
            aria-expanded={true}
            title="Collapse this panel."
            onClick={() => setPanelOpen(false)}
          >
            <span class="status-label">Info</span>
            <span class="panel-chevron">▴</span>
          </button>

          {/* Plugin panels (design §3.5): each client plugin may register
              components; 'panel'-placed ones stack inside the info panel —
              the placement contract's meaning ("the corner panel",
              client/src/plugins/types.ts) is unchanged, only the corner's
              contents around them slimmed down. */}
          <For each={pluginHudPanels().filter((p) => p.placement === 'panel')}>
            {(panel) => (
              <div class="hud-plugin-panel">
                <Dynamic component={panel.component} />
              </div>
            )}
          </For>

          <p class="hud-hint">{hintText(controlBindings(), wheelBehaviour())}</p>
          {/* Touch capability is static per device, so the guard can be a
              plain expression — it never needs to re-run. */}
          <Show when={navigator.maxTouchPoints > 0}>
            <p class="hud-hint">
              1-finger sculpts (tap Mode to switch) · 2-finger{' '}
              {twoFingerGesture() === 'orbit' ? 'orbits' : 'pans'} + pinch zooms
            </p>
          </Show>
        </div>
      </Show>

      {/* The Cartographer overlay, mounted only while open — mounting IS the
          draw (its onMount charts the world of that moment). */}
      <Show when={chartOpen()}>
        <Cartographer source={props.chartSource} />
      </Show>

    </div>
  );
}

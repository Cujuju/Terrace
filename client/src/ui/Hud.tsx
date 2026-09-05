// The HUD. Solid owns this and nothing else — the canvas underneath belongs to
// the imperative renderer (design doc).
//
// LAYOUT (owner redesign, 2026-08-19): three sections in three corners —
//   * TOP LEFT      the info panel: 'panel'-placed plugin panels (relics'
//                    skills, the invite link) and the control hint text.
//                    Collapsible to a tab, as the old all-in-one panel was.
//   * BOTTOM LEFT   the modeler: brush width, tool, edge, mode — the things a
//                    sculpting hand actually reaches for, on screen whenever
//                    the brush is the held tool.
//   * BOTTOM RIGHT  the mana gauge (owner move, 2026-08-25, out of the
//                    bottom-centre cell) beside a column of equal-sized icon
//                    buttons, each opening one thing: connection status, the
//                    Cartographer, and the control-bindings editor.
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
// THE BOTTOM EDGE IS ONE STRIP (owner refinement, same day): the
// bottom-centre instruments and the gear live in one grid row —
// `minmax(0,1fr) auto minmax(0,1fr)` — so a desktop keeps the toolbar
// dead-centre while a phone shrinks the side cells and everything flows along
// the bottom instead of the absolutely-anchored pieces colliding. (The mana
// gauge left the centre cell for the right one, 2026-08-25.) Coarse pointers
// get larger touch targets (hud.css). Every section must stay visible AND
// operable at iPhone portrait width; that is the requirement this strip
// exists to meet.
//
// THE MODELER IS ALL ICONS (owner, 2026-09-04: "instead of text, it uses an
// icon … change the mode to be an icon"): the brush panel kept its corner —
// "I want the center HUD to remain where it was and I want the tool HUD to
// stay on the left", same day, after seeing it docked over the toolbar — but
// every control in it became a picture. The four tools, the two edge profiles
// and the raise/lower toggle wear the shaded art of BrushIcons.tsx, and the
// five brush-width buttons became one slider snapped to the five rungs of the
// ladder. Since the owner's inline mockup (same day) the tools, the edge
// profiles and the direction disc share ONE row, with the slider alone
// beneath them. Two consequences worth naming. The row labels ("Brush", "Tool",
// "Edge", "Mode") are gone: with no words on the tiles there is nothing for a
// word beside them to disambiguate, and each control's own title and
// aria-label carries its name. And the panel is tied to the HELD TOOL rather
// than being unconditionally visible: it configures the brush, so it is on
// screen only while the brush is what the hand holds.
//
// SOLID REACTIVITY: every reactive value below is read by CALLING its accessor
// at the point of use, inside JSX or inside an event handler. A component body
// runs exactly once, so a `const status = connectionStatus()` here would freeze
// the dot on whatever the status happened to be at mount. There are no such
// consts in this file, by construction.

import {
  For,
  Show,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { pluginHudPanels } from '../plugins/hudPanels.ts';
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
} from '../state/worldsState.ts';
import {
  BRUSH_PROFILES,
  BRUSH_RADII,
  brushWidthWorldUnits,
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
  PullIcon,
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
  drag: 'Grab the edge of a terrace and push it about with the cursor — extends a level without changing which levels exist.',
  carve: 'Cuts a tunnel into the land and leaves the roof standing — start at a cliff face and work inward. Lowers only, and only where open air already reaches.',
};

// The `hard` title states the level fill (shared/heightmap.ts,
// applyLevelFillBrush) because that is what the player will actually see with
// the default Stamp tool; the trailing clause is the Smooth pairing, which
// keeps the plain flat lift. A tooltip that still promised "the same height
// change across the whole brush" would be describing the old brush.
const PROFILE_TITLE: Record<SculptProfile, string> = {
  soft: 'Strongest at the centre and fading to nothing at the rim — a rounded hill. With Pull, the edge advances as a smooth face.',
  hard: 'One terrace at a time: levels the lowest ground under the brush before starting the next. With Smooth, one flat lift that then slumps. With Pull, the edge fills every cell it can reach, notches included.',
};

const HINT_BUTTON: Record<string, string> = {
  left: 'Left',
  middle: 'Middle',
  right: 'Right',
};

/**
 * The brush-shape toggles' words (decision 2026-08-14). No longer RENDERED —
 * the dock's tiles are icon-only (owner, 2026-09-04) — but still the wording
 * of every one of those tiles' `aria-label`, which is the only name a screen
 * reader or a hover ever gets for them.
 */
const TOOL_LABEL: Record<SculptTool, string> = {
  stamp: 'Stamp',
  smooth: 'Smooth',
  drag: 'Pull',
  carve: 'Carve',
};

const PROFILE_LABEL: Record<SculptProfile, string> = {
  soft: 'Soft',
  hard: 'Hard',
};

/**
 * The face each tool and each edge profile wears in the dock (BrushIcons.tsx).
 * Keyed by the SAME shared unions the pickers iterate, so a tool added to
 * shared without art here fails to typecheck rather than rendering a blank
 * tile.
 */
const TOOL_ICON: Record<SculptTool, Component> = {
  stamp: StampIcon,
  smooth: SmoothIcon,
  drag: PullIcon,
  carve: CarveIcon,
};

const PROFILE_ICON: Record<SculptProfile, Component> = {
  soft: SoftIcon,
  hard: HardIcon,
};

/**
 * The brush-width slider's top index: it spans the ladder by INDEX, not by
 * radius, which is what makes a native range snap to exactly the five rungs
 * BRUSH_RADII offers (hudState.ts) instead of to arithmetic in between them.
 * Derived from the ladder, so a rung added there widens the slider by itself.
 */
const BRUSH_RUNG_MAX = BRUSH_RADII.length - 1;

/**
 * Where the current brush sits on the ladder. A FUNCTION, not a const: it
 * reads `brushRadius()` at call time, per the file header. Clamped at 0
 * because a radius off the ladder (which readRadius in hudState.ts already
 * refuses to load) must still leave the slider on a real rung rather than at
 * -1.
 */
function brushRungIndex(): number {
  return Math.max(0, BRUSH_RADII.indexOf(brushRadius()));
}

const HINT_MODIFIER: Record<string, string> = {
  none: '',
  shift: 'Shift+',
  ctrl: 'Ctrl+',
  alt: 'Alt+',
};

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

/**
 * The corner panel's collapsed-tab word: the first 'panel' plugin's name,
 * capitalised ("relics" → "Relics"); falls back to "Info" when no plugin has
 * claimed the corner, so the tab is never empty.
 */
function cornerTabName(): string {
  const first = pluginHudPanels().find((p) => p.placement === 'panel');
  if (first === undefined) return 'Info';
  // A plugin may supply a live tab label (relics: "Relics (3)"); otherwise
  // the capitalised registration name stands in.
  return first.tabSummary?.() ?? first.pluginName.charAt(0).toUpperCase() + first.pluginName.slice(1);
}

export function Hud(props: {
  /** What the world-manager panel may ask the server to do (multi-world). */
  worlds: WorldActions;
  /** Window onto the terrain mirror for the Cartographer; null pre-snapshot. */
  chartSource: () => ChartSource | null;
  /**
   * What the restore-points panel may ask the server to do (world rollback).
   * Passed in rather than imported so the HUD holds no reference to the
   * connection — the same arrangement as chartSource above.
   */
  rollback: RollbackActions;
  /**
   * The keyless "restart client + server" button's one action (owner,
   * 2026-09-04). Passed in for the same reason as the two above: the HUD
   * holds no reference to the connection.
   */
  restartStack: () => void;
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
    // An armed admin action is put down first, alone: the operator who
    // pressed Escape mid-aim wants out of the aim, not out of every popup.
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
      {/* Top centre, top to bottom: the world header (core — whose world this
          is), then the plugin stack (at-a-glance status). The header is first
          in source order and the container is a column, so it sits ABOVE
          anything a plugin places here, whatever plugins are installed. */}
      <div class="hud-top-center">
        <WorldHeader />
        {/* The admin aim strip, IN THE STACK under the header rather than a
            fixed banner (owner, 2026-09-01: a fixed one drew over the world
            name). It exists precisely while the admin panel is closed, so it
            is never gated on it. */}
        <AdminAim />
        <For each={pluginHudPanels().filter((p) => p.placement === 'top-center')}>
          {(panel) => <Dynamic component={panel.component} />}
        </For>
      </div>

      {/* TOP RIGHT: the build-identity watermark — core diagnostic chrome,
          outside every panel so it stays readable however the HUD is
          collapsed (see VersionWatermark.tsx for the 2026-08-19 skew story
          it exists to expose). */}
      <VersionWatermark />

      {/* THE BOTTOM STRIP (owner refinement, 2026-08-19): the bottom-centre
          instruments and the settings column share ONE grid row —
          `minmax(0,1fr) auto minmax(0,1fr)` — so the centre cell stays
          dead-centre on a desktop while a phone-width screen shrinks the side
          cells and the sections flow along the bottom edge instead of
          colliding. The strip itself never takes pointer events; each section
          does. Each section NAMES its column in hud.css rather than relying on
          auto-placement: the left cell empties whenever a plugin tool is held
          (below), and auto-placement would then slide the centre cell into it
          and take the toolbar off centre. */}
      <div class="hud-bottom-strip">
        {/* BOTTOM LEFT — the MODELER: what a playing hand reaches for, in the
            corner it has always been in (owner, 2026-09-04: "I want the center
            HUD to remain where it was and I want the tool HUD to stay on the
            left"). Collapsing the info panel never takes the tools away.

            THIS IS THE BRUSH'S SETTINGS, so it is on screen only while the
            brush is what the hand is holding: `activeToolId()` is
            SCULPT_TOOL_ID (plugins/toolbar.ts) exactly then. A plugin tool
            (Pyro, Temple) configures nothing here, and leaving a brush width
            and a sculpt direction up beside its toolbar would be offering
            settings that provably do not touch the press about to be made —
            the same argument the Edge and Mode rows below make for themselves.

            EVERY CONTROL IS ICON-ONLY and carries its own `title` and
            `aria-label`; the row labels the panel used to wear are gone with
            the words on the tiles. */}
        <Show when={activeToolId() === SCULPT_TOOL_ID}>
          <div
            class="hud-modeler hud-anchor-bottom-left"
            role="group"
            aria-label="Brush"
          >
            {/* ONE INLINE ROW (owner mockup, 2026-09-04: "give me this inline
                version"): the tool picker, then the edge picker, then the
                direction disc, side by side, with the width slider alone
                beneath. Tool and edge are orthogonal by design — hard+smooth
                stamps a plateau and lets it slump. Every reactive value is
                read by calling its accessor inline, per the file header; the
                label and icon maps are static, so they need no accessor. */}
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

              {/* EDGE and MODE follow on the same row, and each is present
                  ONLY FOR THE TOOLS THAT HAVE IT (issue #225; owner report,
                  2026-09-02: "Mode should also not be displayed in the HUD,
                  much as we do not show hard or smooth for the pull tool").
                  The drag and the carve have no edge profile at all and the
                  carve only ever removes — shared says which tools those are,
                  and its resolver normalises theirs away, so leaving either
                  control up would offer a choice that provably does nothing.
                  They are REMOVED rather than disabled: a disabled control
                  claims the setting is unavailable right now, and these do
                  not apply. The stored profile and mode are untouched, so
                  picking Stamp again comes back to whatever the player last
                  chose. `brushTool()` is called inside the JSX, per the file
                  header — a `const` here would freeze the row on the
                  mount-time tool. */}
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
                {/* A button, not a label: on touch there are no modifier
                    keys, so tapping this is how one-finger sculpting
                    switches direction. It keeps its two colour states —
                    accent green raising, `--hud-lower` orange lowering —
                    and now says the same thing twice, in the colour and in
                    the arrow it wears. */}
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

            {/* BRUSH WIDTH as a slider (owner, 2026-09-04: "turn it into a
                slider that goes from least to most values with stops for the
                two center values"). A NATIVE `input[type=range]` carrying the
                ladder's INDEX rather than its radius: the five rungs are the
                only reachable values, so the control snaps to them and the
                arrow keys, Home and End all step rung by rung for free —
                which a div-and-pointer-handler slider would have had to
                reimplement, badly.

                The numbers on show are WIDTHS IN WORLD UNITS, not the
                ladder's raw radii — see brushWidthWorldUnits (hudState.ts)
                for why the raw value was showing a quarter of what it
                appeared to promise. The ends caption the ladder's first and
                last rung; the live width rides under the thumb, and is what
                `aria-valuetext` says, because the raw index a screen reader
                would otherwise read out ("3 of 4") means nothing to a
                player.

                --brush-rung is the index the track's fill, its detents and
                the caption's position are all derived from in CSS, so there
                is one number to keep true rather than three. */}
            <div class="hud-row brush-slider">
              <span class="brush-slider__end">
                {brushWidthWorldUnits(BRUSH_RADII[0])}
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
                {/* One detent per rung, its ring growing with the brush it
                    stands for, so the width reads before the number does. */}
                <For each={BRUSH_RADII}>
                  {(radius, index) => (
                    <span
                      class="brush-slider__detent"
                      classList={{ on: brushRadius() >= radius }}
                      style={{ '--brush-detent': String(index()) }}
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
                  title="Brush width in world units — a wider brush moves more land and costs more mana."
                  onInput={(event) =>
                    setBrushRadius(BRUSH_RADII[event.currentTarget.valueAsNumber])
                  }
                />
                <span class="brush-slider__value">
                  {brushWidthWorldUnits(brushRadius())}
                </span>
              </div>
              <span class="brush-slider__end">
                {brushWidthWorldUnits(BRUSH_RADII[BRUSH_RUNG_MAX])}
              </span>
            </div>
          </div>
        </Show>

        {/* Bottom centre: the tool bar, alone in its cell now that the
            gauge has moved right (owner move, 2026-08-25) and the modeler
            stayed left (owner, 2026-09-04). The container is `column-reverse`
            (hud.css), so plugin 'bottom-center' panels registered later stack
            above it. */}
        <div class="hud-bottom-center">
          <Toolbar />
          <For each={pluginHudPanels().filter((p) => p.placement === 'bottom-center')}>
            {(panel) => <Dynamic component={panel.component} />}
          </For>
        </div>

        {/* BOTTOM RIGHT — the MANA GAUGE (owner move, 2026-08-25: out of the
            centre cell, whose toolbar no longer shares it) and the BUTTON
            COLUMN of equal icon buttons, each opening exactly one thing, with
            the popups that grow upward from the top of the column so no
            button ever moves under the pointer. The gauge sits to the LEFT of
            the column, in the same strip cell, so the two read as one corner.
            Everything below shares the cell; the click-outside dismissal (top
            of the component) still treats only the button column as one
            region. Icon-only buttons (owner, 2026-08-19); the aria-label and
            title carry the words the faces no longer do. */}
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
              {/* Beside the bindings panel, not inside it: its reset button
                  promises to reset "every setting on this panel", and audio is
                  not a control binding (see AudioSettingsPanel's header). */}
              <AudioSettingsPanel />
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
          {/* Restore points: the door to world rollback. It sits in the same
              column as the chart and the gear because it is the same shape of
              control — one icon, one thing behind it — and it is an OPERATOR
              tool, so it deliberately gets no more prominence than that. The
              clock-with-an-arrow is the conventional "history" glyph, drawn as
              an inline stroke SVG so it takes the HUD's muted colour like its
              neighbours rather than an emoji's own. */}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: worldPanelOpen() }}
            aria-expanded={worldPanelOpen()}
            aria-haspopup="dialog"
            aria-label="Worlds"
            title="Worlds: create, load and archive the worlds on this server."
            onClick={() => setWorldPanelOpen(!worldPanelOpen())}
          >
            {/* A stack of map layers: several worlds, one on top. */}
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
            title="Restore points: put the world back to an earlier moment."
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
            title="Show or hide the mouse, touch and scroll settings."
            onClick={() => openControls(!showControls())}
          >
            ⚙
          </button>
          {/* RESTART CLIENT + SERVER (owner, 2026-09-04): the development
              loop's update button. ONE CLICK, NO KEY, NO ARMING — the owner's
              ruling ("I just want it to be quick"): it destroys nothing (the
              world is saved first and comes back, the page reloads itself
              when the client dev server returns), and it is the only way new
              CLIENT code arrives, because Vite on this disk does not watch
              files. The keyed, armed "Restart server" in the Worlds panel
              restarts the server half only. Same 40px square as its
              neighbours; a circular arrow with a power-line, the conventional
              "restart" glyph, as an inline stroke SVG like the rest. */}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            aria-label="Restart client and server"
            title="Restart the game server and the client dev server so code that changed on disk becomes live. The world is saved first; this page reloads itself."
            onClick={() => props.restartStack()}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18.4 6.6A9 9 0 1 1 5.6 6.6" />
              <path d="M12 3v8" />
            </svg>
          </button>
          {/* ADMIN MODE (owner, 2026-09-01): the debug spawn panel's door, at
              the very bottom of the column — the corner of the screen — so
              it is the last thing in the row and the first thing under the
              thumb. An operator tool like the restore points above it, so
              it gets the same 40px square and no more prominence. A flask:
              this is where experiments are run. */}
          <button
            type="button"
            class="hud-panel hud-settings-button"
            classList={{ open: adminPanelOpen() }}
            aria-expanded={adminPanelOpen()}
            aria-haspopup="dialog"
            aria-label="Admin: world events"
            title="Admin: fire volcanoes, mudslides, storms and the rest on demand, for debugging."
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

      {/* TOP LEFT — the INFO panel: plugin 'panel' panels. The control
          descriptions moved to the settings popup (owner, 2026-08-21), so
          this corner is purely plugin content. Collapses to a tab exactly as the old all-in-one panel
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
            title="Open the panel."
            onClick={() => setPanelOpen(true)}
          >
            {/* The tab is named by the panel's first plugin — "Relics", not a
                generic "Info" — capitalised from the plugin's registration
                name; with no plugins it falls back to the old word. */}
            {cornerTabName()}
          </button>
        }
      >
        <div class="hud-panel hud-anchor-top-left">
          {/* The header row IS the collapse control — the panel's first row on
              every device, so open and closed toggle in the same place. It
              carries no word of its own: its content is the plugins'
              headerSummary lines (relics' "Relics · N in the world"), which
              also name the collapsed tab below. */}
          <button
            type="button"
            class="hud-row panel-header"
            aria-expanded={true}
            title="Collapse this panel."
            onClick={() => setPanelOpen(false)}
          >
            <For
              each={pluginHudPanels().filter(
                (p) => p.placement === 'panel' && p.headerSummary,
              )}
            >
              {(panel) => <Dynamic component={panel.headerSummary} />}
            </For>
            <span class="panel-chevron">▴</span>
          </button>

          {/* Plugin panels (design doc): each client plugin may register
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
        </div>
      </Show>

      {/* The Cartographer overlay, mounted only while open — mounting IS the
          draw (its onMount charts the world of that moment). */}
      <Show when={chartOpen()}>
        <Cartographer source={props.chartSource} />
      </Show>

      {/* The restore-points overlay, mounted only while open — the panel asks
          the server for nothing until the operator types a key and presses
          List, so mounting it costs one empty sheet. */}
      <Show when={restorePanelOpen()}>
        <RestorePoints actions={props.rollback} />
      </Show>

      {/* The world-manager overlay, mounted only while open — it asks the
          server for nothing until the operator types a key and presses List. */}
      <Show when={worldPanelOpen()}>
        <WorldManager actions={props.worlds} />
      </Show>

      {/* The admin panel, mounted only while open — it asks the server for
          nothing until a key is in hand, and then only for the listing. */}
      <Show when={adminPanelOpen()}>
        <AdminPanel actions={props.worlds} />
      </Show>


      {/* Not gated on the panel: a switch countdown and "no world loaded" are
          shown to every player, whether or not they hold a key. */}
      <WorldSwitchBanner />

    </div>
  );
}

// The bottom TOOLBAR: what the player's hand is holding (owner, 2026-08-24).
//
// Lives in the bottom-centre cell of the HUD's bottom strip, directly under
// the mana gauge — the two read as one instrument, which is what the owner
// asked for ("add this to the mana panel"). The brush panel in the
// bottom-LEFT corner is untouched and stays where it is: it configures the
// brush, and this bar chooses whether the brush is what you are holding at
// all.
//
// CORE RENDERS IT, PLUGINS FILL IT. The bar knows no particular plugin — the
// same rule the corner panel's plugin stack keeps (design doc). It renders
// one built-in face (Sculpt, which is the ABSENCE of a plugin tool) plus
// whatever plugins registered, in registration order, which is the host's
// plugin load order and therefore deterministic per server configuration.
//
// HIDDEN WHEN THERE IS NOTHING TO CHOOSE: with no plugin tools installed a
// lone "Sculpt" button is a control with one setting, so the bar renders
// nothing at all and the gauge sits where it always did.
//
// ICON-ONLY (owner, 2026-09-04: "reduce the size of the sculpt, pyro, and
// temple buttons by removing the text"): each tile is its icon alone, in the
// modeler dock's idiom; the tool's label lives on in its aria-label and its
// title, which are the only names a screen reader or a hover ever gets.
//
// SOLID REACTIVITY: every reactive value is read by CALLING its accessor
// inside JSX, per Hud.tsx's own rule — there are no consts here holding a
// reactive read.

import { For, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import {
  SCULPT_TOOL_ID,
  activeToolId,
  pluginTools,
  selectTool,
} from '../plugins/toolbar.ts';

/**
 * The brush's own face: a trowel driven into a mound of earth on an isometric
 * tile, drawn as a shaded inline SVG (owner, 2026-09-04: "gorgeous 3D
 * icons"). Gradient ids are prefixed with the tool's name because SVG ids are
 * document-global and the toolbar holds several icons at once.
 */
function SculptIcon(): JSX.Element {
  return (
    <svg
      class="hud-tool__icon"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="sculpt-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a6e08a" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="sculpt-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a6a45" />
          <stop offset="1" stop-color="#5a3a22" />
        </linearGradient>
        <linearGradient id="sculpt-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6e4a2f" />
          <stop offset="1" stop-color="#3a2415" />
        </linearGradient>
        <radialGradient id="sculpt-mound" cx="0.38" cy="0.3" r="0.75">
          <stop offset="0" stop-color="#c8f0a8" />
          <stop offset="0.55" stop-color="#6fbf73" />
          <stop offset="1" stop-color="#3f7f3e" />
        </radialGradient>
        <linearGradient id="sculpt-blade" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="0.45" stop-color="#c9d4de" />
          <stop offset="1" stop-color="#7a8895" />
        </linearGradient>
        <linearGradient id="sculpt-handle" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#e0a463" />
          <stop offset="0.5" stop-color="#b0733a" />
          <stop offset="1" stop-color="#6d4220" />
        </linearGradient>
      </defs>
      {/* Ground shadow. */}
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      {/* The tile: grass top, two earth walls. */}
      <polygon points="16,13 28,19 16,25 4,19" fill="url(#sculpt-top)" />
      <polygon points="4,19 16,25 16,29 4,23" fill="url(#sculpt-left)" />
      <polygon points="28,19 16,25 16,29 28,23" fill="url(#sculpt-right)" />
      {/* The mound the brush has raised, with the shade it casts. */}
      <ellipse cx="14" cy="18.6" rx="7.2" ry="4.2" fill="#2e5a2e" opacity="0.45" />
      <ellipse cx="14" cy="16.8" rx="7" ry="4.4" fill="url(#sculpt-mound)" />
      {/* The trowel: wooden handle, steel blade with an edge highlight. */}
      <path d="M25.5 3.5l3 2.4-4.2 5.2-3-2.4z" fill="url(#sculpt-handle)" />
      <path
        d="M21.3 8.7l3 2.4-5.8 8.4-4.5-3z"
        fill="url(#sculpt-blade)"
        stroke="#5b6873"
        stroke-width="0.4"
      />
      <path d="M21.3 8.7L14 16.5" stroke="#ffffff" stroke-width="0.6" opacity="0.7" />
    </svg>
  );
}

const SCULPT_TITLE =
  'The sculpting brush: drag the ground to raise and lower it. The brush panel sets its size and shape.';

export function Toolbar(): JSX.Element {
  return (
    <Show when={pluginTools().length > 0}>
      <div class="hud-panel hud-toolbar" role="toolbar" aria-label="Tools">
        <button
          type="button"
          class="hud-tool"
          classList={{ active: activeToolId() === SCULPT_TOOL_ID }}
          aria-pressed={activeToolId() === SCULPT_TOOL_ID}
          aria-label="Sculpt"
          title={SCULPT_TITLE}
          onClick={() => selectTool(SCULPT_TOOL_ID)}
        >
          <SculptIcon />
        </button>

        <For each={pluginTools()}>
          {(tool) => (
            <button
              type="button"
              class="hud-tool"
              classList={{ active: activeToolId() === tool.id }}
              aria-pressed={activeToolId() === tool.id}
              aria-label={tool.label}
              title={tool.title}
              onClick={() =>
                // A second click on the held tool puts the brush back — the
                // bar must never be a mode you cannot leave from the control
                // you entered it with.
                selectTool(activeToolId() === tool.id ? SCULPT_TOOL_ID : tool.id)
              }
            >
              <Dynamic component={tool.icon} />
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

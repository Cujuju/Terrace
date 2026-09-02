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
 * The brush's own face. A trowel-ish wedge over a ground line — the shape of
 * moving earth, drawn as an inline stroke SVG so it takes the HUD's muted
 * colour exactly like the chart and history icons in the button column.
 */
function SculptIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {/* The blade, point down. */}
      <path d="M9 3h6v7l-3 5-3-5V3Z" />
      {/* The ground it works. */}
      <path d="M4 20h16" />
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
          <span class="hud-tool__label">Sculpt</span>
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
              <span class="hud-tool__label">{tool.label}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

import { For, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import {
  SCULPT_TOOL_ID,
  activeToolId,
  pluginTools,
  selectTool,
} from '../plugins/toolbar.ts';

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
      {}
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      {}
      <polygon points="16,13 28,19 16,25 4,19" fill="url(#sculpt-top)" />
      <polygon points="4,19 16,25 16,29 4,23" fill="url(#sculpt-left)" />
      <polygon points="28,19 16,25 16,29 28,23" fill="url(#sculpt-right)" />
      {}
      <ellipse cx="14" cy="18.6" rx="7.2" ry="4.2" fill="#2e5a2e" opacity="0.45" />
      <ellipse cx="14" cy="16.8" rx="7" ry="4.4" fill="url(#sculpt-mound)" />
      {}
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

const SCULPT_TITLE = 'Sculpt: drag to shape land';

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

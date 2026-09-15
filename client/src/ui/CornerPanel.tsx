import { For, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { pluginHudPanels, type PluginHudPanel } from '../plugins/hudPanels.ts';
import { panelOpen, setPanelOpen } from '../state/hudState.ts';

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

export function CornerPanel(): JSX.Element {
  return (
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
  );
}

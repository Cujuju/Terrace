import { For, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { pluginHudPanels } from '../plugins/hudPanels.ts';
import { VersionWatermark } from './VersionWatermark.tsx';
import { RestorePoints, type RollbackActions } from './RestorePoints.tsx';
import { restorePanelOpen } from '../state/rollbackState.ts';
import { WorldManager, type WorldActions } from './WorldManager.tsx';
import { AdminPanel } from './AdminPanel.tsx';
import { AdminAim } from './AdminAim.tsx';
import { WorldSwitchBanner } from './WorldSwitchBanner.tsx';
import { adminPanelOpen, worldPanelOpen } from '../state/worldsState.ts';
import { BrushModeler } from './BrushModeler.tsx';
import { CornerPanel } from './CornerPanel.tsx';
import { HudSettings } from './HudSettings.tsx';
import { WorldHeader } from './WorldHeader.tsx';
import { Toolbar } from './Toolbar.tsx';
import { SCULPT_TOOL_ID, activeToolId } from '../plugins/toolbar.ts';
import { Cartographer, chartOpen } from './Cartographer.tsx';
import type { ChartSource } from '../terrain/chart.ts';

export function Hud(props: {
  worlds: WorldActions;
  chartSource: () => ChartSource | null;
  rollback: RollbackActions;
  restartStack: () => void;
}): JSX.Element {
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
          <BrushModeler />
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
        <HudSettings worlds={props.worlds} restartStack={props.restartStack} />
        </div>
      </div>

      {
}
      <CornerPanel />

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

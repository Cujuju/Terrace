import { createSignal } from 'solid-js';
import type { Component } from 'solid-js';

export type HudPanelPlacement =
  | 'panel'
  | 'top-center'
  | 'bottom-center'
  | 'bottom-right'
  | 'connection'
  | 'settings';

export interface PluginHudPanel {
  readonly pluginName: string;
  readonly component: Component;
  readonly placement: HudPanelPlacement;
  readonly headerSummary?: Component;
  readonly tabSummary?: () => string;
  readonly hasBody?: () => boolean;
}

const [pluginHudPanels, setPluginHudPanels] = createSignal<
  readonly PluginHudPanel[]
>([]);

export { pluginHudPanels };

export function addPluginHudPanel(panel: PluginHudPanel): void {
  setPluginHudPanels((panels) => [...panels, panel]);
}

export function clearPluginHudPanels(): void {
  setPluginHudPanels([]);
}

export function removePluginHudPanels(pluginName: string): void {
  setPluginHudPanels((panels) =>
    panels.some((panel) => panel.pluginName === pluginName)
      ? panels.filter((panel) => panel.pluginName !== pluginName)
      : panels,
  );
}

export interface PluginDrawRow {
  readonly pluginName: string;
  readonly objects: number;
  readonly budget: number;
  readonly breached: boolean;
}

const [pluginDrawRows, setPluginDrawRowsSignal] = createSignal<
  readonly PluginDrawRow[]
>([]);

export { pluginDrawRows };

export function setPluginDrawRows(rows: readonly PluginDrawRow[]): void {
  setPluginDrawRowsSignal(rows);
}

export function removePluginDrawRow(pluginName: string): void {
  setPluginDrawRowsSignal((rows) =>
    rows.some((row) => row.pluginName === pluginName)
      ? rows.filter((row) => row.pluginName !== pluginName)
      : rows,
  );
}

export interface WorldHeaderAction {
  readonly pluginName: string;
  readonly icon: Component;
  readonly label: string;
  readonly onClick: () => void;
}

const [worldHeaderAction, setWorldHeaderAction] =
  createSignal<WorldHeaderAction | null>(null);

export { worldHeaderAction };

export function claimWorldHeaderAction(action: WorldHeaderAction): void {
  const current = worldHeaderAction();
  if (current !== null) {
    console.warn(
      `world-header action already claimed by "${current.pluginName}"; ` +
        `ignoring the claim from "${action.pluginName}"`,
    );
    return;
  }
  setWorldHeaderAction(action);
}

export function clearWorldHeaderAction(): void {
  setWorldHeaderAction(null);
}

export function releaseWorldHeaderAction(pluginName: string): void {
  if (worldHeaderAction()?.pluginName === pluginName) setWorldHeaderAction(null);
}

export interface WorldClockReading {
  readonly phase: number;
  readonly time: string;
  readonly weekday: string | null;
  readonly day: number | null;
}

const [worldClock, setWorldClockSignal] = createSignal<WorldClockReading | null>(null, {
  equals: (a, b) =>
    a === b ||
    (a !== null &&
      b !== null &&
      a.phase === b.phase &&
      a.time === b.time &&
      a.weekday === b.weekday &&
      a.day === b.day),
});

export { worldClock };

export function setWorldClock(reading: WorldClockReading | null): void {
  setWorldClockSignal(reading);
}

// HUD panels registered by client plugins (design §3.5). Module-scope signal
// for the same reason as hudState.ts: the plugin host writes it from outside
// any reactive root, and the HUD reads it via the accessor at point of use.

import { createSignal } from 'solid-js';
import type { Component } from 'solid-js';

export interface PluginHudPanel {
  /** Owning plugin — used as the render key and shown as the panel title. */
  readonly pluginName: string;
  readonly component: Component;
}

const [pluginHudPanels, setPluginHudPanels] = createSignal<
  readonly PluginHudPanel[]
>([]);

export { pluginHudPanels };

export function addPluginHudPanel(panel: PluginHudPanel): void {
  setPluginHudPanels((panels) => [...panels, panel]);
}

/** Test seam / rejoin hygiene: drops every registered panel. */
export function clearPluginHudPanels(): void {
  setPluginHudPanels([]);
}

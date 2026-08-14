// HUD panels registered by client plugins (design §3.5). Module-scope signal
// for the same reason as hudState.ts: the plugin host writes it from outside
// any reactive root, and the HUD reads it via the accessor at point of use.

import { createSignal } from 'solid-js';
import type { Component } from 'solid-js';

/**
 * Where a plugin panel renders. 'panel' stacks inside the corner HUD panel;
 * 'top-center' floats centred along the top edge of the screen (identity and
 * status headed by the world header); 'bottom-center' mirrors it along the
 * bottom edge (persistent instruments kept out of the world's way, like the
 * mana gauge — owner move, 2026-08-14).
 */
export type HudPanelPlacement = 'panel' | 'top-center' | 'bottom-center';

export interface PluginHudPanel {
  /** Owning plugin — used as the render key and shown as the panel title. */
  readonly pluginName: string;
  readonly component: Component;
  readonly placement: HudPanelPlacement;
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

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
 * mana gauge — owner move, 2026-08-14); 'connection' renders inside the
 * bottom-right connection popup, under its status row and hint sentence
 * (owner move, 2026-08-21: the invite link lives there now).
 */
export type HudPanelPlacement =
  | 'panel'
  | 'top-center'
  | 'bottom-center'
  | 'connection';

export interface PluginHudPanel {
  /** Owning plugin — used as the render key and shown as the panel title. */
  readonly pluginName: string;
  readonly component: Component;
  readonly placement: HudPanelPlacement;
  /**
   * Optional one-row summary shown in the corner panel's header instead of
   * the panel's body — the line the panel is named by (relics' count row).
   */
  readonly headerSummary?: Component;
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

/**
 * The world-header action: ONE plugin may claim the top-centre world banner
 * as its entry point (owner move, 2026-08-19: the chronicle left its info-
 * panel row for the banner). Core renders the claimant's icon to the right of
 * the world name and turns the whole banner into a button; unclaimed, the
 * banner stays the inert title card it always was — so core still knows no
 * particular plugin (design §3.5), only the shape of an action.
 *
 * SINGLE CLAIMANT, FIRST REGISTRATION WINS — the precedence rule this client
 * already uses for canvas presses ("handlers run in plugin registration
 * order; the first claim wins"), and registration order is the host's plugin
 * load order, so the winner is deterministic per server configuration. A
 * second claim is a configuration mistake and is surfaced with a console
 * warning rather than silently stealing the banner.
 */
export interface WorldHeaderAction {
  /** Owning plugin — names the winner in the double-claim warning. */
  readonly pluginName: string;
  /** Small inline icon (SVG component) rendered right of the world name. */
  readonly icon: Component;
  /** Accessible label + tooltip for the whole banner button. */
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

/** Test seam / rejoin hygiene, mirroring clearPluginHudPanels. */
export function clearWorldHeaderAction(): void {
  setWorldHeaderAction(null);
}

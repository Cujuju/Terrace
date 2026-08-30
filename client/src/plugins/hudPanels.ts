// HUD panels registered by client plugins (design §3.5). Module-scope signal
// for the same reason as hudState.ts: the plugin host writes it from outside
// any reactive root, and the HUD reads it via the accessor at point of use.

import { createSignal } from 'solid-js';
import type { Component } from 'solid-js';

/**
 * Where a plugin panel renders. 'panel' stacks inside the corner HUD panel;
 * 'top-center' floats centred along the top edge of the screen (identity and
 * status headed by the world header); 'bottom-center' mirrors it along the
 * bottom edge (persistent instruments kept out of the world's way — the
 * toolbar's plugin tools render there too); 'bottom-right' sits in the
 * bottom-right strip cell, immediately left of the icon-button column (owner
 * move, 2026-08-25: the mana gauge left the centre for it); 'connection'
 * renders inside the bottom-right connection popup, under its status row and
 * hint sentence (owner move, 2026-08-21: the invite link lives there now).
 */
export type HudPanelPlacement =
  | 'panel'
  | 'top-center'
  | 'bottom-center'
  | 'bottom-right'
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
  /** Live label for the collapsed corner tab (`Relics (3)`); falls back to
   *  the capitalised plugin name. */
  readonly tabSummary?: () => string;
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
 * Drops the panels one plugin registered, leaving every other plugin's alone —
 * what unmounting a single plugin needs (the server stopped running its server
 * half, so its HUD must go with it). A no-op for a plugin that registered
 * none.
 */
export function removePluginHudPanels(pluginName: string): void {
  setPluginHudPanels((panels) =>
    panels.some((panel) => panel.pluginName === pluginName)
      ? panels.filter((panel) => panel.pluginName !== pluginName)
      : panels,
  );
}

/**
 * One plugin's draw-object row, published by the host's sampler twice a second
 * (plugins/host.ts) — see part B of
 * docs/plans/frame-budget-growth-and-draw-calls.md.
 *
 * HERE RATHER THAN IN hudState.ts for the same reason the panels are: it is
 * PER-PLUGIN state, keyed by plugin name, and it goes away when the plugin is
 * unmounted along with everything else that plugin registered.
 */
export interface PluginDrawRow {
  readonly pluginName: string;
  /** Renderable objects in the plugin's layer, before frustum culling. */
  readonly objects: number;
  /** What the plugin declared it may hold, from its own spawn caps. */
  readonly budget: number;
  /**
   * Whether this plugin is currently OVER budget. Sticky: set on the first
   * sample at or above the budget and cleared only after
   * DRAW_BUDGET_CLEAR_SAMPLES samples below the clear margin (host.ts).
   */
  readonly breached: boolean;
}

const [pluginDrawRows, setPluginDrawRowsSignal] = createSignal<
  readonly PluginDrawRow[]
>([]);

export { pluginDrawRows };

/** Replaces the whole set — the sampler publishes every mounted plugin at once. */
export function setPluginDrawRows(rows: readonly PluginDrawRow[]): void {
  setPluginDrawRowsSignal(rows);
}

/**
 * Drops one plugin's row on unmount, so the HUD does not show a budget for a
 * plugin that is no longer running for up to a whole sampling window.
 */
export function removePluginDrawRow(pluginName: string): void {
  setPluginDrawRowsSignal((rows) =>
    rows.some((row) => row.pluginName === pluginName)
      ? rows.filter((row) => row.pluginName !== pluginName)
      : rows,
  );
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

/**
 * Releases the banner if — and ONLY if — this plugin is the one holding it.
 * Unmounting a plugin that lost the claim must not evict the winner, and the
 * banner going back to an inert title card is the right result when the
 * claimant itself stops running.
 */
export function releaseWorldHeaderAction(pluginName: string): void {
  if (worldHeaderAction()?.pluginName === pluginName) setWorldHeaderAction(null);
}

/**
 * The world clock, as DISPLAY TEXT — e.g. `3:45 p.m.` or `15:45`, formatted
 * by the owning plugin in the viewer system's own 12/24-hour convention.
 *
 * Lives here (not in hudState.ts) because it is a PLUGIN → core write: the
 * day/night plugin owns the clock (its interpolator advances the phase every
 * frame) and this module is already the seam plugins write through. A string,
 * not a phase number, keeps that seam one-way and narrow — core renders text
 * it did not compute. Nullable because a server without the day/night plugin
 * has no world time at all; the header then shows just name and difficulty,
 * never an invented clock. Server-derived and therefore not persisted (see
 * hudState.ts's header).
 */
const [worldTimeText, setWorldTimeTextSignal] = createSignal<string | null>(null);

export { worldTimeText };

/** Written by the day/night plugin each frame; Solid dedupes equal strings. */
export function setWorldTimeText(text: string | null): void {
  setWorldTimeTextSignal(text);
}

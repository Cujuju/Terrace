// THE TOOLBAR — what the player's hand is holding, and the tools plugins add
// to it (owner, 2026-08-24: "turn the bottom mana panel into a full-blown
// toolbar").
//
// A plugin→core seam, exactly like ./hudPanels.ts beside it and for the same
// reasons: module-scope signals, written by the plugin host from outside any
// reactive root, read by the HUD through the accessor at point of use.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY CORE OWNS THE SELECTION AND NOT THE PLUGINS.
//
// Sculpting and a plugin's tool are MUTUALLY EXCLUSIVE uses of the same
// pointer: a press that places a temple must not also stamp the ground under
// it. A plugin CAN already take a press away from the brush by claiming it
// (ClientPluginCtx.onCanvasPress), so exclusivity between a tool and the brush
// needs nothing new — but exclusivity between TWO plugin tools does, and so
// does the question every other part of the HUD wants to ask ("is the brush
// live right now?", which the outline preview in main.tsx reads). Both are
// facts about the whole client, not about any one plugin, so both live here.
//
// The selection is therefore ONE value in core (`activeToolId`), and a plugin
// learns it only through the callback it registered. That is deliberate: a
// plugin that kept its own `selected` boolean beside this one would be a
// second source of truth for the same fact, and two of them could disagree —
// the same drift argument mana's state.ts makes about the brush.
//
// NOT PERSISTED, unlike the brush settings in state/hudState.ts. A tool is a
// mode that takes the pointer away from sculpting; finding the world in it
// after a reload, with no memory of having chosen it, is a trap. The brush is
// what a session starts holding, always.
// ─────────────────────────────────────────────────────────────────────────────

import { createSignal } from 'solid-js';
import type { Component } from 'solid-js';

/**
 * One tool on the bar. `id` is host-namespaced (`<plugin>:<id>`) exactly like
 * a plugin's wire messages are, so two plugins may both ship a tool called
 * `place` without colliding.
 */
export interface PluginTool {
  readonly id: string;
  /** Owning plugin — names the loser in the duplicate-id warning. */
  readonly pluginName: string;
  /** Short caption under/next to the icon (hidden at phone widths). */
  readonly label: string;
  /** One sentence: what a press with this tool held will do. */
  readonly title: string;
  /** Small inline stroke SVG, so it takes the HUD's colour like every other. */
  readonly icon: Component;
  /**
   * Told on every change of selection — true when this tool becomes the held
   * one, false when it stops being it. The plugin's only view of the
   * selection; see this file's header for why it gets no accessor.
   */
  readonly onSelected: (selected: boolean) => void;
}

/**
 * The id of the built-in brush. `null`, not a string: sculpting is not a
 * registered tool but the ABSENCE of one — core sculpts unless something has
 * taken the pointer — and a sentinel string would invite a plugin to register
 * against it.
 */
export const SCULPT_TOOL_ID = null;

const [pluginTools, setPluginTools] = createSignal<readonly PluginTool[]>([]);

export { pluginTools };

/** The held tool's id, or SCULPT_TOOL_ID (null) while the brush is live. */
const [activeToolId, setActiveToolIdSignal] = createSignal<string | null>(
  SCULPT_TOOL_ID,
);

export { activeToolId };

export function addPluginTool(tool: PluginTool): void {
  const clash = pluginTools().find((existing) => existing.id === tool.id);
  if (clash !== undefined) {
    console.warn(
      `tool id "${tool.id}" already registered by "${clash.pluginName}"; ` +
        `ignoring the registration from "${tool.pluginName}"`,
    );
    return;
  }
  setPluginTools((tools) => [...tools, tool]);
}

/**
 * A tool's own callback must never be able to break the selection: it runs
 * inside `selectTool`, which the HUD calls from a click handler, and a throw
 * there would leave core's state changed and the player's click half-applied.
 */
function tellSelected(tool: PluginTool, selected: boolean): void {
  try {
    tool.onSelected(selected);
  } catch (error) {
    console.error(
      `[terrace] tool "${tool.id}" threw in onSelected(${selected})`,
      error,
    );
  }
}

/**
 * Selects a tool by id, or SCULPT_TOOL_ID to go back to the brush.
 *
 * The OUTGOING tool is told first and the incoming one second, so a tool that
 * puts something on screen while held (a placement ghost) has always torn its
 * own down before the next one builds — with the reverse order two ghosts
 * would coexist for the length of one call.
 */
export function selectTool(id: string | null): void {
  const previous = activeToolId();
  if (previous === id) return;
  setActiveToolIdSignal(id);

  const tools = pluginTools();
  const outgoing = tools.find((tool) => tool.id === previous);
  if (outgoing !== undefined) tellSelected(outgoing, false);
  const incoming = tools.find((tool) => tool.id === id);
  if (incoming !== undefined) tellSelected(incoming, true);
}

/** Test seam / rejoin hygiene, mirroring clearPluginHudPanels. */
export function clearPluginTools(): void {
  // Back to the brush FIRST, so a tool holding a ghost is told to drop it
  // before it is forgotten about — dropping the list alone would leave that
  // ghost in the scene with nothing left that knows to remove it.
  selectTool(SCULPT_TOOL_ID);
  setPluginTools([]);
}

/**
 * Drops the tools one plugin registered, leaving every other plugin's alone —
 * what unmounting a single plugin needs.
 *
 * Deselects FIRST when the held tool is one of this plugin's, for the reason
 * clearPluginTools states: a tool holding a placement ghost has to be told to
 * drop it while it still exists to be told.
 */
export function removePluginTools(pluginName: string): void {
  const owned = pluginTools().filter((tool) => tool.pluginName === pluginName);
  if (owned.length === 0) return;
  if (owned.some((tool) => tool.id === activeToolId())) selectTool(SCULPT_TOOL_ID);
  setPluginTools((tools) => tools.filter((tool) => tool.pluginName !== pluginName));
}

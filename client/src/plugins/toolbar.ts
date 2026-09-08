import { createSignal } from 'solid-js';
import type { Component } from 'solid-js';

export interface PluginTool {
  readonly id: string;
  readonly pluginName: string;
  readonly label: string;
  readonly title: string;
  readonly icon: Component;
  readonly onSelected: (selected: boolean) => void;
}

export const SCULPT_TOOL_ID = null;

const [pluginTools, setPluginTools] = createSignal<readonly PluginTool[]>([]);

export { pluginTools };

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

export function clearPluginTools(): void {
  selectTool(SCULPT_TOOL_ID);
  setPluginTools([]);
}

export function removePluginTools(pluginName: string): void {
  const owned = pluginTools().filter((tool) => tool.pluginName === pluginName);
  if (owned.length === 0) return;
  if (owned.some((tool) => tool.id === activeToolId())) selectTool(SCULPT_TOOL_ID);
  setPluginTools((tools) => tools.filter((tool) => tool.pluginName !== pluginName));
}

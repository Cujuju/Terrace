import type { LoadedPlugin } from './types.ts';

export class InstalledPlugins {
  private entries: readonly LoadedPlugin[];

  constructor(entries: readonly LoadedPlugin[]) {
    this.entries = entries;
  }

  get list(): readonly LoadedPlugin[] {
    return this.entries;
  }

  find(name: string): LoadedPlugin | undefined {
    return this.entries.find((entry) => entry.plugin.name === name);
  }

  replace(replacement: LoadedPlugin): LoadedPlugin {
    const name = replacement.plugin.name;
    const at = this.entries.findIndex((entry) => entry.plugin.name === name);
    if (at < 0) throw new Error(`cannot replace plugin "${name}": it is not installed`);
    const previous = this.entries[at];
    const next = [...this.entries];
    next[at] = replacement;
    this.entries = next;
    return previous;
  }
}

// THE INSTALLED PLUGIN SET — every plugin this process has loaded, and the one
// place a single one of them can be swapped for a newer build (issue #198).
//
// WHY IT IS AN OBJECT AND NOT AN ARRAY. Until an in-process reload existed, the
// discovered list was a `readonly LoadedPlugin[]` handed to the WorldManager at
// boot and never touched again — which is exactly why a reload could not exist:
// every session, every host and every build-identity digest read a snapshot of
// that array taken when it was passed. One holder, asked each time, is what lets
// the NEXT session be built over a different module without anybody who kept a
// reference to "the plugins" quietly running the old one.
//
// LOAD ORDER IS PRESERVED THROUGH A REPLACE, unconditionally: it is intent-
// interceptor order and tick order (see host.ts rule 1), so a replaced plugin
// takes the slot it already had rather than being appended to the end.

import type { LoadedPlugin } from './types.ts';

export class InstalledPlugins {
  private entries: readonly LoadedPlugin[];

  constructor(entries: readonly LoadedPlugin[]) {
    this.entries = entries;
  }

  /** Every installed plugin, in load order. */
  get list(): readonly LoadedPlugin[] {
    return this.entries;
  }

  /** The installed plugin of that name, or undefined. */
  find(name: string): LoadedPlugin | undefined {
    return this.entries.find((entry) => entry.plugin.name === name);
  }

  /**
   * Puts `replacement` in the slot currently held by the plugin of the same
   * name, and returns the entry it displaced.
   *
   * Throws when no plugin of that name is installed: a reload of something
   * nobody installed is a caller bug (the admin path refuses it as
   * 'unknownPlugin' long before here), and appending it would silently change
   * load order for every plugin behind it.
   */
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

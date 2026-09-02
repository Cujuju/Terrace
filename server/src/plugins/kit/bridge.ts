// THE CROSS-PLUGIN DEPENDENCY PATTERN, as a mechanism.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM. `plugins/` is auto-discovered from the filesystem and a
// self-hoster is invited to delete folders they do not want — and, since
// per-world enablement, to switch one off for a world without deleting anything.
// So another plugin is not a dependency in the package-manager sense: it is a
// plugin that is PROBABLY there, and that may not be RUNNING here even when it
// is. A static `import { … } from '../../mana/…'` would turn "I deleted the mana
// folder" into "the server no longer boots", because the failure lands in module
// resolution, before any of our code runs and before the host's per-callback
// try/catch can contain it.
//
// THE PATTERN, in four rules. The first two became GUARANTEES OF THE HOST
// (issue #196); the second two are still the caller's:
//
//   1. ASK THE HOST BY NAME, never the filesystem by path.
//      `WorldApi.sibling('mana')` answers with the module of the plugin RUNNING
//      as mana in this session, or null — a deleted folder, and one the operator
//      disabled for this world, are the same null. A dynamic import could not
//      express the second: its specifier binds to a module URL, so a disabled
//      sibling went on answering.
//   2. IT IS SYNCHRONOUS. Every plugin's module is imported before any host
//      exists, so the lookup can be made in onWorldCreate and needs no awaiting,
//      whatever the sibling's place in load order.
//   3. BUFFER, DO NOT DROP. Everything the optional plugin would have been told
//      is recorded by the CALLER as desired state and replayed once (and if) it
//      arrives — core has no idea what a consumer wanted to say. `onResolved`
//      below is where a bridge hangs that replay.
//   4. DUCK-TYPE THE MODULE. A folder can exist and export the wrong thing — an
//      older sibling without the API, someone's fork. Resolving a sibling is not
//      evidence the API is there; check for the functions.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT MOVED HERE AND WHAT DELIBERATELY DID NOT.
//
// Nineteen `plugins/*/server/*-bridge.ts` files each carried the same skeleton:
// a plugin-name constant, an unavailable-warning constant, a `warned` flag, the
// resolved-API variable, a `warnOnce`, a `load` that re-resolves and a `reset`
// test seam. That is a MECHANISM, and one mechanism written nineteen times is
// one mechanism.
//
// WHAT STAYS A DOCUMENTED COPY IN EACH BRIDGE: the narrow duck-typed interface,
// the `asXApi` predicate that checks it, the warning text, and the accessor
// functions the plugin calls. That interface is the CONTRACT between two
// independently-deletable folders — the thing that must survive one side being
// absent or older — and a contract is exactly what the isolation rule says may
// not be centralised. This file never learns a plugin's name.
//
// This module is core, not a plugin: it has no name, cannot be disabled, and a
// plugin reload does not re-import it (the reload's resolve hook only re-stamps
// URLs inside the reloading plugin's own directory), so importing it is the same
// kind of dependency as importing the WorldApi types beside it.

import type { SiblingModule, WorldApi } from '../types.ts';

/** How a bridge is built. See the header for what each rule buys. */
export interface SiblingBridgeSpec<T> {
  /**
   * The name the host knows the sibling by — the key `WorldApi.sibling` answers
   * to. A NAME, NOT A PATH (issue #196), which is also what made the npm-plugin
   * step possible: where a sibling's code lives stopped being a bridge's
   * business.
   */
  readonly pluginName: string;
  /**
   * Narrows the sibling's module namespace to the API this consumer needs, or
   * null if it does not fit. Rule 4 — each bridge's own, because core cannot
   * know which members a consumer needs.
   */
  duckType(module: SiblingModule | null): T | null;
  /** Logged once, the first time the sibling cannot be reached. */
  readonly unavailableWarning: string;
  /**
   * Called with the API every time one resolves — rule 3's hook. A bridge that
   * buffers desired state replays it here; a bridge that only READS has nothing
   * to replay and omits this.
   */
  onResolved?(api: T): void;
}

/** A resolved-or-not sibling, and the three things a plugin does with one. */
export interface SiblingBridge<T> {
  /**
   * Resolves the sibling through the host. Call from `onWorldCreate`.
   *
   * RE-RESOLVED ON EVERY CALL, deliberately: onWorldCreate replays on a reopen
   * and on a rollback, so a sibling the operator has just enabled is picked up
   * then — and one that STOPPED running is cleared rather than left reachable
   * through a stale reference. The warning still happens at most once.
   */
  load(world: WorldApi): void;
  /** The API right now, or null when no usable sibling is running here. */
  api(): T | null;
  /**
   * Drops the resolved sibling WITHOUT forgetting the warning — what a bridge
   * does when its world closes.
   *
   * A module-scope view must not outlive the world it was resolved for (the
   * 2026-08-25 revocation rule). The warning is the other way round: it is a
   * property of the process — "this deployment has no fire plugin" — so
   * re-warning on every reopen would be a log flood saying the same thing.
   */
  clear(): void;
  /**
   * Emits the unavailable warning, at most once, without resolving anything.
   *
   * For the accessor that has to say something on the degraded path itself
   * rather than only at load — fire's mana bridge, whose charge is an answer to
   * a question being asked right now.
   */
  warnUnavailable(): void;
  /** Test seam: forgets the resolved sibling and the warning. */
  reset(): void;
}

export function createSiblingBridge<T>(spec: SiblingBridgeSpec<T>): SiblingBridge<T> {
  let resolved: T | null = null;
  let warned = false;

  function warnUnavailable(): void {
    if (warned) return;
    warned = true;
    // console rather than the server's logger: plugins do not import server
    // internals at runtime, and a bridge that reached into server/src/log.ts
    // would be a runtime coupling to core that the plugin API is meant to make
    // unnecessary.
    console.warn(spec.unavailableWarning);
  }

  return {
    load(world: WorldApi): void {
      const api = spec.duckType(world.sibling(spec.pluginName));
      if (api === null) {
        // The folder may be there and export the wrong thing — an older
        // sibling, or a fork. Same degraded path as no folder at all. CLEARED,
        // not left standing: see `load` above.
        resolved = null;
        warnUnavailable();
        return;
      }
      resolved = api;
      spec.onResolved?.(api);
    },
    api(): T | null {
      return resolved;
    },
    clear(): void {
      resolved = null;
    },
    warnUnavailable,
    reset(): void {
      resolved = null;
      warned = false;
    },
  };
}

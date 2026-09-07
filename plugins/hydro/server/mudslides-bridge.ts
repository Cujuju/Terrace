// hydro → mudslides, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (server/src/plugins/kit/bridge.ts — read its header; this file follows its
// four rules).
//
// RULE 3 ("buffer, don't drop") DOES NOT APPLY, for the reason fire's mana
// bridge states about its debit: a slide request is not desired state, it is an
// answer to a question being asked right now — "this hillside has taken as much
// water as it is going to; does it go?". Replaying it later would collapse a
// hillside a minute after the water that soaked it had dried.
//
// ─────────────────────────────────────────────────────────────────────────────
// HYDRO MOVES NO TERRAIN. This is the whole of its relationship with the
// ground, and it is a REQUEST rather than an edit: mudslides owns the sculpt,
// mudslides' `sculptGuarded` is the single call site, and the reveal guard, the
// relaxation and the banded spill all apply exactly as they do to a player's
// stroke (plugins/mudslides/server/slides.ts's header). Nothing in this plugin
// ever calls `WorldApi.sculpt`.
//
// WHOSE OPINION "STEEP" IS. Not this plugin's. mudslides refuses on ground
// its own `slopeAt` will not have — the rim test (MUDSLIDE_RIM_DROP) and the
// span test (MUDSLIDE_TRIGGER_DROP), both fractions of the steepest gradient
// the terrain sim can hold — and hydro deliberately keeps no steepness constant
// of its own to disagree with them. A pour on a gentle field simply gets a null
// back and is water and nothing more.
//
// ONE MEMBER, AND EVERY GUARD BEHIND IT. `startDirectedSlide` is mudslides'
// own sibling-facing entry point and it answers for all of its preconditions —
// the frequency setting (a world with mudslides `off` never advances a slide,
// so one started there would sit frozen forever, holding a MAX_ACTIVE_SLIDES
// slot and persisting across restarts), the ceiling itself, and the ground.
// This bridge deliberately duck-types NOTHING ELSE: every member named here is
// another way a version mismatch can degrade, and a guard restated on this side
// of the seam is a guard that can drift from the sim it is guarding.
//
// DEGRADED BEHAVIOUR when mudslides is absent, disabled here, or too old to
// export the entry point: poured water still douses, still darkens the ground
// and still dries out; nothing collapses. One warning is logged, once. A
// self-hoster who removed the mudslides folder removed landslides, not water.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/**
 * The slice of mudslides this plugin uses: the directed slide, and the two
 * members that make its ceiling askable.
 *
 * ONE MEMBER — see the header. It is typed to take `WorldApi` because that is
 * what this plugin holds; mudslides declares it against its own narrow
 * `MudslideWorld`, which WorldApi satisfies structurally
 * (plugins/mudslides/server/terrain.ts — "there is no adapter and no cast").
 * It answers a bare boolean, which is the only thing this plugin may know about
 * a slide: whether it happened.
 */
export interface MudslidesApi {
  startDirectedSlide(world: WorldApi, x: number, y: number): boolean;
}

/**
 * The name the host knows mudslides by — the key `WorldApi.sibling` answers to.
 * A NAME, NOT A PATH (issue #196), so a mudslides plugin that is absent OR
 * disabled for this world resolves to null.
 */
const MUDSLIDES_PLUGIN_NAME = 'mudslides';

export const MUDSLIDES_UNAVAILABLE_WARNING =
  '[hydro] mudslides plugin not available — poured water will not bring a hillside down';

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asMudslidesApi(module: SiblingModule | null): MudslidesApi | null {
  if (module === null) return null;
  if (typeof module.startDirectedSlide !== 'function') return null;
  return module as unknown as MudslidesApi;
}

const bridge = createSiblingBridge<MudslidesApi>({
  pluginName: MUDSLIDES_PLUGIN_NAME,
  duckType: asMudslidesApi,
  unavailableWarning: MUDSLIDES_UNAVAILABLE_WARNING,
});

/**
 * Resolves mudslides through the host, from onWorldCreate.
 *
 * Re-resolved on every call, so a mudslides the operator has just enabled is
 * picked up on the reopen; the bridge's warn-once keeps an absent one to a
 * single line.
 */
export function loadMudslidesBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * Asks mudslides to collapse this cell. True only when a slide actually
 * started.
 *
 * FALSE IS THE ORDINARY ANSWER and covers every unremarkable case the caller
 * must not have to tell apart: there is no mudslides plugin here, mudslides are
 * off for this world, the ground is not a rim, there is nowhere downhill for the
 * mud to go, and the world is already running as many slides as it is allowed
 * to. All of them mean "the water soaked in and the hillside held", which is the
 * commonest outcome of pouring a bucket on a hill and needs no explanation to
 * anybody.
 */
export function requestSlide(world: WorldApi, x: number, y: number): boolean {
  const api = bridge.api();
  if (api === null) {
    bridge.warnUnavailable();
    return false;
  }
  return api.startDirectedSlide(world, x, y);
}

/**
 * Forgets the resolved sibling — what this bridge does when its world closes. A
 * module-scope view must not outlive the world it was resolved for (the
 * 2026-08-25 revocation rule).
 */
export function clearMudslidesBridge(): void {
  bridge.clear();
}

/** Test seam: forgets the resolved sibling and the warning. */
export function resetMudslidesBridge(): void {
  bridge.reset();
}

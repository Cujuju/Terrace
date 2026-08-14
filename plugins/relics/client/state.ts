// Reactive state shared between this plugin's imperative half (client/index.ts,
// which owns the Three.js layer and the pointer handler) and its Solid half
// (RelicsPanel.tsx).
//
// SOLID REACTIVITY — the rule this file exists to make followable, copied from
// client/src/state/hudState.ts and client/src/plugins/hudPanels.ts: the signals
// live at MODULE scope, not inside a component, because the writers are outside
// any reactive root — a message handler, a pointer handler, a frame callback.
// Consumers must read them by CALLING the accessor at the point of use. A
// component body runs exactly once, so `const held = skills()` in a component
// freezes the list forever; `{skills().length}` in JSX, or `skills()` inside an
// event handler, does not.

import { createSignal } from 'solid-js';
import type { RelicView, SkillId, SkillView } from '../protocol.ts';

/** Every relic currently in the world, as last told by the server. */
const [relics, setRelics] = createSignal<readonly RelicView[]>([]);

/** This player's own skills, in roster order, with live cooldowns. */
const [skills, setSkills] = createSignal<readonly SkillView[]>([]);

/**
 * The active skill waiting for a target click, or null.
 *
 * Arming is client-only state on purpose: the server has no notion of "aiming",
 * only of a cast that arrived. Keeping it here means an armed player who
 * changes their mind, or disconnects, has nothing to unwind server-side.
 */
const [armedSkill, setArmedSkill] = createSignal<SkillId | null>(null);

/** The reason the last cast was refused, or null. Cleared on the next arm. */
const [castDenial, setCastDenial] = createSignal<string | null>(null);

export {
  relics,
  setRelics,
  skills,
  setSkills,
  armedSkill,
  castDenial,
  setCastDenial,
};

/** Arms (or disarms) targeting, clearing any stale refusal message with it. */
export function armSkill(skill: SkillId | null): void {
  setArmedSkill(skill);
  setCastDenial(null);
}

/** Test seam / rejoin hygiene: drops every piece of plugin UI state. */
export function resetRelicsClientState(): void {
  setRelics([]);
  setSkills([]);
  setArmedSkill(null);
  setCastDenial(null);
}

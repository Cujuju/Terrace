// HOW MUCH OF A BOUNDARY TREATMENT THIS PLAYER SEES at the edge of the
// received-chunk set (render/frontierFog.ts).
//
// A per-player look, like state/voidPrefs.ts and for the same reasons: two
// people in the same world may choose differently, neither sees the other's,
// and it never touches the server or the protocol. render/frontierFog.ts owns
// what each value draws; this module owns only which one is chosen and that
// the choice survives a reload.

import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';
import type { FrontierMistMode } from '../render/frontierFog.ts';

export type { FrontierMistMode };

/**
 * Every value the pref accepts, in the order the panel lists them. Exported
 * so ui/ControlsPanel.tsx renders its options from the same list the setter
 * validates against.
 */
export const FRONTIER_MIST_MODES: readonly FrontierMistMode[] = ['off', 'line', 'waterline'];

/**
 * Owner's choice, 2026-09-06: the red boundary line (render/frontierLine.ts).
 *
 * SUPERSEDES 'off', which was the owner's call on 2026-09-05 against the only
 * treatment there was then — a water-coloured bank that from a low camera read
 * as a wall across the horizon rather than as an edge. Turning it off left the
 * boundary drawn by nothing at all, which is what made a sculpt at the
 * frontier unaimable; the line marks the same edge without veiling anything.
 * 'waterline' is still here for the player who wants the sea's cut edge hidden.
 */
export const DEFAULT_FRONTIER_MIST_MODE: FrontierMistMode = 'line';

/**
 * v2 because the DEFAULT changed, not the values: a player carrying the stored
 * 'off' from the mist-only pref would otherwise keep an unmarked boundary
 * forever and never see the line they were given. Both old values are still
 * legal, so anyone who re-picks one keeps it.
 */
const FRONTIER_MIST_STORAGE_KEY = 'terrace.frontierMist.v2';

const [frontierMistMode, setFrontierMistModeSignal] = persistedChoice<FrontierMistMode>(
  FRONTIER_MIST_STORAGE_KEY,
  FRONTIER_MIST_MODES,
  DEFAULT_FRONTIER_MIST_MODE,
);

export { frontierMistMode };

export const setFrontierMistMode = setFrontierMistModeSignal;

/**
 * Puts the pref back to its default and forgets the stored value. Called by
 * state/controlPrefs.ts's `resetBindings`, which the Controls panel's reset
 * button promises resets EVERY setting on that panel — this pref is on it.
 */
export function resetFrontierMistPrefs(): void {
  setFrontierMistModeSignal(DEFAULT_FRONTIER_MIST_MODE);
  clearPersistedChoice(FRONTIER_MIST_STORAGE_KEY);
}

// WHICH CELESTIAL VOID THIS PLAYER SEES (issue #326).
//
// A per-player look, not a world setting: two people in the same world may
// choose differently and neither sees the other's, so it never touches the
// server or the protocol. render/celestialVoid.ts owns what each value draws;
// this module owns only which one is chosen and that the choice survives a
// reload.

import {
  clearPersistedChoice,
  persistedChoice,
} from './persistedChoice.ts';
import type { VoidStyle } from '../render/celestialVoid.ts';

export type { VoidStyle };

/**
 * Every value the pref accepts, in the order the panel lists them. Exported
 * so ui/ControlsPanel.tsx renders its options from the same list the setter
 * validates against — one place to add a third look.
 */
export const VOID_STYLES: readonly VoidStyle[] = ['wheel', 'nebula'];

/** Owner's choice, 2026-09-04: the star wheel is what a new player sees. */
export const DEFAULT_VOID_STYLE: VoidStyle = 'wheel';

const VOID_STORAGE_KEY = 'terrace.celestialVoid.v1';

const [voidStyle, setVoidStyleSignal] = persistedChoice<VoidStyle>(
  VOID_STORAGE_KEY,
  VOID_STYLES,
  DEFAULT_VOID_STYLE,
);

export { voidStyle };

export const setVoidStyle = setVoidStyleSignal;

/**
 * Puts the look back to the default and forgets the stored value. Called by
 * state/controlPrefs.ts's `resetBindings`, which the Controls panel's reset
 * button promises resets EVERY setting on that panel — this pref is on it.
 */
export function resetVoidStyle(): void {
  setVoidStyleSignal(DEFAULT_VOID_STYLE);
  clearPersistedChoice(VOID_STORAGE_KEY);
}

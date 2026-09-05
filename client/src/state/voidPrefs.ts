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
import type { VoidAnchor, VoidStyle } from '../render/celestialVoid.ts';

export type { VoidAnchor, VoidStyle };

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
 * What the void is fixed to (owner, 2026-09-04: "the option in settings to
 * lock it"). 'view' is the approved reference look; 'world' locks the disk to
 * the plane of the map at a fixed world position — render/celestialVoid.ts's
 * header says exactly where. Listed in the panel's order.
 */
export const VOID_ANCHORS: readonly VoidAnchor[] = ['view', 'world'];

/** Default: what the owner approved on the concept page, fixed to the view. */
export const DEFAULT_VOID_ANCHOR: VoidAnchor = 'view';

const VOID_ANCHOR_STORAGE_KEY = 'terrace.celestialVoidAnchor.v1';

const [voidAnchor, setVoidAnchorSignal] = persistedChoice<VoidAnchor>(
  VOID_ANCHOR_STORAGE_KEY,
  VOID_ANCHORS,
  DEFAULT_VOID_ANCHOR,
);

export { voidAnchor };

export const setVoidAnchor = setVoidAnchorSignal;

/**
 * Puts both prefs back to their defaults and forgets the stored values.
 * Called by state/controlPrefs.ts's `resetBindings`, which the Controls
 * panel's reset button promises resets EVERY setting on that panel — these
 * prefs are on it.
 */
export function resetVoidPrefs(): void {
  setVoidStyleSignal(DEFAULT_VOID_STYLE);
  clearPersistedChoice(VOID_STORAGE_KEY);
  setVoidAnchorSignal(DEFAULT_VOID_ANCHOR);
  clearPersistedChoice(VOID_ANCHOR_STORAGE_KEY);
}

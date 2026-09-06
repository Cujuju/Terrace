// WHETHER THIS PLAYER SEES THE TERRACE-LIP OVERLAY (render/layerEdgeOverlay.ts).
//
// A per-player look, like state/voidPrefs.ts and state/frontierMistPrefs.ts:
// two people in the same world may choose differently, neither sees the
// other's, and it never touches the server or the protocol.
//
// WHY 'normal' IS AN ABSENCE. The overlay has drawn cyan since the commit that
// introduced it (f953828); there is no earlier tinted version of it to
// restore. "What we had before we changed it to cyan" (owner, 2026-09-05) is
// therefore the terrain WITHOUT the overlay — the terrace lips as the mesh
// itself shades them, which is what 'normal' gives.
//
// 'crease' IS THE THIRD ONE, ADDED ON THE OWNER'S ASK (2026-09-05): the same
// edges the debug picture draws, but as a shadow in the terrain rather than a
// marking over it. render/layerEdgeOverlay.ts owns what that means; the
// choice between the three is all this module holds.
//
// THE HOVER LIP IS NOT PART OF THIS. The warm-white lip under the cursor is
// the grab affordance — it says which layer a drag would take — so it is
// drawn in every mode (owner, 2026-09-05). Only the resting set is a picture
// of what the map knows.

import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';
import type { LayerEdgeStyle } from '../render/layerEdgeOverlay.ts';

export type { LayerEdgeStyle };

/**
 * Every value the pref accepts, in the order the panel lists them. Exported
 * so ui/ControlsPanel.tsx renders its options from the same list the setter
 * validates against.
 */
export const LAYER_EDGE_STYLES: readonly LayerEdgeStyle[] = ['normal', 'crease', 'debug'];

/** Owner's choice, 2026-09-05: the plain terrain is what a player sees. */
export const DEFAULT_LAYER_EDGE_STYLE: LayerEdgeStyle = 'normal';

const LAYER_EDGE_STORAGE_KEY = 'terrace.layerEdges.v1';

const [layerEdgeStyle, setLayerEdgeStyleSignal] = persistedChoice<LayerEdgeStyle>(
  LAYER_EDGE_STORAGE_KEY,
  LAYER_EDGE_STYLES,
  DEFAULT_LAYER_EDGE_STYLE,
);

export { layerEdgeStyle };

export const setLayerEdgeStyle = setLayerEdgeStyleSignal;

/**
 * Puts the pref back to its default and forgets the stored value. Called by
 * state/controlPrefs.ts's `resetBindings`, which the Controls panel's reset
 * button promises resets EVERY setting on that panel — this pref is on it.
 */
export function resetLayerEdgePrefs(): void {
  setLayerEdgeStyleSignal(DEFAULT_LAYER_EDGE_STYLE);
  clearPersistedChoice(LAYER_EDGE_STORAGE_KEY);
}

import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';
import type { LayerEdgeStyle } from '../render/layerEdgeOverlay.ts';

export type { LayerEdgeStyle };

export const LAYER_EDGE_STYLES: readonly LayerEdgeStyle[] = ['normal', 'crease', 'debug'];

export const DEFAULT_LAYER_EDGE_STYLE: LayerEdgeStyle = 'crease';

const LAYER_EDGE_STORAGE_KEY = 'terrace.layerEdges.v1';

const [layerEdgeStyle, setLayerEdgeStyleSignal] = persistedChoice<LayerEdgeStyle>(
  LAYER_EDGE_STORAGE_KEY,
  LAYER_EDGE_STYLES,
  DEFAULT_LAYER_EDGE_STYLE,
);

export { layerEdgeStyle };

export const setLayerEdgeStyle = setLayerEdgeStyleSignal;

export function resetLayerEdgePrefs(): void {
  setLayerEdgeStyleSignal(DEFAULT_LAYER_EDGE_STYLE);
  clearPersistedChoice(LAYER_EDGE_STORAGE_KEY);
}

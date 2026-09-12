import { createSignal } from 'solid-js';
import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';
import { DEFAULT_CREASE_LOOK, type CreaseLook, type LayerEdgeStyle } from '../render/layerEdgeOverlay.ts';

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

const CREASE_COLOR_STORAGE_KEY = 'terrace.creaseColor.v1';

const CREASE_OPACITY_STORAGE_KEY = 'terrace.creaseOpacity.v1';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const MIN_CREASE_OPACITY = 0;

export const MAX_CREASE_OPACITY = 1;

export const CREASE_OPACITY_STEP = 0.05;

const HEX_RADIX = 16;

const HEX_DIGITS = 6;

export function creaseColorHex(color: number): string {
  return `#${color.toString(HEX_RADIX).padStart(HEX_DIGITS, '0')}`;
}

function loadCreaseColor(): number {
  try {
    const raw = localStorage.getItem(CREASE_COLOR_STORAGE_KEY);
    return raw !== null && HEX_COLOR.test(raw)
      ? parseInt(raw.slice(1), HEX_RADIX)
      : DEFAULT_CREASE_LOOK.color;
  } catch {
    return DEFAULT_CREASE_LOOK.color;
  }
}

function loadCreaseOpacity(): number {
  try {
    const raw = localStorage.getItem(CREASE_OPACITY_STORAGE_KEY);
    const opacity = raw === null ? NaN : Number(raw);
    return opacity >= MIN_CREASE_OPACITY && opacity <= MAX_CREASE_OPACITY
      ? opacity
      : DEFAULT_CREASE_LOOK.opacity;
  } catch {
    return DEFAULT_CREASE_LOOK.opacity;
  }
}

const [creaseLook, setCreaseLookSignal] = createSignal<CreaseLook>({
  color: loadCreaseColor(),
  opacity: loadCreaseOpacity(),
});

export { creaseLook };

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
  }
}

/** `hex` is `#rrggbb`, as a colour input yields it; anything else is ignored. */
export function setCreaseColor(hex: string): void {
  if (!HEX_COLOR.test(hex)) return;
  setCreaseLookSignal((look) => ({ ...look, color: parseInt(hex.slice(1), HEX_RADIX) }));
  persist(CREASE_COLOR_STORAGE_KEY, hex.toLowerCase());
}

export function setCreaseOpacity(opacity: number): void {
  if (!(opacity >= MIN_CREASE_OPACITY && opacity <= MAX_CREASE_OPACITY)) return;
  setCreaseLookSignal((look) => ({ ...look, opacity }));
  persist(CREASE_OPACITY_STORAGE_KEY, String(opacity));
}

export function resetLayerEdgePrefs(): void {
  setLayerEdgeStyleSignal(DEFAULT_LAYER_EDGE_STYLE);
  clearPersistedChoice(LAYER_EDGE_STORAGE_KEY);
  setCreaseLookSignal(DEFAULT_CREASE_LOOK);
  clearPersistedChoice(CREASE_COLOR_STORAGE_KEY);
  clearPersistedChoice(CREASE_OPACITY_STORAGE_KEY);
}

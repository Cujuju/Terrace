import { createSignal } from 'solid-js';
import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';
import { DEFAULT_CREASE_LOOK, DEFAULT_CELL_LOOK, type CellLook, type CreaseLook, type LayerEdgeStyle } from '../render/layerEdgeOverlay.ts';

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

const LIP_HIGHLIGHT_STORAGE_KEY = 'terrace.lipHighlight.v1';

const LIP_HIGHLIGHT_CHOICES = ['on', 'off'] as const;

const [lipHighlightChoice, setLipHighlightChoice] = persistedChoice<'on' | 'off'>(
  LIP_HIGHLIGHT_STORAGE_KEY,
  LIP_HIGHLIGHT_CHOICES,
  'on',
);

export const lipHighlight = (): boolean => lipHighlightChoice() === 'on';

export const setLipHighlight = (visible: boolean): void => {
  setLipHighlightChoice(visible ? 'on' : 'off');
};

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

const CELL_LINES_STORAGE_KEY = 'terrace.cellLines.v1';

const CELL_LINES_CHOICES = ['on', 'off'] as const;

const [cellLinesChoice, setCellLinesChoice] = persistedChoice<'on' | 'off'>(
  CELL_LINES_STORAGE_KEY,
  CELL_LINES_CHOICES,
  'off',
);

export const cellLinesVisible = (): boolean => cellLinesChoice() === 'on';

export const setCellLinesVisible = (visible: boolean): void => {
  setCellLinesChoice(visible ? 'on' : 'off');
};

const BAND_GRID_STORAGE_KEY = 'terrace.bandGrid.v1';

const BAND_GRID_CHOICES = ['on', 'off'] as const;

const [bandGridChoice, setBandGridChoice] = persistedChoice<'on' | 'off'>(
  BAND_GRID_STORAGE_KEY,
  BAND_GRID_CHOICES,
  'off',
);

export const bandGridVisible = (): boolean => bandGridChoice() === 'on';

export const setBandGridVisible = (visible: boolean): void => {
  setBandGridChoice(visible ? 'on' : 'off');
};

const SMOOTH_LINES_STORAGE_KEY = 'terrace.smoothLines.v1';

const SMOOTH_LINES_CHOICES = ['on', 'off'] as const;

const [smoothLinesChoice, setSmoothLinesChoice] = persistedChoice<'on' | 'off'>(
  SMOOTH_LINES_STORAGE_KEY,
  SMOOTH_LINES_CHOICES,
  'off',
);

export const smoothLinesEnabled = (): boolean => smoothLinesChoice() === 'on';

export const setSmoothLinesEnabled = (enabled: boolean): void => {
  setSmoothLinesChoice(enabled ? 'on' : 'off');
};

const CELL_COLOR_STORAGE_KEY = 'terrace.cellColor.v1';

const CELL_OPACITY_STORAGE_KEY = 'terrace.cellOpacity.v1';

export const MIN_CELL_OPACITY = 0;

export const MAX_CELL_OPACITY = 1;

export const CELL_OPACITY_STEP = 0.05;

function loadCellColor(): number {
  try {
    const raw = localStorage.getItem(CELL_COLOR_STORAGE_KEY);
    return raw !== null && HEX_COLOR.test(raw)
      ? parseInt(raw.slice(1), HEX_RADIX)
      : DEFAULT_CELL_LOOK.color;
  } catch {
    return DEFAULT_CELL_LOOK.color;
  }
}

function loadCellOpacity(): number {
  try {
    const raw = localStorage.getItem(CELL_OPACITY_STORAGE_KEY);
    const opacity = raw === null ? NaN : Number(raw);
    return opacity >= MIN_CELL_OPACITY && opacity <= MAX_CELL_OPACITY
      ? opacity
      : DEFAULT_CELL_LOOK.opacity;
  } catch {
    return DEFAULT_CELL_LOOK.opacity;
  }
}

const [cellLook, setCellLookSignal] = createSignal<CellLook>({
  color: loadCellColor(),
  opacity: loadCellOpacity(),
});

export { cellLook };

/** `hex` is `#rrggbb`, as a colour input yields it; anything else is ignored. */
export function setCellColor(hex: string): void {
  if (!HEX_COLOR.test(hex)) return;
  setCellLookSignal((look) => ({ ...look, color: parseInt(hex.slice(1), HEX_RADIX) }));
  persist(CELL_COLOR_STORAGE_KEY, hex.toLowerCase());
}

export function setCellOpacity(opacity: number): void {
  if (!(opacity >= MIN_CELL_OPACITY && opacity <= MAX_CELL_OPACITY)) return;
  setCellLookSignal((look) => ({ ...look, opacity }));
  persist(CELL_OPACITY_STORAGE_KEY, String(opacity));
}

export function resetLayerEdgePrefs(): void {
  setLayerEdgeStyleSignal(DEFAULT_LAYER_EDGE_STYLE);
  clearPersistedChoice(LAYER_EDGE_STORAGE_KEY);
  setLipHighlightChoice('on');
  clearPersistedChoice(LIP_HIGHLIGHT_STORAGE_KEY);
  setCreaseLookSignal(DEFAULT_CREASE_LOOK);
  clearPersistedChoice(CREASE_COLOR_STORAGE_KEY);
  clearPersistedChoice(CREASE_OPACITY_STORAGE_KEY);
  setCellLinesChoice('off');
  clearPersistedChoice(CELL_LINES_STORAGE_KEY);
  setBandGridChoice('off');
  clearPersistedChoice(BAND_GRID_STORAGE_KEY);
  setSmoothLinesChoice('off');
  clearPersistedChoice(SMOOTH_LINES_STORAGE_KEY);
  setCellLookSignal(DEFAULT_CELL_LOOK);
  clearPersistedChoice(CELL_COLOR_STORAGE_KEY);
  clearPersistedChoice(CELL_OPACITY_STORAGE_KEY);
}

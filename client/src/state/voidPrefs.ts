import {
  clearPersistedChoice,
  persistedChoice,
} from './persistedChoice.ts';
import type { VoidAnchor, VoidStyle } from '../render/celestialVoid.ts';

export type { VoidAnchor, VoidStyle };

export const VOID_STYLES: readonly VoidStyle[] = ['wheel', 'nebula'];

export const DEFAULT_VOID_STYLE: VoidStyle = 'wheel';

const VOID_STORAGE_KEY = 'terrace.celestialVoid.v1';

const [voidStyle, setVoidStyleSignal] = persistedChoice<VoidStyle>(
  VOID_STORAGE_KEY,
  VOID_STYLES,
  DEFAULT_VOID_STYLE,
);

export { voidStyle };

export const setVoidStyle = setVoidStyleSignal;

export const VOID_ANCHORS: readonly VoidAnchor[] = ['view', 'world'];

export const DEFAULT_VOID_ANCHOR: VoidAnchor = 'view';

const VOID_ANCHOR_STORAGE_KEY = 'terrace.celestialVoidAnchor.v1';

const [voidAnchor, setVoidAnchorSignal] = persistedChoice<VoidAnchor>(
  VOID_ANCHOR_STORAGE_KEY,
  VOID_ANCHORS,
  DEFAULT_VOID_ANCHOR,
);

export { voidAnchor };

export const setVoidAnchor = setVoidAnchorSignal;

export function resetVoidPrefs(): void {
  setVoidStyleSignal(DEFAULT_VOID_STYLE);
  clearPersistedChoice(VOID_STORAGE_KEY);
  setVoidAnchorSignal(DEFAULT_VOID_ANCHOR);
  clearPersistedChoice(VOID_ANCHOR_STORAGE_KEY);
}

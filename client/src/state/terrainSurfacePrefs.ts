import type { DrawnSurfaceMode } from '@terrace/shared';
import { createSignal } from 'solid-js';
import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';

const STORAGE_KEY = 'terrace.smoothTerrainBands.v1';
type StoredMode = DrawnSurfaceMode | 'protected-binomial';
const MODES: readonly StoredMode[] = ['raw', 'binomial', 'protected-binomial'];
const [storedMode, setMode] = persistedChoice<StoredMode>(STORAGE_KEY, MODES, 'raw');
const currentMode = (mode: StoredMode): DrawnSurfaceMode => mode === 'protected-binomial' ? 'binomial' : mode;

function pinnedMode(): DrawnSurfaceMode | null {
  if (!import.meta.env.DEV) return null;
  try {
    const value = new URLSearchParams(location.search).get('surface');
    return MODES.includes(value as StoredMode) ? currentMode(value as StoredMode) : null;
  } catch { return null; }
}
// The comparison URL selects the initial mode without persisting it. An explicit
// settings change takes control, so a comparison page can still be toggled live.
const [urlMode, setUrlMode] = createSignal(pinnedMode());
export const terrainSurfaceMode = (): DrawnSurfaceMode => urlMode() ?? currentMode(storedMode());
export const [terrainSurfaceRebuilding, setTerrainSurfaceRebuilding] = createSignal(false);
export const smoothTerrainBands = (): boolean => terrainSurfaceMode() === 'binomial';
export function setSmoothTerrainBands(enabled: boolean): void {
  setMode(enabled ? 'binomial' : 'raw');
  setUrlMode(null);
}
export function resetTerrainSurfacePrefs(): void {
  setMode('raw');
  setUrlMode(null);
  clearPersistedChoice(STORAGE_KEY);
}

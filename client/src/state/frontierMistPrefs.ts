import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';
import type { FrontierMistMode } from '../render/frontierFog.ts';

export type { FrontierMistMode };

export const FRONTIER_MIST_MODES: readonly FrontierMistMode[] = ['off', 'line', 'waterline'];

export const DEFAULT_FRONTIER_MIST_MODE: FrontierMistMode = 'line';

const FRONTIER_MIST_STORAGE_KEY = 'terrace.frontierMist.v2';

const [frontierMistMode, setFrontierMistModeSignal] = persistedChoice<FrontierMistMode>(
  FRONTIER_MIST_STORAGE_KEY,
  FRONTIER_MIST_MODES,
  DEFAULT_FRONTIER_MIST_MODE,
);

export { frontierMistMode };

export const setFrontierMistMode = setFrontierMistModeSignal;

export function resetFrontierMistPrefs(): void {
  setFrontierMistModeSignal(DEFAULT_FRONTIER_MIST_MODE);
  clearPersistedChoice(FRONTIER_MIST_STORAGE_KEY);
}

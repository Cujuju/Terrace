import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';

export type FrameRateTarget = 'unlimited' | '30' | '60' | '90' | '120' | '144';

export const FRAME_RATE_TARGETS: readonly FrameRateTarget[] = [
  'unlimited',
  '144',
  '120',
  '90',
  '60',
  '30',
];

export const DEFAULT_FRAME_RATE_TARGET: FrameRateTarget = 'unlimited';

const FRAME_RATE_STORAGE_KEY = 'terrace.frameRate.v1';

const [frameRateTarget, setFrameRateTargetSignal] = persistedChoice<FrameRateTarget>(
  FRAME_RATE_STORAGE_KEY,
  FRAME_RATE_TARGETS,
  DEFAULT_FRAME_RATE_TARGET,
);

export { frameRateTarget };

export const setFrameRateTarget = setFrameRateTargetSignal;

export function frameRateTargetFps(target: FrameRateTarget): number | null {
  return target === 'unlimited' ? null : Number(target);
}

export function resetFrameRatePrefs(): void {
  setFrameRateTargetSignal(DEFAULT_FRAME_RATE_TARGET);
  clearPersistedChoice(FRAME_RATE_STORAGE_KEY);
}

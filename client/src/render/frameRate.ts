import { FPS_SAMPLE_INTERVAL_MS } from '../config.ts';
import { setFrameRate } from '../state/hudState.ts';

export function startFrameRateMeter(
  onFrame: (handler: (dt: number) => void) => () => void,
  now: () => number = () => performance.now(),
): () => void {
  let windowStartMs = now();
  let framesThisWindow = 0;
  return onFrame(() => {
    framesThisWindow++;
    const elapsedMs = now() - windowStartMs;
    if (elapsedMs < FPS_SAMPLE_INTERVAL_MS) return;
    setFrameRate(Math.round((framesThisWindow * 1000) / elapsedMs));
    framesThisWindow = 0;
    windowStartMs = now();
  });
}

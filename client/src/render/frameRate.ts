// The frame-rate meter: the one place that turns the viewport's raw per-frame
// callback into the number the HUD prints.
//
// WHY IT IS NOT A SIGNAL WRITE PER FRAME: hudState's `frameRate` drives Solid,
// so writing it every frame would re-render the HUD sixty times a second to
// change a digit no one can read at that rate. The meter therefore counts
// frames itself and publishes once per FPS_SAMPLE_INTERVAL_MS.
//
// WHY IT MEASURES THE CLOCK, NOT THE FRAME DELTA: scene.ts hands each callback
// a delta capped at FRAME_DELTA_CAP_S so simulations cannot be teleported by a
// long stall. Summing those capped deltas would UNDER-report exactly the
// stalls this meter exists to show (a 400 ms freeze would count as 100 ms), so
// the window is timed against performance.now() directly and a stall lands in
// the reading at full size.

import { FPS_SAMPLE_INTERVAL_MS } from '../config.ts';
import { setFrameRate } from '../state/hudState.ts';

/**
 * Starts sampling on `onFrame` (viewport.onFrame). Returns the unregister
 * function that hook handed back, so a caller that tears the viewport down
 * stops the meter with it.
 *
 * `now` is injectable for tests only; production always passes the real clock.
 */
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
    // Rounded to whole frames: the fractional part is noise at this window
    // length, and a fixed-width integer keeps the readout from reflowing the
    // watermark's right-aligned column on every update.
    setFrameRate(Math.round((framesThisWindow * 1000) / elapsedMs));
    framesThisWindow = 0;
    windowStartMs = now();
  });
}

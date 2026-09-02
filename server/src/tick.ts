// The fixed simulation tick (design doc: "fixed tick loop (~10 Hz) runs ongoing
// sim so all clients see identical physics; rendering interpolates, simulation
// never runs client-side as truth").
//
// Phase 1 core has no sim of its own — water is a derived fact of the heightmap
// (decision Q3) and erosion is out of scope. The loop and its plugin hook ARE
// the deliverable: plugin onTick is where ongoing simulation lives until core
// grows one.

import { logError } from './log.ts';

const MILLISECONDS_PER_SECOND = 1000;

export interface TickLoop {
  /** Constant simulated time per tick, in seconds. */
  readonly dt: number;
  stop(): void;
}

/**
 * Starts a fixed-rate loop.
 *
 * `dt` is FIXED at 1/hz, not measured wall-clock elapsed time. That is the
 * whole point of a fixed tick: simulation advances by the same amount every
 * step regardless of how late the timer fired, so two servers (or a server and
 * a predicting client) that process the same number of ticks reach the same
 * state. Real elapsed time would make the sim depend on host scheduling jitter.
 *
 * A throwing callback is logged and the loop continues — one bad tick must not
 * silently stop the world's clock.
 */
export function startTickLoop(hz: number, onTick: (dt: number) => void): TickLoop {
  if (!Number.isFinite(hz) || hz <= 0) {
    throw new RangeError(`tick rate must be a positive number, got ${hz}`);
  }

  const dt = 1 / hz;
  const timer = setInterval(() => {
    try {
      onTick(dt);
    } catch (error) {
      logError('tick failed', error);
    }
  }, MILLISECONDS_PER_SECOND / hz);

  return {
    dt,
    stop(): void {
      clearInterval(timer);
    },
  };
}

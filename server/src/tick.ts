import { logError } from './log.ts';

const MILLISECONDS_PER_SECOND = 1000;

export interface TickLoop {
  readonly dt: number;
  stop(): void;
}

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

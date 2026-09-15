import { logError } from '../log.ts';

/** A fault that repeats at message rate logs at most this often. */
export const ROOM_FAILURE_LOG_INTERVAL_MS = 10_000;

/** Keeps a failure that repeats at message rate from drowning the log. */
export class LogThrottle {
  private readonly intervalMs: number;

  private lastMs = Number.NEGATIVE_INFINITY;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  due(nowMs: number): boolean {
    if (nowMs - this.lastMs < this.intervalMs) return false;
    this.lastMs = nowMs;
    return true;
  }
}

/** Reports a repeating fault at most once per the throttle's interval. */
export function throttledLog(
  throttle: LogThrottle,
  report: () => void,
  nowMs: number = Date.now(),
): void {
  if (!throttle.due(nowMs)) return;
  report();
}

/**
 * Runs one room message handler. Colyseus has no handler of its own, so a throw
 * escaping here would end the process for every player.
 */
export function containRoomMessage(
  type: string,
  throttle: LogThrottle,
  run: () => void,
  refuse?: () => void,
  nowMs: number = Date.now(),
): void {
  try {
    run();
    return;
  } catch (error) {
    const loud = throttle.due(nowMs);
    if (loud) logError(`room message "${type}" threw; refusing its sender`, error);
    if (refuse === undefined) return;
    try {
      refuse();
    } catch (refusalError) {
      if (loud) logError(`the refusal for room message "${type}" also threw`, refusalError);
    }
  }
}

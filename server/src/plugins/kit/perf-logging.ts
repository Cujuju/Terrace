import { perfLogLine } from '../../perf-log.ts';
import { isTickTimingEnabled } from '../../tick-timing.ts';

/** Plugin-safe access to the server performance log: the same on/off flag
 * as tick timing, without a new setting.
 */
export function isPerfLoggingEnabled(): boolean {
  return isTickTimingEnabled();
}

export { perfLogLine };

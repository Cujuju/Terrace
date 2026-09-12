import { perfLogLine } from '../../perf-log.ts';
import { isTickTimingEnabled } from '../../tick-timing.ts';

/**
 * Plugin-safe access to the server performance log. Plugins may import
 * `@terrace/shared` and core's plugin kit but not core directly, so this
 * wrapper exposes the SAME on/off flag as the server tick timing
 * (`PerfLoggingSetting` → `setTickTimingEnabled`) without a new setting.
 */
export function isPerfLoggingEnabled(): boolean {
  return isTickTimingEnabled();
}

export { perfLogLine };

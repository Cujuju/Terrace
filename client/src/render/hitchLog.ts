import { createEffect } from 'solid-js';
import { perfLoggingEnabled } from '../state/perfLoggingPrefs.ts';
import { setHitchSink } from './frameStats.ts';

const LOG_PREFIX = '[hitch]';
const MS_DECIMALS = 1;

function localStamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// Same local HH:MM:SS.mmm stamp as the server log, so the two can be lined up by eye.
export function installHitchLog(): void {
  createEffect(() => {
    if (!perfLoggingEnabled()) {
      setHitchSink(null);
      return;
    }
    setHitchSink((intervalMs, typicalMs) => {
      console.log(
        `${localStamp()} ${LOG_PREFIX} frame gap ${intervalMs.toFixed(MS_DECIMALS)}ms` +
          ` (typical ${typicalMs.toFixed(MS_DECIMALS)}ms)`,
      );
    });
    console.log(`${localStamp()} ${LOG_PREFIX} logging is on (Settings → Performance logging)`);
  });
}

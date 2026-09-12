import { setHitchSink } from './frameStats.ts';

const HITCH_LOG_QUERY_FLAG = 'hitchlog';
const ENABLED_VALUE = '1';
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
  if (new URLSearchParams(location.search).get(HITCH_LOG_QUERY_FLAG) !== ENABLED_VALUE) return;
  setHitchSink((intervalMs, typicalMs) => {
    console.log(
      `${localStamp()} ${LOG_PREFIX} frame gap ${intervalMs.toFixed(MS_DECIMALS)}ms` +
        ` (typical ${typicalMs.toFixed(MS_DECIMALS)}ms)`,
    );
  });
  console.log(`${localStamp()} ${LOG_PREFIX} logging is on (?${HITCH_LOG_QUERY_FLAG}=${ENABLED_VALUE})`);
}

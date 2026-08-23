// Rendering the world clock as display text for the HUD's world header.
//
// The header shows `Difficulty 50 – 3:45 p.m.` on one line; this file owns
// everything right of the dash. Pure function of a phase — no DOM, no clock —
// so the node test runner can assert the formatting directly.
//
// THE CONVENTION ASK (owner, 2026-08-21): the time must read in the VIEWER'S
// own system convention — `a.m.`/`p.m.` where the locale uses them, 24-hour
// where it doesn't. Hand-rolling that would mean re-implementing every
// locale's marker text; instead we let Intl decide by formatting a Date in a
// fixed timezone ('UTC') with no explicit hour12 — resolvedOptions then
// follows the host locale exactly as toLocaleTimeString would for any other
// timestamp. UTC pins the result so no machine timezone or DST shift can move
// a reading across an hour boundary.

import { DAY_LENGTH_SECONDS } from '../protocol.ts';

/** Minutes past midnight the world reads when phase is 0 — protocol.ts: 0 is dawn. */
export const DAWN_MINUTES = 6 * 60;

/**
 * Formats a phase (fraction of DAY_LENGTH_SECONDS in [0, 1)) as the in-world
 * wall-clock time in the viewer's own 12/24-hour convention.
 *
 * Phase 0 is dawn (protocol.ts), not midnight, so the reading is offset half a
 * day's start: dawn displays as 6:00, dusk as 6:00 p.m. / 18:00.
 */
export function formatWorldTime(phase: number): string {
  const totalMinutes = Math.floor(phase * DAY_LENGTH_SECONDS) + DAWN_MINUTES;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  // A fixed anchor date — only its wall-clock fields are ever shown.
  const instant = new Date(Date.UTC(2000, 0, 1, hour, minute));
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(instant);
}

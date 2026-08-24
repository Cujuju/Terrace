// Rendering the world clock as display text for the HUD's world header.
//
// The header shows `Difficulty 50 – Monday · Day 57 · 3:45 p.m.` on one line;
// this file owns everything right of the dash. Pure functions of a phase and a
// day — no DOM, no clock — so the node test runner can assert the formatting
// directly.
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
import { weekdayOf } from '@terrace/shared';

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

/**
 * Separator between the header clock's parts.
 *
 * The middle dot, because the chronicle's own headings already join a weekday
 * to a day with one (plugins/chronicle/client/ChroniclePanel.tsx) and the two
 * readouts name the same day — a header that punctuated it differently would
 * read as a different kind of fact.
 */
const CLOCK_PART_SEPARATOR = ' \u00b7 ';

/**
 * The whole header clock: `Monday · Day 57 · 3:45 p.m.`
 *
 * `day` is the world's AGE in days and `genesisDay` the calendar day its day 0
 * fell on (protocol.ts) — the weekday needs the calendar day, so it is the sum
 * of the two; the counter reads the age, one-based, exactly as a saga heading
 * does ("Day 1" is the world's first day, not its second).
 *
 * A NULL DAY DEGRADES TO THE TIME ALONE rather than to an invented "Day 1": a
 * server too old to send the calendar has not told us which day it is, and the
 * header's one job is to say nothing it does not know.
 *
 * NOTE ON WHEN THE WEEKDAY TURNS OVER: the calendar day increments when the
 * phase wraps, and phase 0 is DAWN (protocol.ts), so a Terrace day runs dawn to
 * dawn — the weekday changes at 6:00 a.m. on the readout, not at midnight. That
 * is the same instant the chronicle starts a new heading, so the two agree; it
 * is a property of the shared calendar, not of this formatting.
 */
export function formatWorldClock(
  phase: number,
  day: number | null,
  genesisDay: number | null,
): string {
  const time = formatWorldTime(phase);
  if (day === null || genesisDay === null) return time;
  return [weekdayOf(day + genesisDay), `Day ${day + 1}`, time].join(CLOCK_PART_SEPARATOR);
}

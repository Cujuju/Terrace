// Rendering the world clock as display text for the HUD's world header.
//
// The header draws the clock as an almanac line (client/src/ui/AlmanacClock.tsx)
// — the sun or moon on its arc, with the weekday, the day number and the time
// as text; this file owns every WORD on it and the minute-granular phase the
// mark is placed at. Pure functions of a phase and a day — no DOM, no clock —
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
import { DAWN_HOUR, weekdayOf } from '@terrace/shared';
import type { WorldClockReading } from '../../../client/src/plugins/hudPanels.ts';

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * The one formatter, built once for the life of the page.
 *
 * BUILT ONCE BECAUSE IT HAS NOTHING TO REMEMBER: locale `undefined` resolves
 * against the host's own preference and 'UTC' is fixed, so every call would
 * construct the identical object. It was constructed per call — and this is
 * called from an unconditional per-frame callback (./index.ts's onFrame), so
 * the page was building a DateTimeFormat, ICU pattern lookup and all, ~140
 * times a second: 36-68 us a call against a 7 ms frame budget, versus ~0.9 us
 * once it is hoisted.
 *
 * No locale listener is needed to keep it honest: the page's locale cannot
 * change without a reload, which rebuilds this module.
 */
const WORLD_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

/**
 * The last reading and the minute that produced it.
 *
 * The output is MINUTE-GRANULAR and the caller asks ~140 times a second, so
 * all but one call in a few hundred is asking a question already answered.
 * Keyed on the total minute rather than on the phase, because two phases a
 * frame apart are different numbers naming the same minute — which is exactly
 * the case this exists to skip.
 */
let lastTotalMinutes = -1;
let lastFormatted = '';

/**
 * Minutes past midnight the world reads when phase is 0 — protocol.ts: 0 is
 * dawn.
 *
 * DERIVED FROM THE SHARED CALENDAR'S DAWN_HOUR, never restated: the same
 * offset decides where the calendar day starts (shared/src/calendar.ts,
 * CALENDAR_LEAD_MILLIS), so a second copy here could drift and print a weekday
 * that changed at an hour the clock never shows as midnight.
 */
export const DAWN_MINUTES = DAWN_HOUR * MINUTES_PER_HOUR;

/**
 * Formats a phase (fraction of DAY_LENGTH_SECONDS in [0, 1)) as the in-world
 * wall-clock time in the viewer's own 12/24-hour convention.
 *
 * Phase 0 is dawn (protocol.ts), not midnight, so the reading is offset half a
 * day's start: dawn displays as 6:00, dusk as 6:00 p.m. / 18:00.
 */
export function formatWorldTime(phase: number): string {
  const totalMinutes = Math.floor(phase * DAY_LENGTH_SECONDS) + DAWN_MINUTES;
  if (totalMinutes === lastTotalMinutes) return lastFormatted;
  const hour = Math.floor(totalMinutes / MINUTES_PER_HOUR) % HOURS_PER_DAY;
  const minute = totalMinutes % MINUTES_PER_HOUR;
  // A fixed anchor date — only its wall-clock fields are ever shown.
  const instant = new Date(Date.UTC(2000, 0, 1, hour, minute));
  lastTotalMinutes = totalMinutes;
  lastFormatted = WORLD_TIME_FORMAT.format(instant);
  return lastFormatted;
}

/**
 * The whole header clock as ONE READING for core to draw: `Monday`, `Day 57`,
 * `3:45 p.m.` and the phase they were read at.
 *
 * THE PHASE IS QUANTISED TO THE MINUTE before it crosses the seam, so the
 * reading only changes when the time text does — the header then updates once
 * per in-world minute (one real second) rather than every frame, which is what
 * keeps a per-frame writer from re-rendering an SVG 140 times a second for a
 * mark that moves less than a tenth of a pixel between frames.
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
 * NOTE ON WHEN THE WEEKDAY TURNS OVER: at MIDNIGHT on this readout — the
 * calendar day is offset from the sim clock's dawn-anchored lap by exactly the
 * DAWN_MINUTES above (shared/src/calendar.ts, CALENDAR_LEAD_MILLIS), so the
 * name changes when the time reads 12:00 a.m. and not when the sun comes up.
 * That is the same instant the chronicle starts a new heading, so the two
 * agree; it is a property of the shared calendar, not of this formatting.
 */
export function worldClockReading(
  phase: number,
  day: number | null,
  genesisDay: number | null,
): WorldClockReading {
  const wholeMinutes = Math.floor(phase * DAY_LENGTH_SECONDS);
  const known = day !== null && genesisDay !== null;
  return {
    phase: wholeMinutes / DAY_LENGTH_SECONDS,
    time: formatWorldTime(phase),
    weekday: known ? weekdayOf(day + genesisDay) : null,
    day: known ? day + 1 : null,
  };
}

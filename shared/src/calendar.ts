// THE WORLD'S CALENDAR — how long a day is, what day it is, and what that day
// is called.
//
// WHY THIS IS IN shared/ AND NOT IN A PLUGIN (2026-08-23). Until now the day
// length lived in plugins/daynight, and the chronicle kept a SECOND, different
// day of its own (600 s against day/night's 1440 s) purely because it could not
// import the first — plugins must not depend on each other. Two clocks was
// survivable while each was private: the chronicle's own comment called its day
// "the saga's coarsest unit, used only to stamp and group entries", and nobody
// had to reconcile that with the sunrise.
//
// The weekday mechanic (owner, 2026-08-23) is what made it untenable: a player
// who is told it is Monday must be able to look at the sky and agree. A name
// for a day is only meaningful if there is ONE day to name, so the calendar
// moves to the one place every plugin may read.
//
// WHAT IS CORE HERE AND WHAT STAYS GAMEY. This file holds only facts about the
// world's clock — how long a day lasts, which day a moment falls in, what that
// day is called. Everything ABOUT a day that is a mechanic or an ambience stays
// in its plugin: the sun's colour and phase quantisation are day/night's, what
// a settlement does on a Monday is structures', and how the saga words a
// heading is the chronicle's. That division is the same one CLAUDE.md draws for
// the rest of core.
//
// DETERMINISM: integer-only, exactly as the terrain math is. `dayOfSimMillis`
// takes MILLISECONDS as an integer rather than accumulated float seconds for
// the reason the chronicle's own clock comment gives — summing a float `dt`
// drifts measurably over a few thousand ticks, and a drifting clock moves day
// boundaries, which would make the weekday engine-dependent.

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Length of one world day, in simulated seconds.
 *
 * TWENTY-FOUR MINUTES, which is the number the day/night cycle has always run
 * at — this constant IS that one, moved rather than re-chosen, so the sky is
 * still the authority on what a day looks like. plugins/daynight re-exports it
 * and keeps every other timing it owns.
 *
 * The chronicle's former 600 s day is GONE rather than kept alongside: see this
 * file's header. Its stored entries are remapped onto this scale by the slice
 * migration in plugins/chronicle (slice version 2).
 */
export const DAY_LENGTH_SECONDS = 24 * 60;

/** The same span in milliseconds — the unit the day boundary is computed in. */
export const DAY_LENGTH_MILLIS = DAY_LENGTH_SECONDS * MILLISECONDS_PER_SECOND;

/**
 * The days of the week, in order, starting at the one a world is born on.
 *
 * MONDAY IS INDEX 0 BECAUSE THE WORLD BEGINS THERE (owner, 2026-08-23: "the
 * world was created on Monday and on Sunday the Creator rested"). That is a
 * joke with a load-bearing consequence: it fixes the phase of the whole
 * calendar to genesis, so `weekdayOf` needs no epoch offset and a world's first
 * moment is unambiguously Monday rather than whatever ISO weekday zero happens
 * to be. Sunday therefore lands on day 6, the day before the settlers come.
 */
export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export type Weekday = (typeof WEEKDAY_NAMES)[number];

/** Days in a week — derived from the names, never restated as a 7. */
export const DAYS_PER_WEEK = WEEKDAY_NAMES.length;

/**
 * THE DAY SETTLERS ARRIVE, as an index into WEEKDAY_NAMES.
 *
 * Monday, the day the world itself began: a new colony is a small genesis, so
 * it happens on the day genesis happened. Named here rather than in structures
 * because it is a fact about the calendar that the chronicle also words ("the
 * Creator rested" only reads as a joke if the reader knows what Monday is for),
 * and two plugins agreeing on a weekday by coincidence is how they stop
 * agreeing later.
 */
export const SETTLING_WEEKDAY = 0;

/**
 * Hours on the world's clock face — the world reads the same 24 hours a real
 * one does, compressed into DAY_LENGTH_SECONDS.
 */
export const HOURS_PER_WORLD_DAY = 24;

/**
 * The hour the SIM clock's zero point reads: phase 0 is DAWN, not midnight
 * (plugins/daynight/protocol.ts), and dawn is six o'clock.
 *
 * Lives here rather than in day/night's formatter because it is no longer only
 * a display offset — since the calendar day turns over at midnight (below) it
 * is the distance between the two zero points, and a formatter that disagreed
 * with the calendar about where dawn falls would print a weekday that changes
 * at the wrong hour. day/night's DAWN_MINUTES is derived from this.
 */
export const DAWN_HOUR = 6;

/**
 * How far the calendar day is AHEAD of the sim day, in milliseconds.
 *
 * THE CALENDAR DAY TURNS OVER AT MIDNIGHT (owner, 2026-08-24), while the sim
 * clock — and the sky it drives — still starts its lap at dawn. Six of the new
 * day's hours are therefore already spent at sim-time zero, and adding them
 * back before the divide is what moves the boundary from dawn to the midnight
 * eighteen world-hours later. Nothing about the sun moves: the phase, its
 * keyframes and the broadcast are untouched, and only the NAME of the day
 * changes at a different moment than before.
 *
 * The world's first day is consequently a short one — a world born at dawn
 * lives eighteen hours of its Monday, exactly as a calendar treats anything
 * born at six in the morning.
 *
 * Floored so the offset stays an integer for any future DAY_LENGTH_SECONDS or
 * DAWN_HOUR that does not divide evenly; at the current values it is exact
 * (1_440_000 * 6 / 24 = 360_000).
 */
const CALENDAR_LEAD_MILLIS = Math.floor((DAY_LENGTH_MILLIS * DAWN_HOUR) / HOURS_PER_WORLD_DAY);

/**
 * Which day of the world a moment falls in — day 0 is the world's first.
 *
 * MIDNIGHT TO MIDNIGHT, not dawn to dawn: see CALENDAR_LEAD_MILLIS. Every
 * consumer of a day — the weekday the header names, the heading the chronicle
 * writes, the Monday settlers arrive on — moves together because they all
 * come through here.
 *
 * Takes integer milliseconds, not seconds: see this file's header on drift.
 */
export function dayOfSimMillis(simMillis: number): number {
  return Math.floor((simMillis + CALENDAR_LEAD_MILLIS) / DAY_LENGTH_MILLIS);
}

/**
 * Which weekday a world-day falls on, as an index into WEEKDAY_NAMES.
 *
 * Total for negative days as well, which cannot arise from a running clock but
 * can from a restored slice whose day stamps predate a migration — the JS `%`
 * keeps its left operand's sign, so a bare `day % DAYS_PER_WEEK` would return a
 * negative index and `WEEKDAY_NAMES[-1]` is `undefined`, i.e. a crash in a
 * heading rather than a wrong name. Nudged up by one week instead.
 */
export function weekdayIndexOf(day: number): number {
  const index = day % DAYS_PER_WEEK;
  return index < 0 ? index + DAYS_PER_WEEK : index;
}

/** What that day is called. */
export function weekdayOf(day: number): Weekday {
  // The index is proven in range by weekdayIndexOf, so this cannot be
  // undefined; the non-null assertion is what tells the compiler that.
  return WEEKDAY_NAMES[weekdayIndexOf(day)]!;
}

/** Is this world-day the one settlers arrive on? */
export function isSettlingDay(day: number): boolean {
  return weekdayIndexOf(day) === SETTLING_WEEKDAY;
}

// ── The world clock against real time ────────────────────────────────────────

/**
 * THE INSTANT WORLD TIME BEGAN, as a real-world Unix timestamp in milliseconds.
 *
 * WHY THE WORLD CLOCK IS ANCHORED TO REAL TIME (owner, 2026-08-23): "we should
 * base the game world clock off a specific offset against real world time so
 * every server iteration will always show a predictable time and schedule."
 * Before this the clock counted ticks from each world's own genesis, so what
 * time it was in a world depended on how long that particular process had been
 * up — two servers were never in the same hour, a restart hid its own downtime,
 * and nobody could say when the next Monday would fall without asking the
 * server. Anchored here, world time is a pure function of the wall clock: every
 * world, on every host, on every restart, agrees on the hour and the weekday,
 * and an operator can work out when settlers land from a watch.
 *
 * MONDAY 2026-01-05T00:00:00Z, chosen for two properties and no others:
 *   - It is a real MONDAY, so absolute day 0 is a Monday and the calendar above
 *     still needs no epoch offset — `weekdayOf(0)` is 'Monday' whether that 0
 *     came from a world's genesis or from this epoch.
 *   - It is UTC midnight, so the world's dawn — the sim clock's zero, where the
 *     sky starts its lap — falls on every real 24-minute mark from midnight,
 *     rather than at some arbitrary offset within the hour. The world's own
 *     midnight, where the DAY NAME turns over, is a fixed eighteen world-hours
 *     (18 real minutes) after each of those marks; see CALENDAR_LEAD_MILLIS.
 * It is deliberately in the past relative to every world this build can open,
 * so no real server ever sees the negative clamp below.
 *
 * A WEEK IS NOT A REAL WEEK, and that is not a defect: a world day is 24
 * minutes, so sixty of them fit in a real day and the world's Monday comes
 * round every 2 h 48 min. What the epoch buys is PREDICTABILITY — the same
 * instant is the same world moment everywhere — not alignment with the real
 * weekday, which a 24-minute day cannot have.
 */
export const WORLD_EPOCH_REAL_MILLIS = Date.UTC(2026, 0, 5);

/**
 * What the world clock reads at a given real-world instant.
 *
 * CLAMPED AT ZERO rather than allowed to go negative: a host whose system
 * clock is set before the epoch is misconfigured, and a negative clock would
 * put every day boundary and every weekday in the world one step out (see
 * weekdayIndexOf's note on what a negative day does). Freezing such a host at
 * the world's first moment is wrong in an obvious, reportable way instead.
 *
 * FLOORED, so the clock stays an integer even if a caller hands over a
 * fractional timestamp — every consumer of `simMillis` assumes integer
 * milliseconds (see the module header on drift).
 */
export function simMillisAtRealTime(realMillis: number): number {
  if (!Number.isFinite(realMillis)) return 0;
  return Math.max(0, Math.floor(realMillis) - WORLD_EPOCH_REAL_MILLIS);
}

/**
 * How many days old a world is — the number a saga heading counts, as opposed
 * to `dayOfSimMillis`, which is the number the WEEKDAY comes from.
 *
 * THE TWO ARE DIFFERENT NUMBERS SINCE THE CLOCK MOVED TO REAL TIME (2026-08-23,
 * owner's choice): the absolute day says which Monday it is and is shared by
 * every world in existence; the age says how much of that a particular world
 * has lived through, and is what a reader means by "Day 57". Deriving the age
 * by subtracting whole DAYS rather than milliseconds is deliberate — it keeps
 * the two numbers changing at the same instant, so a heading never flips to
 * "Day 58" in the middle of a Monday.
 *
 * Never negative: a world cannot be older than it is, and a snapshot whose
 * genesis somehow post-dates its clock is clamped rather than trusted.
 */
export function worldAgeDays(simMillis: number, genesisMillis: number): number {
  return Math.max(0, dayOfSimMillis(simMillis) - dayOfSimMillis(genesisMillis));
}

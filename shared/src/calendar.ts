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
 * Which day of the world a moment falls in — day 0 is the world's first.
 *
 * Takes integer milliseconds, not seconds: see this file's header on drift.
 */
export function dayOfSimMillis(simMillis: number): number {
  return Math.floor(simMillis / DAY_LENGTH_MILLIS);
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

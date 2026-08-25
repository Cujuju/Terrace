// The world calendar: one day, seven names, and a Monday that genesis fixes.

import { describe, expect, it } from 'vitest';
import {
  DAWN_HOUR,
  DAYS_PER_WEEK,
  DAY_LENGTH_MILLIS,
  DAY_LENGTH_SECONDS,
  HOURS_PER_WORLD_DAY,
  SETTLING_WEEKDAY,
  WEEKDAY_NAMES,
  WORLD_EPOCH_REAL_MILLIS,
  dayOfSimMillis,
  isSettlingDay,
  simMillisAtRealTime,
  weekdayIndexOf,
  weekdayOf,
  worldAgeDays,
} from '../src/calendar.ts';

/**
 * Sim-time of the world's FIRST MIDNIGHT — the instant the calendar day rolls
 * from 0 to 1. Sim-time zero is dawn, so midnight is the rest of that day away:
 * eighteen of the world's twenty-four hours. Recomputed here from the same two
 * exported constants rather than hard-coded, so a change to either moves the
 * expectation with the implementation instead of failing opaquely.
 */
const FIRST_MIDNIGHT_MILLIS =
  DAY_LENGTH_MILLIS - (DAY_LENGTH_MILLIS * DAWN_HOUR) / HOURS_PER_WORLD_DAY;

describe('the world calendar', () => {
  it('runs one day per day-night cycle — there is only one day', () => {
    // THE WHOLE POINT OF THIS FILE EXISTING. The chronicle used to keep a
    // second, shorter day (600 s) purely because it could not import the sky's,
    // and a weekday mechanic makes two calendars a contradiction the player can
    // see. 1 440 s is the sky's number, moved rather than re-chosen.
    expect(DAY_LENGTH_SECONDS).toBe(24 * 60);
    expect(DAY_LENGTH_MILLIS).toBe(DAY_LENGTH_SECONDS * 1000);
  });

  it('counts day 0 as the world’s first, and rolls at MIDNIGHT', () => {
    // THE BOUNDARY IS MIDNIGHT, NOT DAWN (owner, 2026-08-24). Sim-time zero is
    // dawn — the sky's lap starts there — so the world's first day is a short
    // one, running from six in the morning to that night's midnight. Every
    // later day is a full DAY_LENGTH_MILLIS long, offset from the sky's lap.
    expect(dayOfSimMillis(0)).toBe(0);
    expect(dayOfSimMillis(FIRST_MIDNIGHT_MILLIS - 1)).toBe(0);
    expect(dayOfSimMillis(FIRST_MIDNIGHT_MILLIS)).toBe(1);
    expect(dayOfSimMillis(FIRST_MIDNIGHT_MILLIS + DAY_LENGTH_MILLIS * 9 + 5)).toBe(10);

    // Dawn is INSIDE a day, not the start of one: the sun coming up must not
    // rename the day, which is the whole content of the owner's ask.
    expect(dayOfSimMillis(DAY_LENGTH_MILLIS - 1)).toBe(1);
    expect(dayOfSimMillis(DAY_LENGTH_MILLIS)).toBe(1);
  });

  it('names seven days and begins the world on a Monday', () => {
    // Genesis is Monday, which is what lets weekdayOf work with no epoch
    // offset — and it is the joke the mechanic is built on (owner, 2026-08-23).
    expect(DAYS_PER_WEEK).toBe(7);
    expect(WEEKDAY_NAMES).toHaveLength(DAYS_PER_WEEK);
    expect(weekdayOf(0)).toBe('Monday');
    expect(weekdayOf(6)).toBe('Sunday');
    expect(weekdayOf(7)).toBe('Monday');
  });

  it('puts the Creator’s rest on the day before the settlers come', () => {
    // The tongue-in-cheek half, pinned so it cannot drift: Sunday is the last
    // day of the week and Monday — the settling day — is the next one.
    expect(WEEKDAY_NAMES[DAYS_PER_WEEK - 1]).toBe('Sunday');
    expect(WEEKDAY_NAMES[SETTLING_WEEKDAY]).toBe('Monday');
    expect(isSettlingDay(6)).toBe(false); // Sunday: the Creator rests.
    expect(isSettlingDay(7)).toBe(true); // Monday: settlers.
  });

  it('settles exactly one day in seven', () => {
    const settling = [];
    for (let day = 0; day < DAYS_PER_WEEK * 3; day++) {
      if (isSettlingDay(day)) settling.push(day);
    }
    expect(settling).toEqual([0, 7, 14]);
  });

  it('names a negative day rather than crashing on one', () => {
    // Cannot arise from a running clock, but CAN from a restored slice whose
    // day stamps predate a migration. A bare `day % 7` would return -1 and
    // WEEKDAY_NAMES[-1] is undefined — a crash inside a heading.
    expect(weekdayIndexOf(-1)).toBe(6);
    expect(weekdayOf(-1)).toBe('Sunday');
    expect(weekdayOf(-7)).toBe('Monday');
  });
});

describe('the world clock against real time', () => {
  it('begins on a real Monday, so the calendar still needs no epoch offset', () => {
    // THE LOAD-BEARING PROPERTY of the epoch constant. Every weekday in the
    // game is `weekdayOf(dayOfSimMillis(clock))`, and that expression carries
    // no offset term — it is correct only because day 0 of the clock is a
    // Monday in the real world too. A future edit that moves the epoch to a
    // Tuesday would rename every day in the game and break the one rule two
    // plugins agree on (settlers arrive on Mondays) with no other symptom.
    expect(new Date(WORLD_EPOCH_REAL_MILLIS).getUTCDay()).toBe(1);
    expect(weekdayOf(dayOfSimMillis(simMillisAtRealTime(WORLD_EPOCH_REAL_MILLIS)))).toBe('Monday');
    expect(isSettlingDay(dayOfSimMillis(0))).toBe(true);
  });

  it('is midnight UTC, so the world\'s DAWN falls on the real 24-minute marks', () => {
    // The second property the epoch was chosen for. Stated as an assertion
    // rather than a comment because it is what makes world time predictable
    // from a watch: at any real UTC midnight, the sky starts a fresh lap at
    // dawn. The world's own midnight — where the day NAME changes — trails it
    // by eighteen world-hours, i.e. 18 real minutes; see CALENDAR_LEAD_MILLIS.
    const REAL_DAY_MILLIS = 24 * 60 * 60 * 1000;
    expect(WORLD_EPOCH_REAL_MILLIS % REAL_DAY_MILLIS).toBe(0);
    expect(simMillisAtRealTime(WORLD_EPOCH_REAL_MILLIS + REAL_DAY_MILLIS) % DAY_LENGTH_MILLIS)
      .toBe(0);
  });

  it('turns a real instant into a world clock reading, as a whole millisecond', () => {
    expect(simMillisAtRealTime(WORLD_EPOCH_REAL_MILLIS)).toBe(0);
    expect(simMillisAtRealTime(WORLD_EPOCH_REAL_MILLIS + DAY_LENGTH_MILLIS)).toBe(
      DAY_LENGTH_MILLIS,
    );
    // Floored, never fractional: every consumer of the clock assumes integers.
    expect(simMillisAtRealTime(WORLD_EPOCH_REAL_MILLIS + 1.9)).toBe(1);
  });

  it('freezes at the world\'s first moment rather than going negative', () => {
    // A host whose system clock is set before the epoch is misconfigured. A
    // negative clock would put every weekday in the world one step out, which
    // is a silent wrong answer; standing still is a visible one.
    expect(simMillisAtRealTime(WORLD_EPOCH_REAL_MILLIS - DAY_LENGTH_MILLIS)).toBe(0);
    expect(simMillisAtRealTime(Number.NaN)).toBe(0);
  });

  it('counts a world\'s age in whole calendar days, not in elapsed spans', () => {
    // The two numbers a heading needs are now different: the calendar day says
    // which Monday it is, the age says what "Day 57" counts. Subtracting whole
    // days is what keeps them turning over together — see worldAgeDays.
    const genesis = DAY_LENGTH_MILLIS * 3;
    expect(worldAgeDays(genesis, genesis)).toBe(0);
    expect(worldAgeDays(genesis + DAY_LENGTH_MILLIS, genesis)).toBe(1);

    // A world born mid-day: its first partial day IS a day, so one millisecond
    // after the next MIDNIGHT it is on its second day, not 0.04 days old.
    const justBeforeMidnight = DAY_LENGTH_MILLIS * 3 + FIRST_MIDNIGHT_MILLIS - 1;
    expect(worldAgeDays(justBeforeMidnight, justBeforeMidnight)).toBe(0);
    expect(worldAgeDays(justBeforeMidnight + 1, justBeforeMidnight)).toBe(1);

    // Never negative: a snapshot whose genesis post-dates its clock is clamped
    // rather than trusted.
    expect(worldAgeDays(genesis, genesis + DAY_LENGTH_MILLIS)).toBe(0);
  });

  it('offsets a world\'s age from the calendar by a CONSTANT number of days', () => {
    // THE PROPERTY THE CHRONICLE'S WIRE FORMAT RESTS ON: the client is sent one
    // `genesisDay` integer and adds it to every entry's age-day to recover the
    // weekday. That is only sound if the difference never wobbles — which it
    // does not, because both sides floor to whole days first. Subtracting the
    // MILLISECONDS instead would alternate between two values whenever genesis
    // falls mid-day, and the heading's weekday would be wrong half the time.
    const genesis = DAY_LENGTH_MILLIS * 3 + 12345;
    const genesisDay = dayOfSimMillis(genesis);
    for (let step = 0; step < DAYS_PER_WEEK * 2; step++) {
      const now = genesis + step * DAY_LENGTH_MILLIS + 777;
      expect(worldAgeDays(now, genesis) + genesisDay).toBe(dayOfSimMillis(now));
    }
  });
});

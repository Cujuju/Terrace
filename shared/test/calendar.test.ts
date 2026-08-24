// The world calendar: one day, seven names, and a Monday that genesis fixes.

import { describe, expect, it } from 'vitest';
import {
  DAYS_PER_WEEK,
  DAY_LENGTH_MILLIS,
  DAY_LENGTH_SECONDS,
  SETTLING_WEEKDAY,
  WEEKDAY_NAMES,
  dayOfSimMillis,
  isSettlingDay,
  weekdayIndexOf,
  weekdayOf,
} from '../src/calendar.ts';

describe('the world calendar', () => {
  it('runs one day per day-night cycle — there is only one day', () => {
    // THE WHOLE POINT OF THIS FILE EXISTING. The chronicle used to keep a
    // second, shorter day (600 s) purely because it could not import the sky's,
    // and a weekday mechanic makes two calendars a contradiction the player can
    // see. 1 440 s is the sky's number, moved rather than re-chosen.
    expect(DAY_LENGTH_SECONDS).toBe(24 * 60);
    expect(DAY_LENGTH_MILLIS).toBe(DAY_LENGTH_SECONDS * 1000);
  });

  it('counts day 0 as the world’s first, and rolls on the boundary', () => {
    expect(dayOfSimMillis(0)).toBe(0);
    expect(dayOfSimMillis(DAY_LENGTH_MILLIS - 1)).toBe(0);
    expect(dayOfSimMillis(DAY_LENGTH_MILLIS)).toBe(1);
    expect(dayOfSimMillis(DAY_LENGTH_MILLIS * 9 + 5)).toBe(9);
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

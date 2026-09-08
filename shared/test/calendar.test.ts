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

const FIRST_MIDNIGHT_MILLIS =
  DAY_LENGTH_MILLIS - (DAY_LENGTH_MILLIS * DAWN_HOUR) / HOURS_PER_WORLD_DAY;

describe('the world calendar', () => {
  it('runs one day per day-night cycle — there is only one day', () => {
    expect(DAY_LENGTH_SECONDS).toBe(24 * 60);
    expect(DAY_LENGTH_MILLIS).toBe(DAY_LENGTH_SECONDS * 1000);
  });

  it('counts day 0 as the world’s first, and rolls at MIDNIGHT', () => {
    expect(dayOfSimMillis(0)).toBe(0);
    expect(dayOfSimMillis(FIRST_MIDNIGHT_MILLIS - 1)).toBe(0);
    expect(dayOfSimMillis(FIRST_MIDNIGHT_MILLIS)).toBe(1);
    expect(dayOfSimMillis(FIRST_MIDNIGHT_MILLIS + DAY_LENGTH_MILLIS * 9 + 5)).toBe(10);

    expect(dayOfSimMillis(DAY_LENGTH_MILLIS - 1)).toBe(1);
    expect(dayOfSimMillis(DAY_LENGTH_MILLIS)).toBe(1);
  });

  it('names seven days and begins the world on a Monday', () => {
    expect(DAYS_PER_WEEK).toBe(7);
    expect(WEEKDAY_NAMES).toHaveLength(DAYS_PER_WEEK);
    expect(weekdayOf(0)).toBe('Monday');
    expect(weekdayOf(6)).toBe('Sunday');
    expect(weekdayOf(7)).toBe('Monday');
  });

  it('puts the Creator’s rest on the day before the settlers come', () => {
    expect(WEEKDAY_NAMES[DAYS_PER_WEEK - 1]).toBe('Sunday');
    expect(WEEKDAY_NAMES[SETTLING_WEEKDAY]).toBe('Monday');
    expect(isSettlingDay(6)).toBe(false);
    expect(isSettlingDay(7)).toBe(true);
  });

  it('settles exactly one day in seven', () => {
    const settling = [];
    for (let day = 0; day < DAYS_PER_WEEK * 3; day++) {
      if (isSettlingDay(day)) settling.push(day);
    }
    expect(settling).toEqual([0, 7, 14]);
  });

  it('names a negative day rather than crashing on one', () => {
    expect(weekdayIndexOf(-1)).toBe(6);
    expect(weekdayOf(-1)).toBe('Sunday');
    expect(weekdayOf(-7)).toBe('Monday');
  });
});

describe('the world clock against real time', () => {
  it('begins on a real Monday, so the calendar still needs no epoch offset', () => {
    expect(new Date(WORLD_EPOCH_REAL_MILLIS).getUTCDay()).toBe(1);
    expect(weekdayOf(dayOfSimMillis(simMillisAtRealTime(WORLD_EPOCH_REAL_MILLIS)))).toBe('Monday');
    expect(isSettlingDay(dayOfSimMillis(0))).toBe(true);
  });

  it('is midnight UTC, so the world\'s DAWN falls on the real 24-minute marks', () => {
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
    expect(simMillisAtRealTime(WORLD_EPOCH_REAL_MILLIS + 1.9)).toBe(1);
  });

  it('freezes at the world\'s first moment rather than going negative', () => {
    expect(simMillisAtRealTime(WORLD_EPOCH_REAL_MILLIS - DAY_LENGTH_MILLIS)).toBe(0);
    expect(simMillisAtRealTime(Number.NaN)).toBe(0);
  });

  it('counts a world\'s age in whole calendar days, not in elapsed spans', () => {
    const genesis = DAY_LENGTH_MILLIS * 3;
    expect(worldAgeDays(genesis, genesis)).toBe(0);
    expect(worldAgeDays(genesis + DAY_LENGTH_MILLIS, genesis)).toBe(1);

    const justBeforeMidnight = DAY_LENGTH_MILLIS * 3 + FIRST_MIDNIGHT_MILLIS - 1;
    expect(worldAgeDays(justBeforeMidnight, justBeforeMidnight)).toBe(0);
    expect(worldAgeDays(justBeforeMidnight + 1, justBeforeMidnight)).toBe(1);

    expect(worldAgeDays(genesis, genesis + DAY_LENGTH_MILLIS)).toBe(0);
  });

  it('offsets a world\'s age from the calendar by a CONSTANT number of days', () => {
    const genesis = DAY_LENGTH_MILLIS * 3 + 12345;
    const genesisDay = dayOfSimMillis(genesis);
    for (let step = 0; step < DAYS_PER_WEEK * 2; step++) {
      const now = genesis + step * DAY_LENGTH_MILLIS + 777;
      expect(worldAgeDays(now, genesis) + genesisDay).toBe(dayOfSimMillis(now));
    }
  });
});

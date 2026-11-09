import { DAY_LENGTH_MILLIS, dayOfSimMillis } from '@terrace/shared';
import { wrapPhase, type DayNightClockState } from '../protocol.ts';

export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 10;

export const DEFAULT_INTERPOLATION_SECONDS = 5;

function shortestPhaseDelta(from: number, to: number): number {
  const raw = wrapPhase(to - from);
  return raw > 0.5 ? raw - 1 : raw;
}

export function lerpPhase(from: number, to: number, t: number): number {
  if (t <= 0) return wrapPhase(from);
  if (t >= 1) return wrapPhase(to);
  return wrapPhase(from + shortestPhaseDelta(from, to) * t);
}

export class DayNightInterpolator {
  private fromDays = 0;
  private toDays = 0;
  private genesisDay: number | null = null;
  private elapsed = 0;
  private window = DEFAULT_INTERPOLATION_SECONDS;
  private sinceLastMessage = 0;
  private hasReceived = false;

  receive(clock: DayNightClockState): void {
    const calendarKnown = clock.day !== null && clock.genesisDay !== null;
    const target = clock.day !== null && clock.genesisDay !== null
      ? clock.day + clock.genesisDay - dayOfSimMillis(clock.phase * DAY_LENGTH_MILLIS) + clock.phase
      : this.sampleDays() + shortestPhaseDelta(this.samplePhase(), clock.phase);
    const rendered = this.hasReceived && this.genesisDay === clock.genesisDay
      ? this.sampleDays()
      : target;

    if (this.hasReceived) {
      this.window = Math.min(
        MAX_INTERPOLATION_SECONDS,
        Math.max(MIN_INTERPOLATION_SECONDS, this.sinceLastMessage),
      );
    }
    this.hasReceived = true;
    this.sinceLastMessage = 0;

    this.fromDays = rendered;
    this.toDays = target;
    this.genesisDay = calendarKnown ? clock.genesisDay : null;
    this.elapsed = 0;
  }

  advance(dt: number): void {
    this.elapsed += dt;
    this.sinceLastMessage += dt;
  }

  progress(): number {
    if (this.window <= 0) return 1;
    return Math.min(1, this.elapsed / this.window);
  }

  samplePhase(): number {
    return wrapPhase(this.sampleDays());
  }

  sampleClock(): DayNightClockState {
    const days = this.sampleDays();
    return {
      phase: wrapPhase(days),
      day: this.genesisDay === null
        ? null
        : Math.max(0, dayOfSimMillis(days * DAY_LENGTH_MILLIS) - this.genesisDay),
      genesisDay: this.genesisDay,
    };
  }

  private sampleDays(): number {
    return this.fromDays + (this.toDays - this.fromDays) * this.progress();
  }

  clear(): void {
    this.fromDays = 0;
    this.toDays = 0;
    this.genesisDay = null;
    this.elapsed = 0;
    this.sinceLastMessage = 0;
    this.window = DEFAULT_INTERPOLATION_SECONDS;
    this.hasReceived = false;
  }
}

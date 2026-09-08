import { wrapPhase } from '../protocol.ts';

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
  private fromPhase = 0;
  private toPhase = 0;
  private elapsed = 0;
  private window = DEFAULT_INTERPOLATION_SECONDS;
  private sinceLastMessage = 0;
  private hasReceived = false;

  receive(phase: number): void {
    const rendered = this.hasReceived ? this.samplePhase() : phase;

    if (this.hasReceived) {
      this.window = Math.min(
        MAX_INTERPOLATION_SECONDS,
        Math.max(MIN_INTERPOLATION_SECONDS, this.sinceLastMessage),
      );
    }
    this.hasReceived = true;
    this.sinceLastMessage = 0;

    this.fromPhase = rendered;
    this.toPhase = phase;
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
    if (!this.hasReceived) return this.fromPhase;
    return lerpPhase(this.fromPhase, this.toPhase, this.progress());
  }

  clear(): void {
    this.fromPhase = 0;
    this.toPhase = 0;
    this.elapsed = 0;
    this.sinceLastMessage = 0;
    this.window = DEFAULT_INTERPOLATION_SECONDS;
    this.hasReceived = false;
  }
}

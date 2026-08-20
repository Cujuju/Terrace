// Smoothing the server's occasional phase broadcast into a per-frame value.
//
// The weather plugin's client/interpolation.ts is the pattern this restates
// (plugin halves do not import each other's internals — same reasoning as
// weather's own header gives for restating the wildlife plugin's
// interpolator): keep the last RENDERED value and the newest received one,
// walk between them over the measured inter-message gap. Pure logic, no
// three, no DOM, no clock of its own — time only enters through advance(dt).
//
// THE ONE DIFFERENCE FROM WEATHER'S VERSION: phase is CYCLIC. Two systems'
// x/y never wrap, so a plain lerp is correct there; a phase broadcast landing
// at 0.999 followed by one at 0.001 has actually moved forward by 0.002 (through
// the dawn/midnight seam), not backward by 0.998 — see lerpPhase.

import { wrapPhase } from '../protocol.ts';

/**
 * Bounds on the measured inter-message gap used as the interpolation window —
 * same shape and same reasoning as weather's MIN/MAX_INTERPOLATION_SECONDS,
 * with numbers matched to THIS plugin's own cadence rather than weather's.
 * The floor is one 60 Hz frame (below it there is nothing to interpolate);
 * the ceiling rides out exactly one dropped broadcast at the server's 5 s
 * cadence (server/index.ts's DAYNIGHT_BROADCAST_INTERVAL_SECONDS) before the
 * client would rather hold at truth than glide through a stale extrapolation
 * — the same 2× relationship weather's own ceiling holds against its 1 s
 * cadence.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 10;

/** Nominal window before two broadcasts have been seen — the server's cadence. */
export const DEFAULT_INTERPOLATION_SECONDS = 5;

/**
 * Shortest signed distance from `from` to `to` around a unit circle, in
 * (-0.5, 0.5]. This is the one piece of maths weather's plain lerp does not
 * need: subtracting the nearest whole lap turns "go the long way around"
 * into "go the short way", which is what makes a broadcast landing just after
 * midnight interpolate FORWARD through the seam instead of spinning
 * backward through the whole day to get there the other way.
 */
function shortestPhaseDelta(from: number, to: number): number {
  const raw = wrapPhase(to - from);
  return raw > 0.5 ? raw - 1 : raw;
}

/**
 * Walks from one phase to another along the SHORT way round the cycle.
 *
 * `t` outside [0, 1] is clamped to the exact endpoint rather than run through
 * the arithmetic below, and that is a correctness choice, not just tidiness:
 * `progress()` clamps at 1 once a segment is fully covered ("holds at truth"
 * — the same rule WeatherInterpolator.sample() documents), and at that clamp
 * the sky must read the EXACT broadcast phase, not a value one floating-point
 * rounding step away from it (0.1 + 0.2 * 1 is 0.30000000000000004 in IEEE
 * 754, not 0.3). This value is parsed, quantised and re-broadcast every cycle
 * (protocol.ts, server/index.ts), so a lerp that could not reproduce an
 * endpoint exactly would compound error over a long-running world.
 */
export function lerpPhase(from: number, to: number, t: number): number {
  if (t <= 0) return wrapPhase(from);
  if (t >= 1) return wrapPhase(to);
  return wrapPhase(from + shortestPhaseDelta(from, to) * t);
}

/**
 * Two-pose interpolator for the single scalar this plugin ever tracks. Unlike
 * WeatherInterpolator there is no id to key by — there is exactly one clock
 * for the whole world.
 */
export class DayNightInterpolator {
  private fromPhase = 0;
  private toPhase = 0;
  /** Seconds elapsed within the current segment. */
  private elapsed = 0;
  /** Length of the current segment, measured from the last inter-message gap. */
  private window = DEFAULT_INTERPOLATION_SECONDS;
  /** Seconds since the previous message, for measuring the next window. */
  private sinceLastMessage = 0;
  private hasReceived = false;

  /**
   * Feeds a freshly received (already validated) phase. ORDER MATTERS exactly
   * as WeatherInterpolator.receive documents: the currently rendered phase is
   * frozen FIRST, before the window is re-measured, so an early message
   * cannot re-evaluate the ending segment against the new (shorter) window and
   * snap the sky to its end.
   *
   * THE VERY FIRST CALL EVER is the one exception, and it mirrors
   * WeatherInterpolator's per-system rule ("a system seen for the first time
   * has no history: it starts where the server says it is"): with no prior
   * broadcast, `rendered` is the new phase itself rather than this class's
   * pre-attach default of 0, so `fromPhase` and `toPhase` land on the same
   * value and samplePhase() reads it exactly regardless of progress — a
   * client that just joined must see the server's real phase immediately, not
   * spend one interpolation window still animating away from dawn.
   */
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

  /** Advances the frame clock. `dt` is seconds. */
  advance(dt: number): void {
    this.elapsed += dt;
    this.sinceLastMessage += dt;
  }

  /** Fraction of the current segment covered, clamped to [0, 1]. */
  progress(): number {
    if (this.window <= 0) return 1;
    return Math.min(1, this.elapsed / this.window);
  }

  /**
   * The phase to render this frame. Before the first broadcast this reads 0
   * (dawn) — the same honest "nothing received yet" default the server itself
   * boots into (server/index.ts: a fresh world starts at elapsedSeconds 0).
   */
  samplePhase(): number {
    if (!this.hasReceived) return this.fromPhase;
    return lerpPhase(this.fromPhase, this.toPhase, this.progress());
  }

  /** Forgets everything (used on dispose). */
  clear(): void {
    this.fromPhase = 0;
    this.toPhase = 0;
    this.elapsed = 0;
    this.sinceLastMessage = 0;
    this.window = DEFAULT_INTERPOLATION_SECONDS;
    this.hasReceived = false;
  }
}

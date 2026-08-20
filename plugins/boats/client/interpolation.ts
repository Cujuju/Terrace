// Smoothing 2 Hz server truth into 60 Hz motion.
//
// THE PATTERN IS THE MONSTERS PLUGIN'S (which took it from wildlife's), COPIED
// DELIBERATELY AND NOT IMPORTED: plugins are independently installable, and a
// boats plugin that stopped compiling because someone removed monsters would be
// a packaging bug dressed up as reuse. What is copied is the approach — keep the
// pose being RENDERED as the start of each segment, measure the window rather
// than assume it, clamp instead of extrapolate — and the bounds below are
// retuned for this plugin's own cadence.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`.

import type { BoatState } from '../protocol.ts';

/** A boat's pose for one frame. */
export interface InterpolatedBoat {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly fighting: boolean;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The floor is one 60 Hz frame. The CEILING is 1 s — HALF the monsters
 * plugin's, and that is the whole reason these are restated rather than shared:
 * boats broadcast at 2 Hz (BROADCAST_TICK_INTERVAL = 5 at TICK_HZ 10), so one
 * dropped message opens a 1 s gap, and a ceiling matched to that rides out
 * exactly one drop while still refusing to glide through a genuine stall.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 1;

/** Nominal window before any two messages have been seen (2 Hz = 0.5 s). */
export const DEFAULT_INTERPOLATION_SECONDS = 0.5;

const TWO_PI = Math.PI * 2;

/** Interpolates two angles the short way round. */
export function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return from + delta * t;
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

interface Pose {
  x: number;
  y: number;
  heading: number;
}

/**
 * Two-pose interpolator, keyed by boat id.
 *
 * A boat absent from the newest message is dropped immediately rather than
 * eased out. That is right for both ways a boat can leave the list: it SANK
 * (the disappearance is the event — a boat easing gently off-station would read
 * as it sailing away, which is the opposite of what happened), or it left this
 * player's unlocked view, where inventing further motion would be inventing
 * knowledge they do not have.
 *
 * Ids are never reused (server/fleet.ts's nextBoatId), so a sinking followed by
 * a later launch cannot blend the newcomer out of the dead boat's position.
 */
export class BoatInterpolator {
  private from = new Map<number, Pose>();
  private latest: readonly BoatState[] = [];
  private elapsed = 0;
  private window = DEFAULT_INTERPOLATION_SECONDS;
  private sinceLastMessage = 0;
  private hasReceived = false;

  /** Feeds a freshly received (already validated) boat list. */
  receive(boats: readonly BoatState[]): void {
    // ORDER MATTERS: freeze the currently rendered pose FIRST, because it is a
    // function of the segment that is ending and has to be read before the
    // window is re-measured for the one starting.
    const rendered = this.sample();

    if (this.hasReceived) {
      this.window = Math.min(
        MAX_INTERPOLATION_SECONDS,
        Math.max(MIN_INTERPOLATION_SECONDS, this.sinceLastMessage),
      );
    }
    this.hasReceived = true;
    this.sinceLastMessage = 0;

    const next = new Map<number, Pose>();
    for (const boat of boats) {
      const current = rendered.get(boat.id);
      next.set(
        boat.id,
        current === undefined
          ? { x: boat.x, y: boat.y, heading: boat.heading }
          : { x: current.x, y: current.y, heading: current.heading },
      );
    }

    this.from = next;
    this.latest = boats;
    this.elapsed = 0;
  }

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
   * Every boat's pose this frame, keyed by id. Clamped rather than
   * extrapolated: a boat holding station at the edge of a fight is stationary
   * for long stretches, and overshooting a thing that has stopped is worse than
   * briefly holding still.
   *
   * `fighting` comes from the authoritative message, never interpolated — it is
   * a boolean, and half-fighting is not a state.
   */
  sample(): Map<number, InterpolatedBoat> {
    const t = this.progress();
    const poses = new Map<number, InterpolatedBoat>();

    for (const boat of this.latest) {
      const start = this.from.get(boat.id);
      if (start === undefined) {
        poses.set(boat.id, boat);
        continue;
      }
      poses.set(boat.id, {
        id: boat.id,
        x: lerp(start.x, boat.x, t),
        y: lerp(start.y, boat.y, t),
        heading: lerpAngle(start.heading, boat.heading, t),
        fighting: boat.fighting,
      });
    }

    return poses;
  }

  clear(): void {
    this.from.clear();
    this.latest = [];
    this.elapsed = 0;
    this.sinceLastMessage = 0;
    this.window = DEFAULT_INTERPOLATION_SECONDS;
    this.hasReceived = false;
  }
}

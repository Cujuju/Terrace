// Smoothing 1 Hz server truth into 60 Hz motion.
//
// The server broadcasts the full system list once a second. Drawing those
// centres directly would step a rain front across the map like a stop-motion
// film — two cells at a time at the wind's ceiling. This module keeps the last
// rendered pose and the newest received one and walks between them.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`,
// which is what makes the whole thing testable in a node environment. It is the
// wildlife plugin's interpolator applied to a different payload, and the
// argument for every design choice in it is the same one — it is restated here
// rather than imported because plugins do not depend on each other's internals.

import type { WeatherKind, WeatherSystemState } from '../protocol.ts';

/** A system's pose for one frame. */
export interface InterpolatedSystem {
  readonly id: number;
  /**
   * Carried through untouched: a system's kind cannot change, so there is
   * nothing to interpolate and the rig it owns never has to be rebuilt.
   */
  readonly kind: WeatherKind;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
  readonly vx: number;
  readonly vy: number;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The window is measured rather than assumed, so this keeps working if the
 * server's tick rate or BROADCAST_TICK_INTERVAL is retuned — but a measurement
 * taken across a stall must not become the window. The floor is one 60 Hz frame
 * (below it, interpolation has nothing to do); the ceiling is two seconds,
 * sized to ride out exactly one dropped message at the shipped 1 Hz cadence,
 * past which a client is better off holding at truth than gliding through a
 * stale extrapolation. That 2 s ceiling is also what makes 1 Hz the FLOOR for
 * the broadcast interval — see the cadence note in server/index.ts.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 2;

/** Nominal window before any two messages have been seen (1 Hz = 1 s). */
export const DEFAULT_INTERPOLATION_SECONDS = 1;

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** The values that are walked between broadcasts. Radius is here for a reason. */
interface Pose {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  vx: number;
  vy: number;
}

/**
 * Two-pose interpolator, keyed by system id.
 *
 * The "from" pose of each segment is the pose that was actually being RENDERED
 * when the message arrived, not the previous message's pose. That distinction
 * matters: if a message is late, the client has already walked most of the way
 * to it, and starting the next segment from the rendered pose continues smoothly
 * instead of jumping back to re-run the interval it just covered.
 *
 * RADIUS AND VELOCITY ARE INTERPOLATED TOO even though the sim holds both
 * constant for a system's life (systems.ts: "a system's shape is fixed"; one
 * shared wind). Interpolating them costs four multiplies a frame and means this
 * class stays correct if either ever starts moving — where special-casing them
 * as constants would be an assumption about another module's internals that
 * nothing would fail loudly about.
 *
 * INTENSITY IS INTERPOLATED, AND THAT IS THE ONLY FADE ANYWHERE ON THIS SIDE.
 * The server ramps a system in and out over SYSTEM_FADE_SECONDS, so a system
 * enters the list at ~0 and leaves it at ~0; systems absent from the newest
 * message are therefore dropped immediately, exactly like a wildlife despawn,
 * with no client-side fade-out to invent. The one case that shows a step is a
 * client JOINING into weather already at full strength, which is the same
 * "everything appears at once on join" every plugin here has.
 */
export class WeatherInterpolator {
  /** Pose each system is being interpolated FROM. */
  private from = new Map<number, Pose>();
  /** Newest authoritative list, in the server's order. */
  private latest: readonly WeatherSystemState[] = [];
  /** Seconds elapsed within the current segment. */
  private elapsed = 0;
  /** Length of the current segment, measured from the last inter-message gap. */
  private window = DEFAULT_INTERPOLATION_SECONDS;
  /** Seconds since the previous message, for measuring the next window. */
  private sinceLastMessage = 0;
  private hasReceived = false;

  /** Feeds a freshly received (already validated) system list. */
  receive(systems: readonly WeatherSystemState[]): void {
    // ORDER MATTERS. Freeze the currently rendered pose FIRST: it is a function
    // of the segment that is ending, so it has to be read before the window is
    // re-measured for the segment that is starting. Doing it the other way round
    // makes an early message re-evaluate the old segment against the new
    // (shorter) window and snap the front to the end of it.
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
    for (const system of systems) {
      const current = rendered.get(system.id);
      // A system seen for the first time has no history: it starts where the
      // server says it is, which is the only honest answer.
      next.set(system.id, {
        x: current?.x ?? system.x,
        y: current?.y ?? system.y,
        radius: current?.radius ?? system.radius,
        intensity: current?.intensity ?? system.intensity,
        vx: current?.vx ?? system.vx,
        vy: current?.vy ?? system.vy,
      });
    }

    this.from = next;
    this.latest = systems;
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
   * The pose of every live system this frame, keyed by id. Interpolation is
   * clamped at 1 rather than extrapolated: overshooting the last known centre of
   * a system whose wind may have veered is worse than briefly holding still, and
   * a held front for the tail of a late message is invisible where a front that
   * ran ahead and jumped back is not.
   */
  sample(): Map<number, InterpolatedSystem> {
    const t = this.progress();
    const poses = new Map<number, InterpolatedSystem>();

    for (const system of this.latest) {
      const start = this.from.get(system.id);
      if (start === undefined) {
        poses.set(system.id, system);
        continue;
      }
      poses.set(system.id, {
        id: system.id,
        kind: system.kind,
        x: lerp(start.x, system.x, t),
        y: lerp(start.y, system.y, t),
        radius: lerp(start.radius, system.radius, t),
        intensity: lerp(start.intensity, system.intensity, t),
        vx: lerp(start.vx, system.vx, t),
        vy: lerp(start.vy, system.vy, t),
      });
    }

    return poses;
  }

  /** Forgets everything (used on dispose). */
  clear(): void {
    this.from.clear();
    this.latest = [];
    this.elapsed = 0;
    this.sinceLastMessage = 0;
    this.window = DEFAULT_INTERPOLATION_SECONDS;
    this.hasReceived = false;
  }
}

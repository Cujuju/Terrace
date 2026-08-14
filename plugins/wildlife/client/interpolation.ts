// Smoothing 5 Hz server truth into 60 Hz motion.
//
// The server broadcasts the full entity list every other tick (200 ms). Drawing
// those positions directly would tick creatures forward five times a second like
// a stop-motion film. This module keeps the last rendered pose and the newest
// received one and walks between them.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`,
// which is what makes the whole thing testable in a node environment.

import type { WildlifeEntityState, WildlifeSpecies } from '../protocol.ts';

/** A creature's pose for one frame. */
export interface InterpolatedEntity {
  readonly id: number;
  readonly species: WildlifeSpecies;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The window is measured rather than assumed, so this keeps working if the
 * server's tick rate or BROADCAST_TICK_INTERVAL is retuned — but a measurement
 * taken across a stall must not become the window. The floor is one 60 Hz frame
 * (below it, interpolation has nothing to do); the ceiling is one second, past
 * which a client is better off snapping to truth than gliding through a second
 * of stale extrapolation.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 1;

/** Nominal window before any two messages have been seen (5 Hz = 200 ms). */
export const DEFAULT_INTERPOLATION_SECONDS = 0.2;

const TWO_PI = Math.PI * 2;

/**
 * Interpolates between two angles the short way round, so a creature turning
 * through ±π spins 10° rather than 350°.
 */
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
 * Two-pose interpolator, keyed by entity id.
 *
 * The "from" pose of each segment is the pose that was actually being RENDERED
 * when the message arrived, not the previous message's pose. That distinction
 * matters: if a message is late, the client has already walked most of the way
 * to it, and starting the next segment from the rendered pose continues smoothly
 * instead of jumping back to re-run the interval it just covered.
 *
 * Entities absent from the newest message are dropped immediately — a despawn is
 * something the server has already decided, and easing a creature out would mean
 * inventing a position no one authorised.
 */
export class WildlifeInterpolator {
  /** Pose each entity is being interpolated FROM. */
  private from = new Map<number, Pose>();
  /** Newest authoritative pose, and the species/order of the current population. */
  private latest: readonly WildlifeEntityState[] = [];
  /** Seconds elapsed within the current segment. */
  private elapsed = 0;
  /** Length of the current segment, measured from the last inter-message gap. */
  private window = DEFAULT_INTERPOLATION_SECONDS;
  /** Seconds since the previous message, for measuring the next window. */
  private sinceLastMessage = 0;
  private hasReceived = false;

  /** Feeds a freshly received (already validated) entity list. */
  receive(entities: readonly WildlifeEntityState[]): void {
    // ORDER MATTERS. Freeze the currently rendered pose FIRST: it is a function
    // of the segment that is ending, so it has to be read before the window is
    // re-measured for the segment that is starting. Doing it the other way round
    // makes an early message re-evaluate the old segment against the new
    // (shorter) window and snap the creature to the end of it.
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
    for (const entity of entities) {
      const current = rendered.get(entity.id);
      // An entity seen for the first time has no history: it starts where the
      // server says it is, which is the only honest answer.
      next.set(
        entity.id,
        current === undefined
          ? { x: entity.x, y: entity.y, heading: entity.heading }
          : { x: current.x, y: current.y, heading: current.heading },
      );
    }

    this.from = next;
    this.latest = entities;
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
   * The pose of every living creature this frame, keyed by id. Interpolation is
   * clamped at 1 rather than extrapolated: overshooting the last known position
   * of a creature that may have turned is worse than briefly holding still.
   */
  sample(): Map<number, InterpolatedEntity> {
    const t = this.progress();
    const poses = new Map<number, InterpolatedEntity>();

    for (const entity of this.latest) {
      const start = this.from.get(entity.id);
      if (start === undefined) {
        poses.set(entity.id, entity);
        continue;
      }
      poses.set(entity.id, {
        id: entity.id,
        species: entity.species,
        x: lerp(start.x, entity.x, t),
        y: lerp(start.y, entity.y, t),
        heading: lerpAngle(start.heading, entity.heading, t),
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

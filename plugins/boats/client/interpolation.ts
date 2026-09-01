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
  /** The receive() generation that last listed this id; older entries are dead. */
  generation: number;
}

/**
 * One boat's pose record. Mutable and PERSISTENT: sample() refills these in
 * place every frame instead of allocating a Map and an object per boat per
 * frame (perf review 2026-08-29, A5). Consumers see it through the readonly
 * InterpolatedBoat face and must not hold one across frames.
 */
interface PoseRecord extends InterpolatedBoat {
  x: number;
  y: number;
  heading: number;
  fighting: InterpolatedBoat['fighting'];
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
  /** The records sample() hands out, keyed by id — refilled, never rebuilt. */
  private readonly poses = new Map<number, PoseRecord>();
  /** Bumped per receive(); a `from` entry not stamped with it has despawned. */
  private generation = 0;
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

    // Refilled in place; entries the message no longer lists are pruned below,
    // and the sampled records for those ids go with them.
    const generation = ++this.generation;
    for (const boat of boats) {
      const current = rendered.get(boat.id);
      let start = this.from.get(boat.id);
      if (start === undefined) {
        start = { x: 0, y: 0, heading: 0, generation };
        this.from.set(boat.id, start);
      }
      // One seen for the first time has no history: it starts where the server
      // says it is, which is the only honest answer.
      const source = current === undefined ? boat : current;
      start.x = source.x;
      start.y = source.y;
      start.heading = source.heading;
      start.generation = generation;
    }
    for (const [id, start] of this.from) {
      if (start.generation !== generation) {
        this.from.delete(id);
        this.poses.delete(id);
      }
    }
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
  sample(): ReadonlyMap<number, InterpolatedBoat> {
    const t = this.progress();
    const poses = this.poses;

    for (const boat of this.latest) {
      let record = poses.get(boat.id);
      if (record === undefined) {
        record = { ...boat };
        poses.set(boat.id, record);
      }
      record.fighting = boat.fighting;
      const start = this.from.get(boat.id);
      if (start === undefined) {
        record.x = boat.x;
        record.y = boat.y;
        record.heading = boat.heading;
        continue;
      }
      record.x = lerp(start.x, boat.x, t);
      record.y = lerp(start.y, boat.y, t);
      record.heading = lerpAngle(start.heading, boat.heading, t);
    }

    return poses;
  }

  clear(): void {
    this.from.clear();
    this.poses.clear();
    this.latest = [];
    this.elapsed = 0;
    this.sinceLastMessage = 0;
    this.window = DEFAULT_INTERPOLATION_SECONDS;
    this.hasReceived = false;
  }
}

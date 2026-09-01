// Smoothing 1 Hz server truth into 60 Hz motion.
//
// THE PATTERN IS THE WILDLIFE PLUGIN'S, COPIED DELIBERATELY AND NOT IMPORTED
// (plugins/wildlife/client/interpolation.ts). Plugins are independently
// installable; a monsters plugin that stopped compiling because someone removed
// wildlife would be a packaging bug dressed up as reuse. What is copied is the
// approach — keep the pose being RENDERED as the start of each segment, measure
// the window rather than assume it, clamp instead of extrapolate — and the two
// bounds below are retuned for this plugin's much slower cadence.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`,
// which is what makes the whole thing testable in a node environment.

import type { MonsterKind, MonsterState, YetiVariant } from '../protocol.ts';

/** A monster's pose for one frame. */
export interface InterpolatedMonster {
  readonly id: number;
  readonly kind: MonsterKind;
  /**
   * Carried through UNINTERPOLATED, obviously — it is a name, and it never
   * changes over one monster's life. It rides here rather than being looked up
   * from the raw list because this map is what the render path reconciles
   * against, and a renderer that had to consult two sources to build one model
   * is a renderer that can build it from a stale half.
   */
  readonly variant?: YetiVariant;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The window is measured rather than assumed, so this keeps working if the
 * server's tick rate or BROADCAST_TICK_INTERVAL is retuned — but a measurement
 * taken across a stall must not become the window.
 *
 * The floor is one 60 Hz frame (below it, interpolation has nothing to do). The
 * CEILING is 2 s, twice the wildlife plugin's, and the difference is the whole
 * reason these constants are restated rather than reused: at 1 Hz a single
 * dropped message opens a 2 s gap, and a 1 s ceiling would clamp it and snap
 * the monster forward mid-glide. Two seconds rides out exactly one drop and
 * still refuses to glide through a genuine stall.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 2;

/** Nominal window before any two messages have been seen (1 Hz = 1 s). */
export const DEFAULT_INTERPOLATION_SECONDS = 1;

const TWO_PI = Math.PI * 2;

/**
 * Interpolates between two angles the short way round, so a monster turning
 * through ±π swings 10° rather than 350°.
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
  /** The receive() generation that last listed this id; older entries are dead. */
  generation: number;
}

/**
 * One monster's pose record. Mutable and PERSISTENT: sample() refills these in
 * place every frame instead of allocating a Map and an object per monster per
 * frame (perf review 2026-08-29, A5). Consumers see it through the readonly
 * InterpolatedMonster face and must not hold one across frames.
 */
interface PoseRecord extends InterpolatedMonster {
  x: number;
  y: number;
  heading: number;
  kind: InterpolatedMonster['kind'];
  variant?: YetiVariant;
}

/**
 * Two-pose interpolator, keyed by monster id.
 *
 * The "from" pose of each segment is the pose that was actually being RENDERED
 * when the message arrived, not the previous message's pose. That distinction
 * matters: if a message is late, the client has already walked most of the way
 * to it, and starting the next segment from the rendered pose continues smoothly
 * instead of jumping back to re-run the interval it just covered.
 *
 * A monster absent from the newest message is dropped immediately. Easing it out
 * would mean inventing a position no one authorised — and here the despawn is
 * the plot: the thing submerged, it did not wander off.
 *
 * Keyed by id, which was already the right shape when a world held at most one
 * monster and is load-bearing now that it holds one per habitat. Ids are never
 * reused (server/summoning.ts), so a banishment followed by a later arrival
 * cannot blend the newcomer out of the departed one's position — and two
 * monsters alive at once cannot be confused for one that teleported.
 */
export class MonsterInterpolator {
  /** Pose each monster is being interpolated FROM. */
  private from = new Map<number, Pose>();
  /** The records sample() hands out, keyed by id — refilled, never rebuilt. */
  private readonly poses = new Map<number, PoseRecord>();
  /** Bumped per receive(); a `from` entry not stamped with it has despawned. */
  private generation = 0;
  /** Newest authoritative poses. */
  private latest: readonly MonsterState[] = [];
  /** Seconds elapsed within the current segment. */
  private elapsed = 0;
  /** Length of the current segment, measured from the last inter-message gap. */
  private window = DEFAULT_INTERPOLATION_SECONDS;
  /** Seconds since the previous message, for measuring the next window. */
  private sinceLastMessage = 0;
  private hasReceived = false;

  /** Feeds a freshly received (already validated) monster list. */
  receive(monsters: readonly MonsterState[]): void {
    // ORDER MATTERS. Freeze the currently rendered pose FIRST: it is a function
    // of the segment that is ending, so it has to be read before the window is
    // re-measured for the segment that is starting. Doing it the other way round
    // makes an early message re-evaluate the old segment against the new
    // (shorter) window and snap the monster to the end of it.
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
    for (const monster of monsters) {
      const current = rendered.get(monster.id);
      let start = this.from.get(monster.id);
      if (start === undefined) {
        start = { x: 0, y: 0, heading: 0, generation };
        this.from.set(monster.id, start);
      }
      // One seen for the first time has no history: it starts where the server
      // says it is, which is the only honest answer.
      const source = current === undefined ? monster : current;
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
    this.latest = monsters;
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
   * The pose of every living monster this frame, keyed by id. Clamped at 1
   * rather than extrapolated: overshooting the last known position of something
   * that may have stopped dead — and stopping dead is half its behaviour — is
   * worse than briefly holding still.
   */
  sample(): ReadonlyMap<number, InterpolatedMonster> {
    const t = this.progress();
    const poses = this.poses;

    for (const monster of this.latest) {
      let record = poses.get(monster.id);
      if (record === undefined) {
        record = { ...monster };
        poses.set(monster.id, record);
      }
      record.kind = monster.kind;
      if (monster.variant === undefined) delete record.variant;
      else record.variant = monster.variant;
      const start = this.from.get(monster.id);
      if (start === undefined) {
        record.x = monster.x;
        record.y = monster.y;
        record.heading = monster.heading;
        continue;
      }
      record.x = lerp(start.x, monster.x, t);
      record.y = lerp(start.y, monster.y, t);
      record.heading = lerpAngle(start.heading, monster.heading, t);
    }

    return poses;
  }

  /** Forgets everything (used on dispose). */
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

// Smoothing broadcast truth into frame-rate motion.
//
// THE PROBLEM EVERY MOVING PLUGIN HAS. The server broadcasts a full list of
// things — boats, monsters, pilgrims, creatures, weather systems — at somewhere
// between 1 and 5 Hz. Drawing those poses directly steps them across the map
// like a stop-motion film. This keeps the last RENDERED pose and the newest
// received one and walks between them.
//
// WHY IT IS HERE. Five plugins carried the same class over different payloads:
// the same window measurement, the same "freeze the rendered pose first" order,
// the same generation-stamped prune, the same recycled pose records (perf review
// 2026-08-29, A5). Only the FIELDS differed. What is left with each plugin is
// exactly the field-specific part — its window constants, and the three little
// functions that say which fields walk, which turn the short way round, and
// which are carried through untouched.
//
// PARAMETERISED BY FUNCTIONS, NOT BY FIELD-NAME LISTS. A list of keys would make
// every per-frame field access a dynamic property lookup on a megamorphic shape,
// which is exactly the cost the recycled records were introduced to remove. The
// callbacks below keep each plugin's field access monomorphic and inlineable.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`,
// which is what makes the whole thing testable in a node environment.

/**
 * The pose a segment is walked FROM, as the kit sees it.
 *
 * `generation` is the kit's bookkeeping and a plugin never reads it: it is
 * stamped on every id the newest message listed, so an id the message did NOT
 * list is recognisable without allocating a Set of ids on every receive.
 */
export interface PoseSegment {
  generation: number;
}

/**
 * The field-specific half of an interpolator: what the fields ARE.
 *
 * `S` is the plugin's broadcast state, `F` its "from" pose, `R` the record
 * `sample()` hands out.
 */
export interface PoseInterpolatorSpec<S, F extends PoseSegment, R> {
  /**
   * Bounds on the measured inter-message gap used as the interpolation window.
   *
   * The window is MEASURED rather than assumed, so a plugin keeps working if the
   * server's tick rate or its broadcast interval is retuned — but a measurement
   * taken across a stall must not become the window. The floor is one frame
   * (below it, interpolation has nothing to do); the ceiling is what the plugin
   * is willing to glide through, past which a client is better off holding at
   * truth than running on a stale extrapolation.
   */
  readonly minWindowSeconds: number;
  readonly maxWindowSeconds: number;
  /** Nominal window before any two messages have been seen. */
  readonly defaultWindowSeconds: number;

  /** A fresh, zeroed segment. Every field is overwritten by `freeze` at once. */
  createSegment(): F;
  /**
   * Copies the walked fields of `source` into `target`. The source is either the
   * pose that was being RENDERED when the message arrived, or — for something
   * seen for the first time — the authoritative state itself.
   */
  freeze(target: F, source: S | R): void;
  /** A fresh output record for a state seen for the first time. */
  createRecord(state: S): R;
  /**
   * Refills `record` for this frame. `segment` is the pose to walk FROM, or
   * undefined for something with no history — which starts where the server says
   * it is, the only honest answer.
   */
  updateRecord(record: R, state: S, segment: F | undefined, t: number): void;
}

/** Linear interpolation. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

const TWO_PI = Math.PI * 2;

/**
 * Interpolates between two angles the short way round, so a thing turning
 * through ±π spins 10° rather than 350°.
 */
export function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return from + delta * t;
}

/**
 * Two-pose interpolator, keyed by id.
 *
 * THE "FROM" POSE OF EACH SEGMENT IS THE POSE THAT WAS ACTUALLY BEING RENDERED
 * when the message arrived, not the previous message's pose. That distinction
 * matters: if a message is late, the client has already walked most of the way
 * to it, and starting the next segment from the rendered pose continues smoothly
 * instead of jumping back to re-run the interval it just covered.
 *
 * IDS ABSENT FROM THE NEWEST MESSAGE ARE DROPPED IMMEDIATELY. A despawn is
 * something the server has already decided, and easing something out would mean
 * inventing a pose no one authorised. (Plugins whose things fade do it on the
 * SERVER, by ramping a field this walks like any other.)
 */
export class PoseInterpolator<S extends { readonly id: number }, F extends PoseSegment, R> {
  /** Pose each id is being interpolated FROM. */
  private readonly from = new Map<number, F>();
  /**
   * The records `sample()` hands out, keyed by id — REFILLED, never rebuilt.
   *
   * Mutable and persistent: sample() runs every frame over every live thing, and
   * allocating a Map and an object per thing per frame was measurable (perf
   * review 2026-08-29, A5). Consumers see them through a readonly face and must
   * not hold one across frames.
   */
  private readonly poses = new Map<number, R>();
  /** Bumped per receive(); a `from` entry not stamped with it has vanished. */
  private generation = 0;
  /** Newest authoritative list, in the server's order. */
  private latest: readonly S[] = [];
  /** Seconds elapsed within the current segment. */
  private elapsed = 0;
  /** Length of the current segment, measured from the last inter-message gap. */
  private window: number;
  /** Seconds since the previous message, for measuring the next window. */
  private sinceLastMessage = 0;
  private hasReceived = false;

  // A plain field, not a constructor parameter property: that syntax is not
  // erasable, and the test runner executes this file through Node's own
  // type stripping (vitest.base.config.ts).
  private readonly spec: PoseInterpolatorSpec<S, F, R>;

  constructor(spec: PoseInterpolatorSpec<S, F, R>) {
    this.spec = spec;
    this.window = spec.defaultWindowSeconds;
  }

  /** Feeds a freshly received (already validated) list. */
  receive(states: readonly S[]): void {
    const spec = this.spec;

    // ORDER MATTERS. Freeze the currently rendered pose FIRST: it is a function
    // of the segment that is ENDING, so it has to be read before the window is
    // re-measured for the segment that is starting. Doing it the other way round
    // makes an early message re-evaluate the old segment against the new
    // (shorter) window and snap everything to the end of it.
    const rendered = this.sample();

    if (this.hasReceived) {
      this.window = Math.min(
        spec.maxWindowSeconds,
        Math.max(spec.minWindowSeconds, this.sinceLastMessage),
      );
    }
    this.hasReceived = true;
    this.sinceLastMessage = 0;

    const generation = ++this.generation;
    for (const state of states) {
      const current = rendered.get(state.id);
      let start = this.from.get(state.id);
      if (start === undefined) {
        start = spec.createSegment();
        this.from.set(state.id, start);
      }
      spec.freeze(start, current === undefined ? state : current);
      start.generation = generation;
    }
    for (const [id, start] of this.from) {
      if (start.generation !== generation) {
        this.from.delete(id);
        this.poses.delete(id);
      }
    }

    this.latest = states;
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
   * The pose of everything live this frame, keyed by id.
   *
   * CLAMPED AT 1 RATHER THAN EXTRAPOLATED: overshooting the last known pose of
   * something that may have turned is worse than briefly holding still, and a
   * held pose for the tail of a late message is invisible where one that ran
   * ahead and jumped back is not.
   */
  sample(): ReadonlyMap<number, R> {
    const spec = this.spec;
    const t = this.progress();
    const poses = this.poses;

    for (const state of this.latest) {
      let record = poses.get(state.id);
      if (record === undefined) {
        record = spec.createRecord(state);
        poses.set(state.id, record);
      }
      spec.updateRecord(record, state, this.from.get(state.id), t);
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
    this.window = this.spec.defaultWindowSeconds;
    this.hasReceived = false;
  }
}

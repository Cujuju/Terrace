// THE CLIENT HALF OF A DRIFTING-DISC PLUGIN, as a mechanism: subscribe to the
// mass list, interpolate it, keep one pooled rig per living mass, animate them.
//
// Four plugins do exactly this and differ only in which message they listen to
// and what a rig of theirs contains. They cannot import each other — a plugin
// folder is deletable — so the alternative to this file is four copies of the
// same hundred lines.
//
// IT HOLDS NO AUTHORITY: it never spawns a mass, never moves one of its own
// accord, and never predicts. Between broadcasts it interpolates and animates;
// both are purely cosmetic, so a client that misses messages looks stiller,
// never wrong.
//
// AN EMPTY LIST COSTS NOTHING. No masses means no rigs parented into the scene,
// no buffers written, no draw calls, and no change to any global scene state —
// the sun, the sky and scene.fog are exactly what core set them to.

import { Group } from 'three';
import type { ClientPluginCtx } from '../types.ts';
import { DiscInterpolator, type InterpolatedDisc } from './discInterpolator.ts';
import type { RigPool } from './discRig.ts';
import { reconcileById } from './viewReconcile.ts';
import { watchReducedMotion } from './reducedMotion.ts';
import { parseDiscSystemsPayload } from '@terrace/shared';

/**
 * Cap on the animation clock's advance per frame, in seconds. `onFrame`'s dt is
 * already capped by the host, but the animation clock is an accumulator: this
 * keeps a pathological frame (a background tab coming back) from jumping every
 * particle a full cycle and every sheet a full turn.
 */
export const MAX_ANIMATION_STEP_SECONDS = 0.1;

/** What a plugin tells this view about itself. */
export interface DiscSystemsViewSpec<R extends { readonly root: Group }> {
  /** The UN-namespaced message carrying the mass list; the host prefixes it. */
  readonly systemsMessage: string;
  /** Name of this plugin's own child Group, for the three.js inspector. */
  readonly containerName: string;
  /**
   * Built at attach, disposed at dispose. One rig per living mass.
   *
   * TAKES THE CONTEXT because a pool's materials have to be clipped to the
   * revealed map (`ClientPluginCtx.applyRevealClip`) and its cloud deck has to
   * be built from it, and both are decided once, when the material and the
   * deck are created, rather than per frame.
   */
  createPool(ctx: ClientPluginCtx): RigPool<R>;
  /** One frame of one rig. */
  update(rig: R, disc: InterpolatedDisc, elapsed: number, dt: number, reduced: boolean): void;
  /**
   * Anything else this plugin parents into its layer BESIDE the masses — a
   * fixed light bank, a loose bolt that belongs to no mass. Called once, after
   * the pool exists.
   */
  attachExtras?(ctx: ClientPluginCtx): void;
  /** Per-frame work for those extras, run whatever the sky is doing. */
  frameExtras?(dt: number, reduced: boolean): void;
  /** Freed at dispose, before the pool is. */
  disposeExtras?(): void;
}

/** A plugin's live view of its own masses. */
export interface DiscSystemsView<R> {
  attach(ctx: ClientPluginCtx): void;
  dispose(): void;
  /** The rig drawing this mass right now, or undefined. */
  rigFor(id: number): R | undefined;
  /** This frame's interpolated pose for a mass, or undefined. */
  poseFor(id: number): InterpolatedDisc | undefined;
  /**
   * Every living mass's interpolated pose this frame.
   *
   * THE SAME MAP THE RIGS WERE DRAWN FROM, which is what makes a ground shade
   * published out of it land under the cloud that is actually on screen rather
   * than under where it was at the last broadcast.
   */
  poses(): ReadonlyMap<number, InterpolatedDisc>;
  /** Whether the viewer asked for reduced motion. */
  isReduced(): boolean;
}

export function createDiscSystemsView<R extends { readonly root: Group }>(
  spec: DiscSystemsViewSpec<R>,
): DiscSystemsView<R> {
  let pool: RigPool<R> | null = null;
  let container: Group | null = null;
  /** The rig drawing each live mass, keyed by system id. */
  const views = new Map<number, R>();
  const interpolator = new DiscInterpolator();
  /**
   * The animation clock. It STOPS ADVANCING under prefers-reduced-motion, and
   * that one line is what becalms the whole plugin: fall, sway, spin and bob are
   * all functions of it, so none of them needs its own reduced-motion branch.
   */
  let animationSeconds = 0;
  let reducedMotion: { matches(): boolean; stop(): void } | null = null;
  let unsubscribeMessages: (() => void) | null = null;
  let unsubscribeFrames: (() => void) | null = null;

  function reconcileViews(sampled: ReadonlyMap<number, InterpolatedDisc>): void {
    const rigs = pool;
    const scene = container;
    if (rigs === null || scene === null) return;

    reconcileById(sampled, views, {
      // RELEASES FIRST, THEN ACQUIRES. One broadcast can retire a mass and
      // introduce another, and doing it the other way round makes the newcomer
      // build a rig while the one it could have reused is still a frame away
      // from the free list — a needless buffer and, for some plugins, a needless
      // shader recompile.
      order: 'release-first',
      acquire: () => {
        const rig = rigs.acquire();
        scene.add(rig.root);
        return rig;
      },
      release: (_id, rig) => {
        scene.remove(rig.root);
        // Back to the pool, not disposed: the next mass is minutes away and will
        // want exactly this rig.
        rigs.release(rig);
      },
    });
  }

  function renderFrame(dt: number): void {
    const reduced = reducedMotion?.matches() ?? false;
    if (!reduced) animationSeconds += Math.min(dt, MAX_ANIMATION_STEP_SECONDS);

    interpolator.advance(dt);
    spec.frameExtras?.(dt, reduced);

    const sampled = interpolator.sample();
    reconcileViews(sampled);

    for (const [id, disc] of sampled) {
      const rig = views.get(id);
      if (rig === undefined) continue;
      spec.update(rig, disc, animationSeconds, dt, reduced);
    }
  }

  return {
    attach(ctx: ClientPluginCtx): void {
      pool = spec.createPool(ctx);
      reducedMotion = watchReducedMotion();

      // One child Group of our own inside the host's layer: it keeps every mass
      // under a single named node, which makes the scene graph legible in the
      // three.js inspector and gives dispose() one thing to clear.
      container = new Group();
      container.name = spec.containerName;
      ctx.layer.add(container);

      spec.attachExtras?.(ctx);

      unsubscribeMessages = ctx.onMessage(spec.systemsMessage, (payload) => {
        const systems = parseDiscSystemsPayload(payload);
        // A malformed payload is dropped whole: what is already on screen keeps
        // drawing until the next good message, which is a second away.
        if (systems === null) return;
        interpolator.receive(systems);
      });

      unsubscribeFrames = ctx.onFrame((dt) => renderFrame(dt));
    },

    dispose(): void {
      unsubscribeMessages?.();
      unsubscribeFrames?.();
      unsubscribeMessages = null;
      unsubscribeFrames = null;

      views.clear();
      interpolator.clear();

      container?.clear();
      container = null;

      spec.disposeExtras?.();
      pool?.dispose();
      pool = null;

      reducedMotion?.stop();
      reducedMotion = null;
      animationSeconds = 0;
    },

    rigFor(id: number): R | undefined {
      return views.get(id);
    },

    poseFor(id: number): InterpolatedDisc | undefined {
      return interpolator.sample().get(id);
    },

    poses(): ReadonlyMap<number, InterpolatedDisc> {
      return interpolator.sample();
    },

    isReduced(): boolean {
      return reducedMotion?.matches() ?? false;
    },
  };
}

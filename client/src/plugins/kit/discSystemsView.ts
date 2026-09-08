import { Group } from 'three';
import type { ClientPluginCtx } from '../types.ts';
import { DiscInterpolator, type InterpolatedDisc } from './discInterpolator.ts';
import type { RigPool } from './discRig.ts';
import type { CumulusDeck } from './cumulusDeck.ts';
import { reconcileById } from './viewReconcile.ts';
import { watchReducedMotion } from './reducedMotion.ts';
import { parseDiscSystemsPayload } from '@terrace/shared';

export const MAX_ANIMATION_STEP_SECONDS = 0.1;

export interface DiscSystemsViewSpec<R extends { readonly root: Group }> {
  readonly systemsMessage: string;
  readonly containerName: string;
  createPool(ctx: ClientPluginCtx): RigPool<R>;
  update(rig: R, disc: InterpolatedDisc, elapsed: number, dt: number, reduced: boolean): void;
  deck?(): CumulusDeck | null;
  attachExtras?(ctx: ClientPluginCtx): void;
  frameExtras?(dt: number, reduced: boolean): void;
  disposeExtras?(): void;
}

export interface DiscSystemsView<R> {
  attach(ctx: ClientPluginCtx): void;
  dispose(): void;
  rigFor(id: number): R | undefined;
  poseFor(id: number): InterpolatedDisc | undefined;
  poses(): ReadonlyMap<number, InterpolatedDisc>;
  isReduced(): boolean;
}

export function createDiscSystemsView<R extends { readonly root: Group }>(
  spec: DiscSystemsViewSpec<R>,
): DiscSystemsView<R> {
  let pool: RigPool<R> | null = null;
  let container: Group | null = null;
  const views = new Map<number, R>();
  const interpolator = new DiscInterpolator();
  let animationSeconds = 0;
  let reducedMotion: { matches(): boolean; stop(): void } | null = null;
  let context: ClientPluginCtx | null = null;
  let unsubscribeMessages: (() => void) | null = null;
  let unsubscribeFrames: (() => void) | null = null;

  function reconcileViews(sampled: ReadonlyMap<number, InterpolatedDisc>): void {
    const rigs = pool;
    const scene = container;
    if (rigs === null || scene === null) return;

    reconcileById(sampled, views, {
      order: 'release-first',
      acquire: () => {
        const rig = rigs.acquire();
        scene.add(rig.root);
        return rig;
      },
      release: (_id, rig) => {
        scene.remove(rig.root);
        rigs.release(rig);
      },
    });
  }

  function renderFrame(dt: number): void {
    const reduced = reducedMotion?.matches() ?? false;
    if (!reduced) animationSeconds += Math.min(dt, MAX_ANIMATION_STEP_SECONDS);

    interpolator.advance(dt);

    if (context !== null) {
      spec.deck?.()?.orderAgainstCamera(context.cameraPosition().y);
    }

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
      context = ctx;
      pool = spec.createPool(ctx);
      reducedMotion = watchReducedMotion();

      container = new Group();
      container.name = spec.containerName;
      ctx.layer.add(container);

      spec.attachExtras?.(ctx);

      unsubscribeMessages = ctx.onMessage(spec.systemsMessage, (payload) => {
        const systems = parseDiscSystemsPayload(payload);
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
      context = null;

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

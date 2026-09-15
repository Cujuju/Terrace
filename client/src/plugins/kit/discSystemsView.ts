import { Group, type Object3D } from 'three';
import type { ClientPluginCtx, GroundShadeDisc } from '../types.ts';
import { DiscInterpolator, type InterpolatedDisc } from './discInterpolator.ts';
import type { RigPool } from './discRig.ts';
import { DECK_BASE_WORLD_Y, DECK_RIM_FADE_START, type CumulusDeck } from './cumulusDeck.ts';
import { reconcileById } from './viewReconcile.ts';
import { watchReducedMotion } from './reducedMotion.ts';
import { CELL_WORLD_SIZE, parseDiscSystemsPayload } from '@terrace/shared';

export const MAX_ANIMATION_STEP_SECONDS = 0.1;

export interface DiscSystemsViewSpec<R extends { readonly root: Group }> {
  readonly systemsMessage: string;
  readonly containerName: string;
  readonly maxSystems?: number;
  createPool(ctx: ClientPluginCtx): RigPool<R>;
  update(rig: R, disc: InterpolatedDisc, elapsed: number, dt: number, reduced: boolean): void;
  deck?(): CumulusDeck | null;
  kindObjects?(): readonly Object3D[];
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
  let unsubscribeReset: (() => void) | null = null;
  const kindObjects: Object3D[] = [];

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

      for (const object of spec.kindObjects?.() ?? []) kindObjects.push(object);
      for (const object of kindObjects) ctx.layer.add(object);

      spec.attachExtras?.(ctx);

      unsubscribeMessages = ctx.onMessage(spec.systemsMessage, (payload) => {
        const systems = parseDiscSystemsPayload(payload, spec.maxSystems);
        if (systems === null) return;
        interpolator.receive(systems);
      });

      unsubscribeReset = ctx.onWorldReset(() => {
        interpolator.clear();
        reconcileViews(interpolator.sample());
      });

      unsubscribeFrames = ctx.onFrame((dt) => renderFrame(dt));
    },

    dispose(): void {
      unsubscribeMessages?.();
      unsubscribeFrames?.();
      unsubscribeReset?.();
      unsubscribeMessages = null;
      unsubscribeFrames = null;
      unsubscribeReset = null;

      views.clear();
      interpolator.clear();

      container?.clear();
      container?.removeFromParent();
      container = null;

      for (const object of kindObjects) object.removeFromParent();
      kindObjects.length = 0;

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

type MutableGroundShadeDisc = { -readonly [K in keyof GroundShadeDisc]: GroundShadeDisc[K] };

function blankShadeDisc(): MutableGroundShadeDisc {
  return { x: 0, z: 0, y: 0, radius: 0, darkness: 0, inner: 0 };
}

// One ground-shade disc per lit system, refilled in place over a pool: the
// gauge runs every frame and must allocate nothing.
export function deckShadeFrom(
  view: DiscSystemsView<unknown>,
  darkness: number,
): () => readonly GroundShadeDisc[] {
  const pool: MutableGroundShadeDisc[] = [];
  const shade: GroundShadeDisc[] = [];
  return () => {
    shade.length = 0;
    for (const disc of view.poses().values()) {
      if (disc.intensity <= 0) continue;
      while (pool.length <= shade.length) pool.push(blankShadeDisc());
      const filled = pool[shade.length]!;
      filled.x = disc.x * CELL_WORLD_SIZE;
      filled.z = disc.y * CELL_WORLD_SIZE;
      filled.y = DECK_BASE_WORLD_Y;
      filled.radius = disc.radius * CELL_WORLD_SIZE;
      filled.darkness = darkness * disc.intensity;
      filled.inner = DECK_RIM_FADE_START;
      shade.push(filled);
    }
    return shade;
  };
}

// The loudest system over the camera: intensity faded to nothing at its rim.
export function discWeightUnderCamera(
  view: DiscSystemsView<unknown>,
  ctx: ClientPluginCtx,
): number {
  const camera = ctx.cameraPosition();
  const cameraCellX = camera.x / CELL_WORLD_SIZE;
  const cameraCellY = camera.z / CELL_WORLD_SIZE;
  let loudest = 0;
  for (const disc of view.poses().values()) {
    if (disc.intensity <= 0 || disc.radius <= 0) continue;
    const dx = cameraCellX - disc.x;
    const dy = cameraCellY - disc.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance >= disc.radius) continue;
    const weight = disc.intensity * (1 - distance / disc.radius);
    if (weight > loudest) loudest = weight;
  }
  return Math.min(1, Math.max(0, loudest));
}

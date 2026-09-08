import { Group, Vector3 } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  ClientPluginCtx,
  MoverPose,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  BOATS_PAYLOAD_CAP,
  BOATS_PLUGIN_NAME,
  BOATS_STATE_MESSAGE,
  parseBoatsPayload,
} from '../protocol.ts';
import { BoatInterpolator } from './interpolation.ts';
import warBoatUrl from './assets/war-boat.glb?url';
import {
  BOAT_SHAPE,
  FLEET_SAIL_DRAW_OBJECTS,
  createBoatModels,
  disposeBoatKit,
  preloadBoatModels,
  type BoatModel,
  type BoatModels,
} from './models.ts';

const SEA_SURFACE_WORLD_Y = 0;

const MAX_ANIMATION_STEP_SECONDS = 0.1;

const PHASE_PER_ID = 0.618;

interface BoatView {
  readonly model: BoatModel;
  readonly phase: number;
  readonly drawnAt: Vector3;
}

const interpolator = new BoatInterpolator();
const views = new Map<number, BoatView>();

let models: BoatModels | null = null;
let container: Group | null = null;

let unmarkPickable: (() => void) | null = null;
let unpublishMovers: (() => void) | null = null;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let animationSeconds = 0;

function reconcileViews(sampled: ReadonlyMap<number, unknown>): void {
  if (models === null || container === null) return;

  for (const [id, view] of views) {
    if (sampled.has(id)) continue;
    view.model.dispose();
    views.delete(id);
  }

  for (const id of sampled.keys()) {
    if (views.has(id)) continue;
    views.set(id, { model: models.create(), phase: (id * PHASE_PER_ID) % 1, drawnAt: new Vector3() });
  }
}

function renderFrame(dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  models?.beginFrame();

  for (const [id, boat] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    view.drawnAt.set(
      boat.x * CELL_WORLD_SIZE,
      SEA_SURFACE_WORLD_Y + BOAT_SHAPE.waterlineLift,
      boat.y * CELL_WORLD_SIZE,
    );
    view.model.draw(
      view.drawnAt.x,
      view.drawnAt.y,
      view.drawnAt.z,
      -boat.heading,
      animationSeconds,
      view.phase,
      step,
      boat.fighting,
    );
  }

  models?.commitFrame();
}

function drawnPoseOf(id: number): MoverPose | null {
  const view = views.get(id);
  if (view === undefined) return null;
  const at = view.drawnAt;
  return {
    x: at.x,
    y: at.y,
    z: at.z,
    bodyBottomY: at.y + BOAT_SHAPE.fireColumn.bottomY,
    bodyHeight: BOAT_SHAPE.fireColumn.height,
  };
}

export const clientPlugin: TerraceClientPlugin = {
  name: BOATS_PLUGIN_NAME,

  get drawBudget(): number {
    return BOAT_SHAPE.drawObjects + FLEET_SAIL_DRAW_OBJECTS;
  },

  preload(ctx: ClientPluginCtx): Promise<void> {
    return preloadBoatModels(ctx, warBoatUrl);
  },

  attach(ctx: ClientPluginCtx): void {
    models = createBoatModels();

    container = new Group();
    container.name = 'boats:afloat';
    for (const object of models.objects) container.add(object);
    ctx.layer.add(container);
    unmarkPickable = ctx.markPickable(container);
    unpublishMovers = ctx.publishMovers(drawnPoseOf);

    unsubscribeMessages = ctx.onMessage(BOATS_STATE_MESSAGE, (payload) => {
      const boats = parseBoatsPayload(payload);
      if (boats === null) return;
      interpolator.receive(boats);
    });

    unsubscribeFrames = ctx.onFrame(renderFrame);
  },

  dispose(): void {
    unsubscribeMessages?.();
    unsubscribeFrames?.();
    unsubscribeMessages = null;
    unsubscribeFrames = null;
    unmarkPickable?.();
    unmarkPickable = null;
    unpublishMovers?.();
    unpublishMovers = null;

    for (const view of views.values()) view.model.dispose();
    views.clear();
    interpolator.clear();

    container?.clear();
    container = null;

    models?.dispose();
    models = null;
    disposeBoatKit();
    animationSeconds = 0;
  },
};

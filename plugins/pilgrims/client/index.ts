import { Group } from 'three';
import { CELL_WORLD_SIZE, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';
import {
  drawnGroundSampler,
  followGroundY,
} from '../../../client/src/plugins/kit/groundFollow.ts';
import {
  advanceClimbRiserShift,
  newClimbRiserShift,
  type ClimbRiserShift,
} from '../../../client/src/plugins/kit/climbRiser.ts';
import { moverGaitOf } from '../../../client/src/plugins/kit/moverGait.ts';
import { moverStanceFromWire } from '@terrace/shared';

const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;
import type {
  ClientPluginCtx,
  MoverPose,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  PILGRIMS_ENTITIES_MESSAGE,
  PILGRIMS_PLUGIN_NAME,
  parseEntitiesPayload,
  WALKERS_WIRE_CAP,
} from '../protocol.ts';
import { PilgrimInterpolator, type InterpolatedPilgrim } from './interpolation.ts';
import {
  PILGRIM_HEIGHT,
  createPilgrimModels,
  type PilgrimModel,
  type PilgrimModels,
} from './models.ts';

const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

const MAX_ANIMATION_STEP_SECONDS = 0.1;

interface PilgrimView {
  readonly model: PilgrimModel;
  readonly phase: number;
  drawnY: number | null;
  readonly riserShift: ClimbRiserShift;
}

let models: PilgrimModels | null = null;
let container: Group | null = null;
const views = new Map<number, PilgrimView>();
const interpolator = new PilgrimInterpolator();

let unmarkPickable: (() => void) | null = null;
let unpublishMovers: (() => void) | null = null;
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

function reconcileViews(sampled: ReadonlyMap<number, InterpolatedPilgrim>): void {
  if (models === null || container === null) return;

  for (const [id, pilgrim] of sampled) {
    if (views.has(id)) continue;
    const model = models.create(pilgrim.race, pilgrim.kind);
    container.add(model.root);
    views.set(id, {
      model,
      phase: id * PHASE_RADIANS_PER_ID,
      drawnY: null,
      riserShift: newClimbRiserShift(),
    });
  }

  for (const [id, view] of views) {
    if (sampled.has(id)) continue;
    container.remove(view.model.root);
    view.model.dispose();
    views.delete(id);
  }
}

function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  const groundAt = drawnGroundSampler(ctx);

  for (const [id, pilgrim] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    const terrainY = groundAt(pilgrim.x, pilgrim.y);
    if (terrainY === null) {
      view.model.root.visible = false;
      view.drawnY = null;
      view.riserShift.x = 0;
      view.riserShift.y = 0;
      continue;
    }
    view.model.root.visible = true;
    const targetY =
      pilgrim.climbHeight === null ? terrainY : pilgrim.climbHeight * HEIGHT_WORLD_SCALE;
    const drawnY = followGroundY(view.drawnY, targetY, dt);
    view.drawnY = drawnY;
    advanceClimbRiserShift(view.riserShift, ctx, pilgrim, drawnY, dt);
    view.model.root.position.set(
      (pilgrim.x + view.riserShift.x) * CELL_WORLD_SIZE,
      drawnY,
      (pilgrim.y + view.riserShift.y) * CELL_WORLD_SIZE,
    );
    view.model.root.rotation.y = -pilgrim.heading;
    view.model.animate(
      animationSeconds,
      view.phase,
      moverGaitOf(pilgrim.climbHeight, pilgrim.falling, moverStanceFromWire(pilgrim.stance)),
    );
  }
}

function drawnPoseOf(id: number): MoverPose | null {
  const view = views.get(id);
  if (view === undefined || !view.model.root.visible) return null;
  const at = view.model.root.position;
  return { x: at.x, y: at.y, z: at.z, bodyBottomY: at.y, bodyHeight: PILGRIM_HEIGHT };
}

const WALKER_DRAW_OBJECTS = 2;

export const clientPlugin: TerraceClientPlugin = {
  name: PILGRIMS_PLUGIN_NAME,

  drawBudget: WALKERS_WIRE_CAP * WALKER_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    models = createPilgrimModels();

    container = new Group();
    container.name = 'pilgrims:walkers';
    ctx.layer.add(container);
    unmarkPickable = ctx.markPickable(container);
    unpublishMovers = ctx.publishMovers(drawnPoseOf);

    unsubscribeMessages = ctx.onMessage(PILGRIMS_ENTITIES_MESSAGE, (payload) => {
      const pilgrims = parseEntitiesPayload(payload);
      if (pilgrims === null) return;
      interpolator.receive(pilgrims);
    });

    unsubscribeFrames = ctx.onFrame((dt) => renderFrame(ctx, dt));
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

    for (const view of views.values()) {
      view.model.dispose();
      view.model.root.clear();
    }
    views.clear();
    interpolator.clear();

    container?.clear();
    container = null;

    models?.dispose();
    models = null;
    animationSeconds = 0;
  },
};

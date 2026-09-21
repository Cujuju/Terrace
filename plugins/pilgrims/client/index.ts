import { Group } from 'three';
import { NO_SAMPLE } from '../../../client/src/plugins/kit/viewReconcile.ts';
import { BAND_HEIGHT, CELL_WORLD_SIZE, drawnBandOfSample } from '@terrace/shared';
import {
  drawnGroundSampler,
  followGroundY,
} from '../../../client/src/plugins/kit/groundFollow.ts';
import { HEIGHT_WORLD_SCALE } from '../../../client/src/worldScale.ts';
import {
  advanceClimbRiserShift,
  newClimbRiserShift,
  type ClimbRiserShift,
} from '../../../client/src/plugins/kit/climbRiser.ts';
import { moverGaitOf } from '../../../client/src/plugins/kit/moverGait.ts';
import { moverStanceFromWire } from '@terrace/shared';
import type {
  ClientPluginCtx,
  MoverPose,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  PILGRIMS_ENTITIES_MESSAGE,
  PILGRIMS_PLUGIN_NAME,
  parseEntitiesPayload,
  type SettlerRace,
  type WalkerKind,
} from '../protocol.ts';
import { PilgrimInterpolator, type InterpolatedPilgrim } from './interpolation.ts';
import {
  PILGRIM_HEIGHT,
  createPilgrimModels,
  type PilgrimModels,
} from './models.ts';

const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

const MAX_ANIMATION_STEP_SECONDS = 0.1;

interface PilgrimView {
  race: SettlerRace;
  kind: WalkerKind;
  readonly phase: number;
  drawn: boolean;
  drawnX: number;
  drawnY: number | null;
  drawnZ: number;
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
let unsubscribeReset: (() => void) | null = null;

function reconcileViews(sampled: ReadonlyMap<number, InterpolatedPilgrim>): void {
  for (const [id, pilgrim] of sampled) {
    if (views.has(id)) continue;
    views.set(id, {
      race: pilgrim.race,
      kind: pilgrim.kind,
      phase: id * PHASE_RADIANS_PER_ID,
      drawn: false,
      drawnX: 0,
      drawnY: null,
      drawnZ: 0,
      riserShift: newClimbRiserShift(),
    });
  }

  for (const [id] of views) {
    if (sampled.has(id)) continue;
    views.delete(id);
  }
}

function forgetViews(): void {
  reconcileViews(NO_SAMPLE);
  interpolator.clear();
}

function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  if (models === null) return;
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);
  models.beginFrame(animationSeconds);

  const groundAt = drawnGroundSampler(ctx);

  for (const [id, pilgrim] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;
    view.race = pilgrim.race;
    view.kind = pilgrim.kind;

    const terrainY = groundAt(pilgrim.x, pilgrim.y);
    if (terrainY === null) {
      view.drawn = false;
      view.drawnY = null;
      view.riserShift.x = 0;
      view.riserShift.y = 0;
      continue;
    }
    // Raw height through the drawn function, agreeing with drawn caps.
    const targetY =
      pilgrim.climbHeight === null
        ? terrainY
        : drawnBandOfSample(pilgrim.climbHeight) * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
    const drawnY = followGroundY(view.drawnY, targetY, dt);
    view.drawnY = drawnY;
    advanceClimbRiserShift(view.riserShift, ctx, pilgrim, drawnY, dt);
    const drawnX = (pilgrim.x + view.riserShift.x) * CELL_WORLD_SIZE;
    const drawnZ = (pilgrim.y + view.riserShift.y) * CELL_WORLD_SIZE;
    view.drawnX = drawnX;
    view.drawnZ = drawnZ;
    view.drawn = true;
    models.draw(
      view.race,
      view.kind,
      view.phase,
      moverGaitOf(pilgrim.climbHeight, pilgrim.falling, moverStanceFromWire(pilgrim.stance)),
      drawnX,
      drawnY,
      drawnZ,
      -pilgrim.heading,
    );
  }

  models.endFrame();
}

function drawnPoseOf(id: number): MoverPose | null {
  const view = views.get(id);
  if (view === undefined || !view.drawn || view.drawnY === null) return null;
  return {
    x: view.drawnX,
    y: view.drawnY,
    z: view.drawnZ,
    bodyBottomY: view.drawnY,
    bodyHeight: PILGRIM_HEIGHT,
  };
}

const PILGRIM_HERD_DRAW_OBJECTS = 6;

export const clientPlugin: TerraceClientPlugin = {
  name: PILGRIMS_PLUGIN_NAME,

  drawBudget: PILGRIM_HERD_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    models = createPilgrimModels();
    if (models.objects.length !== PILGRIM_HERD_DRAW_OBJECTS) {
      throw new Error(
        `pilgrims: draw budget is ${String(PILGRIM_HERD_DRAW_OBJECTS)} objects but the ` +
          `model pool baked ${String(models.objects.length)} — update the herd surface ` +
          'table in client/index.ts.',
      );
    }

    container = new Group();
    container.name = 'pilgrims:walkers';
    for (const object of models.objects) container.add(object);
    ctx.layer.add(container);
    unmarkPickable = ctx.markPickable(container);
    unpublishMovers = ctx.publishMovers(drawnPoseOf);

    unsubscribeMessages = ctx.onMessage(PILGRIMS_ENTITIES_MESSAGE, (payload) => {
      const pilgrims = parseEntitiesPayload(payload);
      if (pilgrims === null) return;
      interpolator.receive(pilgrims);
    });

    unsubscribeFrames = ctx.onFrame((dt) => renderFrame(ctx, dt));
    unsubscribeReset = ctx.onWorldReset(forgetViews);
  },

  dispose(): void {
    unsubscribeMessages?.();
    unsubscribeFrames?.();
    unsubscribeReset?.();
    unsubscribeMessages = null;
    unsubscribeFrames = null;
    unsubscribeReset = null;
    unmarkPickable?.();
    unmarkPickable = null;
    unpublishMovers?.();
    unpublishMovers = null;

    forgetViews();

    container?.clear();
    container = null;

    models?.dispose();
    models = null;
    animationSeconds = 0;
  },
};

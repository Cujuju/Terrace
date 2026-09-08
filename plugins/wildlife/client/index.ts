import { Group } from 'three';
import { CELL_WORLD_SIZE, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';

const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  WILDLIFE_ENTITIES_MESSAGE,
  WILDLIFE_PLUGIN_NAME,
  parseEntitiesPayload,
  sizeClassAt,
  MAX_BIRDS_ALOFT,
  WILDLIFE_POPULATION_CAP,
} from '../protocol.ts';
import { WildlifeInterpolator, type InterpolatedEntity } from './interpolation.ts';
import type { MoverPose } from '../../../client/src/plugins/types.ts';
import { reconcileById } from '../../../client/src/plugins/kit/viewReconcile.ts';
import { createWildlifeModels, type WildlifeModels } from './models.ts';
import { loadRigAsset } from '../../../client/src/render/rigAsset.ts';
import { disposeSpeciesAssets, installSpeciesAsset } from './species/assetSpecies.ts';
import { SPECIES_ASSETS } from './species/assets.ts';
import { modelScaleFor } from './modelScale.ts';
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
import {
  BODY_COLUMNS,
  SWIM_PROFILES,
  creatureWorldY,
  placementKindOf,
  swimmerSeabedY,
  walkerGroundY,
  walkerStrideRadians,
} from './placement.ts';

const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

const MAX_ANIMATION_STEP_SECONDS = 0.1;

interface CreatureView {
  phase: number;
  drawnX: number;
  drawnZ: number;
  drawnY: number | null;
  drawnBodyBottomY: number;
  drawnBodyHeight: number;
  readonly riserShift: ClimbRiserShift;
}

let models: WildlifeModels | null = null;
let container: Group | null = null;
const views = new Map<number, CreatureView>();
const interpolator = new WildlifeInterpolator();

let unmarkPickable: (() => void) | null = null;
let unpublishMovers: (() => void) | null = null;
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

function reconcileViews(sampled: ReadonlyMap<number, InterpolatedEntity>): void {
  reconcileById(sampled, views, {
    acquire: (id) => ({
      phase: id * PHASE_RADIANS_PER_ID,
      drawnX: 0,
      drawnZ: 0,
      drawnY: null,
      drawnBodyBottomY: 0,
      drawnBodyHeight: 0,
      riserShift: newClimbRiserShift(),
    }),
    release: () => {},
  });
}

function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  if (models === null) return;
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  models.beginFrame(animationSeconds);

  const sample = drawnGroundSampler(ctx);

  for (const [id, entity] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    const sizeClass = sizeClassAt(entity.size);
    const kind = placementKindOf(entity.species);
    const swimProfile = SWIM_PROFILES[entity.species];
    const terrainY =
      kind === 'flyer'
        ? null
        : kind === 'walker' || swimProfile === null
          ? walkerGroundY(sample, entity.x, entity.y, entity.species)
          : swimmerSeabedY(
              sample,
              entity.x,
              entity.y,
              entity.heading,
              swimProfile,
              modelScaleFor(entity.species, sizeClass),
            );
    if (kind !== 'flyer' && terrainY === null) continue;
    const previousDrawnY = view.drawnY;
    const drawnY =
      entity.climbHeight === null
        ? creatureWorldY(entity.species, terrainY, sizeClass, previousDrawnY, dt)
        : followGroundY(previousDrawnY, entity.climbHeight * HEIGHT_WORLD_SCALE, dt);
    advanceClimbRiserShift(view.riserShift, ctx, entity, drawnY, dt);
    const drawnX = (entity.x + view.riserShift.x) * CELL_WORLD_SIZE;
    const drawnZ = (entity.y + view.riserShift.y) * CELL_WORLD_SIZE;
    if (kind === 'walker' && previousDrawnY !== null) {
      view.phase += walkerStrideRadians(
        entity.species,
        Math.hypot(drawnX - view.drawnX, drawnY - previousDrawnY, drawnZ - view.drawnZ),
      );
    }
    view.drawnY = drawnY;
    view.drawnX = drawnX;
    view.drawnZ = drawnZ;
    const column = BODY_COLUMNS[entity.species];
    const modelScale = modelScaleFor(entity.species, sizeClass);
    view.drawnBodyBottomY = drawnY + column.bellyY * modelScale;
    view.drawnBodyHeight = (column.crownY - column.bellyY) * modelScale;
    models.draw(
      entity.species,
      sizeClass,
      id,
      view.phase,
      moverGaitOf(entity.climbHeight, entity.falling, moverStanceFromWire(entity.stance)),
      view.drawnX,
      drawnY,
      view.drawnZ,
      -entity.heading,
    );
  }

  models.endFrame();
}

function drawnPoseOf(id: number): MoverPose | null {
  const view = views.get(id);
  if (view === undefined || view.drawnY === null) return null;
  return {
    x: view.drawnX,
    y: view.drawnY,
    z: view.drawnZ,
    bodyBottomY: view.drawnBodyBottomY,
    bodyHeight: view.drawnBodyHeight,
  };
}

const SINGLE_SURFACE_SPECIES = 11;
const TWO_SURFACE_SPECIES = 1;
const GRAZER_ASSET_DRAW_OBJECTS = 1;
const WOLF_ASSET_DRAW_OBJECTS = 1;
const WILDLIFE_SPECIES_DRAW_OBJECTS =
  SINGLE_SURFACE_SPECIES +
  GRAZER_ASSET_DRAW_OBJECTS +
  WOLF_ASSET_DRAW_OBJECTS +
  TWO_SURFACE_SPECIES * 2;

export const clientPlugin: TerraceClientPlugin = {
  name: WILDLIFE_PLUGIN_NAME,

  drawBudget: WILDLIFE_SPECIES_DRAW_OBJECTS,

  async preload(): Promise<void> {
    for (const { spec, url } of SPECIES_ASSETS) {
      installSpeciesAsset(spec, await loadRigAsset(url, null));
    }
  },

  attach(ctx: ClientPluginCtx): void {
    models = createWildlifeModels(WILDLIFE_POPULATION_CAP + MAX_BIRDS_ALOFT);
    if (models.objects.length !== WILDLIFE_SPECIES_DRAW_OBJECTS) {
      throw new Error(
        `wildlife: draw budget is ${String(WILDLIFE_SPECIES_DRAW_OBJECTS)} objects but the ` +
          `model pool baked ${String(models.objects.length)} — update the per-species surface ` +
          'table in client/index.ts.',
      );
    }

    container = new Group();
    container.name = 'wildlife:creatures';
    for (const object of models.objects) container.add(object);
    ctx.layer.add(container);
    unmarkPickable = ctx.markPickable(container);
    unpublishMovers = ctx.publishMovers(drawnPoseOf);

    unsubscribeMessages = ctx.onMessage(WILDLIFE_ENTITIES_MESSAGE, (payload) => {
      const entities = parseEntitiesPayload(payload);
      if (entities === null) return;
      interpolator.receive(entities);
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

    views.clear();
    interpolator.clear();

    container?.clear();
    container = null;

    models?.dispose();
    models = null;
    disposeSpeciesAssets();
    animationSeconds = 0;
  },
};

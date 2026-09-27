import { Group } from 'three';
import { cellsAcross } from '@terrace/shared';
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
import { NO_SAMPLE, reconcileById } from '../../../client/src/plugins/kit/viewReconcile.ts';
import { createWildlifeModels, type WildlifeModels } from './models.ts';
import { loadRigAsset } from '../../../client/src/render/rigAsset.ts';
import { disposeSpeciesAssets, installSpeciesAsset } from './species/assetSpecies.ts';
import { SPECIES_ASSETS } from './species/assets.ts';
import { modelScaleFor } from './modelScale.ts';
import {
  serverGroundSampler,
  serverWorldPosition,
  followClimbGroundY,
  newClimbGroundState,
  type ClimbGroundState,
} from '../../../client/src/plugins/kit/groundFollow.ts';
import {
  advanceClimbRiserShift,
  newClimbRiserShift,
  type ClimbRiserShift,
} from '../../../client/src/plugins/kit/climbRiser.ts';
import { leapProgressOf, moverGaitOf, type MoverGait } from '../../../client/src/plugins/kit/moverGait.ts';
import { moverStanceFromWire } from '@terrace/shared';
import {
  BODY_COLUMNS,
  SWIM_PROFILES,
  WALKER_CLIMB_REACH_BY_SPECIES,
  creatureWorldY,
  placementKindOf,
  swimmerSeabedY,
  walkerGroundY,
  walkerStrideRadians,
} from './placement.ts';

const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

const TWO_PI = Math.PI * 2;

/** Beyond this camera distance a creature holds its pose: ground sampling, gait
 *  animation and palette capture run once every LOD_FULL_EVERY frames, staggered by
 *  id. Placement still refreshes. */
const LOD_DISTANCE_WORLD_UNITS = 120;
const LOD_FULL_EVERY = 6;

const MAX_ANIMATION_STEP_SECONDS = 0.1;

interface CreatureView {
  phase: number;
  /** Phase the last full update posed with; a hold re-addresses that slot. */
  posePhase: number;
  drawnX: number;
  drawnZ: number;
  /** Written by the full path only, so it doubles as the last-full Y. */
  drawnY: number | null;
  drawnBodyBottomY: number;
  drawnBodyHeight: number;
  readonly riserShift: ClimbRiserShift;
  readonly climbGround: ClimbGroundState;
  lodReady: boolean;
  lodGait: MoverGait | null;
  /** Wall time and X/Z since the last full update; the full path integrates against
   *  them, so a hold costs no travel and no elapsed time. */
  sinceFullSeconds: number;
  lastFullX: number;
  lastFullZ: number;
}

let models: WildlifeModels | null = null;
let container: Group | null = null;
const views = new Map<number, CreatureView>();
const interpolator = new WildlifeInterpolator();

let unmarkPickable: (() => void) | null = null;
let unpublishMovers: (() => void) | null = null;
let animationSeconds = 0;
let frameIndex = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let unsubscribeReset: (() => void) | null = null;

function reconcileViews(sampled: ReadonlyMap<number, InterpolatedEntity>): void {
  reconcileById(sampled, views, {
    acquire: (id) => ({
      phase: id * PHASE_RADIANS_PER_ID,
      posePhase: id * PHASE_RADIANS_PER_ID,
      drawnX: 0,
      drawnZ: 0,
      drawnY: null,
      drawnBodyBottomY: 0,
      drawnBodyHeight: 0,
      riserShift: newClimbRiserShift(),
      climbGround: newClimbGroundState(),
      lodReady: false,
      lodGait: null,
      sinceFullSeconds: 0,
      lastFullX: 0,
      lastFullZ: 0,
    }),
    release: () => {},
  });
}

function forgetViews(): void {
  reconcileViews(NO_SAMPLE);
  interpolator.clear();
}

function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  if (models === null) return;
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  frameIndex += 1;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  models.beginFrame(animationSeconds);

  const sample = serverGroundSampler(ctx);
  const camera = ctx.cameraPosition();

  for (const [id, entity] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;
    view.sinceFullSeconds += dt;

    const gait = moverGaitOf(
      entity.climbHeight,
      entity.falling,
      moverStanceFromWire(entity.stance),
      entity.climbPath,
    );
    // Hold path needs an already-placed pose to freeze (first sight always full).
    const heldY = view.drawnY;
    const dx = serverWorldPosition(entity.x) - camera.x;
    const dz = serverWorldPosition(entity.y) - camera.z;
    // Unplaced creature counts as level with the camera; it takes the full path anyway.
    const dy = (heldY ?? camera.y) - camera.y;
    // Hold: frozen phase and gait address the slot the last full update captured, whose
    // palette layer persists, so the held draw stays valid.
    const full =
      !view.lodReady ||
      view.lodGait !== gait ||
      dx * dx + dy * dy + dz * dz <
        LOD_DISTANCE_WORLD_UNITS * LOD_DISTANCE_WORLD_UNITS ||
      (frameIndex + id) % LOD_FULL_EVERY === 0;
    if (!full && heldY !== null) {
      // Body column fields follow the frozen drawnY, so they match the held draw; a
      // size-class change lands on the next full frame.
      view.drawnX = serverWorldPosition(entity.x + view.riserShift.x);
      view.drawnZ = serverWorldPosition(entity.y + view.riserShift.y);
      models.draw(
        entity.species,
        sizeClassAt(entity.size),
        id,
        view.posePhase,
        gait,
        view.drawnX,
        heldY,
        view.drawnZ,
        -entity.heading,
        true,
      );
      continue;
    }
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
              modelScaleFor(entity.species, sizeClass, id),
            );
    if (kind !== 'flyer' && terrainY === null) continue;
    // The full path spends the whole hold interval at once: smoothers get the elapsed
    // time and the stride integral the travel since the last full update.
    const sinceFull = view.sinceFullSeconds;
    const previousDrawnY = view.drawnY;
    const drawnY =
      kind === 'walker' || entity.climbHeight !== null
        // Continuous climb progress joins drawn support at both ends.
        ? followClimbGroundY(view.climbGround, ctx, entity, previousDrawnY, terrainY!, sinceFull)
        : creatureWorldY(entity.species, terrainY, sizeClass, id, previousDrawnY, sinceFull);
    if (drawnY === null) continue;
    // Progress is recorded only past the last bail, so a frame that draws nothing
    // neither consumes the hold interval nor claims a gait it never captured.
    view.lodGait = gait;
    view.sinceFullSeconds = 0;
    const modelScale = modelScaleFor(entity.species, sizeClass, id);
    const climbReach = WALKER_CLIMB_REACH_BY_SPECIES[entity.species];
    advanceClimbRiserShift(view.riserShift, ctx, entity, drawnY, sinceFull,
      climbReach === null ? undefined : cellsAcross(climbReach * modelScale));
    const drawnX = serverWorldPosition(entity.x + view.riserShift.x);
    const drawnZ = serverWorldPosition(entity.y + view.riserShift.y);
    if (kind === 'walker' && previousDrawnY !== null) {
      view.phase += walkerStrideRadians(
        entity.species,
        Math.hypot(drawnX - view.lastFullX, drawnY - previousDrawnY, drawnZ - view.lastFullZ),
      );
    }
    // A leap poses by its progress; every other gait by its stride phase.
    const leap = gait === 'fall' ? null : leapProgressOf(entity);
    view.posePhase = leap === null ? view.phase : leap * TWO_PI;
    view.drawnY = drawnY;
    view.drawnX = drawnX;
    view.drawnZ = drawnZ;
    view.lastFullX = drawnX;
    view.lastFullZ = drawnZ;
    const column = BODY_COLUMNS[entity.species];
    view.drawnBodyBottomY = drawnY + column.bellyY * modelScale;
    view.drawnBodyHeight = (column.crownY - column.bellyY) * modelScale;
    models.draw(
      entity.species,
      sizeClass,
      id,
      view.posePhase,
      gait,
      view.drawnX,
      drawnY,
      view.drawnZ,
      -entity.heading,
    );
    view.lodReady = true;
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
    disposeSpeciesAssets();
    animationSeconds = 0;
    frameIndex = 0;
  },
};

// wildlife — client half. Draws whatever the server's `wildlife:entities`
// broadcast says exists: no authority, no prediction, interpolation and idle
// animations as the only cosmetics.

import { Group } from 'three';
import { CELL_WORLD_SIZE, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';

/**
 * World units per stored height unit. Restated from its two @terrace/shared
 * inputs: importing client/src/config.ts drags `import.meta.env` into a node
 * test run.
 */
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

/**
 * Per-creature animation phase offset, in radians per unit of entity id. The
 * golden angle: consecutive ids land as far apart on the cycle as possible.
 */
const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

/**
 * Cap on the animation clock's advance per frame, in seconds. The clock is an
 * accumulator: this keeps a pathological frame from jumping a full cycle.
 */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

/** A creature currently in the scene. */
interface CreatureView {
  /**
   * The creature's animation phase, in radians. Seeded from the entity id; a
   * SWIMMER's or FLYER's is never touched again, a WALKER's advances by the
   * ground it was drawn covering.
   */
  phase: number;
  /**
   * Where this creature was last DRAWN, in world units. Held here because it has
   * no scene object: it is one instance inside its species' herd, rewritten
   * every frame.
   */
  drawnX: number;
  drawnZ: number;
  /**
   * World Y this creature was drawn at last frame, or null until drawn once. A
   * SWIMMER's depth is eased frame to frame; walkers and flyers never read it.
   */
  drawnY: number | null;
  /**
   * The body's vertical span as drawn this frame — BODY_COLUMNS at this
   * creature's size class, hung on `drawnY`. What `drawnPoseOf` answers with.
   */
  drawnBodyBottomY: number;
  drawnBodyHeight: number;
}

/**
 * Module-level singletons, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin (client/src/plugins/
 * host.ts), and `attach`/`dispose` bracket their whole lifetime.
 */
let models: WildlifeModels | null = null;
let container: Group | null = null;
const views = new Map<number, CreatureView>();
const interpolator = new WildlifeInterpolator();

/** Withdraws this plugin's aimable creatures / pose lookup from the host. */
let unmarkPickable: (() => void) | null = null;
let unpublishMovers: (() => void) | null = null;
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

/**
 * Keeps `views` matching the sampled population. Nothing touches the SCENE: a
 * creature is an instance inside its species' herd, written afresh each frame.
 */
function reconcileViews(sampled: ReadonlyMap<number, InterpolatedEntity>): void {
  reconcileById(sampled, views, {
    acquire: (id) => ({
      phase: id * PHASE_RADIANS_PER_ID,
      drawnX: 0,
      drawnZ: 0,
      drawnY: null,
      drawnBodyBottomY: 0,
      drawnBodyHeight: 0,
    }),
    // A creature's view is numbers and no scene object: the instanced meshes
    // are rebuilt every frame, so retiring one is dropping the entry.
    release: () => {},
  });
}

/**
 * THE RENDER PATH. Runs once per animation frame. Placement is recomputed every
 * frame: both the creature and the ground under it move. One drawnGroundYAt
 * lookup per creature.
 */
function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  if (models === null) return;
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  // Every herd is rewritten from empty each frame: the placements change every
  // frame, so there is nothing worth carrying between them.
  models.beginFrame(animationSeconds);

  // One sampler per frame, not per creature: it captures only `ctx`.
  const sample = drawnGroundSampler(ctx);

  for (const [id, entity] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    // Three placement rules (./placement.ts): flyers cruise at a fixed altitude
    // and never sample; walkers stand on the highest cap their FOOTPRINT
    // overlaps; swimmers float over their HULL's.
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
    // NO GROUND, NO DRAW — the same answer every other plugin gives. Flyers
    // never sample ground and are unaffected.
    if (kind !== 'flyer' && terrainY === null) continue;
    // Cell coordinates scale to world X/Z by CELL_WORLD_SIZE (see placement.ts,
    // whose named residual this multiply is).
    const drawnX = entity.x * CELL_WORLD_SIZE;
    const drawnZ = entity.y * CELL_WORLD_SIZE;
    const previousDrawnY = view.drawnY;
    // ON A WALL the server owns the height (`climbHeight`); the follower still
    // eases toward it, which costs a climber nothing.
    const drawnY =
      entity.climbHeight === null
        ? creatureWorldY(entity.species, terrainY, sizeClass, previousDrawnY, dt)
        : followGroundY(previousDrawnY, entity.climbHeight * HEIGHT_WORLD_SCALE, dt);
    // A walker's legs are paced by the DISTANCE it covers between drawn frames,
    // in THREE dimensions: measured horizontally it is zero for a climber,
    // whose x/y stay pinned.
    if (kind === 'walker' && previousDrawnY !== null) {
      view.phase += walkerStrideRadians(
        entity.species,
        Math.hypot(drawnX - view.drawnX, drawnY - previousDrawnY, drawnZ - view.drawnZ),
      );
    }
    view.drawnY = drawnY;
    view.drawnX = drawnX;
    view.drawnZ = drawnZ;
    // The body span, at the scale models.draw is about to apply to the rig.
    const column = BODY_COLUMNS[entity.species];
    const modelScale = modelScaleFor(entity.species, sizeClass);
    view.drawnBodyBottomY = drawnY + column.bellyY * modelScale;
    view.drawnBodyHeight = (column.crownY - column.bellyY) * modelScale;
    models.draw(
      entity.species,
      sizeClass,
      // `id` seeds which of the three whale bodies this creature gets: it is
      // stable for the creature's whole life, so an individual never changes
      // species between frames.
      id,
      view.phase,
      // Climbing and falling are their own poses, not a walk at another
      // height; so are standing and sitting (@terrace/shared's stance.ts).
      moverGaitOf(entity.climbHeight, entity.falling, moverStanceFromWire(entity.stance)),
      view.drawnX,
      drawnY,
      view.drawnZ,
      // Models face +X. Rotating +X about Y by θ yields (cos θ, 0, -sin θ), and
      // the creature travels toward (cos heading, 0, sin heading) — hence the
      // negation.
      -entity.heading,
    );
  }

  models.endFrame();
}

/**
 * Where a creature is DRAWN, for anything drawn on it (publishMovers). Read off
 * what this frame committed to the herd's instance buffer: the pose on screen.
 */
function drawnPoseOf(id: number): MoverPose | null {
  const view = views.get(id);
  // Null until the frame loop has drawn it once: `drawnY` is the flag, because
  // it is the one component that has no meaningful value before then.
  if (view === undefined || view.drawnY === null) return null;
  return {
    x: view.drawnX,
    y: view.drawnY,
    z: view.drawnZ,
    bodyBottomY: view.drawnBodyBottomY,
    bodyHeight: view.drawnBodyHeight,
  };
}

/**
 * Draw objects the whole population costs: ONE INSTANCED MESH PER BAKED SURFACE
 * PER HERD, a herd being a species. A constant; `attach` throws if the pool
 * disagrees.
 */
const SINGLE_SURFACE_SPECIES = 11; // fish, ibex, bison, ray, shark, eel, angelfish, humpback, blue whale, sperm whale, bird
const TWO_SURFACE_SPECIES = 1; // deepsea
/**
 * The DOWNLOADED grazer's surfaces: this repo did not write its material set.
 * ONE — its glTF materials differ only in base colour, which rigSkin's
 * signature leaves out.
 */
const GRAZER_ASSET_DRAW_OBJECTS = 1;
/**
 * The DOWNLOADED wolf's surfaces, for the same reason. ONE, checked separately:
 * "the other imported animal bakes to one" is not evidence about this file.
 */
const WOLF_ASSET_DRAW_OBJECTS = 1;
const WILDLIFE_SPECIES_DRAW_OBJECTS =
  SINGLE_SURFACE_SPECIES +
  GRAZER_ASSET_DRAW_OBJECTS +
  WOLF_ASSET_DRAW_OBJECTS +
  TWO_SURFACE_SPECIES * 2;

export const clientPlugin: TerraceClientPlugin = {
  name: WILDLIFE_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: WILDLIFE_SPECIES_DRAW_OBJECTS,

  /**
   * Loads every asset-sourced species before attach, so createWildlifeModels
   * has something to bake from. SEQUENTIAL, not Promise.all: being told which
   * file broke first is what makes the failure useful.
   */
  async preload(): Promise<void> {
    for (const { spec, url } of SPECIES_ASSETS) {
      // Lamps-only (null environment): fur, feather and scale, not metal — see
      // ClientPluginCtx.loadRigAsset for the choice.
      installSpeciesAsset(spec, await loadRigAsset(url, null));
    }
  },

  attach(ctx: ClientPluginCtx): void {
    // Every herd sizes its instance buffers to the whole population: any one
    // species may, in principle, be all of it.
    models = createWildlifeModels(WILDLIFE_POPULATION_CAP + MAX_BIRDS_ALOFT);
    // The budget above is a promise about geometry this plugin does not own.
    // Checked at boot against the pool actually built: a mismatch throws.
    if (models.objects.length !== WILDLIFE_SPECIES_DRAW_OBJECTS) {
      throw new Error(
        `wildlife: draw budget is ${String(WILDLIFE_SPECIES_DRAW_OBJECTS)} objects but the ` +
          `model pool baked ${String(models.objects.length)} — update the per-species surface ` +
          'table in client/index.ts.',
      );
    }

    // One child Group of our own inside the host's layer: it keeps every
    // creature under one named node and gives dispose() one thing to clear.
    container = new Group();
    container.name = 'wildlife:creatures';
    for (const object of models.objects) container.add(object);
    ctx.layer.add(container);
    // AN ANIMAL IS SOMETHING YOU CAN POINT AT — without this the torch aims
    // through a grazer at the ground behind it (ClientPluginCtx.pickWorldCell).
    unmarkPickable = ctx.markPickable(container);
    // And something a flame can be drawn ON: fire asks this plugin, every
    // frame, where the creature it set alight has got to.
    unpublishMovers = ctx.publishMovers(drawnPoseOf);

    unsubscribeMessages = ctx.onMessage(WILDLIFE_ENTITIES_MESSAGE, (payload) => {
      const entities = parseEntitiesPayload(payload);
      // A malformed payload is dropped whole: the previous population keeps
      // rendering until the next good message, which is 200 ms away.
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

    // Shared geometries and materials are freed exactly once, here.
    models?.dispose();
    models = null;
    // AND THE ASSETS AFTER THE BLUEPRINTS, never before. A baked surface holds
    // a material clone that shares the source's textures by reference.
    disposeSpeciesAssets();
    animationSeconds = 0;
  },
};

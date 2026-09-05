// wildlife — client half. Draws whatever the server's `wildlife:entities`
// broadcast says exists, and nothing else.
//
// It holds no authority: it never spawns, never moves a creature of its own
// accord, and never predicts. Between the 5 Hz broadcasts it interpolates
// (./interpolation.ts) and plays idle animations (./models.ts); both are purely
// cosmetic, so a client that misses messages simply looks stiller, never wrong.
//
// Everything it touches arrives through ClientPluginCtx: its own Group in the
// scene, the rendered terrain height, the message channel, and the frame clock.

import { Group } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  WILDLIFE_ENTITIES_MESSAGE,
  WILDLIFE_PLUGIN_NAME,
  WILDLIFE_SIZE_MODEL_SCALE,
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
import { WHALE_SPECIES } from './whaleSpecies.ts';
import {
  BODY_COLUMNS,
  SWIM_PROFILES,
  creatureWorldY,
  placementKindOf,
  swimmerSeabedY,
  walkerGroundY,
} from './placement.ts';

/**
 * Per-creature animation phase offset, in radians per unit of entity id. The
 * golden angle: consecutive ids land as far apart on the cycle as possible, so a
 * school of five fish spawned back to back does not swim in lock-step.
 */
const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

/**
 * Cap on the animation clock's advance per frame, in seconds. `onFrame`'s dt is
 * already capped by the host, but the animation clock is an accumulator: this
 * keeps a pathological frame from jumping every creature a full cycle.
 */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

/** A creature currently in the scene. */
interface CreatureView {
  /** Fixed at creation from the entity id — never recomputed per frame. */
  readonly phase: number;
  /**
   * Where this creature was last DRAWN, in world units.
   *
   * Held here because a creature no longer has a scene object to read it back
   * off: it is one instance inside its species' herd (models.ts), and the
   * instance buffer is rewritten from scratch every frame. This is the pose
   * `drawnPoseOf` answers with — the one this loop last committed.
   */
  drawnX: number;
  drawnZ: number;
  /**
   * World Y this creature was drawn at last frame, or null until it has been
   * drawn once. A SWIMMER's depth is eased frame to frame rather than
   * recomputed from scratch (placement.ts's SWIM_VERTICAL_WORLD_UNITS_PER_
   * SECOND), so it is the one part of a pose that has history; walkers and
   * flyers never read it.
   *
   * Held HERE rather than read back off the drawn transform: the eased value
   * has to be the one this loop last COMMITTED, not wherever anything else
   * might have put it.
   */
  drawnY: number | null;
  /**
   * The body's vertical span as drawn this frame — BODY_COLUMNS at the size
   * class this creature was born at, hung on `drawnY`. Committed with the pose
   * for the same reason as the pose: it is what `drawnPoseOf` answers with.
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
 * Keeps `views` matching the sampled population.
 *
 * Nothing is added to or removed from the SCENE here any more: a creature is an
 * instance inside its species' herd, written afresh each frame (models.ts), so
 * the only per-creature state left is the history this loop keeps — its phase
 * and where it was last drawn.
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
    // A creature's view is four numbers and no scene object of its own — the
    // instanced meshes are shared and rebuilt from the live set every frame —
    // so retiring one is dropping the entry, which the kit does.
    release: () => {},
  });
}

/**
 * THE RENDER PATH. Runs once per animation frame.
 *
 * Placement is recomputed every frame rather than cached, because both inputs
 * move: the creature drifts between cells, and the terrain under it can be
 * sculpted at any moment. It is one terrainHeightAt lookup per creature — at
 * most a hundred — which is nothing next to the draw calls that follow it.
 */
function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  if (models === null) return;
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  // Every herd is rewritten from empty each frame: the population changes at
  // 5 Hz and the placements change every frame, so there is no state worth
  // carrying between frames and nothing to reconcile.
  models.beginFrame(animationSeconds);

  // One sampler per frame, not per creature: it captures only `ctx`.
  const sample = (cx: number, cy: number): number | null => ctx.terrainHeightAt(cx, cy);

  for (const [id, entity] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    // Three placement rules, one per PlacementKind (client/placement.ts):
    //   * flyers cruise at a fixed altitude and never sample the terrain at all
    //     — which is also why a bird over an unrevealed chunk is drawn correctly
    //     instead of sagging to the unknown-terrain default;
    //   * walkers stand on the highest band their FOOTPRINT overlaps (see
    //     walkerGroundY — the single-cell sample is the body-through-the-riser
    //     clipping bug);
    //   * swimmers float over the highest band their own HULL overlaps, nose to
    //     tail along their heading (swimmerSeabedY — the same bug, and a whale
    //     is five world units of it), and ease toward their preferred depth
    //     instead of recomputing it from a band-quantised seabed each frame.
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
              WILDLIFE_SIZE_MODEL_SCALE[sizeClass],
            );
    // NO GROUND, NO DRAW — the same answer every other plugin gives
    // (pilgrims, relics, fire). A swimmer with no known seabed used to be
    // placed against UNKNOWN_TERRAIN_WORLD_Y, which is the sea surface: the
    // one frame it was meant to cover became a whale lying on top of the sea
    // whenever its whole hull sampled ground this client had not been sent.
    // Flyers never sample ground and are unaffected.
    if (kind !== 'flyer' && terrainY === null) continue;
    const drawnY = creatureWorldY(entity.species, terrainY, sizeClass, view.drawnY, dt);
    view.drawnY = drawnY;
    // Cell coordinates scale to world X/Z by CELL_WORLD_SIZE (see placement.ts,
    // whose named residual this multiply is).
    view.drawnX = entity.x * CELL_WORLD_SIZE;
    view.drawnZ = entity.y * CELL_WORLD_SIZE;
    // The body span, at the scale models.draw is about to apply to the rig.
    const column = BODY_COLUMNS[entity.species];
    const modelScale = WILDLIFE_SIZE_MODEL_SCALE[sizeClass];
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
 * Where a creature is DRAWN, for anything that has to be drawn on it — a flame,
 * today (ClientPluginCtx.publishMovers).
 *
 * Read straight off what this frame committed to the herd's instance buffer, so
 * it is the pose actually on screen: interpolated, ground-sampled, eased, and
 * the body span at the drawn scale — heading excluded, which no consumer asks
 * for. That is the entire point
 * of answering per id per frame instead of publishing positions — a second
 * consumer re-deriving this from the same wire messages would get a slightly
 * different answer every frame, and whatever it drew would crawl around the
 * animal instead of sitting on it.
 *
 * Null for a creature this client is not drawing: one it has never heard of,
 * one already removed, or one whose view has not been built yet.
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
 * Draw objects the whole population costs, at any size: ONE INSTANCED MESH PER
 * BAKED SURFACE PER HERD, and a herd is a species (three of them, for the three
 * whale bodies — see models.ts).
 *
 * THE PER-SPECIES TABLE, measured off `models.objects` on 2026-09-02 and
 * asserted below rather than trusted:
 *
 *   | herd                    | surfaces |
 *   |-------------------------|----------|
 *   | fish                    |        1 |
 *   | grazer                  |        1 |
 *   | ibex                    |        1 |
 *   | bison                   |        1 |
 *   | ray                     |        1 |
 *   | shark                   |        1 |
 *   | bird                    |        1 |
 *   | deepsea                 |        2 |
 *   | whale × WHALE_SPECIES   |        2 |
 *
 * The six species authored in models.ts's ./species/ directory each bake to
 * ONE surface because their kit welds every extrusion (species/bodyKit.ts:
 * rigSkin groups by material signature AND by indexed/non-indexed, and colour
 * is not in the signature). The deep-sea creature's lure is UNLIT and each
 * whale carries a second material its body cannot share — those are the only
 * two-surface herds.
 *
 * WHY A CONSTANT AND NOT `models.objects.length`. `drawBudget` is a static
 * field on the plugin object (client/src/plugins/types.ts), read by the host
 * before `attach` ever runs and therefore before a pool exists. So the number
 * is written down here and `attach` THROWS if the pool it builds disagrees —
 * a species that quietly gains a surface fails at boot rather than showing up
 * as a budget breach half a second into the first frame.
 */
const SINGLE_SURFACE_SPECIES = 9; // fish, grazer, ibex, bison, ray, shark, eel, angelfish, bird
const TWO_SURFACE_SPECIES = 1 + WHALE_SPECIES.length; // deepsea, and each whale body
const WILDLIFE_SPECIES_DRAW_OBJECTS = SINGLE_SURFACE_SPECIES + TWO_SURFACE_SPECIES * 2;

export const clientPlugin: TerraceClientPlugin = {
  name: WILDLIFE_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: WILDLIFE_SPECIES_DRAW_OBJECTS,

  /**
   * Loads every asset-sourced species before attach, so createWildlifeModels
   * has something to bake from. Parsing a glTF is promise-based and attach()
   * is synchronous, which is the whole reason this hook exists (see
   * TerraceClientPlugin.preload).
   *
   * SEQUENTIAL, not Promise.all: the installs are cheap and the failure a
   * developer will actually hit is a bad asset, where being told WHICH file
   * broke first — rather than being handed whichever rejection won a race —
   * is what makes the message useful. A rejected preload is a logged breach
   * for this plugin only: the host never attaches it, so the world simply has
   * no wildlife in it rather than no client.
   */
  async preload(): Promise<void> {
    for (const { spec, url } of SPECIES_ASSETS) {
      installSpeciesAsset(spec, await loadRigAsset(url));
    }
  },

  attach(ctx: ClientPluginCtx): void {
    // Every herd sizes its instance buffers to the whole population: any one
    // species may, in principle, be all of it.
    models = createWildlifeModels(WILDLIFE_POPULATION_CAP + MAX_BIRDS_ALOFT);
    // The budget above is a promise about geometry this plugin does not own —
    // nine species files, each free to add a material. Checked against the pool
    // that was actually built, once, at boot: a mismatch is a wrong `drawBudget`
    // for the whole session, so it throws rather than logging.
    if (models.objects.length !== WILDLIFE_SPECIES_DRAW_OBJECTS) {
      throw new Error(
        `wildlife: draw budget is ${String(WILDLIFE_SPECIES_DRAW_OBJECTS)} objects but the ` +
          `model pool baked ${String(models.objects.length)} — update the per-species surface ` +
          'table in client/index.ts.',
      );
    }

    // One child Group of our own inside the host's layer: it keeps every
    // creature under a single named node, which makes the scene graph legible in
    // the three.js inspector and gives dispose() one thing to clear.
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
    // the asset's own material clone, and a clone shares the source's texture
    // objects by reference (client/src/render/rigSkin.ts, vertexColoured), so
    // freeing a file while a rig baked from it is still drawn pulls the texels
    // out from under it. models.dispose() above frees every blueprint; only
    // then is there nothing left reading the files.
    disposeSpeciesAssets();
    animationSeconds = 0;
  },
};

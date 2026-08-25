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
} from '../protocol.ts';
import { WildlifeInterpolator, type InterpolatedEntity } from './interpolation.ts';
import type { MoverPose } from '../../../client/src/plugins/types.ts';
import { createWildlifeModels, type CreatureModel, type WildlifeModels } from './models.ts';
import {
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
  readonly model: CreatureModel;
  /** Fixed at creation from the entity id — never recomputed per frame. */
  readonly phase: number;
  /**
   * World Y this creature was drawn at last frame, or null until it has been
   * drawn once. A SWIMMER's depth is eased frame to frame rather than
   * recomputed from scratch (placement.ts's SWIM_VERTICAL_WORLD_UNITS_PER_
   * SECOND), so it is the one part of a pose that has history; walkers and
   * flyers never read it.
   *
   * Held HERE rather than read back off `model.root.position.y`, which would
   * work today and would silently become wrong the moment anything else — an
   * idle animation, a hit reaction — moved the root: the eased value has to be
   * the one this loop last COMMITTED, not wherever the node ended up.
   */
  drawnY: number | null;
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

/** Adds/removes scene objects so `views` matches the sampled population. */
function reconcileViews(sampled: ReadonlyMap<number, InterpolatedEntity>): void {
  if (models === null || container === null) return;

  for (const [id, entity] of sampled) {
    if (views.has(id)) continue;
    // Size is fixed for a creature's whole life (the server draws it at spawn),
    // so it is baked into the model here rather than re-read every frame.
    // `id` also seeds which of the three whale bodies this creature gets: it is
    // stable for the creature's whole life, so an individual never changes
    // species between frames.
    const model = models.create(entity.species, sizeClassAt(entity.size), id);
    container.add(model.root);
    views.set(id, { model, phase: id * PHASE_RADIANS_PER_ID, drawnY: null });
  }

  for (const [id, view] of views) {
    if (sampled.has(id)) continue;
    container.remove(view.model.root);
    // Geometries and materials are shared per species and owned by `models`, so
    // there is nothing to dispose here — dropping the Mesh objects is the whole
    // teardown. Disposing them here would tear the resource out from under every
    // other creature of the same species.
    views.delete(id);
  }
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
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

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
    const sample = (cx: number, cy: number): number | null => ctx.terrainHeightAt(cx, cy);
    const swimProfile = SWIM_PROFILES[entity.species];
    const terrainY =
      kind === 'flyer'
        ? null
        : kind === 'walker' || swimProfile === null
          ? walkerGroundY(sample, entity.x, entity.y)
          : swimmerSeabedY(
              sample,
              entity.x,
              entity.y,
              entity.heading,
              swimProfile,
              WILDLIFE_SIZE_MODEL_SCALE[sizeClass],
            );
    const drawnY = creatureWorldY(entity.species, terrainY, sizeClass, view.drawnY, dt);
    view.drawnY = drawnY;
    const root = view.model.root;
    // Cell coordinates scale to world X/Z by CELL_WORLD_SIZE (see placement.ts,
    // whose named residual this multiply is).
    root.position.set(entity.x * CELL_WORLD_SIZE, drawnY, entity.y * CELL_WORLD_SIZE);
    // Models face +X. Rotating +X about Y by θ yields (cos θ, 0, -sin θ), and the
    // creature travels toward (cos heading, 0, sin heading) — hence the negation.
    root.rotation.y = -entity.heading;

    view.model.animate(animationSeconds, view.phase);
  }
}

/**
 * Where a creature is DRAWN, for anything that has to be drawn on it — a flame,
 * today (ClientPluginCtx.publishMovers).
 *
 * Read straight off the model's own root, so it is the pose this frame actually
 * put on screen: interpolated, ground-sampled, eased. That is the entire point
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
  if (view === undefined) return null;
  const at = view.model.root.position;
  return { x: at.x, y: at.y, z: at.z };
}

export const clientPlugin: TerraceClientPlugin = {
  name: WILDLIFE_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    models = createWildlifeModels();

    // One child Group of our own inside the host's layer: it keeps every
    // creature under a single named node, which makes the scene graph legible in
    // the three.js inspector and gives dispose() one thing to clear.
    container = new Group();
    container.name = 'wildlife:creatures';
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

    for (const view of views.values()) view.model.root.clear();
    views.clear();
    interpolator.clear();

    container?.clear();
    container = null;

    // Shared geometries and materials are freed exactly once, here.
    models?.dispose();
    models = null;
    animationSeconds = 0;
  },
};

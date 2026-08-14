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
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  WILDLIFE_ENTITIES_MESSAGE,
  WILDLIFE_PLUGIN_NAME,
  parseEntitiesPayload,
} from '../protocol.ts';
import { WildlifeInterpolator, type InterpolatedEntity } from './interpolation.ts';
import { createWildlifeModels, type CreatureModel, type WildlifeModels } from './models.ts';
import { creatureWorldY } from './placement.ts';

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
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

/** Adds/removes scene objects so `views` matches the sampled population. */
function reconcileViews(sampled: ReadonlyMap<number, InterpolatedEntity>): void {
  if (models === null || container === null) return;

  for (const [id, entity] of sampled) {
    if (views.has(id)) continue;
    const model = models.create(entity.species);
    container.add(model.root);
    views.set(id, { model, phase: id * PHASE_RADIANS_PER_ID });
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

    const terrainY = ctx.terrainHeightAt(Math.floor(entity.x), Math.floor(entity.y));
    const root = view.model.root;
    // CELL_WORLD_SIZE is 1, so cell coordinates ARE world X/Z (see placement.ts).
    root.position.set(entity.x, creatureWorldY(entity.species, terrainY), entity.y);
    // Models face +X. Rotating +X about Y by θ yields (cos θ, 0, -sin θ), and the
    // creature travels toward (cos heading, 0, sin heading) — hence the negation.
    root.rotation.y = -entity.heading;

    view.model.animate(animationSeconds, view.phase);
  }
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

// pilgrims — client half. Draws whatever the server's `pilgrims:entities`
// broadcast says is on the road, and nothing else — wildlife's client shape
// exactly: no authority, no prediction, interpolation and a walk cycle as the
// only cosmetics, so a client that misses messages looks stiller, never wrong.

import { Group } from 'three';
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  PILGRIMS_ENTITIES_MESSAGE,
  PILGRIMS_PLUGIN_NAME,
  parseEntitiesPayload,
} from '../protocol.ts';
import { PilgrimInterpolator, type InterpolatedPilgrim } from './interpolation.ts';
import { createPilgrimModels, type PilgrimModel, type PilgrimModels } from './models.ts';

/** Golden-angle phase spread — wildlife's trick, same constant, same reason. */
const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

/** Cap on the animation clock's advance per frame — wildlife's guard. */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

interface PilgrimView {
  readonly model: PilgrimModel;
  readonly phase: number;
}

let models: PilgrimModels | null = null;
let container: Group | null = null;
const views = new Map<number, PilgrimView>();
const interpolator = new PilgrimInterpolator();
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

function reconcileViews(sampled: ReadonlyMap<number, InterpolatedPilgrim>): void {
  if (models === null || container === null) return;

  for (const [id, pilgrim] of sampled) {
    if (views.has(id)) continue;
    // kind is stable per id (the allocator never reuses one across kinds), so
    // binding the model at first sight is safe.
    const model = models.create(pilgrim.race, pilgrim.kind);
    container.add(model.root);
    views.set(id, { model, phase: id * PHASE_RADIANS_PER_ID });
  }

  for (const [id, view] of views) {
    if (sampled.has(id)) continue;
    container.remove(view.model.root);
    // Geometries/materials are shared and owned by `models` — dropping the
    // meshes is the whole teardown (wildlife's identical note).
    views.delete(id);
  }
}

function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  for (const [id, pilgrim] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    // Single-cell ground sample, unlike wildlife's footprint-corner walkers:
    // a pilgrim is ~0.2 cells wide, so its body cannot overlap a neighbouring
    // riser the way a multi-cell yeti or grazer can — the clipping bug that
    // sample exists for is out of reach here. Unknown ground (chunk not yet
    // streamed) simply skips the pilgrim this frame.
    const terrainY = ctx.terrainHeightAt(Math.floor(pilgrim.x), Math.floor(pilgrim.y));
    if (terrainY === null) {
      view.model.root.visible = false;
      continue;
    }
    view.model.root.visible = true;
    view.model.root.position.set(pilgrim.x, terrainY, pilgrim.y);
    // Models face +X; travel is toward (cos heading, sin heading) — the same
    // negation every mover in this repo applies.
    view.model.root.rotation.y = -pilgrim.heading;
    view.model.animate(animationSeconds, view.phase);
  }
}

export const clientPlugin: TerraceClientPlugin = {
  name: PILGRIMS_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    models = createPilgrimModels();

    container = new Group();
    container.name = 'pilgrims:walkers';
    ctx.layer.add(container);

    unsubscribeMessages = ctx.onMessage(PILGRIMS_ENTITIES_MESSAGE, (payload) => {
      const pilgrims = parseEntitiesPayload(payload);
      // Malformed payload → dropped whole; the previous crowd keeps walking
      // until the next good message, 200 ms away.
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

    for (const view of views.values()) view.model.root.clear();
    views.clear();
    interpolator.clear();

    container?.clear();
    container = null;

    models?.dispose();
    models = null;
    animationSeconds = 0;
  },
};

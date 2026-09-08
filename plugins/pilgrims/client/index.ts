// pilgrims — client half. Draws whatever the server's `pilgrims:entities`
// broadcast says is on the road: no authority, no prediction, interpolation
// and a walk cycle as the only cosmetics.

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

/**
 * World units per stored height unit. Restated from its two @terrace/shared
 * inputs rather than imported: client/src/config.ts would drag
 * `import.meta.env` into this plugin's node typecheck and test run.
 */
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

/** Golden-angle phase spread — wildlife's trick, same constant, same reason. */
const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

/** Cap on the animation clock's advance per frame — wildlife's guard. */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

interface PilgrimView {
  readonly model: PilgrimModel;
  readonly phase: number;
  /**
   * Where this walker was DRAWN vertically last frame, the follower's state.
   * Null until its first drawn frame, and reset to null whenever it is hidden.
   */
  drawnY: number | null;
  /** How far the drawn body sits off the wire while it holds a wall. */
  readonly riserShift: ClimbRiserShift;
}

let models: PilgrimModels | null = null;
let container: Group | null = null;
const views = new Map<number, PilgrimView>();
const interpolator = new PilgrimInterpolator();

/** Withdraws this plugin's aimable walkers / pose lookup from the host. */
let unmarkPickable: (() => void) | null = null;
let unpublishMovers: (() => void) | null = null;
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
    // Geometries/materials are shared and owned by `models`; model.dispose()
    // frees only this walker's own skeleton bone texture.
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

  // One sampler per frame, not per walker: it captures only `ctx`.
  const groundAt = drawnGroundSampler(ctx);

  for (const [id, pilgrim] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    // Single-cell sample: a pilgrim is ~0.2 cells wide, unlike wildlife's
    // footprint corners. FRACTIONAL, NOT FLOORED: the drawn cap resolves to a
    // quarter cell, so a foot follows the contour.
    const terrainY = groundAt(pilgrim.x, pilgrim.y);
    if (terrainY === null) {
      view.model.root.visible = false;
      // Nothing to ease from next time: see PilgrimView.drawnY.
      view.drawnY = null;
      view.riserShift.x = 0;
      view.riserShift.y = 0;
      continue;
    }
    view.model.root.visible = true;
    // Three cases, one expression: on a wall the server's `climbHeight` is the
    // answer; walking, the drawn cap under its feet, chased not assigned; first
    // frame, the target itself.
    const targetY =
      pilgrim.climbHeight === null ? terrainY : pilgrim.climbHeight * HEIGHT_WORLD_SCALE;
    const drawnY = followGroundY(view.drawnY, targetY, dt);
    view.drawnY = drawnY;
    // A climber holds the riser the terrain DREW, which is nowhere near the
    // lattice edge the server pins its foot to (the kit's climbRiser).
    advanceClimbRiserShift(view.riserShift, ctx, pilgrim, drawnY, dt);
    // Cell coordinates scale to world X/Z by CELL_WORLD_SIZE; the model itself
    // is built in world units and is unaffected by the sampling density.
    view.model.root.position.set(
      (pilgrim.x + view.riserShift.x) * CELL_WORLD_SIZE,
      drawnY,
      (pilgrim.y + view.riserShift.y) * CELL_WORLD_SIZE,
    );
    // Models face +X; travel is toward (cos heading, sin heading) — the same
    // negation every mover in this repo applies.
    view.model.root.rotation.y = -pilgrim.heading;
    // What the walker is doing decides its pose: a climb or a fall is not a
    // walk at another height, and a walker covering no ground is not walking.
    view.model.animate(
      animationSeconds,
      view.phase,
      moverGaitOf(pilgrim.climbHeight, pilgrim.falling, moverStanceFromWire(pilgrim.stance)),
    );
  }
}

/**
 * Where a walker is DRAWN, for anything drawn on them (publishMovers). Read off
 * the model's root: the pose this frame put on screen. Null when not drawn.
 */
function drawnPoseOf(id: number): MoverPose | null {
  const view = views.get(id);
  if (view === undefined || !view.model.root.visible) return null;
  const at = view.model.root.position;
  // Baked with the feet at the origin (models.ts), so the body starts at `y`.
  return { x: at.x, y: at.y, z: at.z, bodyBottomY: at.y, bodyHeight: PILGRIM_HEIGHT };
}

/**
 * Draw objects one walker costs: TWO, whatever its race or kind. A fur surface
 * and a gloss surface (models.ts), with props on those same two.
 */
const WALKER_DRAW_OBJECTS = 2;

export const clientPlugin: TerraceClientPlugin = {
  name: PILGRIMS_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: WALKERS_WIRE_CAP * WALKER_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    models = createPilgrimModels();

    container = new Group();
    container.name = 'pilgrims:walkers';
    ctx.layer.add(container);
    // A PEEP IS SOMETHING YOU CAN POINT AT (pickWorldCell), and something a
    // flame can be drawn ON (publishMovers).
    unmarkPickable = ctx.markPickable(container);
    unpublishMovers = ctx.publishMovers(drawnPoseOf);

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

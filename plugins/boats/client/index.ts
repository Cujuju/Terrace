// boats — the client half: broadcast poses in, boats on the water out.
//
// SHAPE, and it is the monsters plugin's unchanged: validate the payload whole,
// feed an interpolator, and render its sample each frame. What differs is the
// VERTICAL rule, which is the simplest in the codebase — a boat floats on the
// sea surface, full stop. It never stands on the seabed the way a swimmer
// clamps to it (plugins/monsters/client/placement.ts) and never rides the
// terrain the way a walker does, because the server only ever puts a boat on a
// cell that is water, and every water cell's surface is at the same Y.
//
// That is why this plugin has no placement.ts: there is no rule to own.

import { Group } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  ClientPluginCtx,
  MoverPose,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  BOATS_PAYLOAD_CAP,
  BOATS_PLUGIN_NAME,
  BOATS_STATE_MESSAGE,
  parseBoatsPayload,
} from '../protocol.ts';
import { BoatInterpolator } from './interpolation.ts';
import warBoatUrl from './assets/war-boat.glb?url';
import {
  BOAT_DRAW_OBJECTS,
  BOAT_FIRE_COLUMN,
  BOAT_WATERLINE_LIFT,
  createBoatModels,
  disposeBoatKit,
  preloadBoatModels,
  type BoatModel,
  type BoatModels,
} from './models.ts';

/**
 * World-space Y of the sea surface.
 *
 * SEA_LEVEL is 0 by definition in @terrace/shared ("water is every height at or
 * below zero") and the renderer draws the sea at SEA_LEVEL * HEIGHT_WORLD_SCALE
 * plus a thirty-second of a world unit of lift, so this is 0 to well within a hull's
 * thickness. Restated as a literal rather than imported from the client's own
 * render layer, which a plugin has no business reaching into.
 */
const SEA_SURFACE_WORLD_Y = 0;

/**
 * Largest animation step honoured in one frame.
 *
 * A background tab that wakes after a minute must not hand the oar clock a
 * minute of accumulated stroke — the boats would spin their oars like a
 * flipbook for one frame. Monsters' own cap, for the same reason. Note the
 * INTERPOLATOR is still advanced by the raw dt: its own window clamp
 * (MAX_INTERPOLATION_SECONDS) is what handles a stall there, and capping the
 * step twice would make a recovering client glide in slow motion.
 */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

/**
 * Per-boat animation phase, so a fleet does not roll as one rigid object.
 *
 * Derived from the id rather than randomised: a boat must look the same on
 * every client, and a random phase would give the same boat a different roll in
 * two browsers watching the same fight. The multiplier is irrational-ish so
 * consecutive ids do not land on the same phase.
 */
const PHASE_PER_ID = 0.618;

interface BoatView {
  readonly model: BoatModel;
  readonly phase: number;
}

const interpolator = new BoatInterpolator();
const views = new Map<number, BoatView>();

let models: BoatModels | null = null;
let container: Group | null = null;

/** Withdraws this plugin's aimable boats / pose lookup from the host. */
let unmarkPickable: (() => void) | null = null;
let unpublishMovers: (() => void) | null = null;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let animationSeconds = 0;

/**
 * Creates views for boats that just appeared and destroys those that are gone.
 *
 * A boat leaving the sample is destroyed at once rather than faded: it sank, or
 * it left this player's view, and neither is something to ease out of (see the
 * interpolator's own note).
 */
function reconcileViews(sampled: ReadonlyMap<number, unknown>): void {
  if (models === null || container === null) return;

  for (const [id, view] of views) {
    if (sampled.has(id)) continue;
    container.remove(view.model.root);
    view.model.dispose();
    views.delete(id);
  }

  for (const id of sampled.keys()) {
    if (views.has(id)) continue;
    const model = models.create();
    container.add(model.root);
    views.set(id, { model, phase: (id * PHASE_PER_ID) % 1 });
  }
}

function renderFrame(dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  for (const [id, boat] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    // Cell coordinates scale to world X/Z by CELL_WORLD_SIZE. It was 1 until
    // the 2026-08-21 re-sample and this line carried no factor; a boat's pose
    // is in cells because the server steers it in cells, and the hull it is
    // attached to is modelled in world units.
    view.model.root.position.set(
      boat.x * CELL_WORLD_SIZE,
      SEA_SURFACE_WORLD_Y + BOAT_WATERLINE_LIFT,
      boat.y * CELL_WORLD_SIZE,
    );
    view.model.animate(animationSeconds, view.phase, boat.fighting);
    // Models face +X. Rotating +X about Y by θ yields (cos θ, 0, −sin θ) and
    // the boat travels toward (cos heading, 0, sin heading) — hence the
    // negation. The same rule monsters' render loop states, because both
    // plugins' models share the +X convention.
    //
    // Applied AFTER animate, which writes rotation.x and rotation.z for the
    // swell: animate must not clobber the yaw, and this must not clobber the
    // roll, so the two touch disjoint axes and the order is only about which
    // reads clearly.
    view.model.root.rotation.y = -boat.heading;
  }
}

/**
 * Where a boat is DRAWN, for anything that has to be drawn on it — a flame
 * (ClientPluginCtx.publishMovers).
 *
 * THIS IS WHY BURNING BOATS NEEDED NO NEW WIRE FIELD. The pose's `y` is this
 * plugin's own waterline, so a flame attached to it sits on the deck rather
 * than on the seabed several world units below — which is what a flame placed
 * from the TERRAIN height under a boat would have done.
 */
function drawnPoseOf(id: number): MoverPose | null {
  const view = views.get(id);
  if (view === undefined) return null;
  const at = view.model.root.position;
  return {
    x: at.x,
    y: at.y,
    z: at.z,
    bodyBottomY: at.y + BOAT_FIRE_COLUMN.bottomY,
    bodyHeight: BOAT_FIRE_COLUMN.height,
  };
}

export const clientPlugin: TerraceClientPlugin = {
  name: BOATS_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget. A GETTER, not a value: the per-boat count
   * is measured when the asset bakes (the textured hull costs its own surface
   * beside the flat set, which is why this settles at 3 and not the hand-built
   * 2), and the host reads the field every sample — so the budget follows the
   * measurement instead of freezing the pre-load ceiling.
   */
  get drawBudget(): number {
    return BOATS_PAYLOAD_CAP * BOAT_DRAW_OBJECTS;
  },

  /**
   * Loads war-boat.glb before attach, so createBoatModels has an asset to
   * bake from. A rejected load is a logged breach for this plugin only — the
   * host never attaches afterwards, so the fleet simply stays ashore.
   */
  preload(): Promise<void> {
    return preloadBoatModels(warBoatUrl);
  },

  attach(ctx: ClientPluginCtx): void {
    models = createBoatModels();

    container = new Group();
    container.name = 'boats:afloat';
    ctx.layer.add(container);
    // Aimable, and something a flame can be drawn on — the two halves of being
    // able to put a torch to a boat and watch it burn to the waterline.
    unmarkPickable = ctx.markPickable(container);
    unpublishMovers = ctx.publishMovers(drawnPoseOf);

    unsubscribeMessages = ctx.onMessage(BOATS_STATE_MESSAGE, (payload) => {
      const boats = parseBoatsPayload(payload);
      // Dropped whole if malformed: the previous fleet keeps rendering until
      // the next good message, half a second away. An EMPTY list is not
      // malformed — it is how a client learns its boats sank or left view.
      if (boats === null) return;
      interpolator.receive(boats);
    });

    unsubscribeFrames = ctx.onFrame(renderFrame);
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

    for (const view of views.values()) view.model.dispose();
    views.clear();
    interpolator.clear();

    container?.clear();
    container = null;

    models?.dispose();
    models = null;
    // After the blueprints: the baked surfaces sample the asset's textures,
    // and freeing them first would pull the texels out from under a living rig.
    disposeBoatKit();
    animationSeconds = 0;
  },
};

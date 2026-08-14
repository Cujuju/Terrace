// monsters — client half. Draws whatever the server's `monsters:state`
// broadcast says exists, and nothing else.
//
// It holds no authority: it never summons, never moves the monster of its own
// accord, and never predicts. Between the 1 Hz broadcasts it interpolates
// (./interpolation.ts) and plays the idle animation (./models.ts); both are
// purely cosmetic, so a client that misses messages looks stiller, never wrong.
//
// No HUD panel, deliberately: the entire point of this plugin is a thing you
// notice in the water. A counter telling you it is there would be the opposite
// of the feature.
//
// Everything it touches arrives through ClientPluginCtx: its own Group in the
// scene, the rendered terrain height, the message channel, and the frame clock.

import { Group } from 'three';
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  MONSTERS_PLUGIN_NAME,
  MONSTERS_STATE_MESSAGE,
  parseMonstersPayload,
} from '../protocol.ts';
import { MonsterInterpolator, type InterpolatedMonster } from './interpolation.ts';
import { createMonsterModels, type MonsterModel, type MonsterModels } from './models.ts';
import { monsterOriginWorldY } from './placement.ts';

/**
 * Per-monster animation phase offset, in radians per unit of id. The golden
 * angle: consecutive ids land as far apart on the cycle as possible. With one
 * monster at a time this only matters across a banishment and a re-arrival —
 * the newcomer should not resume the departed one's breath mid-stroke.
 */
const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

/**
 * Cap on the animation clock's advance per frame, in seconds. `onFrame`'s dt is
 * already capped by the host, but the animation clock is an accumulator: this
 * keeps a pathological frame from jumping the idle animation a full cycle.
 */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

/** A monster currently in the scene. */
interface MonsterView {
  readonly model: MonsterModel;
  /** Fixed at creation from the id — never recomputed per frame. */
  readonly phase: number;
}

/**
 * Module-level singletons, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin (client/src/
 * plugins/host.ts), and `attach`/`dispose` bracket their whole lifetime.
 */
let models: MonsterModels | null = null;
let container: Group | null = null;
const views = new Map<number, MonsterView>();
const interpolator = new MonsterInterpolator();
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

/**
 * Adds/removes scene objects so `views` matches the sampled state.
 *
 * Written as a general reconcile over a map rather than as "if there is one,
 * show it" even though MAX_LIVING_MONSTERS is 1: the wire format is a list, and
 * a client that assumed the list's length would be a client that breaks on the
 * day the server's cap changes — while looking, until then, exactly correct.
 */
function reconcileViews(sampled: ReadonlyMap<number, InterpolatedMonster>): void {
  if (models === null || container === null) return;

  for (const [id, monster] of sampled) {
    if (views.has(id)) continue;
    const model = models.create(monster.kind);
    container.add(model.root);
    views.set(id, { model, phase: id * PHASE_RADIANS_PER_ID });
  }

  for (const [id, view] of views) {
    if (sampled.has(id)) continue;
    container.remove(view.model.root);
    // Geometries and materials are shared per kind and owned by `models`, so
    // there is nothing to dispose here — dropping the Mesh objects is the whole
    // teardown. Disposing them here would tear the resource out from under the
    // next monster of the same kind.
    views.delete(id);
  }
}

/**
 * THE RENDER PATH. Runs once per animation frame.
 *
 * Placement is recomputed every frame rather than cached, because both inputs
 * move: the monster drifts between cells, and the seabed under it can be
 * sculpted at any moment. It is one terrainHeightAt lookup for one entity.
 */
function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  for (const [id, monster] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    // The seabed under its centre cell. A single sample is right here: the
    // monster floats in the water column rather than standing on a footprint,
    // and the placement rule only uses the seabed as a floor.
    const seabedY = ctx.terrainHeightAt(Math.floor(monster.x), Math.floor(monster.y));
    const root = view.model.root;
    // CELL_WORLD_SIZE is 1, so cell coordinates ARE world X/Z (see placement.ts).
    root.position.set(monster.x, monsterOriginWorldY(seabedY), monster.y);
    // Models face +X. Rotating +X about Y by θ yields (cos θ, 0, -sin θ), and
    // the monster travels toward (cos heading, 0, sin heading) — hence the
    // negation.
    root.rotation.y = -monster.heading;

    view.model.animate(animationSeconds, view.phase);
  }
}

export const clientPlugin: TerraceClientPlugin = {
  name: MONSTERS_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    models = createMonsterModels();

    // One child Group of our own inside the host's layer: it keeps the monster
    // under a single named node, which makes the scene graph legible in the
    // three.js inspector and gives dispose() one thing to clear.
    container = new Group();
    container.name = 'monsters:living';
    ctx.layer.add(container);

    unsubscribeMessages = ctx.onMessage(MONSTERS_STATE_MESSAGE, (payload) => {
      const monsters = parseMonstersPayload(payload);
      // A malformed payload is dropped whole: the previous state keeps rendering
      // until the next good message, which is a second away. An EMPTY list is
      // not malformed — it is the despawn, and it is applied.
      if (monsters === null) return;
      interpolator.receive(monsters);
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

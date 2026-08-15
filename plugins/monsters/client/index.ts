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
// The mist and the lightning around it (./atmosphere.ts) are the same kind of
// thing one step further: pure presentation, invented here, on the client, out
// of the position the server already sent and the frame clock. Nothing about
// them is on the wire, and nothing in the world can observe them.
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
import { createDread, type Dread } from './atmosphere.ts';
import { MonsterInterpolator, type InterpolatedMonster } from './interpolation.ts';
import { createMonsterModels, type MonsterModel, type MonsterModels } from './models.ts';
import { SEA_SURFACE_WORLD_Y, lurkDepthOf, monsterOriginWorldY } from './placement.ts';

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
  /** The mist and lightning around it (./atmosphere.ts). Purely cosmetic. */
  readonly dread: Dread;
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
/**
 * The weather of monsters that have LEFT, still fading out where they stood.
 *
 * The model goes the instant the server stops listing it — the submersion is the
 * plot (see interpolation.ts) — but a mist bank that vanished on the same frame
 * would be a light switch. These outlive their monster by MIST_FADE_SECONDS and
 * are disposed the moment the fade reaches zero, so the list is empty in every
 * frame but the couple of hundred after a banishment.
 */
const retiringDread: Dread[] = [];
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
    const dread = createDread();
    container.add(dread.root);
    views.set(id, { model, dread, phase: id * PHASE_RADIANS_PER_ID });
  }

  for (const [id, view] of views) {
    if (sampled.has(id)) continue;
    container.remove(view.model.root);
    // Geometries and materials are shared per kind and owned by `models`, so
    // there is nothing to dispose here — dropping the Mesh objects is the whole
    // teardown. Disposing them here would tear the resource out from under the
    // next monster of the same kind.
    //
    // The dread is the opposite case: it owns its geometry, its materials and
    // its light outright, so it stays in the scene until it has faded and is
    // then disposed — by renderFrame, which is the only thing here with a dt.
    retiringDread.push(view.dread);
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
    // The lurking depth is the KIND's — the two monsters sit at very different
    // heights in the same water, which is most of what tells them apart from a
    // distance.
    root.position.set(monster.x, monsterOriginWorldY(seabedY, lurkDepthOf(monster.kind)), monster.y);
    // Models face +X. Rotating +X about Y by θ yields (cos θ, 0, -sin θ), and
    // the monster travels toward (cos heading, 0, sin heading) — hence the
    // negation.
    root.rotation.y = -monster.heading;

    view.model.animate(animationSeconds, view.phase);

    // THE MIST FOLLOWS THE SAME INTERPOLATED POSE the model does, so the bank
    // cannot lag or lead the thing it belongs to. It sits on the SEA SURFACE
    // rather than at the model's origin (which is down at the lurking depth) and
    // is never yawed — mist does not turn with the monster.
    //
    // It is advanced by the CAPPED step rather than the raw dt for the same
    // reason the animation clock is: after a background tab wakes up, a fade
    // must not jump to its end and the lightning clock must not be handed a
    // minute of accumulated waiting.
    view.dread.root.position.set(monster.x, SEA_SURFACE_WORLD_Y, monster.y);
    view.dread.update(animationSeconds, step, true);
  }

  // Banished monsters' weather, fading in place. Iterated backwards so a
  // finished one can be spliced out without skipping its neighbour.
  for (let index = retiringDread.length - 1; index >= 0; index--) {
    const dread = retiringDread[index]!;
    dread.update(animationSeconds, step, false);
    if (!dread.isFaded()) continue;
    container?.remove(dread.root);
    dread.dispose();
    retiringDread.splice(index, 1);
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

    for (const view of views.values()) {
      view.model.root.clear();
      // Each dread owns its own GPU resources, so every one of them — living or
      // still fading — is freed here. Nothing may outlive the plugin.
      view.dread.dispose();
    }
    views.clear();
    for (const dread of retiringDread) dread.dispose();
    retiringDread.length = 0;
    interpolator.clear();

    container?.clear();
    container = null;

    // Shared geometries and materials are freed exactly once, here.
    models?.dispose();
    models = null;
    animationSeconds = 0;
  },
};

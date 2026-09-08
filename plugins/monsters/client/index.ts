// monsters — client half. Draws whatever the server's `monsters:state`
// broadcast says exists: no authority, no prediction, interpolation and an
// idle animation as the only cosmetics. No HUD panel, deliberately.

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
 * inputs: importing client/src/config.ts drags `import.meta.env` into a node
 * typecheck.
 */
const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  MONSTERS_PLUGIN_NAME,
  MONSTERS_STATE_MESSAGE,
  parseMonstersPayload,
  type YetiVariant,
  MAX_LIVING_MONSTERS,
} from '../protocol.ts';
import { createDread, type Dread } from './atmosphere.ts';
import { dreadSpecOf } from './dread.ts';
import { reconcileById } from '../../../client/src/plugins/kit/viewReconcile.ts';
import { MonsterInterpolator, type InterpolatedMonster } from './interpolation.ts';
import { createMonsterModels, type MonsterModel, type MonsterModels } from './models.ts';
import { SEA_SURFACE_WORLD_Y, monsterOriginY, placementRuleOf } from './placement.ts';

/**
 * Per-monster animation phase offset, in radians per unit of id. The golden
 * angle: consecutive ids land as far apart on the cycle as possible.
 */
const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

/**
 * Cap on the animation clock's advance per frame, in seconds. The clock is an
 * accumulator: this keeps a pathological frame from jumping a full cycle.
 */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

/** A monster currently in the scene. */
interface MonsterView {
  readonly model: MonsterModel;
  /**
   * The mist and lightning around it (./atmosphere.ts), or null for a kind with
   * no weather. Sea weather pinned to the waterline, so the test is PLACEMENT.
   */
  readonly dread: Dread | null;
  /** Fixed at creation from the id — never recomputed per frame. */
  readonly phase: number;
  /**
   * WHICH BODY this view was built from, or undefined for a kind with only one.
   * Recorded because a MonsterModel cannot be asked; the reconcile rebuilds a
   * monster whose variant changed.
   */
  readonly variant: YetiVariant | undefined;
  /**
   * Where this monster was DRAWN vertically last frame, the ground follower's
   * state, so crossing a band is a step. Null before its first drawn frame.
   */
  drawnY: number | null;
  /** How far the drawn body sits off the wire while it holds a wall. */
  readonly riserShift: ClimbRiserShift;
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
 * The weather of monsters that have LEFT, still fading where they stood. A mist
 * bank that vanished with its model would be a light switch.
 */
const retiringDread: Dread[] = [];
const interpolator = new MonsterInterpolator();
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

/**
 * Adds/removes scene objects so `views` matches the sampled state. A general
 * reconcile over a map, because the wire format is a list whose length is the
 * server's business.
 */
function reconcileViews(sampled: ReadonlyMap<number, InterpolatedMonster>): void {
  if (models === null || container === null) return;

  const bank = models;
  const scene = container;

  reconcileById(sampled, views, {
    acquire: (id, monster) => {
      const model = bank.create(monster.kind, monster.variant);
      scene.add(model.root);
      // Each swimmer's weather is derived from its OWN anatomy (dreadSpecOf).
      // A kind with no spec gets no dread, the same set as the non-swimmers.
      const spec = dreadSpecOf(monster.kind);
      const dread = spec !== null ? createDread(spec) : null;
      if (dread !== null) scene.add(dread.root);
      return {
        model,
        dread,
        phase: id * PHASE_RADIANS_PER_ID,
        variant: monster.variant,
        drawnY: null,
        riserShift: newClimbRiserShift(),
      };
    },
    replace: (_id, monster, existing) => {
      if (existing.variant === monster.variant) return null;
      // A LIVE ID WHOSE BODY CHANGED — belt and suspenders: a variant is
      // readonly for the monster's life. The DREAD is untouched, following the
      // KIND's placement.
      scene.remove(existing.model.root);
      existing.model.dispose();
      const rebuilt = bank.create(monster.kind, monster.variant);
      scene.add(rebuilt.root);
      return {
        drawnY: existing.drawnY,
        model: rebuilt,
        dread: existing.dread,
        phase: existing.phase,
        variant: monster.variant,
        riserShift: existing.riserShift,
      };
    },
    release: (_id, view) => {
      scene.remove(view.model.root);
      // Geometries and materials are shared per kind and owned by `models`, so
      // model.dispose() frees only this instance's skeleton bone texture.
      view.model.dispose();
      // The dread owns its geometry, materials and light outright, so it stays
      // in the scene until faded and is then disposed by renderFrame.
      if (view.dread !== null) retiringDread.push(view.dread);
    },
  });
}

/**
 * THE RENDER PATH. Runs once per animation frame. Placement is recomputed every
 * frame: both the monster and the ground under it move. One drawnGroundYAt
 * lookup per entity.
 */
function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  // One sampler per frame, not per monster: it captures only `ctx`.
  const groundAt = drawnGroundSampler(ctx);

  for (const [id, monster] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    const root = view.model.root;
    // WHERE IT IS VERTICALLY, in three cases: on a wall the server's
    // `climbHeight`; otherwise the kind's own placement rule, chased not
    // assigned; first frame, the target itself.
    const placedY = monsterOriginY(monster.kind, groundAt, monster.x, monster.y);
    const targetY =
      monster.climbHeight === null ? placedY : monster.climbHeight * HEIGHT_WORLD_SCALE;
    const drawnY = followGroundY(view.drawnY, targetY, dt);
    view.drawnY = drawnY;
    // A climber holds the riser the terrain DREW, which is nowhere near the
    // lattice edge the server pins its foot to (the kit's climbRiser).
    advanceClimbRiserShift(view.riserShift, ctx, monster, drawnY, dt);
    root.position.set(
      (monster.x + view.riserShift.x) * CELL_WORLD_SIZE,
      drawnY,
      (monster.y + view.riserShift.y) * CELL_WORLD_SIZE,
    );
    // Models face +X. Rotating +X about Y by θ yields (cos θ, 0, -sin θ), and
    // the monster travels toward (cos heading, 0, sin heading) — hence the
    // negation.
    root.rotation.y = -monster.heading;

    // A climb and a fall are poses, not a walk at another height, and so are
    // standing and sitting (the kit's moverGaitOf, off the server's climb and
    // stance fields).
    view.model.animate(
      animationSeconds,
      view.phase,
      moverGaitOf(monster.climbHeight, monster.falling, moverStanceFromWire(monster.stance)),
    );

    // THE MIST FOLLOWS THE SAME INTERPOLATED POSE the model does, sits on the
    // SEA SURFACE rather than the model's origin, and never yaws. Advanced by
    // the CAPPED step.
    if (view.dread !== null) {
      view.dread.root.position.set(
        monster.x * CELL_WORLD_SIZE,
        SEA_SURFACE_WORLD_Y,
        monster.y * CELL_WORLD_SIZE,
      );
      view.dread.update(animationSeconds, step, true);
    }
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

/**
 * Draw objects one monster's MODEL costs at worst: SIX, the yeti, whose rig
 * bakes to six surfaces.
 */
const MONSTER_MODEL_DRAW_OBJECTS = 6;

/**
 * And its weather: FIVE for a swimmer's dread rig. Budgeted for every living
 * monster rather than the swimmers alone; which kinds carry one is a question
 * for ./dread.ts.
 */
const MONSTER_DREAD_DRAW_OBJECTS = 5;

export const clientPlugin: TerraceClientPlugin = {
  name: MONSTERS_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: MAX_LIVING_MONSTERS * (MONSTER_MODEL_DRAW_OBJECTS + MONSTER_DREAD_DRAW_OBJECTS),

  attach(ctx: ClientPluginCtx): void {
    models = createMonsterModels();

    // One child Group of our own inside the host's layer: it keeps the monster
    // under a single named node and gives dispose() one thing to clear.
    container = new Group();
    container.name = 'monsters:living';
    ctx.layer.add(container);

    unsubscribeMessages = ctx.onMessage(MONSTERS_STATE_MESSAGE, (payload) => {
      const monsters = parseMonstersPayload(payload);
      // A malformed payload is dropped whole: the previous state keeps
      // rendering until the next good message. An EMPTY list is the despawn.
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
      view.model.dispose();
      view.model.root.clear();
      // Each dread owns its own GPU resources, so every one of them — living or
      // still fading — is freed here. Nothing may outlive the plugin.
      view.dread?.dispose();
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

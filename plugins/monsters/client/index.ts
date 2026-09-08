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

const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

const MAX_ANIMATION_STEP_SECONDS = 0.1;

interface MonsterView {
  readonly model: MonsterModel;
  readonly dread: Dread | null;
  readonly phase: number;
  readonly variant: YetiVariant | undefined;
  drawnY: number | null;
  readonly riserShift: ClimbRiserShift;
}

let models: MonsterModels | null = null;
let container: Group | null = null;
const views = new Map<number, MonsterView>();
const retiringDread: Dread[] = [];
const interpolator = new MonsterInterpolator();
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

function reconcileViews(sampled: ReadonlyMap<number, InterpolatedMonster>): void {
  if (models === null || container === null) return;

  const bank = models;
  const scene = container;

  reconcileById(sampled, views, {
    acquire: (id, monster) => {
      const model = bank.create(monster.kind, monster.variant);
      scene.add(model.root);
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
      view.model.dispose();
      if (view.dread !== null) retiringDread.push(view.dread);
    },
  });
}

function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  const groundAt = drawnGroundSampler(ctx);

  for (const [id, monster] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    const root = view.model.root;
    const placedY = monsterOriginY(monster.kind, groundAt, monster.x, monster.y);
    const targetY =
      monster.climbHeight === null ? placedY : monster.climbHeight * HEIGHT_WORLD_SCALE;
    const drawnY = followGroundY(view.drawnY, targetY, dt);
    view.drawnY = drawnY;
    advanceClimbRiserShift(view.riserShift, ctx, monster, drawnY, dt);
    root.position.set(
      (monster.x + view.riserShift.x) * CELL_WORLD_SIZE,
      drawnY,
      (monster.y + view.riserShift.y) * CELL_WORLD_SIZE,
    );
    root.rotation.y = -monster.heading;

    view.model.animate(
      animationSeconds,
      view.phase,
      moverGaitOf(monster.climbHeight, monster.falling, moverStanceFromWire(monster.stance)),
    );

    if (view.dread !== null) {
      view.dread.root.position.set(
        monster.x * CELL_WORLD_SIZE,
        SEA_SURFACE_WORLD_Y,
        monster.y * CELL_WORLD_SIZE,
      );
      view.dread.update(animationSeconds, step, true);
    }
  }

  for (let index = retiringDread.length - 1; index >= 0; index--) {
    const dread = retiringDread[index]!;
    dread.update(animationSeconds, step, false);
    if (!dread.isFaded()) continue;
    container?.remove(dread.root);
    dread.dispose();
    retiringDread.splice(index, 1);
  }
}

const MONSTER_MODEL_DRAW_OBJECTS = 6;

const MONSTER_DREAD_DRAW_OBJECTS = 5;

export const clientPlugin: TerraceClientPlugin = {
  name: MONSTERS_PLUGIN_NAME,

  drawBudget: MAX_LIVING_MONSTERS * (MONSTER_MODEL_DRAW_OBJECTS + MONSTER_DREAD_DRAW_OBJECTS),

  attach(ctx: ClientPluginCtx): void {
    models = createMonsterModels();

    container = new Group();
    container.name = 'monsters:living';
    ctx.layer.add(container);

    unsubscribeMessages = ctx.onMessage(MONSTERS_STATE_MESSAGE, (payload) => {
      const monsters = parseMonstersPayload(payload);
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
      view.dread?.dispose();
    }
    views.clear();
    for (const dread of retiringDread) dread.dispose();
    retiringDread.length = 0;
    interpolator.clear();

    container?.clear();
    container = null;

    models?.dispose();
    models = null;
    animationSeconds = 0;
  },
};

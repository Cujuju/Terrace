import { Group, type PointLight } from 'three';
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
  MONSTER_KINDS,
  parseMonstersPayload,
  type MonsterKind,
  type YetiVariant,
  MAX_LIVING_MONSTERS,
  MAX_LIVING_MONSTERS_PER_KIND,
} from '../protocol.ts';
import { createDreadRigs, type Dread, type DreadRigs } from './atmosphere.ts';
import { FLASH_COLOR, FLASH_LIGHT_RANGE_CELLS, dreadSpecOf } from './dread.ts';
import {
  createLightBank,
  type LightBank,
} from '../../../client/src/plugins/kit/lightBank.ts';
import { NO_SAMPLE, reconcileById } from '../../../client/src/plugins/kit/viewReconcile.ts';
import { MonsterInterpolator, type InterpolatedMonster } from './interpolation.ts';
import { createMonsterModels, type MonsterModel, type MonsterModels } from './models.ts';
import { SEA_SURFACE_WORLD_Y, monsterOriginY, placementRuleOf } from './placement.ts';

const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

const MAX_ANIMATION_STEP_SECONDS = 0.1;

const DREAD_RETIRE_FADE_RIGS = 1;

const DREAD_RIGS_PER_KIND = MAX_LIVING_MONSTERS_PER_KIND + DREAD_RETIRE_FADE_RIGS;

interface MonsterView {
  readonly model: MonsterModel;
  readonly kind: MonsterKind;
  readonly dread: Dread | null;
  readonly flash: PointLight | null;
  readonly phase: number;
  readonly variant: YetiVariant | undefined;
  drawnY: number | null;
  readonly riserShift: ClimbRiserShift;
}

interface RetiringDread {
  readonly kind: MonsterKind;
  readonly dread: Dread;
  flash: PointLight | null;
}

let models: MonsterModels | null = null;
let container: Group | null = null;
const views = new Map<number, MonsterView>();
const retiringDread: RetiringDread[] = [];
const dreadRigs = new Map<MonsterKind, DreadRigs>();
const freeDread = new Map<MonsterKind, Dread[]>();
let flashBank: LightBank | null = null;

function endRetirement(index: number): Dread {
  const retiring = retiringDread[index]!;
  retiringDread.splice(index, 1);
  retiring.dread.setFlashLight(null);
  if (retiring.flash !== null) flashBank?.give(retiring.flash);
  return retiring.dread;
}

// Nothing is built after attach: a spawn that finds its kind's rigs all out takes the
// oldest retiree's, the one furthest into its fade, rather than growing the pool.
function lendDread(kind: MonsterKind): Dread | null {
  const free = freeDread.get(kind);
  if (free === undefined) return null;
  const pooled = free.pop();
  if (pooled !== undefined) {
    pooled.reset();
    return pooled;
  }
  for (let index = 0; index < retiringDread.length; index++) {
    if (retiringDread[index]!.kind !== kind) continue;
    const reclaimed = endRetirement(index);
    reclaimed.reset();
    return reclaimed;
  }
  return null;
}

// Same rule for the fixed light bank: a retiree's flash is already fading towards zero,
// so it yields its light to a living dread instead of the bank growing.
function lendFlashLight(): PointLight | null {
  const bank = flashBank;
  if (bank === null) return null;
  const lent = bank.lend();
  if (lent !== null) return lent;
  for (const retiring of retiringDread) {
    const light = retiring.flash;
    if (light === null) continue;
    retiring.flash = null;
    retiring.dread.setFlashLight(null);
    bank.give(light);
    return bank.lend();
  }
  return null;
}

const interpolator = new MonsterInterpolator();
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let unsubscribeReset: (() => void) | null = null;

function reconcileViews(sampled: ReadonlyMap<number, InterpolatedMonster>): void {
  if (models === null || container === null) return;

  const bank = models;
  const scene = container;

  reconcileById(sampled, views, {
    acquire: (id, monster) => {
      const model = bank.create(monster.kind, monster.variant);
      scene.add(model.root);
      const dread = lendDread(monster.kind);
      const flash = dread === null ? null : lendFlashLight();
      dread?.setFlashLight(flash);
      return {
        model,
        kind: monster.kind,
        dread,
        flash,
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
        kind: monster.kind,
        dread: existing.dread,
        flash: existing.flash,
        phase: existing.phase,
        variant: monster.variant,
        riserShift: existing.riserShift,
      };
    },
    release: (_id, view) => {
      scene.remove(view.model.root);
      view.model.dispose();
      if (view.dread !== null) {
        retiringDread.push({ kind: view.kind, dread: view.dread, flash: view.flash });
      }
    },
  });
}

function forgetViews(): void {
  reconcileViews(NO_SAMPLE);
  interpolator.clear();
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
    const retiring = retiringDread[index]!;
    retiring.dread.update(animationSeconds, step, false);
    if (!retiring.dread.isFaded()) continue;
    const kind = retiring.kind;
    freeDread.get(kind)?.push(endRetirement(index));
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

    flashBank = createLightBank({
      size: MAX_LIVING_MONSTERS,
      color: FLASH_COLOR,
      range: FLASH_LIGHT_RANGE_CELLS,
      name: `${MONSTERS_PLUGIN_NAME}:flash-light`,
      parent: container,
    });

    for (const kind of MONSTER_KINDS) {
      const spec = dreadSpecOf(kind);
      if (spec === null) continue;
      const rigs = createDreadRigs(spec, DREAD_RIGS_PER_KIND);
      dreadRigs.set(kind, rigs);
      freeDread.set(kind, [...rigs.rigs]);
      for (const rig of rigs.rigs) container.add(rig.root);
    }

    unsubscribeMessages = ctx.onMessage(MONSTERS_STATE_MESSAGE, (payload) => {
      const monsters = parseMonstersPayload(payload);
      if (monsters === null) return;
      interpolator.receive(monsters);
    });

    unsubscribeFrames = ctx.onFrame((dt) => renderFrame(ctx, dt));
    unsubscribeReset = ctx.onWorldReset(forgetViews);
  },

  dispose(): void {
    unsubscribeMessages?.();
    unsubscribeFrames?.();
    unsubscribeReset?.();
    unsubscribeMessages = null;
    unsubscribeFrames = null;
    unsubscribeReset = null;

    forgetViews();
    retiringDread.length = 0;
    for (const rigs of dreadRigs.values()) rigs.dispose();
    dreadRigs.clear();
    freeDread.clear();
    flashBank?.dispose();
    flashBank = null;

    container?.clear();
    container = null;

    models?.dispose();
    models = null;
    animationSeconds = 0;
  },
};

import { Group, Vector3 } from 'three';
import { CELL_WORLD_SIZE, SEA_LEVEL } from '@terrace/shared';
import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import { reconcileById } from '../../../client/src/plugins/kit/viewReconcile.ts';
import { watchReducedMotion } from '../../../client/src/plugins/kit/reducedMotion.ts';
import {
  MAX_LASER_BOLTS,
  MAX_SAUCERS_PER_ENCOUNTER,
  SAUCERS_PLUGIN_NAME,
  SAUCERS_STATE_MESSAGE,
  parseSaucersPayload,
  type CrashState,
  type LaserBolt,
} from '../protocol.ts';
import {
  BURST_DRAW_OBJECTS,
  LASER_POOL_DRAW_OBJECTS,
  SPLASH_DRAW_OBJECTS,
  createCrashSplashes,
  type CrashSplashes,
  createCrashBursts,
  createLaserPool,
  type CrashBursts,
  type LaserPool,
} from './effects.ts';
import { factionColour } from './factions.ts';
import { SaucerInterpolator, type InterpolatedSaucer } from './interpolation.ts';
import {
  createSaucerModels,
  disposeSaucerAssets,
  preloadSaucerModels,
  SAUCER_MODEL_DRAW_OBJECTS,
  type SaucerModel,
  type SaucerModels,
} from './models.ts';

const RING_RADIANS_PER_SECOND = 6;

const LIGHTS_FLASHES_PER_SECOND = 2;
const LIGHTS_FLASH_FRACTION = 0.4;

const MUZZLE_FLASH_GAIN = 2.5;
const MUZZLE_FLASH_DECAY_PER_SECOND = 8;

const MAX_BANK_RADIANS = 0.6;
const BANK_FULL_TURN_RATE = 2;

const MAX_ANIMATION_STEP_SECONDS = 0.1;

interface SaucerView {
  readonly model: SaucerModel;
  readonly variant: number;
  lastHeading: number;
}

let models: SaucerModels | null = null;
let container: Group | null = null;
let lasers: LaserPool | null = null;
let bursts: CrashBursts | null = null;
let splashes: CrashSplashes | null = null;
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
const views = new Map<number, SaucerView>();
const interpolator = new SaucerInterpolator();
const SEA_SURFACE_WORLD_Y: 0 = SEA_LEVEL;

let bolts: readonly LaserBolt[] = [];
let sinceBolts = 0;
let crashes: readonly CrashState[] = [];
let animationSeconds = 0;
let unsubscribes: Array<() => void> = [];

const boltFrom = new Vector3();
const boltAim = new Vector3();

function reconcileViews(sampled: ReadonlyMap<number, InterpolatedSaucer>): void {
  if (models === null || container === null) return;
  const bank = models;
  const scene = container;

  reconcileById(sampled, views, {
    acquire: (_id, saucer) => {
      const model = bank.create(saucer.variant);
      model.root.rotation.order = 'YXZ';
      scene.add(model.root);
      return { model, variant: saucer.variant, lastHeading: saucer.heading };
    },
    replace: (_id, saucer, existing) => {
      if (existing.variant === saucer.variant) return null;
      scene.remove(existing.model.root);
      existing.model.dispose();
      const rebuilt = bank.create(saucer.variant);
      rebuilt.root.rotation.order = 'YXZ';
      scene.add(rebuilt.root);
      return { model: rebuilt, variant: saucer.variant, lastHeading: existing.lastHeading };
    },
    release: (_id, view) => {
      scene.remove(view.model.root);
      view.model.dispose();
    },
  });
}

function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  if (!(reducedMotion?.matches() ?? false)) animationSeconds += step;

  interpolator.advance(dt);
  sinceBolts += dt;
  const sampled = interpolator.sample();
  reconcileViews(sampled);

  for (const [id, saucer] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;
    const root = view.model.root;

    root.position.set(saucer.x * CELL_WORLD_SIZE, saucer.alt, saucer.y * CELL_WORLD_SIZE);

    root.rotation.y = -saucer.heading;

    const turn = step > 0 ? shortestAngle(saucer.heading - view.lastHeading) / step : 0;
    view.lastHeading = saucer.heading;
    root.rotation.x = clampSigned(turn / BANK_FULL_TURN_RATE) * MAX_BANK_RADIANS;

    if (view.model.ring !== null) {
      view.model.ring.rotation.y = animationSeconds * RING_RADIANS_PER_SECOND;
    }
    if (view.model.ringGlow !== null) {
      view.model.ringGlow.emissiveIntensity = view.model.ringBaseEmissive * muzzleGlow(id);
    }
    if (view.model.lights !== null) {
      view.model.lights.emissiveIntensity =
        view.model.lightsBaseEmissive *
        (1 +
          LIGHTS_FLASH_FRACTION *
            Math.sin(animationSeconds * LIGHTS_FLASHES_PER_SECOND * Math.PI * 2));
    }
  }

  drawBolts();
  drawCrashes(ctx);
}

function muzzleGlow(id: number): number {
  let youngest = Infinity;
  for (const bolt of bolts) {
    if (bolt.from !== id) continue;
    const age = boltRenderAge(bolt);
    if (age < youngest) youngest = age;
  }
  if (youngest === Infinity) return 1;
  return 1 + (MUZZLE_FLASH_GAIN - 1) * Math.exp(-MUZZLE_FLASH_DECAY_PER_SECOND * youngest);
}

function boltRenderAge(bolt: LaserBolt): number {
  return bolt.age + sinceBolts - interpolator.lagSeconds();
}

function drawBolts(): void {
  const pool = lasers;
  if (pool === null) return;
  pool.begin();
  if (bolts.length === 0) return;

  for (const bolt of bolts) {
    const shooter = views.get(bolt.from);
    if (shooter === undefined) continue;
    const age = boltRenderAge(bolt);
    if (age < 0) continue;
    boltFrom.set(bolt.x * CELL_WORLD_SIZE, bolt.alt, bolt.y * CELL_WORLD_SIZE);
    boltAim.set(bolt.aimX * CELL_WORLD_SIZE, bolt.aimAlt, bolt.aimY * CELL_WORLD_SIZE);
    pool.draw(boltFrom, boltAim, age, factionColour(shooter.variant));
  }
}

function drawCrashes(ctx: ClientPluginCtx): void {
  const rig = bursts;
  const splashRig = splashes;
  if (rig === null || splashRig === null) return;
  rig.begin();
  splashRig.begin();
  for (const crash of crashes) {
    const x = crash.x * CELL_WORLD_SIZE;
    const z = crash.y * CELL_WORLD_SIZE;
    if (crash.water) {
      rig.show(x, SEA_SURFACE_WORLD_Y, z, crash.age);
      splashRig.show(x, SEA_SURFACE_WORLD_Y, z, crash.age);
      continue;
    }
    const groundY = ctx.terrainHeightAt(crash.x, crash.y);
    if (groundY === null) continue;
    rig.show(x, groundY, z, crash.age);
  }
}

function shortestAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let delta = radians % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return delta;
}

function clampSigned(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

export const clientPlugin: TerraceClientPlugin = {
  name: SAUCERS_PLUGIN_NAME,

  get drawBudget(): number {
    return (
      MAX_SAUCERS_PER_ENCOUNTER * SAUCER_MODEL_DRAW_OBJECTS +
      LASER_POOL_DRAW_OBJECTS +
      BURST_DRAW_OBJECTS +
      SPLASH_DRAW_OBJECTS
    );
  },

  preload(ctx: ClientPluginCtx): Promise<void> {
    return preloadSaucerModels(ctx);
  },

  attach(ctx: ClientPluginCtx): void {
    models = createSaucerModels();
    reducedMotion = watchReducedMotion();
    animationSeconds = 0;
    bolts = [];
    crashes = [];

    container = new Group();
    container.name = 'saucers:flying';
    ctx.layer.add(container);

    lasers = createLaserPool();
    ctx.layer.add(lasers.root);
    bursts = createCrashBursts();
    ctx.layer.add(bursts.root);
    splashes = createCrashSplashes();
    ctx.layer.add(splashes.root);

    unsubscribes = [
      ctx.onMessage(SAUCERS_STATE_MESSAGE, (payload) => {
        const state = parseSaucersPayload(payload);
        if (state === null) return;
        interpolator.receive(state.saucers);
        bolts = state.lasers;
        sinceBolts = 0;
        crashes = state.crashes;
      }),

      ctx.onFrame((dt) => renderFrame(ctx, dt)),
    ];
  },

  dispose(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];

    for (const view of views.values()) view.model.dispose();
    views.clear();
    interpolator.clear();
    bolts = [];
    crashes = [];

    lasers?.dispose();
    lasers = null;
    bursts?.dispose();
    bursts = null;
    splashes?.dispose();
    splashes = null;

    container?.clear();
    container = null;

    models?.dispose();
    models = null;
    disposeSaucerAssets();

    reducedMotion?.stop();
    reducedMotion = null;
    animationSeconds = 0;
  },
};

export { MAX_LASER_BOLTS };

import type {
  ClientPluginCtx,
  GroundShadeDisc,
  SkyRigState,
  TerraceClientPlugin,
  WorldPosition,
} from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  CYCLONE_ALL_MESSAGE,
  CYCLONE_PLUGIN_NAME,
  parseAllPayload,
  MAX_ACTIVE_CYCLONES,
  type CycloneState,
} from '../protocol.ts';
import {
  createSpiral,
  SPIRAL_DRAW_OBJECTS,
  type SpiralRenderer,
  type SpiralSource,
} from './spiral.ts';
import { CYCLONE_DECK_BASE_WORLD_Y, MAX_SPIRALS } from './spiralLayout.ts';
import { CYCLONE_SHADE_CORE_FRACTION, CYCLONE_SHADE_DARKNESS } from './spiralLook.ts';
import {
  createCycloneRainField,
  CYCLONE_RAIN_DRAW_OBJECTS,
  type CycloneRainField,
  type CycloneRainSource,
} from './rain.ts';
import { GLOOM_RESPONSE_PER_SECOND, applyGloom, overheadFraction } from './gloom.ts';
import { extrapolate } from '../../../client/src/plugins/kit/extrapolation.ts';
import { watchReducedMotion } from '../../../client/src/plugins/kit/reducedMotion.ts';

let spiral: SpiralRenderer | null = null;
let rain: CycloneRainField | null = null;
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
let unsubscribes: Array<() => void> = [];

let storms: readonly CycloneState[] = [];
let receivedAtSeconds = 0;

let elapsedSeconds = 0;

let gloomDepth = 0;

function at(storm: CycloneState): { x: number; y: number } {
  return extrapolate(storm, elapsedSeconds - receivedAtSeconds);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// Every lookup below runs each frame, so each refills its own pool in place.
function refill<T>(pool: Mutable<T>[], out: T[], blank: () => Mutable<T>): Mutable<T> {
  while (pool.length <= out.length) pool.push(blank());
  return pool[out.length]!;
}

function blankSpiralSource(): Mutable<SpiralSource> {
  return { id: 0, x: 0, z: 0, radiusCells: 0, intensity: 0 };
}

const spiralPool: Mutable<SpiralSource>[] = [];
const spiralSources: SpiralSource[] = [];

function refreshSpiralSources(): readonly SpiralSource[] {
  spiralSources.length = 0;
  for (const storm of storms) {
    const centre = at(storm);
    const filled = refill(spiralPool, spiralSources, blankSpiralSource);
    filled.id = storm.id;
    filled.x = centre.x * CELL_WORLD_SIZE;
    filled.z = centre.y * CELL_WORLD_SIZE;
    filled.radiusCells = storm.radius;
    filled.intensity = storm.intensity;
    spiralSources.push(filled);
  }
  return spiralSources;
}

function blankRainSource(): Mutable<CycloneRainSource> {
  return { id: 0, x: 0, z: 0, radiusWorldUnits: 0, intensity: 0, vx: 0, vz: 0 };
}

const rainPool: Mutable<CycloneRainSource>[] = [];
const rainSources: CycloneRainSource[] = [];

function refreshRainSources(): readonly CycloneRainSource[] {
  rainSources.length = 0;
  for (const storm of storms) {
    const centre = at(storm);
    const filled = refill(rainPool, rainSources, blankRainSource);
    filled.id = storm.id;
    filled.x = centre.x * CELL_WORLD_SIZE;
    filled.z = centre.y * CELL_WORLD_SIZE;
    filled.radiusWorldUnits = storm.radius * CELL_WORLD_SIZE;
    filled.intensity = storm.intensity;
    filled.vx = storm.vx * CELL_WORLD_SIZE;
    filled.vz = storm.vy * CELL_WORLD_SIZE;
    rainSources.push(filled);
  }
  return rainSources;
}

// The deck darkens what is under it, and the camera is what the player is under.
function gloomTarget(camera: WorldPosition): number {
  const cameraCellX = camera.x / CELL_WORLD_SIZE;
  const cameraCellY = camera.z / CELL_WORLD_SIZE;
  let deepest = 0;
  for (const storm of storms) {
    const centre = at(storm);
    const dx = cameraCellX - centre.x;
    const dy = cameraCellY - centre.y;
    const depth = storm.intensity * overheadFraction(Math.hypot(dx, dy), storm.radius);
    if (depth > deepest) deepest = depth;
  }
  return deepest;
}

function blankShadeDisc(): Mutable<GroundShadeDisc> {
  return { x: 0, z: 0, y: 0, radius: 0, darkness: 0, inner: 0 };
}

const shadePool: Mutable<GroundShadeDisc>[] = [];
const shade: GroundShadeDisc[] = [];

function shadeDiscs(): readonly GroundShadeDisc[] {
  shade.length = 0;
  for (const storm of storms) {
    if (storm.intensity <= 0) continue;
    const centre = at(storm);
    const filled = refill(shadePool, shade, blankShadeDisc);
    filled.x = centre.x * CELL_WORLD_SIZE;
    filled.z = centre.y * CELL_WORLD_SIZE;
    filled.y = CYCLONE_DECK_BASE_WORLD_Y;
    filled.radius = storm.radius * CELL_WORLD_SIZE;
    filled.darkness = CYCLONE_SHADE_DARKNESS * storm.intensity;
    filled.inner = CYCLONE_SHADE_CORE_FRACTION;
    shade.push(filled);
  }
  return shade;
}

const CYCLONE_DRAW_OBJECTS = SPIRAL_DRAW_OBJECTS + CYCLONE_RAIN_DRAW_OBJECTS;

function forgetStorms(): void {
  storms = [];
  receivedAtSeconds = 0;
  elapsedSeconds = 0;
  gloomDepth = 0;
  spiralSources.length = 0;
  rainSources.length = 0;
  shade.length = 0;
}

export const clientPlugin: TerraceClientPlugin = {
  name: CYCLONE_PLUGIN_NAME,

  drawBudget: CYCLONE_DRAW_OBJECTS,

  groundShadeBudget: MAX_SPIRALS,

  attach(ctx: ClientPluginCtx): void {
    forgetStorms();
    reducedMotion = watchReducedMotion();

    spiral = createSpiral((material, label) => ctx.applyRevealClip(material, label));
    ctx.layer.add(spiral.root);

    rain = createCycloneRainField((material, label) => ctx.applyRevealClip(material, label));
    ctx.layer.add(rain.root);

    unsubscribes = [
      ctx.onMessage(CYCLONE_ALL_MESSAGE, (payload) => {
        const all = parseAllPayload(payload, MAX_ACTIVE_CYCLONES);
        if (all === null) return;
        storms = all.storms;
        receivedAtSeconds = elapsedSeconds;
      }),

      ctx.modulateSkyRig((state: SkyRigState) => applyGloom(state, gloomDepth)),

      ctx.publishGroundShade(shadeDiscs),

      ctx.onWorldReset(() => {
        forgetStorms();
        spiral?.reset();
        rain?.reset();
      }),

      ctx.onFrame((dt) => {
        if (!(reducedMotion?.matches() ?? false)) elapsedSeconds += dt;

        const camera = ctx.cameraPosition();
        spiral?.orderAgainstCamera(camera.y);

        spiral?.apply(refreshSpiralSources());
        spiral?.update(dt, elapsedSeconds);
        rain?.apply(refreshRainSources(), elapsedSeconds);

        const target = gloomTarget(camera);
        const step = GLOOM_RESPONSE_PER_SECOND * dt;
        gloomDepth =
          target > gloomDepth
            ? Math.min(target, gloomDepth + step)
            : Math.max(target, gloomDepth - step);
      }),
    ];
  },

  dispose(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];

    forgetStorms();

    spiral?.dispose();
    spiral = null;

    rain?.dispose();
    rain = null;

    reducedMotion?.stop();
    reducedMotion = null;
  },
};

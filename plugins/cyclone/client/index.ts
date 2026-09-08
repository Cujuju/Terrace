import type {
  ClientPluginCtx,
  GroundShadeDisc,
  SkyRigState,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  CYCLONE_ALL_MESSAGE,
  CYCLONE_PLUGIN_NAME,
  parseAllPayload,
  type CycloneState,
} from '../protocol.ts';
import {
  createSpiral,
  CYCLONE_DECK_BASE_WORLD_Y,
  CYCLONE_SHADE_CORE_FRACTION,
  CYCLONE_SHADE_DARKNESS,
  MAX_SPIRALS,
  type SpiralRenderer,
  type SpiralSource,
} from './spiral.ts';
import {
  createCycloneRainField,
  CYCLONE_RAIN_DRAW_OBJECTS,
  type CycloneRainField,
  type CycloneRainSource,
} from './rain.ts';
import {
  GLOOM_RESPONSE_PER_SECOND,
  applyGloom,
  overheadFraction,
} from './gloom.ts';
import { extrapolate } from '../../../client/src/plugins/kit/extrapolation.ts';
import { watchReducedMotion } from '../../../client/src/plugins/kit/reducedMotion.ts';

export const GLOOM_AIM_INTERVAL_SECONDS = 0.25;

let spiral: SpiralRenderer | null = null;
let rain: CycloneRainField | null = null;
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
let unsubscribes: Array<() => void> = [];

let storms: readonly CycloneState[] = [];
let receivedAtSeconds = 0;

let elapsedSeconds = 0;

let gloomDepth = 0;
let aimedCell: { x: number; y: number } | null = null;
let sinceAimSeconds = GLOOM_AIM_INTERVAL_SECONDS;

function at(storm: CycloneState): { x: number; y: number } {
  return extrapolate(storm, elapsedSeconds - receivedAtSeconds);
}

function spiralSources(): SpiralSource[] {
  const sources: SpiralSource[] = [];
  for (const storm of storms) {
    const centre = at(storm);
    sources.push({
      id: storm.id,
      x: centre.x * CELL_WORLD_SIZE,
      z: centre.y * CELL_WORLD_SIZE,
      radiusCells: storm.radius,
      intensity: storm.intensity,
    });
  }
  return sources;
}

const rainSources: CycloneRainSource[] = [];

function refreshRainSources(): readonly CycloneRainSource[] {
  rainSources.length = 0;
  for (const storm of storms) {
    const centre = at(storm);
    rainSources.push({
      id: storm.id,
      x: centre.x * CELL_WORLD_SIZE,
      z: centre.y * CELL_WORLD_SIZE,
      radiusWorldUnits: storm.radius * CELL_WORLD_SIZE,
      intensity: storm.intensity,
      vx: storm.vx * CELL_WORLD_SIZE,
      vz: storm.vy * CELL_WORLD_SIZE,
    });
  }
  return rainSources;
}

function gloomTarget(): number {
  if (aimedCell === null) return 0;
  let deepest = 0;
  for (const storm of storms) {
    const centre = at(storm);
    const dx = aimedCell.x - centre.x;
    const dy = aimedCell.y - centre.y;
    const depth = storm.intensity * overheadFraction(Math.hypot(dx, dy), storm.radius);
    if (depth > deepest) deepest = depth;
  }
  return deepest;
}

function refreshAim(ctx: ClientPluginCtx, dt: number): void {
  sinceAimSeconds += dt;
  if (sinceAimSeconds < GLOOM_AIM_INTERVAL_SECONDS) return;
  sinceAimSeconds = 0;
  if (typeof window === 'undefined') return;
  const cell = ctx.pickTerrainCell(window.innerWidth / 2, window.innerHeight / 2);
  if (cell !== null) aimedCell = cell;
}

const shade: GroundShadeDisc[] = [];

function shadeDiscs(): readonly GroundShadeDisc[] {
  shade.length = 0;
  for (const storm of storms) {
    if (storm.intensity <= 0) continue;
    const centre = at(storm);
    shade.push({
      x: centre.x * CELL_WORLD_SIZE,
      z: centre.y * CELL_WORLD_SIZE,
      y: CYCLONE_DECK_BASE_WORLD_Y,
      radius: storm.radius * CELL_WORLD_SIZE,
      darkness: CYCLONE_SHADE_DARKNESS * storm.intensity,
      inner: CYCLONE_SHADE_CORE_FRACTION,
    });
  }
  return shade;
}

const SPIRAL_DRAW_OBJECTS = 1;

const CYCLONE_DRAW_OBJECTS = SPIRAL_DRAW_OBJECTS + MAX_SPIRALS * CYCLONE_RAIN_DRAW_OBJECTS;

export const clientPlugin: TerraceClientPlugin = {
  name: CYCLONE_PLUGIN_NAME,

  drawBudget: CYCLONE_DRAW_OBJECTS,

  groundShadeBudget: MAX_SPIRALS,

  attach(ctx: ClientPluginCtx): void {
    storms = [];
    receivedAtSeconds = 0;
    elapsedSeconds = 0;
    gloomDepth = 0;
    aimedCell = null;
    sinceAimSeconds = GLOOM_AIM_INTERVAL_SECONDS;
    reducedMotion = watchReducedMotion();

    spiral = createSpiral((material, label) => ctx.applyRevealClip(material, label));
    ctx.layer.add(spiral.root);

    rain = createCycloneRainField((material, label) => ctx.applyRevealClip(material, label));
    ctx.layer.add(rain.root);

    unsubscribes = [
      ctx.onMessage(CYCLONE_ALL_MESSAGE, (payload) => {
        const all = parseAllPayload(payload);
        if (all === null) return;
        storms = all.storms;
        receivedAtSeconds = elapsedSeconds;
      }),

      ctx.modulateSkyRig((state: SkyRigState) => applyGloom(state, gloomDepth)),

      ctx.publishGroundShade(shadeDiscs),

      ctx.onFrame((dt) => {
        if (!(reducedMotion?.matches() ?? false)) elapsedSeconds += dt;

        spiral?.orderAgainstCamera(ctx.cameraPosition().y);

        spiral?.apply(spiralSources());
        spiral?.update(dt, elapsedSeconds);
        rain?.apply(refreshRainSources(), elapsedSeconds);

        refreshAim(ctx, dt);
        const target = gloomTarget();
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

    storms = [];
    receivedAtSeconds = 0;
    elapsedSeconds = 0;
    gloomDepth = 0;
    aimedCell = null;

    spiral?.dispose();
    spiral = null;

    rain?.dispose();
    rain = null;

    reducedMotion?.stop();
    reducedMotion = null;
  },
};

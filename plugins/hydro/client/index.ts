import type {
  ClientPluginCtx,
  GroundShadeDisc,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  BAND_HEIGHT, CELL_WORLD_SIZE, CHUNK_SIZE, DRAWN_GROUND_CELL_CENTRE,
  MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, chunkIndexOfCell, drawnSampleCellIndex,
} from '@terrace/shared';
import {
  HYDRO_CHANGES_MESSAGE,
  HYDRO_PATCHES_MESSAGE,
  HYDRO_PATCH_CAP,
  HYDRO_PATCH_CORE_FRACTION,
  HYDRO_PATCH_RADIUS_CELLS,
  HYDRO_PATCH_RADIUS_WORLD_UNITS,
  HYDRO_PLUGIN_NAME,
  HYDRO_POUR_MESSAGE,
  hydroKey,
  hydroWetness,
  isDried,
  parseChangesPayload,
  parsePatchesPayload,
  type HydroPatchState,
} from '../protocol.ts';
import { WaterIcon } from './WaterIcon.tsx';
import { createPourMarker, type PourMarker } from './pourMarker.ts';
import {
  PUDDLE_MASK_CELLS,
  PUDDLE_MASK_SAMPLES_PER_CELL,
  PUDDLE_MASK_SPAN,
  createPuddles,
  type PuddleInstance,
  type Puddles,
} from './puddles.ts';

interface LocalPatch {
  readonly cell: HydroPatchState;
  readonly supportChunks: readonly number[];
  drawnY: number | null;
  onStep: Uint8Array | null;
  ageSeconds: number;
}

// Cells drawn within half a band of the centre's ground share its step; others lie past a riser.
const SAME_STEP_TOLERANCE_WORLD = (BAND_HEIGHT * MAX_RELIEF_WORLD_UNITS) / MAX_HEIGHT / 2;

/** Includes the corner samples used by drawn-ground queries at the footprint's far edge. */
function puddleSupportChunks(size: number, cell: HydroPatchState): number[] {
  const clamp = (value: number): number => Math.max(0, Math.min(size - 1, value));
  const first = (value: number): number =>
    clamp(drawnSampleCellIndex(value - HYDRO_PATCH_RADIUS_CELLS + DRAWN_GROUND_CELL_CENTRE));
  const last = (value: number): number =>
    clamp(drawnSampleCellIndex(value + HYDRO_PATCH_RADIUS_CELLS + DRAWN_GROUND_CELL_CENTRE) + 1);
  const startX = Math.floor(first(cell.x) / CHUNK_SIZE) * CHUNK_SIZE;
  const startY = Math.floor(first(cell.y) / CHUNK_SIZE) * CHUNK_SIZE;
  const chunks: number[] = [];
  for (let y = startY; y <= last(cell.y); y += CHUNK_SIZE) {
    for (let x = startX; x <= last(cell.x); x += CHUNK_SIZE) {
      chunks.push(chunkIndexOfCell(size, x, y));
    }
  }
  return chunks;
}

function stepMask(sample: ClientPluginCtx['drawnGroundYAt'], cell: HydroPatchState, drawnY: number): Uint8Array {
  const mask = new Uint8Array(PUDDLE_MASK_CELLS);
  const half = HYDRO_PATCH_RADIUS_CELLS * PUDDLE_MASK_SAMPLES_PER_CELL;
  for (let sy = 0; sy < PUDDLE_MASK_SPAN; sy++) {
    for (let sx = 0; sx < PUDDLE_MASK_SPAN; sx++) {
      const ground = sample(
        cell.x + (sx - half) / PUDDLE_MASK_SAMPLES_PER_CELL,
        cell.y + (sy - half) / PUDDLE_MASK_SAMPLES_PER_CELL,
      );
      const same = ground !== null && Math.abs(ground - drawnY) <= SAME_STEP_TOLERANCE_WORLD;
      mask[sy * PUDDLE_MASK_SPAN + sx] = same ? 1 : 0;
    }
  }
  return mask;
}

let puddles: Puddles | null = null;
let marker: PourMarker | null = null;

let bucketHeld = false;

let toolInput: ReturnType<ClientPluginCtx['bindToolInput']> | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;
let unsubscribeTerrain: (() => void) | null = null;
let unpublishShade: (() => void) | null = null;

const patches = new Map<number, LocalPatch>();

let pendingGround = 0;

let elapsedSeconds = 0;

const instances: PuddleInstance[] = [];
const shade: GroundShadeDisc[] = [];

const POUR_TOOL_ID = 'pour';
const POUR_TOOL_LABEL = 'Hydro';
const POUR_TOOL_TITLE = 'Hydro: douse unlocked ground';

const HYDRO_SHADE_DARKNESS = 0.18;

const PUDDLE_DRAW_OBJECTS = 1;
const POUR_MARKER_DRAW_OBJECTS = 1;

function adoptGround(
  ctx: ClientPluginCtx, patch: LocalPatch,
  sample: ClientPluginCtx['drawnGroundYAt'] = (x, y) => ctx.drawnGroundYAt(x, y),
): void {
  if (patch.drawnY !== null) return;
  const drawnY = sample(patch.cell.x, patch.cell.y);
  if (drawnY === null) {
    pendingGround++;
    return;
  }
  patch.drawnY = drawnY;
  patch.onStep = stepMask(sample, patch.cell, drawnY);
}

function resolveGround(ctx: ClientPluginCtx): void {
  pendingGround = 0;
  // Overlapping masks share samples only within this synchronous ground update.
  const rows = new Map<number, Map<number, number | null>>();
  const sample = (x: number, y: number): number | null => {
    let row = rows.get(y);
    if (row === undefined) rows.set(y, row = new Map());
    const cached = row.get(x);
    if (cached !== undefined) return cached;
    const ground = ctx.drawnGroundYAt(x, y);
    row.set(x, ground);
    return ground;
  };
  for (const patch of patches.values()) adoptGround(ctx, patch, sample);
}

function addPatch(ctx: ClientPluginCtx, cell: HydroPatchState): void {
  const patch: LocalPatch = {
    cell, supportChunks: puddleSupportChunks(ctx.worldSize(), cell),
    drawnY: null, onStep: null, ageSeconds: cell.ageSeconds,
  };
  patches.set(hydroKey(cell.x, cell.y), patch);
  adoptGround(ctx, patch);
}

function replaceAll(ctx: ClientPluginCtx, cells: readonly HydroPatchState[]): void {
  patches.clear();
  pendingGround = 0;
  for (const cell of cells) addPatch(ctx, cell);
}

function buildLists(): void {
  instances.length = 0;
  shade.length = 0;

  for (const patch of patches.values()) {
    if (patch.drawnY === null || patch.onStep === null) continue;
    const wetness = hydroWetness(patch.ageSeconds);
    if (wetness <= 0) continue;

    const x = patch.cell.x * CELL_WORLD_SIZE;
    const z = patch.cell.y * CELL_WORLD_SIZE;
    instances.push({ x, z, drawnY: patch.drawnY, wetness, onStep: patch.onStep });
    shade.push({
      x,
      z,
      y: patch.drawnY,
      radius: HYDRO_PATCH_RADIUS_WORLD_UNITS,
      darkness: HYDRO_SHADE_DARKNESS * wetness,
      inner: HYDRO_PATCH_CORE_FRACTION,
    });
  }
}

export const clientPlugin: TerraceClientPlugin = {
  name: HYDRO_PLUGIN_NAME,

  drawBudget: PUDDLE_DRAW_OBJECTS + POUR_MARKER_DRAW_OBJECTS,

  groundShadeBudget: HYDRO_PATCH_CAP,

  attach(ctx: ClientPluginCtx): void {
    patches.clear();
    pendingGround = 0;
    elapsedSeconds = 0;

    puddles = createPuddles();
    ctx.layer.add(puddles.root);

    marker = createPourMarker();
    ctx.layer.add(marker.mesh);

    unpublishShade = ctx.publishGroundShade(() => shade);

    ctx.registerTool({
      id: POUR_TOOL_ID,
      label: POUR_TOOL_LABEL,
      title: POUR_TOOL_TITLE,
      icon: WaterIcon,
      onSelected: (selected) => {
        bucketHeld = selected;
        if (!selected) marker?.hide();
      },
    });

    toolInput = ctx.bindToolInput({
      active: () => bucketHeld,
      pick: 'terrain',
      onPress: (cell) => {
        if (cell !== null) ctx.send(HYDRO_POUR_MESSAGE, { x: cell.x, y: cell.y });
      },
    });

    unsubscribeMessages = [
      ctx.onMessage(HYDRO_PATCHES_MESSAGE, (payload) => {
        const cells = parsePatchesPayload(payload);
        if (cells === null) return;
        replaceAll(ctx, cells);
      }),

      ctx.onMessage(HYDRO_CHANGES_MESSAGE, (payload) => {
        const changes = parseChangesPayload(payload);
        if (changes === null) return;
        for (const cell of changes.dried) patches.delete(hydroKey(cell.x, cell.y));
        for (const cell of changes.poured) addPatch(ctx, cell);
      }),
    ];

    unsubscribeTerrain = ctx.onTerrainChanged((dirty) => {
      for (const patch of patches.values()) {
        if (!patch.supportChunks.some((chunk) => dirty.has(chunk))) continue;
        patch.drawnY = null;
        patch.onStep = null;
      }
      resolveGround(ctx);
    });

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (puddles === null) return;

      elapsedSeconds += dt;

      const pourCell = toolInput?.aim() ?? null;
      if (bucketHeld && pourCell !== null && marker !== null) {
        const groundY = ctx.drawnGroundYAt(pourCell.x, pourCell.y);
        if (groundY === null) marker.hide();
        else {
          marker.showAt(pourCell.x * CELL_WORLD_SIZE, groundY, pourCell.y * CELL_WORLD_SIZE);
          marker.update(elapsedSeconds);
        }
      } else {
        marker?.hide();
      }

      if (patches.size === 0) {
        if (instances.length > 0 || shade.length > 0) {
          instances.length = 0;
          shade.length = 0;
          puddles.apply(instances);
        }
        return;
      }

      for (const patch of patches.values()) patch.ageSeconds += dt;
      for (const [key, patch] of patches) {
        if (isDried(patch.ageSeconds)) patches.delete(key);
      }

      buildLists();
      puddles.apply(instances);
      puddles.update(elapsedSeconds);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeTerrain?.();
    unsubscribeTerrain = null;
    unsubscribeFrames?.();
    unsubscribeFrames = null;
    toolInput?.dispose();
    toolInput = null;
    unpublishShade?.();
    unpublishShade = null;
    bucketHeld = false;

    patches.clear();
    instances.length = 0;
    shade.length = 0;
    pendingGround = 0;

    puddles?.dispose();
    puddles = null;
    marker?.hide();
    marker?.dispose();
    marker = null;
  },
};

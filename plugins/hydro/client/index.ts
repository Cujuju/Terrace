import type {
  ClientPluginCtx,
  GroundShadeDisc,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  HYDRO_CHANGES_MESSAGE,
  HYDRO_PATCHES_MESSAGE,
  HYDRO_PATCH_CAP,
  HYDRO_PATCH_CORE_FRACTION,
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
import { createPuddles, type PuddleInstance, type Puddles } from './puddles.ts';

const HYDRO_GROUND_RETRY_SECONDS = 0.5;

interface LocalPatch {
  readonly cell: HydroPatchState;
  drawnY: number | null;
  ageSeconds: number;
}

let puddles: Puddles | null = null;
let marker: PourMarker | null = null;

let bucketHeld = false;

let pourCell: { x: number; y: number } | null = null;

let pointerX = 0;
let pointerY = 0;
let pointerMoved = false;

let pickedAtX = 0;
let pickedAtY = 0;

const POUR_REPICK_TRAVEL_PX = 4;

let onPointerMove: ((event: PointerEvent) => void) | null = null;
let unsubscribePress: (() => void) | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;
let unpublishShade: (() => void) | null = null;

const patches = new Map<number, LocalPatch>();

let pendingGround = 0;
let sinceRetrySeconds = 0;

let elapsedSeconds = 0;

const instances: PuddleInstance[] = [];
const shade: GroundShadeDisc[] = [];

const POUR_TOOL_ID = 'pour';
const POUR_TOOL_LABEL = 'Hydro';
const POUR_TOOL_TITLE = 'Hydro: douse unlocked ground';

const POUR_BUTTON = 0;

const HYDRO_SHADE_DARKNESS = 0.18;

const PUDDLE_DRAW_OBJECTS = 1;
const POUR_MARKER_DRAW_OBJECTS = 1;

function adoptGround(ctx: ClientPluginCtx, patch: LocalPatch): void {
  if (patch.drawnY !== null) return;
  const drawnY = ctx.drawnGroundYAt(patch.cell.x, patch.cell.y);
  if (drawnY === null) {
    pendingGround++;
    return;
  }
  patch.drawnY = drawnY;
}

function resolveGround(ctx: ClientPluginCtx): void {
  pendingGround = 0;
  sinceRetrySeconds = 0;
  for (const patch of patches.values()) adoptGround(ctx, patch);
}

function addPatch(ctx: ClientPluginCtx, cell: HydroPatchState): void {
  const patch: LocalPatch = { cell, drawnY: null, ageSeconds: cell.ageSeconds };
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
    if (patch.drawnY === null) continue;
    const wetness = hydroWetness(patch.ageSeconds);
    if (wetness <= 0) continue;

    const x = patch.cell.x * CELL_WORLD_SIZE;
    const z = patch.cell.y * CELL_WORLD_SIZE;
    instances.push({ x, z, drawnY: patch.drawnY, wetness });
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

function handlePress(ctx: ClientPluginCtx, event: PointerEvent): boolean {
  if (!bucketHeld) return false;
  if (event.button !== POUR_BUTTON) return false;

  const cell = ctx.pickWorldCell(event.clientX, event.clientY);
  if (cell === null) return true;

  ctx.send(HYDRO_POUR_MESSAGE, { x: cell.x, y: cell.y });
  return true;
}

export const clientPlugin: TerraceClientPlugin = {
  name: HYDRO_PLUGIN_NAME,

  drawBudget: PUDDLE_DRAW_OBJECTS + POUR_MARKER_DRAW_OBJECTS,

  groundShadeBudget: HYDRO_PATCH_CAP,

  attach(ctx: ClientPluginCtx): void {
    patches.clear();
    pendingGround = 0;
    sinceRetrySeconds = 0;
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
        if (!selected) {
          pourCell = null;
          marker?.hide();
        }
      },
    });

    onPointerMove = (event: PointerEvent): void => {
      if (!bucketHeld) return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerMoved = true;
    };
    window.addEventListener('pointermove', onPointerMove);

    unsubscribePress = ctx.onCanvasPress((event) => handlePress(ctx, event));

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

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (puddles === null) return;

      elapsedSeconds += dt;

      if (bucketHeld && pointerMoved) {
        const travelX = pointerX - pickedAtX;
        const travelY = pointerY - pickedAtY;
        const farEnough =
          travelX * travelX + travelY * travelY >=
          POUR_REPICK_TRAVEL_PX * POUR_REPICK_TRAVEL_PX;
        if (pourCell === null || farEnough) {
          pointerMoved = false;
          pickedAtX = pointerX;
          pickedAtY = pointerY;
          pourCell = ctx.pickWorldCell(pointerX, pointerY);
        }
      }

      if (bucketHeld && pourCell !== null && marker !== null) {
        const groundY = ctx.terrainHeightAt(pourCell.x, pourCell.y);
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

      if (pendingGround > 0) {
        sinceRetrySeconds += dt;
        if (sinceRetrySeconds >= HYDRO_GROUND_RETRY_SECONDS) resolveGround(ctx);
      }

      buildLists();
      puddles.apply(instances);
      puddles.update(elapsedSeconds);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;
    unsubscribePress?.();
    unsubscribePress = null;
    unpublishShade?.();
    unpublishShade = null;
    if (onPointerMove !== null) window.removeEventListener('pointermove', onPointerMove);
    onPointerMove = null;
    bucketHeld = false;
    pourCell = null;
    pointerMoved = false;
    pickedAtX = 0;
    pickedAtY = 0;

    patches.clear();
    instances.length = 0;
    shade.length = 0;
    pendingGround = 0;
    sinceRetrySeconds = 0;

    puddles?.dispose();
    puddles = null;
    marker?.hide();
    marker?.dispose();
    marker = null;
  },
};

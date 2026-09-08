import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  FIRE_CHANGES_MESSAGE,
  FIRE_ENTITIES_MESSAGE,
  FIRE_FIRES_MESSAGE,
  FIRE_IGNITE_MESSAGE,
  FIRE_PLUGIN_NAME,
  fireIntensity,
  fireKey,
  isBurnedOut,
  fireEntityKey,
  parseChangesPayload,
  parseEntitiesPayload,
  parseFiresPayload,
  type FireCellState,
  type FireEntityState,
} from '../protocol.ts';
import { TorchIcon } from './TorchIcon.tsx';
import { createFireLights, type FireLights } from './fireLights.ts';
import { createTorchMarker, type TorchMarker } from './torchMarker.ts';
import { SHIPPED_FLAMES } from './flames/index.ts';
import { createFireSmoke, type FireSmoke } from './smoke.ts';
import { createFireScar, type DrawnGroundAt, type FireScar } from './scar.ts';
import type { FireInstance, FlameRenderer } from './flames/types.ts';

export const FIRE_GROUND_RETRY_SECONDS = 0.5;

interface LocalFire {
  readonly cell: FireCellState;
  groundY: number | null;
  ageSeconds: number;
  readonly drawKey: number;
}

let flames: FlameRenderer | null = null;
let smoke: FireSmoke | null = null;
let scar: FireScar | null = null;
let scarGroundAt: DrawnGroundAt | null = null;
let lights: FireLights | null = null;
let marker: TorchMarker | null = null;

let torchHeld = false;

let torchCell: { x: number; y: number } | null = null;

let pointerX = 0;
let pointerY = 0;
let pointerMoved = false;

let pickedAtX = 0;
let pickedAtY = 0;

const TORCH_REPICK_TRAVEL_PX = 4;

let onPointerMove: ((event: PointerEvent) => void) | null = null;
let unsubscribePress: (() => void) | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

const fires = new Map<number, LocalFire>();

interface LocalEntityFire {
  readonly entity: FireEntityState;
  ageSeconds: number;
  readonly drawKey: number;
}

const entityFires = new Map<string, LocalEntityFire>();

let nextDrawKey = 1;

let pendingGround = 0;
let sinceRetrySeconds = 0;

let elapsedSeconds = 0;

const instances: FireInstance[] = [];

type MutableFireInstance = { -readonly [K in keyof FireInstance]: FireInstance[K] };
const instancePool: MutableFireInstance[] = [];

function nextInstanceSlot(): MutableFireInstance {
  let slot = instancePool[instances.length];
  if (slot === undefined) {
    slot = { key: 0, x: 0, z: 0, groundY: 0, fuelHeight: 0, intensity: 0, ageSeconds: 0, seed: 0 };
    instancePool.push(slot);
  }
  instances.push(slot);
  return slot;
}

function adoptGround(ctx: ClientPluginCtx, fire: LocalFire): void {
  if (fire.groundY !== null) return;
  const groundY = ctx.terrainHeightAt(fire.cell.x, fire.cell.y);
  if (groundY === null) {
    pendingGround++;
    return;
  }
  fire.groundY = groundY;
}

function resolveGround(ctx: ClientPluginCtx): void {
  pendingGround = 0;
  for (const fire of fires.values()) adoptGround(ctx, fire);
  sinceRetrySeconds = 0;
}

function addFire(ctx: ClientPluginCtx, cell: FireCellState, inheritedKey?: number): void {
  const fire: LocalFire = {
    cell,
    groundY: null,
    ageSeconds: cell.ageSeconds,
    drawKey: inheritedKey ?? nextDrawKey++,
  };
  adoptGround(ctx, fire);
  fires.set(fireKey(cell.x, cell.y), fire);
}

function replaceAll(ctx: ClientPluginCtx, cells: readonly FireCellState[]): void {
  const previous = new Map(fires);
  fires.clear();
  pendingGround = 0;
  for (const cell of cells) {
    addFire(ctx, cell, previous.get(fireKey(cell.x, cell.y))?.drawKey);
  }
}

function buildInstances(): void {
  instances.length = 0;
  for (const [key, fire] of fires) {
    if (isBurnedOut(fire.ageSeconds, fire.cell.burnSeconds)) {
      fires.delete(key);
      continue;
    }
    if (fire.groundY === null) continue;

    const slot = nextInstanceSlot();
    slot.key = fire.drawKey;
    slot.x = fire.cell.x * CELL_WORLD_SIZE;
    slot.z = fire.cell.y * CELL_WORLD_SIZE;
    slot.groundY = fire.groundY;
    slot.fuelHeight = fire.cell.fuelHeight;
    slot.intensity = fireIntensity(fire.ageSeconds, fire.cell.burnSeconds);
    slot.ageSeconds = fire.ageSeconds;
    slot.seed = key;
  }
}

function buildEntityInstances(ctx: ClientPluginCtx): void {
  for (const [key, fire] of entityFires) {
    if (isBurnedOut(fire.ageSeconds, fire.entity.burnSeconds)) {
      entityFires.delete(key);
      continue;
    }

    const pose = ctx.moverPose(fire.entity.sourceName, fire.entity.id);
    if (pose === null) continue;

    const slot = nextInstanceSlot();
    slot.key = fire.drawKey;
    slot.x = pose.x;
    slot.z = pose.z;
    slot.groundY = pose.bodyBottomY;
    slot.fuelHeight = pose.bodyHeight;
    slot.intensity = fireIntensity(fire.ageSeconds, fire.entity.burnSeconds);
    slot.ageSeconds = fire.ageSeconds;
    slot.seed = fire.entity.id;
  }
}

const TORCH_TOOL_ID = 'ignite';
const TORCH_TOOL_LABEL = 'Pyro';
const TORCH_TOOL_TITLE = 'Pyro: set unlocked growth alight';

const TORCH_BUTTON = 0;

function handlePress(ctx: ClientPluginCtx, event: PointerEvent): boolean {
  if (!torchHeld) return false;
  if (event.button !== TORCH_BUTTON) return false;

  const cell = ctx.pickWorldCell(event.clientX, event.clientY);
  if (cell === null) return true;

  ctx.send(FIRE_IGNITE_MESSAGE, { x: cell.x, y: cell.y });
  return true;
}

const FLAME_DRAW_OBJECTS = 2;
const SMOKE_DRAW_OBJECTS = 1;
const SCAR_DRAW_OBJECTS = 1;
const FIRE_LIGHT_DRAW_OBJECTS = 0;
const TORCH_MARKER_DRAW_OBJECTS = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: FIRE_PLUGIN_NAME,

  drawBudget: FLAME_DRAW_OBJECTS +
    SMOKE_DRAW_OBJECTS +
    SCAR_DRAW_OBJECTS +
    FIRE_LIGHT_DRAW_OBJECTS +
    TORCH_MARKER_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    fires.clear();
    entityFires.clear();
    pendingGround = 0;
    sinceRetrySeconds = 0;
    elapsedSeconds = 0;

    flames = SHIPPED_FLAMES();
    ctx.layer.add(flames.root);

    smoke = createFireSmoke();
    ctx.layer.add(smoke.root);

    scar = createFireScar();
    scarGroundAt = (worldX: number, worldZ: number): number | null =>
      ctx.drawnGroundYAt(worldX / CELL_WORLD_SIZE, worldZ / CELL_WORLD_SIZE);
    ctx.layer.add(scar.root);

    lights = createFireLights();
    ctx.layer.add(lights.root);

    marker = createTorchMarker();
    ctx.layer.add(marker.mesh);

    ctx.registerTool({
      id: TORCH_TOOL_ID,
      label: TORCH_TOOL_LABEL,
      title: TORCH_TOOL_TITLE,
      icon: TorchIcon,
      onSelected: (selected) => {
        torchHeld = selected;
        if (!selected) {
          torchCell = null;
          marker?.hide();
        }
      },
    });

    onPointerMove = (event: PointerEvent): void => {
      if (!torchHeld) return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerMoved = true;
    };
    window.addEventListener('pointermove', onPointerMove);

    unsubscribePress = ctx.onCanvasPress((event) => handlePress(ctx, event));

    unsubscribeMessages = [
      ctx.onMessage(FIRE_FIRES_MESSAGE, (payload) => {
        const cells = parseFiresPayload(payload);
        if (cells === null) return;
        replaceAll(ctx, cells);
      }),

      ctx.onMessage(FIRE_ENTITIES_MESSAGE, (payload) => {
        const entities = parseEntitiesPayload(payload);
        if (entities === null) return;
        const previous = new Map(entityFires);
        entityFires.clear();
        for (const entity of entities) {
          const key = fireEntityKey(entity.sourceName, entity.id);
          entityFires.set(key, {
            entity,
            ageSeconds: entity.ageSeconds,
            drawKey: previous.get(key)?.drawKey ?? nextDrawKey++,
          });
        }
      }),

      ctx.onMessage(FIRE_CHANGES_MESSAGE, (payload) => {
        const changes = parseChangesPayload(payload);
        if (changes === null) return;
        for (const cell of changes.extinguished) fires.delete(fireKey(cell.x, cell.y));
        for (const cell of changes.ignited) addFire(ctx, cell);
      }),
    ];

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (flames === null || smoke === null || scar === null || lights === null) return;
      if (scarGroundAt === null) return;

      elapsedSeconds += dt;

      if (torchHeld && pointerMoved) {
        const travelX = pointerX - pickedAtX;
        const travelY = pointerY - pickedAtY;
        const farEnough =
          travelX * travelX + travelY * travelY >=
          TORCH_REPICK_TRAVEL_PX * TORCH_REPICK_TRAVEL_PX;
        if (torchCell === null || farEnough) {
          pointerMoved = false;
          pickedAtX = pointerX;
          pickedAtY = pointerY;
          torchCell = ctx.pickWorldCell(pointerX, pointerY);
        }
      }

      if (torchHeld && torchCell !== null && marker !== null) {
        const groundY = ctx.terrainHeightAt(torchCell.x, torchCell.y);
        if (groundY === null) marker.hide();
        else {
          marker.showAt(torchCell.x * CELL_WORLD_SIZE, groundY, torchCell.y * CELL_WORLD_SIZE);
          marker.update(elapsedSeconds);
        }
      } else {
        marker?.hide();
      }

      if (fires.size === 0 && entityFires.size === 0) {
        lights.darken();
        if (flames.drawnCount > 0 || smoke.drawnCount > 0 || scar.drawnCount > 0) {
          instances.length = 0;
          flames.apply(instances);
          smoke.apply(instances);
          smoke.update(dt, elapsedSeconds);
          scar.apply(instances, scarGroundAt);
          scar.update(dt);
        }
        return;
      }

      for (const fire of fires.values()) fire.ageSeconds += dt;
      for (const fire of entityFires.values()) fire.ageSeconds += dt;

      if (pendingGround > 0) {
        sinceRetrySeconds += dt;
        if (sinceRetrySeconds >= FIRE_GROUND_RETRY_SECONDS) resolveGround(ctx);
      }

      buildInstances();
      buildEntityInstances(ctx);
      flames.apply(instances);
      flames.update(dt, elapsedSeconds);
      smoke.apply(instances);
      smoke.update(dt, elapsedSeconds);
      scar.apply(instances, scarGroundAt);
      scar.update(dt);
      lights.update(instances, dt);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;
    unsubscribePress?.();
    unsubscribePress = null;
    if (onPointerMove !== null) window.removeEventListener('pointermove', onPointerMove);
    onPointerMove = null;
    torchHeld = false;
    torchCell = null;
    pointerMoved = false;
    pickedAtX = 0;
    pickedAtY = 0;

    fires.clear();
    entityFires.clear();
    instances.length = 0;
    pendingGround = 0;
    sinceRetrySeconds = 0;

    flames?.dispose();
    flames = null;
    smoke?.dispose();
    smoke = null;
    scar?.dispose();
    scar = null;
    scarGroundAt = null;
    lights = null;
    marker?.dispose();
    marker = null;
  },
};

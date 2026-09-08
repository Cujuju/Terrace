import { SEA_LEVEL } from '@terrace/shared';
import type {
  PersistenceSlice,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  HYDRO_CHANGES_MESSAGE,
  HYDRO_PATCHES_MESSAGE,
  HYDRO_PATCH_CAP,
  HYDRO_PATCH_RADIUS_CELLS,
  HYDRO_PATCH_SECONDS,
  HYDRO_PLUGIN_NAME,
  HYDRO_POUR_MESSAGE,
  hydroWetness,
  packCells,
  packPatches,
  parsePourPayload,
  type HydroPatchState,
} from '../protocol.ts';
import { Puddles, type DriedCell, type StoredPatch } from './patches.ts';
import { chargeMana, clearManaBridge, loadManaBridge } from './mana-bridge.ts';
import {
  clearMudslidesBridge,
  loadMudslidesBridge,
  requestSlide,
} from './mudslides-bridge.ts';
import {
  loadWeatherBridge,
  registerWithHub,
  unregisterFromHub,
  type SkyCell,
} from './weather-bridge.ts';

const HYDRO_REPAIRS_PER_PATCH = 4;

export const HYDRO_KEEPALIVE_SECONDS = HYDRO_PATCH_SECONDS / HYDRO_REPAIRS_PER_PATCH;

const HYDRO_SEND_EMPTY = { skipEmpty: false } as const;

const HYDRO_SKIP_EMPTY = { skipEmpty: true } as const;

export const POUR_MANA_COST = 40;

export const HYDRO_SLIDE_SOAK_SECONDS = 6;

const puddles = new Puddles();

let simSeconds = 0;

let lastKeepaliveSeconds = 0;

let restoredPatches: StoredPatch[] = [];

function patchPosition(patch: { readonly x: number; readonly y: number }): {
  x: number;
  y: number;
} {
  return { x: patch.x, y: patch.y };
}

function broadcastSnapshot(world: WorldApi, onlyPlayerId: string | null = null): void {
  world.broadcastVisible(
    HYDRO_PATCHES_MESSAGE,
    puddles.patches(),
    patchPosition,
    (visible) => ({ patches: packPatches(visible) }),
    onlyPlayerId === null ? HYDRO_SEND_EMPTY : { skipEmpty: false, onlyPlayerId },
  );
  if (onlyPlayerId === null) lastKeepaliveSeconds = simSeconds;
}

type TaggedPatchChange =
  | { readonly kind: 'poured'; readonly patch: HydroPatchState }
  | { readonly kind: 'dried'; readonly cell: DriedCell };

function broadcastChanges(
  world: WorldApi,
  poured: readonly HydroPatchState[],
  dried: readonly DriedCell[],
): void {
  if (poured.length === 0 && dried.length === 0) return;

  const tagged: TaggedPatchChange[] = [
    ...poured.map((patch): TaggedPatchChange => ({ kind: 'poured', patch })),
    ...dried.map((cell): TaggedPatchChange => ({ kind: 'dried', cell })),
  ];
  world.broadcastVisible(
    HYDRO_CHANGES_MESSAGE,
    tagged,
    (change) =>
      change.kind === 'poured' ? patchPosition(change.patch) : patchPosition(change.cell),
    (visible) => ({
      poured: packPatches(
        visible
          .filter((c): c is Extract<TaggedPatchChange, { kind: 'poured' }> => c.kind === 'poured')
          .map((c) => c.patch),
      ),
      dried: packCells(
        visible
          .filter((c): c is Extract<TaggedPatchChange, { kind: 'dried' }> => c.kind === 'dried')
          .map((c) => c.cell),
      ),
    }),
    HYDRO_SKIP_EMPTY,
  );
}

function skyCells(): readonly SkyCell[] {
  return puddles.patches().map((patch) => ({
    x: patch.x,
    y: patch.y,
    radius: HYDRO_PATCH_RADIUS_CELLS,
    intensity: hydroWetness(patch.ageSeconds),
  }));
}

function onPourRequest(world: WorldApi, player: Player, payload: unknown): void {
  const request = parsePourPayload(payload);
  if (request === null) return;
  if (request.x >= world.worldSize || request.y >= world.worldSize) return;
  if (!world.isCellVisibleTo(player.id, request.x, request.y)) return;

  if (world.heightAt(request.x, request.y) <= SEA_LEVEL) return;
  if (!puddles.canTakeWater(request.x, request.y)) return;

  if (!chargeMana(world, player.id, POUR_MANA_COST)) return;

  const poured = puddles.pour(request.x, request.y);
  if (poured === null) return;

  broadcastChanges(
    world,
    [poured.patch],
    poured.evicted === null ? [] : [poured.evicted],
  );
}

function askForSlides(world: WorldApi): void {
  for (const cell of puddles.takeSoakedCells(HYDRO_SLIDE_SOAK_SECONDS)) {
    if (requestSlide(world, cell.x, cell.y)) {
      console.info(`[hydro] water at (${cell.x}, ${cell.y}) brought the hillside down`);
    }
  }
}

function tick(world: WorldApi, dt: number): void {
  simSeconds += dt;

  if (puddles.size === 0) {
    lastKeepaliveSeconds = simSeconds;
    return;
  }

  const dried = puddles.advance(dt);
  if (dried.length > 0) broadcastChanges(world, [], dried);

  askForSlides(world);

  if (simSeconds - lastKeepaliveSeconds >= HYDRO_KEEPALIVE_SECONDS) {
    broadcastSnapshot(world);
  }
}

const persistence: PersistenceSlice = {
  version: 1,
  save(): unknown {
    return { patches: puddles.entries() };
  },

  load(data: unknown): void {
    restoredPatches = [];
    if (typeof data !== 'object' || data === null) return;
    const patches = (data as { patches?: unknown }).patches;
    if (!Array.isArray(patches)) return;

    for (const entry of patches) {
      if (typeof entry !== 'object' || entry === null) continue;
      const patch = entry as Partial<StoredPatch>;
      if (
        typeof patch.x !== 'number' ||
        typeof patch.y !== 'number' ||
        typeof patch.ageSeconds !== 'number'
      ) {
        continue;
      }
      restoredPatches.push({
        x: patch.x,
        y: patch.y,
        ageSeconds: patch.ageSeconds,
        askedForSlide: patch.askedForSlide === true,
      });
    }
  },
};

export const plugin: TerracePlugin = {
  name: HYDRO_PLUGIN_NAME,

  archetype: 'terrain',

  onWorldCreate(world: WorldApi): void {
    simSeconds = 0;
    lastKeepaliveSeconds = 0;
    puddles.restore(restoredPatches);
    restoredPatches = [];

    loadWeatherBridge(world);
    loadMudslidesBridge(world);
    loadManaBridge(world);

    registerWithHub({
      name: HYDRO_PLUGIN_NAME,
      cells: skyCells,
      wetnessAt: (x, y) => puddles.wetnessAt(x, y),
    });

    broadcastSnapshot(world);
  },

  onWorldClose(): void {
    unregisterFromHub();
    clearMudslidesBridge();
    clearManaBridge();
    puddles.clear();
    simSeconds = 0;
    lastKeepaliveSeconds = 0;
  },

  onTick(world: WorldApi, dt: number): void {
    tick(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    broadcastSnapshot(world, player.id);
  },

  messages: {
    [HYDRO_POUR_MESSAGE]: onPourRequest,
  },

  persistence,
};

export function resetHydroState(): void {
  simSeconds = 0;
  lastKeepaliveSeconds = 0;
  restoredPatches = [];
  puddles.clear();
}

export function wetnessAt(x: number, y: number): number {
  return puddles.wetnessAt(x, y);
}

export { HYDRO_PATCH_CAP };

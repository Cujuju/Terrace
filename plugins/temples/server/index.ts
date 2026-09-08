import type { CellDiff } from '@terrace/shared';
import type {
  PersistenceSlice,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  TEMPLES_PLUGIN_NAME,
  TEMPLE_PLACE_MESSAGE,
  TEMPLE_REFUSED_GROUND,
  TEMPLE_REFUSED_MESSAGE,
  TEMPLE_REFUSED_NO_SETTLERS,
  TEMPLE_REFUSED_STANDING,
  TEMPLE_REMOVE_MESSAGE,
  TEMPLE_STATE_MESSAGE,
  TEMPLE_SURVEY_RADIUS_CELLS,
  packTemple,
  packTempleRefusal,
  templeDoorCell,
  templeFootprintCells,
  parseTemplePlacePayload,
  type TempleCell,
} from '../protocol.ts';
import { isTempleSite } from './suitability.ts';
import { loadPilgrimsBridge, templeCanSettle } from './pilgrims-bridge.ts';
import {
  loadStructuresBridge,
  reserveStructureGround,
} from './structures-bridge.ts';

let temple: TempleCell | null = null;

let restoredTemple: TempleCell | null = null;

function broadcastState(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    TEMPLE_STATE_MESSAGE,
    temple === null ? [] : [temple],
    (cell) => cell,
    (visible) => ({ temple: packTemple(visible[0] ?? null) }),
    onlyPlayerId === undefined ? undefined : { onlyPlayerId },
  );
}

function refuse(world: WorldApi, playerId: string, cell: TempleCell, reason: number): void {
  world.sendTo(playerId, TEMPLE_REFUSED_MESSAGE, {
    refused: packTempleRefusal({ x: cell.x, y: cell.y, reason }),
  });
}

function publishClaim(): void {
  reserveStructureGround(temple === null ? [] : templeFootprintCells(temple));
}

function placeTemple(world: WorldApi, playerId: string, payload: unknown): void {
  const cell = parseTemplePlacePayload(payload);
  if (cell === null) return;
  if (temple !== null) {
    refuse(world, playerId, cell, TEMPLE_REFUSED_STANDING);
    return;
  }
  if (!isTempleSite(world, cell.x, cell.y)) {
    refuse(world, playerId, cell, TEMPLE_REFUSED_GROUND);
    return;
  }

  const door = templeDoorCell(cell);
  if (!templeCanSettle(world, { x: cell.x, y: cell.y, doorX: door.x, doorY: door.y })) {
    refuse(world, playerId, cell, TEMPLE_REFUSED_NO_SETTLERS);
    return;
  }

  temple = cell;
  publishClaim();
  broadcastState(world);
  world.emitEvent('raised', { x: cell.x, y: cell.y });
}

function removeTemple(world: WorldApi): void {
  if (temple === null) return;
  const fallen = temple;
  temple = null;
  publishClaim();
  broadcastState(world);
  world.emitEvent('fallen', { x: fallen.x, y: fallen.y, cause: 'razed' });
}

function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (temple === null || diff.length === 0) return;

  let touched = false;
  for (const cell of diff) {
    if (
      Math.abs(cell.x - temple.x) <= TEMPLE_SURVEY_RADIUS_CELLS &&
      Math.abs(cell.y - temple.y) <= TEMPLE_SURVEY_RADIUS_CELLS
    ) {
      touched = true;
      break;
    }
  }
  if (!touched) return;
  if (isTempleSite(world, temple.x, temple.y)) return;

  const fallen = temple;
  temple = null;
  publishClaim();
  broadcastState(world);
  world.emitEvent('fallen', { x: fallen.x, y: fallen.y, cause: 'sculpt' });
}

function isPersistedTemple(value: unknown): value is TempleCell {
  if (typeof value !== 'object' || value === null) return false;
  const cell = value as { x?: unknown; y?: unknown };
  return Number.isInteger(cell.x) && Number.isInteger(cell.y);
}

const persistence: PersistenceSlice = {
  version: 1,
  save(): unknown {
    return { temple: temple === null ? null : { x: temple.x, y: temple.y } };
  },
  load(data: unknown): void {
    restoredTemple = null;
    if (typeof data !== 'object' || data === null) return;
    const saved = (data as { temple?: unknown }).temple;
    if (isPersistedTemple(saved)) restoredTemple = { x: saved.x, y: saved.y };
  },
};

export const plugin: TerracePlugin = {
  name: TEMPLES_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    loadPilgrimsBridge(world);
    loadStructuresBridge(world);

    temple =
      restoredTemple !== null &&
      isTempleSite(world, restoredTemple.x, restoredTemple.y)
        ? restoredTemple
        : null;
    restoredTemple = null;
    publishClaim();

    broadcastState(world);
  },

  onWorldClose(): void {
    temple = null;
    publishClaim();
    resetTemplesState();
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    broadcastState(world, player.id);
  },

  messages: {
    [TEMPLE_PLACE_MESSAGE]: (world, player, payload) => placeTemple(world, player.id, payload),
    [TEMPLE_REMOVE_MESSAGE]: (world) => removeTemple(world),
  },

  persistence,
};

export function standingTemple(): StandingTemple | null {
  if (temple === null) return null;
  const door = templeDoorCell(temple);
  return { x: temple.x, y: temple.y, doorX: door.x, doorY: door.y };
}

export interface StandingTemple extends TempleCell {
  readonly doorX: number;
  readonly doorY: number;
}

export function resetTemplesState(): void {
  temple = null;
  restoredTemple = null;
}

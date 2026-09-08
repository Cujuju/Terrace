import { CHUNK_SIZE, type CellDiff } from '@terrace/shared';
import type {
  PersistenceSlice,
  Player,
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  FIRE_BURNED_EVENT,
  FIRE_CELL_CAP,
  FIRE_CELLS_BURNED_OUT_EVENT,
  FIRE_CHANGES_MESSAGE,
  FIRE_ENTITY_CAP,
  FIRE_ENTITIES_MESSAGE,
  FIRE_FIRES_MESSAGE,
  FIRE_IGNITE_MESSAGE,
  FIRE_IGNITED_EVENT,
  FIRE_PLUGIN_NAME,
  parseIgnitePayload,
  fireEntityKey,
  packCells,
  packEntities,
  packFires,
  type FireCellState,
  type FireEntityState,
} from '../protocol.ts';
import { Blaze, type FuelCell } from './blaze.ts';
import { EntityBlaze } from './entityBlaze.ts';
import { clearEntityFuelRegistry, entityFuelAt, entityFuelSource } from './entityFuel.ts';
import { clearFuelRegistry, fuelAt, fuelSources } from './fuel.ts';
import { fireRandom, happensWithin } from './rng.ts';
import { resetSpreadSweep, SPREAD_INTERVAL_SECONDS, spreadOnce } from './spread.ts';
import { parseStruckCells } from './strike-event.ts';
import { chargeMana, loadManaBridge } from './mana-bridge.ts';
import { loadWeatherBridge, precipitationAt } from './weather-bridge.ts';

export const FIRE_KEEPALIVE_SECONDS = 10;

const ENTITY_REPAIRS_PER_BURN = 4;

const FIRE_SEND_EMPTY = { skipEmpty: false } as const;

const FIRE_SKIP_EMPTY = { skipEmpty: true } as const;

const blaze = new Blaze();

const entityBlaze = new EntityBlaze();

let currentWorld: WorldApi | null = null;

const IGNITE_ACTION = 'ignite';

let simSeconds = 0;

let lastKeepaliveSeconds = 0;

let lastEntityBroadcastSeconds = 0;

let episodeConsumed = 0;
let episodeOrigin: FuelCell | null = null;

const MAX_SPREAD_DEBT_SECONDS = SPREAD_INTERVAL_SECONDS * 2;

let spreadDebtSeconds = 0;

let restoredFires: Array<FireCellState & { readonly sourceName: string }> = [];

let restoredEntities: FireEntityState[] = [];

function firePosition(fire: { readonly x: number; readonly y: number }): { x: number; y: number } {
  return { x: fire.x, y: fire.y };
}

function broadcastSnapshot(world: WorldApi): void {
  world.broadcastVisible(
    FIRE_FIRES_MESSAGE,
    blaze.fires(),
    firePosition,
    (visible) => ({ fires: packFires(visible) }),
    FIRE_SEND_EMPTY,
  );
  lastKeepaliveSeconds = simSeconds;
}

type TaggedFireChange =
  | { readonly kind: 'ignited'; readonly fire: FireCellState }
  | { readonly kind: 'extinguished'; readonly cell: FuelCell };

function broadcastChanges(
  world: WorldApi,
  ignited: readonly FireCellState[],
  extinguished: readonly FuelCell[],
): void {
  if (ignited.length === 0 && extinguished.length === 0) return;

  const tagged: TaggedFireChange[] = [
    ...ignited.map((fire): TaggedFireChange => ({ kind: 'ignited', fire })),
    ...extinguished.map((cell): TaggedFireChange => ({ kind: 'extinguished', cell })),
  ];
  world.broadcastVisible(
    FIRE_CHANGES_MESSAGE,
    tagged,
    (change) => (change.kind === 'ignited' ? firePosition(change.fire) : firePosition(change.cell)),
    (visible) => ({
      ignited: packFires(
        visible.filter((c): c is Extract<TaggedFireChange, { kind: 'ignited' }> => c.kind === 'ignited').map((c) => c.fire),
      ),
      extinguished: packCells(
        visible
          .filter((c): c is Extract<TaggedFireChange, { kind: 'extinguished' }> => c.kind === 'extinguished')
          .map((c) => c.cell),
      ),
    }),
    FIRE_SKIP_EMPTY,
  );
}

function broadcastEntities(world: WorldApi, onlyPlayerId: string | null = null): void {
  const positions = new Map<string, { x: number; y: number }>();
  for (const at of entityBlaze.positions()) {
    positions.set(fireEntityKey(at.sourceName, at.id), { x: at.x, y: at.y });
  }

  const placed = entityBlaze
    .entities()
    .filter((entity) => positions.has(fireEntityKey(entity.sourceName, entity.id)));

  world.broadcastVisible(
    FIRE_ENTITIES_MESSAGE,
    placed,
    (entity) => {
      const at = positions.get(fireEntityKey(entity.sourceName, entity.id))!;
      return { x: Math.floor(at.x), y: Math.floor(at.y) };
    },
    (visible) => packEntities(visible),
    onlyPlayerId === null ? FIRE_SEND_EMPTY : { skipEmpty: false, onlyPlayerId },
  );
  if (onlyPlayerId === null) lastEntityBroadcastSeconds = simSeconds;
}

function refreshEntitiesForToken(world: WorldApi, token: string): void {
  for (const player of world.players()) {
    if (player.token === token) broadcastEntities(world, player.id);
  }
}

function entityRepairIntervalSeconds(): number {
  const shortest = entityBlaze.shortestBurnSeconds();
  if (shortest === null) return FIRE_KEEPALIVE_SECONDS;
  return Math.min(FIRE_KEEPALIVE_SECONDS, shortest / ENTITY_REPAIRS_PER_BURN);
}

function refreshUnlockedChunk(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk = blaze
    .fires()
    .filter((fire) => fire.x >= x0 && fire.x < x0 + CHUNK_SIZE && fire.y >= y0 && fire.y < y0 + CHUNK_SIZE);
  if (inChunk.length === 0) return;

  const payload = { ignited: packFires(inChunk), extinguished: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FIRE_CHANGES_MESSAGE, payload);
  }
}

let ignitionBatchDepth = 0;

function announceIgnitions(world: WorldApi): void {
  const cells = blaze.takeIgnited();
  const entities = entityBlaze.takeIgnited();
  if (cells.length === 0 && entities.length === 0) return;

  const ignited: number[] = [];
  for (const at of cells) ignited.push(at.x, at.y);
  for (const at of entities) ignited.push(at.x, at.y);
  world.emitEvent(FIRE_IGNITED_EVENT, { ignited });
}

function inIgnitionBatch<T>(world: WorldApi, body: () => T): T {
  ignitionBatchDepth++;
  try {
    return body();
  } finally {
    ignitionBatchDepth--;
    if (ignitionBatchDepth === 0) announceIgnitions(world);
  }
}

export function igniteAt(x: number, y: number): boolean {
  const world = currentWorld;
  if (world === null) return false;

  return inIgnitionBatch(world, () => {
    const fire = blaze.ignite(x, y);
    if (fire === null) return false;

    broadcastChanges(world, [fire], []);
    return true;
  });
}

export function igniteEntityAt(x: number, y: number): boolean {
  const world = currentWorld;
  if (world === null) return false;

  return inIgnitionBatch(world, () => {
    const fire = entityBlaze.igniteAtCell(x, y);
    if (fire === null) return false;

    broadcastEntities(world);
    return true;
  });
}

export function extinguishAt(cells: Iterable<{ readonly x: number; readonly y: number }>): number {
  const world = currentWorld;
  if (world === null) return 0;

  const stopped = blaze.extinguish(cells);
  if (stopped.length === 0) return 0;

  broadcastChanges(world, [], stopped);
  if (blaze.size === 0) endEpisode(world);
  return stopped.length;
}

export function burningCells(): FireCellState[] {
  return blaze.fires();
}

export { registerFuel, unregisterFuel, type CellFuel, type FuelSource } from './fuel.ts';
export {
  registerEntityFuel,
  unregisterEntityFuel,
  type EntityFuel,
  type EntityFuelSource,
} from './entityFuel.ts';

function endEpisode(world: WorldApi): void {
  const origin = episodeOrigin;
  const consumed = episodeConsumed;
  episodeOrigin = null;
  episodeConsumed = 0;
  if (origin === null || consumed === 0) return;

  world.emitEvent(FIRE_BURNED_EVENT, { consumed, x: origin.x, y: origin.y });
}

export const RAIN_SUPPRESSION_RATE_PER_SECOND = 0.25;

function suppressWithRain(dt: number): FuelCell[] {
  const drenched: FuelCell[] = [];
  for (const fire of blaze.fires()) {
    const wetness = precipitationAt(fire.x, fire.y);
    if (wetness <= 0) continue;
    if (!happensWithin(RAIN_SUPPRESSION_RATE_PER_SECOND * wetness, dt)) continue;
    drenched.push({ x: fire.x, y: fire.y });
  }
  return blaze.extinguish(drenched);
}

function suppressEntitiesWithRain(dt: number): number {
  const drenched: Array<{ sourceName: string; id: number }> = [];
  for (const at of entityBlaze.positions()) {
    const wetness = precipitationAt(Math.floor(at.x), Math.floor(at.y));
    if (wetness <= 0) continue;
    if (!happensWithin(RAIN_SUPPRESSION_RATE_PER_SECOND * wetness, dt)) continue;
    drenched.push({ sourceName: at.sourceName, id: at.id });
  }
  return entityBlaze.extinguish(drenched);
}

export const LIGHTNING_IGNITION_CHANCE = 0.35;

function igniteStruckCells(cells: readonly { readonly x: number; readonly y: number }[]): void {
  for (const cell of cells) {
    if (fireRandom() >= LIGHTNING_IGNITION_CHANCE) continue;
    igniteAt(cell.x, cell.y);
    igniteEntityAt(cell.x, cell.y);
  }
}

export const IGNITE_MANA_COST = 60;

function onIgniteRequest(world: WorldApi, player: Player, payload: unknown): void {
  const request = parseIgnitePayload(payload);
  if (request === null) return;
  if (request.x >= world.worldSize || request.y >= world.worldSize) return;
  if (!world.isCellVisibleTo(player.id, request.x, request.y)) return;

  const cellCatches =
    !blaze.isBurning(request.x, request.y) &&
    blaze.size < FIRE_CELL_CAP &&
    fuelAt(request.x, request.y) !== null;

  const standing = entityFuelAt(request.x, request.y, (sourceName, id) =>
    entityBlaze.isBurning(sourceName, id),
  );
  const entityCatches = standing !== null && entityBlaze.size < FIRE_ENTITY_CAP;

  if (!cellCatches && !entityCatches) return;
  if (!chargeMana(world, player.id, IGNITE_MANA_COST)) return;

  inIgnitionBatch(world, () => {
    if (cellCatches) igniteAt(request.x, request.y);
    if (entityCatches) igniteEntityAt(request.x, request.y);
  });
}

const persistence: PersistenceSlice = {
  version: 1,
  save(): unknown {
    return { fires: blaze.entries(), entities: entityBlaze.entities() };
  },

  load(data: unknown): void {
    restoredFires = [];
    restoredEntities = [];
    if (typeof data !== 'object' || data === null) return;
    const fires = (data as { fires?: unknown }).fires;
    if (!Array.isArray(fires)) return;

    for (const entry of fires) {
      if (typeof entry !== 'object' || entry === null) continue;
      const fire = entry as Partial<FireCellState & { sourceName: string }>;
      if (
        typeof fire.x !== 'number' ||
        typeof fire.y !== 'number' ||
        typeof fire.fuelHeight !== 'number' ||
        typeof fire.ageSeconds !== 'number' ||
        typeof fire.burnSeconds !== 'number' ||
        typeof fire.sourceName !== 'string'
      ) {
        continue;
      }
      restoredFires.push({
        x: fire.x,
        y: fire.y,
        fuelHeight: fire.fuelHeight,
        ageSeconds: fire.ageSeconds,
        burnSeconds: fire.burnSeconds,
        sourceName: fire.sourceName,
      });
    }

    const entities = (data as { entities?: unknown }).entities;
    if (!Array.isArray(entities)) return;
    for (const entry of entities) {
      if (typeof entry !== 'object' || entry === null) continue;
      const entity = entry as Partial<FireEntityState>;
      if (
        typeof entity.sourceName !== 'string' ||
        typeof entity.id !== 'number' ||
        typeof entity.ageSeconds !== 'number' ||
        typeof entity.burnSeconds !== 'number'
      ) {
        continue;
      }
      restoredEntities.push({
        sourceName: entity.sourceName,
        id: entity.id,
        ageSeconds: entity.ageSeconds,
        burnSeconds: entity.burnSeconds,
      });
    }
  },
};

export const plugin: TerracePlugin = {
  name: FIRE_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    currentWorld = world;
    simSeconds = 0;
    lastKeepaliveSeconds = 0;
    spreadDebtSeconds = 0;
    episodeConsumed = 0;
    episodeOrigin = null;
    blaze.restore(restoredFires);
    restoredFires = [];
    entityBlaze.restore(restoredEntities);
    restoredEntities = [];

    loadWeatherBridge(world);
    loadManaBridge(world);

    broadcastSnapshot(world);
    broadcastEntities(world);
  },

  onWorldClose(): void {
    clearFuelRegistry();
    clearEntityFuelRegistry();
  },

  onTick(world: WorldApi, dt: number): void {
    inIgnitionBatch(world, () => tick(world, dt));
  },

  archetype: 'terrain',
  actions: [
    {
      key: IGNITE_ACTION,
      label: 'Light a fire',
      description: 'Sets the cell you are looking at alight, if there is anything there to burn.',
    },
  ],

  onAction(_world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== IGNITE_ACTION) return { ok: false, detail: `no such action "${key}"` };
    if (igniteAt(site.x, site.y)) return { ok: true, detail: `(${site.x}, ${site.y}) is alight` };
    return {
      ok: false,
      detail:
        `nothing caught at (${site.x}, ${site.y}) — nothing flammable there (bare rock, water), ` +
        `already burning, or ${FIRE_CELL_CAP} fires are already burning`,
    };
  },

  onTerrainChanged(_world: WorldApi, diff: readonly CellDiff[]): void {
    if (blaze.size === 0 || diff.length === 0) return;
    extinguishAt(diff);
  },

  onWorldEvent(world: WorldApi, event: string, payload: unknown): void {
    if (event !== 'thunderstorm:strikes') return;
    const struck = parseStruckCells(payload, world.worldSize);
    if (struck === null) return;
    inIgnitionBatch(world, () => igniteStruckCells(struck));
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    world.broadcastVisible(
      FIRE_FIRES_MESSAGE,
      blaze.fires(),
      firePosition,
      (visible) => ({ fires: packFires(visible) }),
      { skipEmpty: false, onlyPlayerId: player.id },
    );
    broadcastEntities(world);
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
    if (entityBlaze.size > 0) refreshEntitiesForToken(world, token);
  },

  messages: {
    [FIRE_IGNITE_MESSAGE]: onIgniteRequest,
  },

  persistence,
};

export function resetFireState(): void {
  currentWorld = null;
  simSeconds = 0;
  lastKeepaliveSeconds = 0;
  spreadDebtSeconds = 0;
  episodeConsumed = 0;
  episodeOrigin = null;
  restoredFires = [];
  restoredEntities = [];
  blaze.clear();
  entityBlaze.clear();
  resetSpreadSweep();
}

function tick(world: WorldApi, dt: number): void {
  simSeconds += dt;

  if (blaze.size === 0 && entityBlaze.size === 0) {
    if (episodeConsumed > 0) endEpisode(world);
    lastKeepaliveSeconds = simSeconds;
    resetSpreadSweep();
    return;
  }

  const { burnedOut, stopped } = blaze.advance(dt);

  if (burnedOut.size > 0) {
    for (const source of fuelSources()) {
      const cells = burnedOut.get(source.name);
      if (cells === undefined || cells.length === 0) continue;
      source.onBurnedOut(cells);
      episodeConsumed += cells.length;
      episodeOrigin ??= cells[0]!;
    }
    const burnedOutCells: FuelCell[] = [];
    for (const cells of burnedOut.values()) burnedOutCells.push(...cells);
    world.emitEvent(FIRE_CELLS_BURNED_OUT_EVENT, { cells: packCells(burnedOutCells) });
  }

  const walking = entityBlaze.advance(dt);
  let entitiesChanged = walking.changed;
  if (walking.burnedOut.size > 0) {
    for (const [sourceName, ids] of walking.burnedOut) {
      const source = entityFuelSource(sourceName);
      if (source === null || ids.length === 0) continue;
      source.onBurnedOut(ids);
    }
  }
  if (suppressEntitiesWithRain(dt) > 0) entitiesChanged = true;

  spreadDebtSeconds = Math.min(spreadDebtSeconds + dt, MAX_SPREAD_DEBT_SECONDS);
  let ignited: FireCellState[] = [];
  let drenched: FuelCell[] = [];
  while (spreadDebtSeconds >= SPREAD_INTERVAL_SECONDS) {
    drenched = [...drenched, ...suppressWithRain(SPREAD_INTERVAL_SECONDS)];
    const spread = spreadOnce(world, blaze, entityBlaze, SPREAD_INTERVAL_SECONDS);
    ignited = [...ignited, ...spread.cells];
    if (spread.entities.length > 0) entitiesChanged = true;
    spreadDebtSeconds -= SPREAD_INTERVAL_SECONDS;
  }

  const ended = drenched.length > 0 ? [...stopped, ...drenched] : stopped;
  if (ignited.length > 0 || ended.length > 0) broadcastChanges(world, ignited, ended);
  if (entitiesChanged) broadcastEntities(world);

  if (blaze.size === 0) endEpisode(world);

  if (simSeconds - lastKeepaliveSeconds >= FIRE_KEEPALIVE_SECONDS) {
    broadcastSnapshot(world);
  }

  if (
    entityBlaze.size > 0 &&
    simSeconds - lastEntityBroadcastSeconds >= entityRepairIntervalSeconds()
  ) {
    broadcastEntities(world);
  }
}
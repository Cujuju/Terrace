import { CHUNK_SIZE, dayOfSimMillis, type CellDiff } from '@terrace/shared';
import type {
  PersistenceSlice,
  SliceLoadOutcome,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  STRUCTURES_ALL_MESSAGE,
  STRUCTURES_CHANGES_MESSAGE,
  STRUCTURES_CAP,
  MAX_STRUCTURE_TIER,
  STRUCTURES_PLUGIN_NAME,
  cellOfKey,
  packCells,
  packStructureCells,
  structureKey,
  type StructureCell,
} from '../protocol.ts';
import {
  CA_GENERATION_INTERVAL_SECONDS,
  shouldSeed,
  CA_STIR_PROBABILITY_PER_GENERATION,
  GenerationSurvey,
  attemptSeed,
  attemptStir,
  generationChunksPerTick,
  type LiveCellRecord,
} from './life.ts';
import {
  STRUCTURES_MODELS,
  STRUCTURES_MODEL_LIFE,
  STRUCTURES_MODEL_POPULOUS,
  STRUCTURES_MODEL_SETTING_KEY,
  growthModel,
  isStructuresModel,
  readStructuresModel,
  type BoardCellRecord,
  type GrowthContext,
  type StructuresModel,
} from './growth-model.ts';
import { resetBlessings } from './blessings.ts';
import { resetReservations } from './reservations.ts';
import { STRUCTURES_SLICE_VERSION, loadStructures, saveStructures } from './persistence.ts';
import { STRUCTURES_RNG_DEFAULT_SEED, createStructuresRng, type StructuresRng } from './rng.ts';
import { isBuildableCell, type StructuresWorld } from './suitability.ts';
import { hasBuildingWithinSeparation } from './clearance.ts';
import { closeFireBridge, loadFireBridge, registerStructuresFuel } from './fire-bridge.ts';
import {
  parseStormDamage,
  severityAt,
} from '../../../server/src/plugins/kit/rotatingStormDamage.ts';
import {
  CYCLONE_DAMAGE_EVENT_NAME,
  STRUCTURES_WIND_MIN_SEVERITY,
  windDemolishChance,
} from './cyclone-event.ts';

export const STRUCTURES_KEEPALIVE_SECONDS = 60;

export const NO_GROWTH_MODEL_WARNING =
  '[structures] configured for a non-default growth model, but none was registered — the board will not change';

let live: Map<number, BoardCellRecord> = new Map();

let generation = 0;
let lastSeedDay = -1;
let restoredLastSeedDay = -1;

let defaultModel: StructuresModel = readStructuresModel(process.env);

let selectedModel: StructuresModel = defaultModel;

let lastGrowthSeconds = 0;

let warnedNoGrowthModel = false;

let survey = new GenerationSurvey();
let rng: StructuresRng = createStructuresRng(STRUCTURES_RNG_DEFAULT_SEED);

let simSeconds = 0;
let lastKeepaliveSeconds = 0;

let scanCredit = 0;

let pendingFounded: StructureCell[] = [];

let restoredLive: Map<number, BoardCellRecord> = new Map();
let restoredGeneration = 0;

function liveCells(): StructureCell[] {
  const cells: StructureCell[] = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    cells.push({ x: cell.x, y: cell.y, tier: record.tier });
  }
  return cells;
}

function structurePosition(cell: { readonly x: number; readonly y: number }): {
  x: number;
  y: number;
} {
  return { x: cell.x, y: cell.y };
}

const STRUCTURES_SKIP_EMPTY = { skipEmpty: true } as const;

function broadcastAll(world: WorldApi): void {
  world.broadcastVisible(
    STRUCTURES_ALL_MESSAGE,
    liveCells(),
    structurePosition,
    (visible) => ({ structures: packStructureCells(visible) }),
    STRUCTURES_SKIP_EMPTY,
  );
  lastKeepaliveSeconds = simSeconds;
}

interface TaggedStructureChange {
  readonly kind: 'founded' | 'upgraded' | 'demolished';
  readonly x: number;
  readonly y: number;
  readonly tier: number;
}

function broadcastChanges(
  world: WorldApi,
  founded: readonly StructureCell[],
  upgraded: readonly StructureCell[],
  demolished: ReadonlyArray<{ x: number; y: number }>,
): void {
  if (founded.length === 0 && upgraded.length === 0 && demolished.length === 0) return;

  const tagged: TaggedStructureChange[] = [
    ...founded.map((c): TaggedStructureChange => ({ kind: 'founded', x: c.x, y: c.y, tier: c.tier })),
    ...upgraded.map((c): TaggedStructureChange => ({ kind: 'upgraded', x: c.x, y: c.y, tier: c.tier })),
    ...demolished.map((c): TaggedStructureChange => ({ kind: 'demolished', x: c.x, y: c.y, tier: 0 })),
  ];
  world.broadcastVisible(
    STRUCTURES_CHANGES_MESSAGE,
    tagged,
    structurePosition,
    (visible) => ({
      founded: packStructureCells(visible.filter((c) => c.kind === 'founded')),
      upgraded: packStructureCells(visible.filter((c) => c.kind === 'upgraded')),
      demolished: packCells(visible.filter((c) => c.kind === 'demolished')),
    }),
    STRUCTURES_SKIP_EMPTY,
  );
}

function refreshUnlockedChunk(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: StructureCell[] = [];
  for (const cell of liveCells()) {
    if (cell.x >= x0 && cell.x < x0 + CHUNK_SIZE && cell.y >= y0 && cell.y < y0 + CHUNK_SIZE) {
      inChunk.push(cell);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { founded: packStructureCells(inChunk), upgraded: [], demolished: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, STRUCTURES_CHANGES_MESSAGE, payload);
  }
}

function advanceLife(world: WorldApi, dt: number): void {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  scanCredit = Math.min(scanCredit + generationChunksPerTick(world, dt), totalChunks);
  const budget = Math.floor(scanCredit);
  if (budget > 0) {
    scanCredit -= budget;
    const outcome = survey.advance(world, live, budget);
    if (outcome !== null) {
      live = outcome.nextLive;
      generation++;

      let seeded: StructureCell[] = [];
      const today = dayOfSimMillis(world.simMillis);
      if (shouldSeed(live, today, lastSeedDay)) {
        lastSeedDay = today;
        const placement = attemptSeed(world, live, rng);
        if (placement !== null) {
          for (const cell of placement) live.set(structureKey(cell.x, cell.y), { age: 0, tier: 0 });
          seeded = placement;
        }
      }

      let stirred: StructureCell[] = [];
      if (rng.next() < CA_STIR_PROBABILITY_PER_GENERATION) {
        const sparks = attemptStir(world, live, rng);
        if (sparks !== null) {
          for (const cell of sparks) live.set(structureKey(cell.x, cell.y), { age: 0, tier: 0 });
          stirred = sparks;
        }
      }

      broadcastChanges(world, [...outcome.born, ...seeded, ...stirred], outcome.upgraded, outcome.died);

      if (seeded.length > 0 || outcome.upgraded.length > 0 || outcome.died.length > 0) {
        world.emitEvent('changes', {
          cause: 'generation',
          seeded,
          upgraded: outcome.upgraded,
          died: outcome.died,
        });
      }
    }
  }

}

function advanceGrowthModel(world: WorldApi): void {
  if (simSeconds - lastGrowthSeconds < CA_GENERATION_INTERVAL_SECONDS) return;
  lastGrowthSeconds = simSeconds;

  const model = growthModel();
  if (model === null) {
    if (!warnedNoGrowthModel) {
      warnedNoGrowthModel = true;
      console.warn(NO_GROWTH_MODEL_WARNING);
    }
    return;
  }

  const ctx: GrowthContext = {
    isBuildable: (x: number, y: number) => isBuildableCell(world, x, y),
    maxTier: MAX_STRUCTURE_TIER,
    hasBuildingWithinSeparation: (cells, x: number, y: number) =>
      hasBuildingWithinSeparation(cells, world, x, y),
  };
  const outcome = model.step(world, live, ctx);

  live = outcome.nextLive;
  generation++;
  broadcastChanges(world, outcome.born, outcome.upgraded, outcome.died);
  if (outcome.born.length > 0 || outcome.upgraded.length > 0 || outcome.died.length > 0) {
    world.emitEvent('changes', {
      cause: 'generation',
      seeded: outcome.born,
      upgraded: outcome.upgraded,
      died: outcome.died,
    });
  }

  model.afterSwap?.(outcome.emitted);
}

function simulate(world: WorldApi, dt: number): void {
  simSeconds += dt;

  if (pendingFounded.length > 0) {
    const founded = pendingFounded;
    pendingFounded = [];
    broadcastChanges(world, founded, [], []);
    world.emitEvent('changes', { cause: 'settled', seeded: founded, upgraded: [], died: [] });
  }

  if (selectedModel === STRUCTURES_MODEL_LIFE) advanceLife(world, dt);
  else advanceGrowthModel(world);

  if (simSeconds - lastKeepaliveSeconds >= STRUCTURES_KEEPALIVE_SECONDS) broadcastAll(world);
}

export const STRUCTURES_BURN_SECONDS = 30;

export const STRUCTURES_FUEL_HEIGHT = 1.0;

function structuresFuelAt(x: number, y: number): { burnSeconds: number; height: number } | null {
  if (!live.has(structureKey(x, y))) return null;
  return { burnSeconds: STRUCTURES_BURN_SECONDS, height: STRUCTURES_FUEL_HEIGHT };
}

function structuresBurnedOut(cells: readonly { readonly x: number; readonly y: number }[]): void {
  const world = fuelWorld;
  if (world === null) return;

  const burned: Array<{ x: number; y: number }> = [];
  for (const cell of cells) {
    const key = structureKey(cell.x, cell.y);
    if (!live.delete(key)) continue;
    survey.evict(key);
    burned.push({ x: cell.x, y: cell.y });
  }
  if (burned.length === 0) return;

  broadcastChanges(world, [], [], burned);
  world.emitEvent('changes', { cause: 'fire', died: burned });
}

function reactToCycloneDamage(world: WorldApi, payload: unknown): void {
  const damage = parseStormDamage(payload);
  if (damage === null) return;

  const demolished: Array<{ x: number; y: number }> = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    const severity = severityAt(damage, cell.x, cell.y);
    if (severity < STRUCTURES_WIND_MIN_SEVERITY) continue;
    if (rng.next() >= windDemolishChance(severity, damage.durationSeconds, record.tier)) continue;
    demolished.push(cell);
  }
  if (demolished.length === 0) return;

  for (const cell of demolished) {
    const key = structureKey(cell.x, cell.y);
    live.delete(key);
    survey.evict(key);
  }

  broadcastChanges(world, [], [], demolished);
  world.emitEvent('changes', { cause: 'wind', died: demolished });
}

let fuelWorld: WorldApi | null = null;

function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (diff.length === 0) return;

  const demolished: Array<{ x: number; y: number }> = [];
  for (const cell of diff) {
    const key = structureKey(cell.x, cell.y);
    if (!live.delete(key)) continue;
    survey.evict(key);
    demolished.push({ x: cell.x, y: cell.y });
  }
  broadcastChanges(world, [], [], demolished);

  if (demolished.length > 0) world.emitEvent('changes', { cause: 'sculpt', died: demolished });
}

function selfDescribedSliceVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const version = (data as { version?: unknown }).version;
  return Number.isSafeInteger(version) ? (version as number) : undefined;
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return saveStructures(live, generation, rng, lastSeedDay);
  },
  version: STRUCTURES_SLICE_VERSION,
  load(data: unknown, fromVersion: number): SliceLoadOutcome {
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > STRUCTURES_SLICE_VERSION) {
      return 'refuse';
    }
    const restored = loadStructures(data);
    restoredLive = restored.live;
    restoredGeneration = restored.generation;
    restoredLastSeedDay = restored.lastSeedDay;
    rng = createStructuresRng(restored.rngState);
    return undefined;
  },
};

function sessionModel(world: WorldApi): StructuresModel {
  const chosen = world.setting(STRUCTURES_MODEL_SETTING_KEY);
  if (chosen === undefined) return defaultModel;
  if (isStructuresModel(chosen)) return chosen;
  console.warn(unknownModelWarning(chosen));
  return defaultModel;
}

export function structuresModelMessage(model: StructuresModel): string {
  return `[structures] growth model for this world: ${model}`;
}

export function unknownModelWarning(stored: string): string {
  return (
    `[structures] this world is set to growth model "${stored}", which this build ` +
    `does not have — running "${defaultModel}" instead`
  );
}

function resetSessionState(): void {
  survey = new GenerationSurvey();
  scanCredit = 0;
  simSeconds = 0;
  lastGrowthSeconds = 0;
  lastKeepaliveSeconds = 0;
  warnedNoGrowthModel = false;
  pendingFounded = [];
}

export const plugin: TerracePlugin = {
  name: STRUCTURES_PLUGIN_NAME,

  settings: [
    {
      key: STRUCTURES_MODEL_SETTING_KEY,
      values: STRUCTURES_MODELS,
      defaultValue: defaultModel,
    },
  ],

  onWorldCreate(world: WorldApi): void {
    resetSessionState();
    selectedModel = sessionModel(world);
    console.info(structuresModelMessage(selectedModel));

    live = new Map();
    for (const [key, record] of restoredLive) {
      const cell = cellOfKey(key);
      if (isBuildableCell(world, cell.x, cell.y)) live.set(key, record);
    }
    generation = restoredGeneration;
    lastSeedDay = restoredLastSeedDay;
    restoredLive = new Map();
    restoredGeneration = 0;
    restoredLastSeedDay = -1;

    fuelWorld = world;
    loadFireBridge(world);
    registerStructuresFuel({
      name: STRUCTURES_PLUGIN_NAME,
      fuelAt: structuresFuelAt,
      onBurnedOut: structuresBurnedOut,
    });

    broadcastAll(world);
  },

  onWorldClose(): void {
    closeFireBridge();
    resetStructuresState();
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onWorldEvent(world: WorldApi, event: string, payload: unknown): void {
    if (event === CYCLONE_DAMAGE_EVENT_NAME) reactToCycloneDamage(world, payload);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    world.broadcastVisible(
      STRUCTURES_ALL_MESSAGE,
      liveCells(),
      structurePosition,
      (visible) => ({ structures: packStructureCells(visible) }),
      { ...STRUCTURES_SKIP_EMPTY, onlyPlayerId: player.id },
    );
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
  },

  persistence,
};

export { setBlessedStructureCells } from './blessings.ts';

export { setReservedStructureCells } from './reservations.ts';

export function foundStructure(world: StructuresWorld, x: number, y: number): boolean {
  if (!canFoundStructure(world, x, y)) return false;

  live.set(structureKey(x, y), { age: 0, tier: 0 });
  pendingFounded.push({ x, y, tier: 0 });
  return true;
}

export function canFoundStructure(world: StructuresWorld, x: number, y: number): boolean {
  if (live.size >= STRUCTURES_CAP) return false;
  if (live.has(structureKey(x, y))) return false;
  if (hasBuildingWithinSeparation(live, world, x, y)) return false;
  return isBuildableCell(world, x, y);
}

export interface StandingStructure extends StructureCell {
  readonly age: number;
}

export function standingStructures(): StandingStructure[] {
  const cells: StandingStructure[] = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    cells.push({ x: cell.x, y: cell.y, tier: record.tier, age: record.age });
  }
  return cells;
}

export function currentLive(): ReadonlyMap<number, BoardCellRecord> {
  return live;
}

export { setGrowthModel } from './growth-model.ts';

export function structuresModel(): StructuresModel {
  return selectedModel;
}

export function setStructuresModel(model: StructuresModel): void {
  defaultModel = model;
  selectedModel = model;
}

export function currentGeneration(): number {
  return generation;
}

export function resetStructuresState(): void {
  resetSessionState();
  live = new Map();
  generation = 0;
  lastSeedDay = -1;
  resetBlessings();
  resetReservations();
  rng = createStructuresRng(STRUCTURES_RNG_DEFAULT_SEED);
  restoredLive = new Map();
  restoredGeneration = 0;
  restoredLastSeedDay = -1;
  fuelWorld = null;
}

import { CHUNK_SIZE, dayOfSimMillis, drawnBandOfSample, isWater, type CellDiff } from '@terrace/shared';
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
  MAX_FOOTPRINT_RADIUS_CELLS,
  STRUCTURES_PLUGIN_NAME,
  cellOfKey,
  packCells,
  packStructureCells,
  footprintRadiusOfKind,
  structureKey,
  type StructureCell,
} from '../protocol.ts';
import {
  buildingIdOf,
  tierOfKind,
} from '../settlementRules.ts';
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
  type StructuresModel,
} from './growth-model.ts';
import { createGrowthContext, resolveGrowthStage } from './growth-context.ts';
import { resetBlessings } from './blessings.ts';
import { resetReservations } from './reservations.ts';
import { STRUCTURES_SLICE_VERSION, UNRESOLVED_KIND, loadStructures, saveStructures } from './persistence.ts';
import { STRUCTURES_RNG_DEFAULT_SEED, createStructuresRng, type StructuresRng } from './rng.ts';
import { foundingKindAt, isBuildableCell, type StructuresWorld } from './suitability.ts';
import { hasBuildingWithinSeparation } from './clearance.ts';
import { closeFireBridge, loadFireBridge, registerStructuresFuel } from './fire-bridge.ts';
import {
  parseStormDamage,
  severityAt,
  STORM_WIND_FALLOFF_EYEWALL,
  STORM_WIND_FALLOFF_QUADRATIC,
} from '../../../server/src/plugins/kit/rotatingStormDamage.ts';
import {
  CYCLONE_DAMAGE_EVENT_NAME,
  TORNADO_DAMAGE_EVENT_NAME,
  STRUCTURES_WIND_MIN_SEVERITY,
  windDemolishChance,
} from './cyclone-event.ts';

export const STRUCTURES_KEEPALIVE_SECONDS = 60;

export const NO_GROWTH_MODEL_WARNING =
  '[structures] configured for a non-default growth model, but none was registered — the board will not change';

let live: Map<number, BoardCellRecord> = new Map();

/** Resting band of each standing structure. Demolition fires only when that
 * band changes; a tunnel below leaves it standing. */
let supportBands = new Map<number, number>();

function noteSupportBand(world: StructuresWorld, x: number, y: number): void {
  supportBands.set(structureKey(x, y), drawnBandOfSample(world.heightAt(x, y)));
}

function syncSupportBands(world: StructuresWorld): void {
  for (const key of supportBands.keys()) {
    if (!live.has(key)) supportBands.delete(key);
  }
  for (const key of live.keys()) {
    if (!supportBands.has(key)) {
      const cell = cellOfKey(key);
      noteSupportBand(world, cell.x, cell.y);
    }
  }
}

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

const pendingFounded = new Map<number, BoardCellRecord>();

let restoredLive: Map<number, BoardCellRecord> = new Map();
let restoredGeneration = 0;

function liveCells(): StructureCell[] {
  const cells: StructureCell[] = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    cells.push({ x: cell.x, y: cell.y, tier: record.tier, kind: record.kind });
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

interface TaggedStructureChange extends StructureCell {
  readonly change: 'founded' | 'upgraded' | 'demolished';
}

function broadcastChanges(
  world: WorldApi,
  founded: readonly StructureCell[],
  upgraded: readonly StructureCell[],
  demolished: ReadonlyArray<{ x: number; y: number }>,
): void {
  if (founded.length === 0 && upgraded.length === 0 && demolished.length === 0) return;

  const tagged: TaggedStructureChange[] = [
    ...founded.map((c): TaggedStructureChange => ({ ...c, change: 'founded' })),
    ...upgraded.map((c): TaggedStructureChange => ({ ...c, change: 'upgraded' })),
    ...demolished.map((c): TaggedStructureChange => ({ x: c.x, y: c.y, tier: 0, kind: 0, change: 'demolished' })),
  ];
  world.broadcastVisible(
    STRUCTURES_CHANGES_MESSAGE,
    tagged,
    structurePosition,
    (visible) => ({
      founded: packStructureCells(visible.filter((c) => c.change === 'founded')),
      upgraded: packStructureCells(visible.filter((c) => c.change === 'upgraded')),
      demolished: packCells(visible.filter((c) => c.change === 'demolished')),
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
        const placement = attemptSeed(world, live, rng, survey.buildableChunks());
        if (placement !== null) {
          for (const cell of placement) live.set(structureKey(cell.x, cell.y), { age: 0, tier: cell.tier, kind: cell.kind });
          seeded = placement;
        }
      }

      let stirred: StructureCell[] = [];
      if (rng.next() < CA_STIR_PROBABILITY_PER_GENERATION) {
        const sparks = attemptStir(world, live, rng);
        if (sparks !== null) {
          for (const cell of sparks) live.set(structureKey(cell.x, cell.y), { age: 0, tier: cell.tier, kind: cell.kind });
          stirred = sparks;
        }
      }

      broadcastChanges(world, [...outcome.born, ...seeded, ...stirred], outcome.upgraded, outcome.died);
      syncSupportBands(world);

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

  const ctx = createGrowthContext(world);
  const outcome = model.step(world, live, ctx);

  const nextLive = new Map<number, BoardCellRecord>();
  for (const [key, record] of outcome.nextLive) {
    if (nextLive.size >= STRUCTURES_CAP) break;
    const cell = cellOfKey(key);
    const stage = ctx.resolveStage(cell.x, cell.y, record.tier, record);
    if (ctx.isBuildable(cell.x, cell.y, stage.kind)) {
      nextLive.set(key, { ...record, ...stage });
    } else {
      const previous = live.get(key);
      if (previous !== undefined && ctx.isBuildable(cell.x, cell.y, previous.kind)) {
        nextLive.set(key, previous);
      }
    }
  }
  const born: StructureCell[] = [];
  const upgraded: StructureCell[] = [];
  const died: Array<{ x: number; y: number }> = [];
  for (const [key, record] of nextLive) {
    const cell = { ...cellOfKey(key), tier: record.tier, kind: record.kind };
    const previous = live.get(key);
    if (previous === undefined) born.push(cell);
    else if (previous.kind !== record.kind || previous.tier !== record.tier) upgraded.push(cell);
  }
  for (const key of live.keys()) if (!nextLive.has(key)) died.push(cellOfKey(key));

  live = nextLive;
  generation++;
  syncSupportBands(world);
  broadcastChanges(world, born, upgraded, died);
  if (born.length > 0 || upgraded.length > 0 || died.length > 0) {
    world.emitEvent('changes', {
      cause: 'generation',
      seeded: born,
      upgraded,
      died,
    });
  }

  model.afterSwap?.(outcome.emitted.filter((cell) => nextLive.has(structureKey(cell.x, cell.y))));
}

function simulate(world: WorldApi, dt: number): void {
  simSeconds += dt;

  if (pendingFounded.size > 0) {
    const founded: StructureCell[] = [];
    for (const [key, record] of pendingFounded) {
      if (live.get(key) === record) founded.push({ ...cellOfKey(key), tier: record.tier, kind: record.kind });
    }
    pendingFounded.clear();
    if (founded.length > 0) {
      broadcastChanges(world, founded, [], []);
      world.emitEvent('changes', { cause: 'settled', seeded: founded, upgraded: [], died: [] });
    }
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
    supportBands.delete(key);
    burned.push({ x: cell.x, y: cell.y });
  }
  if (burned.length === 0) return;

  broadcastChanges(world, [], [], burned);
  world.emitEvent('changes', { cause: 'fire', died: burned });
}

function reactToWindDamage(world: WorldApi, event: string, payload: unknown): void {
  const damage = parseStormDamage(payload, event === TORNADO_DAMAGE_EVENT_NAME
    ? STORM_WIND_FALLOFF_QUADRATIC : STORM_WIND_FALLOFF_EYEWALL);
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
    supportBands.delete(key);
  }

  broadcastChanges(world, [], [], demolished);
  world.emitEvent('changes', { cause: 'wind', died: demolished });
}

let fuelWorld: WorldApi | null = null;

function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (diff.length === 0) return;

  // A building falls when an edit knocks any cell under it off its resting band or floods it.
  const broken = new Set<number>();
  for (const cell of diff) {
    survey.forgetStagedBirthsAt(cell.x, cell.y);
    const height = world.heightAt(cell.x, cell.y);
    const flooded = isWater(height);
    const band = drawnBandOfSample(height);
    for (let dy = -MAX_FOOTPRINT_RADIUS_CELLS; dy <= MAX_FOOTPRINT_RADIUS_CELLS; dy++) {
      for (let dx = -MAX_FOOTPRINT_RADIUS_CELLS; dx <= MAX_FOOTPRINT_RADIUS_CELLS; dx++) {
        const bx = cell.x + dx;
        const by = cell.y + dy;
        if (bx < 0 || by < 0 || bx >= world.worldSize || by >= world.worldSize) continue;
        const key = structureKey(bx, by);
        const record = live.get(key);
        if (record === undefined || broken.has(key)) continue;
        const radius = footprintRadiusOfKind(record.kind);
        if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;
        const resting = supportBands.get(key);
        if (!flooded && resting !== undefined && band === resting) continue;
        broken.add(key);
      }
    }
  }

  const demolished: Array<{ x: number; y: number }> = [];
  for (const key of broken) {
    if (!live.delete(key)) continue;
    survey.evict(key);
    supportBands.delete(key);
    demolished.push(cellOfKey(key));
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
  pendingFounded.clear();
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
    supportBands.clear();
    for (const [key, record] of restoredLive) {
      const cell = cellOfKey(key);
      const known = record.kind === UNRESOLVED_KIND ? undefined : record.kind;
      const stage = resolveGrowthStage(world, cell.x, cell.y, record.tier, { ...record, kind: known });
      if (!isBuildableCell(world, cell.x, cell.y, footprintRadiusOfKind(stage.kind))) continue;
      live.set(key, { ...record, ...stage });
      noteSupportBand(world, cell.x, cell.y);
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
    if (event === CYCLONE_DAMAGE_EVENT_NAME || event === TORNADO_DAMAGE_EVENT_NAME) {
      reactToWindDamage(world, event, payload);
    }
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
  const kind = foundingKindAt(world, x, y)!;
  const tier = tierOfKind(kind);

  const key = structureKey(x, y);
  const record = { age: 0, tier, kind };
  live.set(key, record);
  noteSupportBand(world, x, y);
  pendingFounded.set(key, record);
  return true;
}

export function canFoundStructure(world: StructuresWorld, x: number, y: number): boolean {
  if (survey.reservedSize(live) >= STRUCTURES_CAP) return false;
  if (live.has(structureKey(x, y))) return false;
  if (hasBuildingWithinSeparation(live, world, x, y)) return false;
  return isBuildableCell(world, x, y) && foundingKindAt(world, x, y) !== null;
}

export interface StandingStructure extends StructureCell {
  readonly age: number;
  /** The building's id in spawn-bands.json. */
  readonly building: string;
  /** Cells from the anchor to the edge of the drawn building, in a square. */
  readonly footprintRadiusCells: number;
}

export function standingStructures(): StandingStructure[] {
  const cells: StandingStructure[] = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    cells.push({
      x: cell.x,
      y: cell.y,
      tier: record.tier,
      kind: record.kind,
      age: record.age,
      building: buildingIdOf(record.kind),
      footprintRadiusCells: footprintRadiusOfKind(record.kind),
    });
  }
  return cells;
}

export function currentLive(): ReadonlyMap<number, BoardCellRecord> {
  return live;
}

export { GROWTH_MODEL_VERSION, setGrowthModel } from './growth-model.ts';

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
  supportBands = new Map();
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

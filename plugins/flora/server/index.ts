import { CHUNK_SIZE, type CellDiff } from '@terrace/shared';
import type {
  PersistenceSlice,
  SliceLoadOutcome,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  FLORA_CHANGES_MESSAGE,
  FLORA_CROPS_MESSAGE,
  FLORA_CROP_CHANGES_MESSAGE,
  FLORA_FOREST_MESSAGE,
  FLORA_PLUGIN_NAME,
  FLORA_GRASS_MESSAGE,
  FLORA_GRASS_CHANGES_MESSAGE,
  FLORA_FRINGE_MESSAGE,
  FLORA_FRINGE_CHANGES_MESSAGE,
  FLORA_STUMP_MESSAGE,
  FLORA_STUMP_CHANGES_MESSAGE,
  packCropCells,
  packFringeCells,
  packGrassCells,
  packStumpCells,
  packTreeCells,
  grassKey,
  stumpKey,
  treeKey,
  type CropCell,
  type FringeCell,
  type FringeSpecies,
  type GrassCell,
  type StumpCell,
  type TreeCell,
} from '../protocol.ts';
import {
  FLORA_RNG_DEFAULT_SEED,
  FLORA_SURVEY_INTERVAL_SECONDS,
  Forest,
  createFloraRng,
  type FloraRng,
  type BarredGround,
  type OccupancyPredicate,
} from './forest.ts';
import { CropField, cropSurveyChunksPerTick } from './crops.ts';
import { GrassField, grassSurveyChunksPerTick, isMeadowCell } from './grass.ts';
import { FringeField, fringeSurveyChunksPerTick, type FringePlant } from './fringe.ts';
import { closeFireBridge, loadFireBridge, registerFloraFuel } from './fire-bridge.ts';
import {
  FIRE_CELLS_BURNED_OUT_EVENT_NAME,
  parseBurnedOutCells,
} from './fire-event.ts';
import { StumpField } from './stumps.ts';
import { ScorchField, type ScorchRemaining } from './scorch.ts';
import { FLORA_SLICE_VERSION, loadForestSlice, saveForest } from './persistence.ts';
import { StabilityMap } from './stability.ts';
import { bridgedStructures, loadStructuresBridge } from './structures-bridge.ts';
import { parseStructuresOccupation } from './structures-event.ts';
import {
  parseStormDamage,
  severityAt,
} from '../../../server/src/plugins/kit/rotatingStormDamage.ts';
import {
  CYCLONE_DAMAGE_EVENT_NAME,
  FLORA_WIND_CROP_FLATTEN_CHANCE_PER_SEVERITY_SECOND,
  FLORA_WIND_CROP_MIN_SEVERITY,
  FLORA_WIND_CROP_REGROW_SECONDS,
  FLORA_WIND_MIN_SEVERITY,
  FLORA_WIND_TREE_FELL_CHANCE_PER_SEVERITY_SECOND,
  windEffectChance,
} from './cyclone-event.ts';

export const FLORA_KEEPALIVE_SECONDS = 60;

const forest = new Forest();

const cropField = new CropField();

const grassField = new GrassField();

const fringeField = new FringeField();

const stumpField = new StumpField();

const scorchField = new ScorchField();

const flattenedField = new ScorchField(FLORA_WIND_CROP_REGROW_SECONDS);

let stability: StabilityMap | null = null;

let rng: FloraRng = createFloraRng(FLORA_RNG_DEFAULT_SEED);

let simSeconds = 0;

let simTick = 0;

const STRUCTURE_SNAPSHOT_UNSET = -1;
let structureSnapshotTick = STRUCTURE_SNAPSHOT_UNSET;
const structureSnapshot = new Set<number>();

function structureOccupiedCells(): ReadonlySet<number> {
  if (structureSnapshotTick !== simTick) {
    structureSnapshot.clear();
    for (const cell of bridgedStructures()) structureSnapshot.add(grassKey(cell.x, cell.y));
    structureSnapshotTick = simTick;
  }
  return structureSnapshot;
}

let lastKeepaliveSeconds = 0;

let scanCredit = 0;

let cropScanCredit = 0;

let grassScanCredit = 0;

let fringeScanCredit = 0;

let restoredCells: readonly TreeCell[] = [];

let restoredScorch: readonly ScorchRemaining[] = [];

function treePosition(cell: TreeCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

const FLORA_SKIP_EMPTY = { skipEmpty: true } as const;

function broadcastForest(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_FOREST_MESSAGE,
    forest.cells(),
    treePosition,
    (visible) => ({ trees: packTreeCells(visible) }),
    FLORA_SKIP_EMPTY,
  );
  lastKeepaliveSeconds = simSeconds;
}

interface TaggedTreeChange {
  readonly kind: 'grown' | 'felled';
  readonly cell: TreeCell;
}

function broadcastChanges(
  world: WorldApi,
  grown: readonly TreeCell[],
  felled: readonly TreeCell[],
): void {
  if (grown.length === 0 && felled.length === 0) return;

  const tagged: TaggedTreeChange[] = [
    ...grown.map((cell): TaggedTreeChange => ({ kind: 'grown', cell })),
    ...felled.map((cell): TaggedTreeChange => ({ kind: 'felled', cell })),
  ];
  world.broadcastVisible(
    FLORA_CHANGES_MESSAGE,
    tagged,
    (change) => treePosition(change.cell),
    (visible) => ({
      grown: packTreeCells(visible.filter((c) => c.kind === 'grown').map((c) => c.cell)),
      felled: packTreeCells(visible.filter((c) => c.kind === 'felled').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

function cropPosition(cell: CropCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

function broadcastCrops(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_CROPS_MESSAGE,
    cropField.cells(),
    cropPosition,
    (visible) => ({ crops: packCropCells(visible) }),
    FLORA_SKIP_EMPTY,
  );
}

interface TaggedCropChange {
  readonly kind: 'sprouted' | 'withered';
  readonly cell: CropCell;
}

function broadcastCropChanges(
  world: WorldApi,
  sprouted: readonly CropCell[],
  withered: readonly CropCell[],
): void {
  if (sprouted.length === 0 && withered.length === 0) return;

  const tagged: TaggedCropChange[] = [
    ...sprouted.map((cell): TaggedCropChange => ({ kind: 'sprouted', cell })),
    ...withered.map((cell): TaggedCropChange => ({ kind: 'withered', cell })),
  ];
  world.broadcastVisible(
    FLORA_CROP_CHANGES_MESSAGE,
    tagged,
    (change) => cropPosition(change.cell),
    (visible) => ({
      sprouted: packCropCells(visible.filter((c) => c.kind === 'sprouted').map((c) => c.cell)),
      withered: packCropCells(visible.filter((c) => c.kind === 'withered').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

function refreshUnlockedChunkCrops(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: CropCell[] = [];
  for (const crop of cropField.cells()) {
    if (crop.x >= x0 && crop.x < x0 + CHUNK_SIZE && crop.y >= y0 && crop.y < y0 + CHUNK_SIZE) {
      inChunk.push(crop);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { sprouted: packCropCells(inChunk), withered: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_CROP_CHANGES_MESSAGE, payload);
  }
}

function grassPosition(cell: GrassCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

function broadcastGrass(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_GRASS_MESSAGE,
    grassField.cells(),
    grassPosition,
    (visible) => ({ grass: packGrassCells(visible) }),
    FLORA_SKIP_EMPTY,
  );
}

interface TaggedGrassChange {
  readonly kind: 'sprouted' | 'withered';
  readonly cell: GrassCell;
}

function broadcastGrassChanges(
  world: WorldApi,
  sprouted: readonly GrassCell[],
  withered: readonly GrassCell[],
): void {
  if (sprouted.length === 0 && withered.length === 0) return;

  const tagged: TaggedGrassChange[] = [
    ...sprouted.map((cell): TaggedGrassChange => ({ kind: 'sprouted', cell })),
    ...withered.map((cell): TaggedGrassChange => ({ kind: 'withered', cell })),
  ];
  world.broadcastVisible(
    FLORA_GRASS_CHANGES_MESSAGE,
    tagged,
    (change) => grassPosition(change.cell),
    (visible) => ({
      sprouted: packGrassCells(visible.filter((c) => c.kind === 'sprouted').map((c) => c.cell)),
      withered: packGrassCells(visible.filter((c) => c.kind === 'withered').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

function refreshUnlockedChunkGrass(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: GrassCell[] = [];
  for (const tuft of grassField.cells()) {
    if (tuft.x >= x0 && tuft.x < x0 + CHUNK_SIZE && tuft.y >= y0 && tuft.y < y0 + CHUNK_SIZE) {
      inChunk.push(tuft);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { sprouted: packGrassCells(inChunk), withered: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_GRASS_CHANGES_MESSAGE, payload);
  }
}

function fringePosition(cell: FringeCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

function packBySpecies(plants: readonly FringePlant[]): {
  reeds: number[];
  heather: number[];
} {
  const reeds: FringeCell[] = [];
  const heather: FringeCell[] = [];
  for (const plant of plants) {
    (plant.species === 'reed' ? reeds : heather).push(plant.cell);
  }
  return { reeds: packFringeCells(reeds), heather: packFringeCells(heather) };
}

function broadcastFringe(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_FRINGE_MESSAGE,
    fringeField.plants(),
    (plant) => fringePosition(plant.cell),
    (visible) => packBySpecies(visible),
    FLORA_SKIP_EMPTY,
  );
}

interface TaggedFringeChange {
  readonly kind: 'sprouted' | 'withered';
  readonly cell: FringeCell;
  readonly species: FringeSpecies | null;
}

function broadcastFringeChanges(
  world: WorldApi,
  sprouted: readonly FringePlant[],
  withered: readonly FringeCell[],
): void {
  if (sprouted.length === 0 && withered.length === 0) return;

  const tagged: TaggedFringeChange[] = [
    ...sprouted.map(
      (plant): TaggedFringeChange => ({
        kind: 'sprouted',
        cell: plant.cell,
        species: plant.species,
      }),
    ),
    ...withered.map((cell): TaggedFringeChange => ({ kind: 'withered', cell, species: null })),
  ];
  world.broadcastVisible(
    FLORA_FRINGE_CHANGES_MESSAGE,
    tagged,
    (change) => fringePosition(change.cell),
    (visible) => ({
      ...packBySpecies(
        visible.flatMap((c): FringePlant[] =>
          c.kind === 'sprouted' && c.species !== null
            ? [{ cell: c.cell, species: c.species }]
            : [],
        ),
      ),
      withered: packFringeCells(visible.filter((c) => c.kind === 'withered').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

function refreshUnlockedChunkFringe(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: FringePlant[] = [];
  for (const plant of fringeField.plants()) {
    const { x, y } = plant.cell;
    if (x >= x0 && x < x0 + CHUNK_SIZE && y >= y0 && y < y0 + CHUNK_SIZE) inChunk.push(plant);
  }
  if (inChunk.length === 0) return;

  const payload = { ...packBySpecies(inChunk), withered: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_FRINGE_CHANGES_MESSAGE, payload);
  }
}

function stumpPosition(cell: StumpCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

function broadcastStumps(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_STUMP_MESSAGE,
    stumpField.cells(),
    stumpPosition,
    (visible) => ({ stumps: packStumpCells(visible) }),
    FLORA_SKIP_EMPTY,
  );
}

interface TaggedStumpChange {
  readonly kind: 'left' | 'rotted';
  readonly cell: StumpCell;
}

function broadcastStumpChanges(
  world: WorldApi,
  left: readonly StumpCell[],
  rotted: readonly StumpCell[],
): void {
  if (left.length === 0 && rotted.length === 0) return;

  const tagged: TaggedStumpChange[] = [
    ...left.map((cell): TaggedStumpChange => ({ kind: 'left', cell })),
    ...rotted.map((cell): TaggedStumpChange => ({ kind: 'rotted', cell })),
  ];
  world.broadcastVisible(
    FLORA_STUMP_CHANGES_MESSAGE,
    tagged,
    (change) => stumpPosition(change.cell),
    (visible) => ({
      left: packStumpCells(visible.filter((c) => c.kind === 'left').map((c) => c.cell)),
      rotted: packStumpCells(visible.filter((c) => c.kind === 'rotted').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

function refreshUnlockedChunkStumps(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: StumpCell[] = [];
  for (const cell of stumpField.cells()) {
    if (cell.x >= x0 && cell.x < x0 + CHUNK_SIZE && cell.y >= y0 && cell.y < y0 + CHUNK_SIZE) {
      inChunk.push(cell);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { left: packStumpCells(inChunk), rotted: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_STUMP_CHANGES_MESSAGE, payload);
  }
}

function refreshUnlockedChunk(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: TreeCell[] = [];
  for (const tree of forest.cells()) {
    if (tree.x >= x0 && tree.x < x0 + CHUNK_SIZE && tree.y >= y0 && tree.y < y0 + CHUNK_SIZE) {
      inChunk.push(tree);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { grown: packTreeCells(inChunk), felled: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_CHANGES_MESSAGE, payload);
  }
}

function chunksPerTick(world: WorldApi, dt: number): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerSurvey = Math.max(1, Math.round(FLORA_SURVEY_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerSurvey;
}

function occupiedCells(): OccupancyPredicate {
  const occupied = new Set<number>();
  for (const cell of bridgedStructures()) occupied.add(treeKey(cell.x, cell.y));
  for (const cell of stumpField.cells()) occupied.add(treeKey(cell.x, cell.y));
  return (x: number, y: number): boolean => occupied.has(treeKey(x, y));
}

function groundCoverOccupied(x: number, y: number): boolean {
  const key = grassKey(x, y);
  return structureOccupiedCells().has(key) || cropField.has(x, y) || stumpField.has(x, y);
}

function barredGround(isOccupied: OccupancyPredicate): BarredGround {
  return (x, y) => isOccupied(x, y) || scorchField.has(x, y);
}

const groundCoverBarred: BarredGround = barredGround(groundCoverOccupied);

function cropBarred(isOccupied: OccupancyPredicate): BarredGround {
  const barred = barredGround(isOccupied);
  return (x, y) => barred(x, y) || flattenedField.has(x, y);
}

function simulate(world: WorldApi, dt: number): void {
  simSeconds += dt;
  simTick++;
  if (stability === null) return;

  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  scanCredit = Math.min(scanCredit + chunksPerTick(world, dt), totalChunks);
  const budget = Math.floor(scanCredit);
  if (budget > 0) {
    scanCredit -= budget;
    const treeOccupied = occupiedCells();
    const { grown, felled } = forest.advanceSurvey(
      world,
      stability,
      simSeconds,
      rng,
      budget,
      treeOccupied,
      barredGround(treeOccupied),
    );
    broadcastChanges(world, grown, felled);
  }

  cropScanCredit = Math.min(cropScanCredit + cropSurveyChunksPerTick(world, dt), totalChunks);
  const cropBudget = Math.floor(cropScanCredit);
  if (cropBudget > 0) {
    cropScanCredit -= cropBudget;
    const outcome = cropField.advance(world, cropBarred(occupiedCells()), cropBudget);
    if (outcome !== null) broadcastCropChanges(world, outcome.sprouted, outcome.withered);
  }

  grassScanCredit = Math.min(grassScanCredit + grassSurveyChunksPerTick(world, dt), totalChunks);
  const grassBudget = Math.floor(grassScanCredit);
  if (grassBudget > 0) {
    grassScanCredit -= grassBudget;
    const outcome = grassField.advance(world, groundCoverBarred, grassBudget);
    if (outcome !== null) broadcastGrassChanges(world, outcome.sprouted, outcome.withered);
  }

  fringeScanCredit = Math.min(fringeScanCredit + fringeSurveyChunksPerTick(world, dt), totalChunks);
  const fringeBudget = Math.floor(fringeScanCredit);
  if (fringeBudget > 0) {
    fringeScanCredit -= fringeBudget;
    const outcome = fringeField.advance(world, groundCoverBarred, fringeBudget);
    if (outcome !== null) broadcastFringeChanges(world, outcome.sprouted, outcome.withered);
  }

  const rotted = stumpField.advanceDecay(simSeconds);
  if (rotted.length > 0) broadcastStumpChanges(world, [], rotted);

  scorchField.advanceRegrowth(simSeconds);
  flattenedField.advanceRegrowth(simSeconds);

  if (simSeconds - lastKeepaliveSeconds >= FLORA_KEEPALIVE_SECONDS) {
    broadcastForest(world);
    broadcastCrops(world);
    broadcastGrass(world);
    broadcastFringe(world);
    broadcastStumps(world);
  }
}

function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (stability === null || diff.length === 0) return;

  const felled: TreeCell[] = [];
  const withered: CropCell[] = [];
  const uprooted: GrassCell[] = [];
  const strippedFringe: FringeCell[] = [];
  const clearedStumps: StumpCell[] = [];
  for (const cell of diff) {
    stability.markChanged(cell.x, cell.y, simSeconds);
    if (forest.fell(cell.x, cell.y)) felled.push({ x: cell.x, y: cell.y });
    const witheredCell = cropField.reactToEdit(cell.x, cell.y);
    if (witheredCell !== null) withered.push(witheredCell);
    const uprootedCell = grassField.reactToEdit(cell.x, cell.y);
    if (uprootedCell !== null) uprooted.push(uprootedCell);
    const strippedCell = fringeField.reactToEdit(cell.x, cell.y);
    if (strippedCell !== null) strippedFringe.push(strippedCell);
    const clearedStump = stumpField.reactToEdit(cell.x, cell.y);
    if (clearedStump !== null) clearedStumps.push(clearedStump);
  }

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
  broadcastGrassChanges(world, [], uprooted);
  broadcastFringeChanges(world, [], strippedFringe);
  broadcastStumpChanges(world, [], clearedStumps);
}

function onStructuresChanges(world: WorldApi, payload: unknown): void {
  const occupation = parseStructuresOccupation(payload);
  if (occupation === null) return;

  structureSnapshotTick = STRUCTURE_SNAPSHOT_UNSET;

  const felled: TreeCell[] = [];
  const withered: CropCell[] = [];
  const uprooted: GrassCell[] = [];
  const strippedFringe: FringeCell[] = [];
  const clearedStumps: StumpCell[] = [];
  const clearCell = (x: number, y: number): void => {
    if (forest.fell(x, y)) felled.push({ x, y });
    const witheredCell = cropField.reactToEdit(x, y);
    if (witheredCell !== null) withered.push(witheredCell);
    const uprootedCell = grassField.reactToEdit(x, y);
    if (uprootedCell !== null) uprooted.push(uprootedCell);
    const strippedCell = fringeField.reactToEdit(x, y);
    if (strippedCell !== null) strippedFringe.push(strippedCell);
    const clearedStump = stumpField.reactToEdit(x, y);
    if (clearedStump !== null) clearedStumps.push(clearedStump);
  };
  for (const cell of occupation.seeded) clearCell(cell.x, cell.y);
  for (const cell of occupation.upgraded) clearCell(cell.x, cell.y);

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
  broadcastGrassChanges(world, [], uprooted);
  broadcastFringeChanges(world, [], strippedFringe);
  broadcastStumpChanges(world, [], clearedStumps);
}

export const FLORA_TREE_BURN_SECONDS = 22;

export const FLORA_CROP_BURN_SECONDS = 4;

export const FLORA_TREE_FUEL_HEIGHT = 1.5;

export const FLORA_CROP_FUEL_HEIGHT = 0.35;

export const FLORA_GRASS_BURN_SECONDS = 22;

export const FLORA_GRASS_FUEL_HEIGHT = 0.15;

function floraFuelAt(x: number, y: number): { burnSeconds: number; height: number } | null {
  if (forest.has(x, y)) {
    return { burnSeconds: FLORA_TREE_BURN_SECONDS, height: FLORA_TREE_FUEL_HEIGHT };
  }
  if (cropField.has(x, y)) {
    return { burnSeconds: FLORA_CROP_BURN_SECONDS, height: FLORA_CROP_FUEL_HEIGHT };
  }
  const world = fuelWorld;
  if (world !== null && isMeadowCell(world, groundCoverBarred, x, y)) {
    return { burnSeconds: FLORA_GRASS_BURN_SECONDS, height: FLORA_GRASS_FUEL_HEIGHT };
  }
  return null;
}

function floraBurnedOut(cells: readonly { readonly x: number; readonly y: number }[]): void {
  removeStanding(cells, 'fire');
}

type FloraRemovalCause = 'fire' | 'wind';

function removeStanding(
  cells: readonly { readonly x: number; readonly y: number }[],
  cause: FloraRemovalCause,
): void {
  const world = fuelWorld;
  if (world === null) return;

  const felled: TreeCell[] = [];
  const withered: CropCell[] = [];
  const scorched: GrassCell[] = [];
  const stumps: StumpCell[] = [];
  for (const cell of cells) {
    if (forest.fell(cell.x, cell.y)) {
      felled.push({ x: cell.x, y: cell.y });
      const stump = stumpField.leave(cell.x, cell.y, simSeconds);
      if (stump !== null) stumps.push(stump);
    }
    const witheredCell = cropField.reactToEdit(cell.x, cell.y);
    if (witheredCell !== null) {
      withered.push(witheredCell);
      if (cause === 'wind') flattenedField.scorch(cell.x, cell.y, simSeconds);
    }
    if (cause === 'fire') {
      const scorchedCell = grassField.reactToEdit(cell.x, cell.y);
      if (scorchedCell !== null) scorched.push(scorchedCell);
    }

    if (cause === 'fire') scorchField.scorch(cell.x, cell.y, simSeconds);
  }

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
  if (scorched.length > 0) broadcastGrassChanges(world, [], scorched);
  broadcastStumpChanges(world, stumps, []);
}

function reactToBurnedOutCells(payload: unknown): void {
  if (fuelWorld === null) return;
  const cells = parseBurnedOutCells(payload);
  if (cells === null) return;
  for (const cell of cells) scorchField.scorch(cell.x, cell.y, simSeconds);
}

function reactToCycloneDamage(payload: unknown): void {
  if (fuelWorld === null) return;
  const damage = parseStormDamage(payload);
  if (damage === null) return;

  const taken: TreeCell[] = [];

  for (const tree of forest.cells()) {
    const severity = severityAt(damage, tree.x, tree.y);
    if (severity < FLORA_WIND_MIN_SEVERITY) continue;
    const chance = windEffectChance(
      severity,
      damage.durationSeconds,
      FLORA_WIND_TREE_FELL_CHANCE_PER_SEVERITY_SECOND,
    );
    if (rng.next() < chance) taken.push({ x: tree.x, y: tree.y });
  }

  for (const crop of cropField.cells()) {
    const severity = severityAt(damage, crop.x, crop.y);
    if (severity < FLORA_WIND_CROP_MIN_SEVERITY) continue;
    const chance = windEffectChance(
      severity,
      damage.durationSeconds,
      FLORA_WIND_CROP_FLATTEN_CHANCE_PER_SEVERITY_SECOND,
    );
    if (rng.next() < chance) taken.push({ x: crop.x, y: crop.y });
  }

  if (taken.length === 0) return;
  removeStanding(taken, 'wind');
}

let fuelWorld: WorldApi | null = null;

function selfDescribedSliceVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const version = (data as { version?: unknown }).version;
  return Number.isSafeInteger(version) ? (version as number) : undefined;
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return saveForest(forest, rng, scorchField, simSeconds);
  },
  version: FLORA_SLICE_VERSION,
  load(data: unknown, fromVersion: number): SliceLoadOutcome {
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > FLORA_SLICE_VERSION) {
      return 'refuse';
    }
    const restored = loadForestSlice(data);
    restoredCells = restored.cells;
    restoredScorch = restored.scorch;
    rng = createFloraRng(restored.rngState);
    return undefined;
  },
};

export const plugin: TerracePlugin = {
  name: FLORA_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    stability = new StabilityMap(world.worldSize);

    forest.replaceAll(restoredCells);
    restoredCells = [];

    scorchField.restore(
      restoredScorch.filter((entry) => entry.x < world.worldSize && entry.y < world.worldSize),
      simSeconds,
    );
    restoredScorch = [];

    loadStructuresBridge(world);

    fuelWorld = world;
    loadFireBridge(world);
    registerFloraFuel({
      name: FLORA_PLUGIN_NAME,
      fuelAt: floraFuelAt,
      onBurnedOut: floraBurnedOut,
    });

    broadcastForest(world);
    broadcastCrops(world);
    broadcastFringe(world);
    broadcastGrass(world);
    broadcastStumps(world);
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onWorldClose(): void {
    closeFireBridge();
    resetFloraState();
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onWorldEvent(world: WorldApi, event: string, payload: unknown): void {
    if (event === 'structures:changes') onStructuresChanges(world, payload);
    if (event === FIRE_CELLS_BURNED_OUT_EVENT_NAME) reactToBurnedOutCells(payload);
    if (event === CYCLONE_DAMAGE_EVENT_NAME) reactToCycloneDamage(payload);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    world.broadcastVisible(
      FLORA_FOREST_MESSAGE,
      forest.cells(),
      treePosition,
      (visible) => ({ trees: packTreeCells(visible) }),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );

    world.broadcastVisible(
      FLORA_CROPS_MESSAGE,
      cropField.cells(),
      cropPosition,
      (visible) => ({ crops: packCropCells(visible) }),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );

    world.broadcastVisible(
      FLORA_GRASS_MESSAGE,
      grassField.cells(),
      grassPosition,
      (visible) => ({ grass: packGrassCells(visible) }),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );

    world.broadcastVisible(
      FLORA_FRINGE_MESSAGE,
      fringeField.plants(),
      (plant) => fringePosition(plant.cell),
      (visible) => packBySpecies(visible),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );

    world.broadcastVisible(
      FLORA_STUMP_MESSAGE,
      stumpField.cells(),
      stumpPosition,
      (visible) => ({ stumps: packStumpCells(visible) }),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
    refreshUnlockedChunkCrops(world, token, cx, cy);
    refreshUnlockedChunkGrass(world, token, cx, cy);
    refreshUnlockedChunkFringe(world, token, cx, cy);
    refreshUnlockedChunkStumps(world, token, cx, cy);
  },

  persistence,
};

export function standingTrees(): readonly TreeCell[] {
  return forest.cells();
}

export function currentForest(): Forest {
  return forest;
}

export function currentStability(): StabilityMap | null {
  return stability;
}

export function standingCrops(): readonly CropCell[] {
  return cropField.cells();
}

export function currentCropField(): CropField {
  return cropField;
}

export function standingGrass(): readonly GrassCell[] {
  return grassField.cells();
}

export function currentGrassField(): GrassField {
  return grassField;
}

export function standingFringe(): readonly FringeCell[] {
  return fringeField.cells();
}

export function currentFringeField(): FringeField {
  return fringeField;
}

export function standingStumps(): readonly StumpCell[] {
  return stumpField.cells();
}

export function currentStumpField(): StumpField {
  return stumpField;
}

export function resetFloraState(): void {
  stability = null;
  fuelWorld = null;
  forest.replaceAll([]);
  cropField.clear();
  grassField.clear();
  fringeField.clear();
  stumpField.clear();
  scorchField.clear();
  flattenedField.clear();
  rng = createFloraRng(FLORA_RNG_DEFAULT_SEED);
  simSeconds = 0;
  simTick = 0;
  structureSnapshotTick = STRUCTURE_SNAPSHOT_UNSET;
  structureSnapshot.clear();
  lastKeepaliveSeconds = 0;
  scanCredit = 0;
  cropScanCredit = 0;
  grassScanCredit = 0;
  fringeScanCredit = 0;
  restoredCells = [];
}

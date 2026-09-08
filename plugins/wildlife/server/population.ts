import { climbWireOf, newStillness, stanceWireOf } from '@terrace/shared';
import type { ClimbState } from '@terrace/shared';
import { CHUNK_SIZE, nearestWithinReach } from '@terrace/shared';
import {
  DEFAULT_SIZE_CLASS,
  WILDLIFE_HABITAT_SPECIES,
  WILDLIFE_SIZE_CLASSES,
  type WildlifeEntityState,
  type WildlifeHabitatSpecies,
  type WildlifeSizeClass,
  roundBroadcastCell,
  roundBroadcastPosition,
  sizeClassAt,
  sizeClassIndex,
} from '../protocol.ts';
import {
  HABITAT_CENSUS_INTERVAL_SECONDS,
  WILDLIFE_POPULATION_CAP,
  type HabitatWorld,
  emptySpeciesCounts,
  isValidCellFor,
  openDirectionCount,
  satisfiesSpawnGround,
  withinSpawnHeights,
  targetsFor,
} from './census.ts';
import { reconcileCensus } from './census-index.ts';
import { randomSigned } from './rng.ts';
import { type SizeWeights, type SpeciesProfile, profileOf, spawnGroundConstrains } from './species.ts';

export interface WildlifeEntity {
  readonly id: number;
  readonly species: WildlifeHabitatSpecies;

  readonly schoolId: number;

  readonly size: WildlifeSizeClass;

  x: number;
  y: number;
  heading: number;
  fleeSecondsRemaining: number;

  idle: boolean;

  huntTargetId: number | null;

  climb: ClimbState | null;

  stillSeconds: number;
  stillX: number;
  stillY: number;

  huntSecondsRemaining: number;

  huntRestSecondsRemaining: number;
}

interface RespawnCredit {
  readonly species: WildlifeHabitatSpecies;
  readonly readyAt: number;
}

export const HABITAT_LOSS_RESPAWN_DELAY_SECONDS = 8;

export const SPAWN_GROUPS_PER_TICK = 1;

export const SPAWN_MEAN_WAIT_SECONDS = 20;

export const NATURAL_LIFESPAN_SECONDS = 300;

export const SPAWN_SAMPLE_ATTEMPTS = 48;

const GROUP_SCATTER_BODY_LENGTHS = 2;

const entities: WildlifeEntity[] = [];

let credits: RespawnCredit[] = [];

let simSeconds = 0;

let lastCensusSeconds = Number.NEGATIVE_INFINITY;

let targets: Record<WildlifeHabitatSpecies, number> = emptySpeciesCounts();

let spawnChunks: ReadonlyArray<readonly [number, number]> = [];

let nextEntityId = 1;

let nextSchoolId = 1;

let naturalDepartures = 0;

export function livingEntities(): readonly WildlifeEntity[] {
  return entities;
}

export function naturalDepartureCount(): number {
  return naturalDepartures;
}

export function populationTargets(): Readonly<Record<WildlifeHabitatSpecies, number>> {
  return targets;
}

export function pendingCreditCount(): number {
  return credits.length;
}

export function pendingCreditsSnapshot(): ReadonlyArray<{
  readonly species: WildlifeHabitatSpecies;
  readonly readyAt: number;
}> {
  return credits.map((credit) => ({ ...credit }));
}

export function nextEntityIdValue(): number {
  return nextEntityId;
}

export function allocateEntityId(): number {
  return nextEntityId++;
}

export function nextSchoolIdValue(): number {
  return nextSchoolId;
}

export function schoolMembers(schoolId: number): WildlifeEntity[] {
  return entities.filter((entity) => entity.schoolId === schoolId);
}

export function resetPopulation(): void {
  entities.length = 0;
  credits = [];
  simSeconds = 0;
  lastCensusSeconds = Number.NEGATIVE_INFINITY;
  targets = emptySpeciesCounts();
  spawnChunks = [];
  nextEntityId = 1;
  nextSchoolId = 1;
  naturalDepartures = 0;
}

function countOf(species: WildlifeHabitatSpecies): number {
  let count = 0;
  for (const entity of entities) if (entity.species === species) count++;
  return count;
}

function creditsFor(species: WildlifeHabitatSpecies): number {
  let count = 0;
  for (const credit of credits) if (credit.species === species) count++;
  return count;
}

function reconcileToTargets(): void {
  for (const species of WILDLIFE_HABITAT_SPECIES) {
    const deficit = targets[species] - countOf(species) - creditsFor(species);

    if (deficit > 0) {
      for (let n = 0; n < deficit; n++) credits.push({ species, readyAt: simSeconds });
      continue;
    }
    if (deficit === 0) continue;

    let surplus = -deficit;
    for (let i = credits.length - 1; i >= 0 && surplus > 0; i--) {
      if (credits[i].species !== species) continue;
      credits.splice(i, 1);
      surplus--;
    }
    for (let i = entities.length - 1; i >= 0 && surplus > 0; i--) {
      if (entities[i].species !== species) continue;
      entities.splice(i, 1);
      surplus--;
    }
  }
}

function sampleUnlockedCell(): { x: number; y: number } | null {
  if (spawnChunks.length === 0) return null;
  const [cx, cy] = spawnChunks[Math.floor(Math.random() * spawnChunks.length)];
  return {
    x: cx * CHUNK_SIZE + Math.random() * CHUNK_SIZE,
    y: cy * CHUNK_SIZE + Math.random() * CHUNK_SIZE,
  };
}

function canSettleAt(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  x: number,
  y: number,
): boolean {
  if (!isValidCellFor(world, species, x, y)) return false;
  if (!withinSpawnHeights(world, species, x, y)) return false;
  return satisfiesSpawnGround(world, species, x, y);
}

function findSpawnCell(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
): { x: number; y: number } | null {
  for (let attempt = 0; attempt < SPAWN_SAMPLE_ATTEMPTS; attempt++) {
    const candidate = sampleUnlockedCell();
    if (candidate === null) return null;
    if (canSettleAt(world, species, candidate.x, candidate.y)) return candidate;
  }
  return null;
}

function drawSizeClass(weights: SizeWeights): WildlifeSizeClass {
  let total = 0;
  for (const sizeClass of WILDLIFE_SIZE_CLASSES) total += weights[sizeClass];
  if (total <= 0) return DEFAULT_SIZE_CLASS;

  let roll = Math.random() * total;
  for (const sizeClass of WILDLIFE_SIZE_CLASSES) {
    roll -= weights[sizeClass];
    if (roll < 0) return sizeClass;
  }
  return DEFAULT_SIZE_CLASS;
}

function drawGroupSizes(profile: SpeciesProfile, wanted: number): WildlifeSizeClass[] {
  if (profile.sizeDraw === 'per-member') {
    return Array.from({ length: wanted }, () => drawSizeClass(profile.sizeWeights));
  }
  const shared = drawSizeClass(profile.sizeWeights);
  return Array.from({ length: wanted }, () => shared);
}

function groupSizeClassOf(sizes: readonly WildlifeSizeClass[]): WildlifeSizeClass {
  let largest = -1;
  for (const size of sizes) largest = Math.max(largest, sizeClassIndex(size));
  return largest < 0 ? DEFAULT_SIZE_CLASS : sizeClassAt(largest);
}

function spawnGroup(world: HabitatWorld, species: WildlifeHabitatSpecies, wanted: number): number {
  const seed = findSpawnCell(world, species);
  if (seed === null) return 0;

  const profile = profileOf(species);
  const sizes = drawGroupSizes(profile, wanted);
  const cohesive = Math.random() < profile.schoolingProbabilityBySize[groupSizeClassOf(sizes)];
  const groupSchoolId = nextSchoolId++;

  const scatter = profile.bodyLengthCells * GROUP_SCATTER_BODY_LENGTHS;
  const heading = Math.random() * Math.PI * 2;
  let created = 0;

  for (let n = 0; n < wanted; n++) {
    const x = n === 0 ? seed.x : seed.x + randomSigned(scatter);
    const y = n === 0 ? seed.y : seed.y + randomSigned(scatter);
    if (!canSettleAt(world, species, x, y)) continue;
    entities.push({
      id: allocateEntityId(),
      species,
      schoolId: cohesive ? groupSchoolId : nextSchoolId++,
      size: sizes[n]!,
      x,
      y,
      heading,
      fleeSecondsRemaining: 0,
      idle: false,
      huntTargetId: null,
      huntSecondsRemaining: 0,
      huntRestSecondsRemaining: 0,
      climb: null,
      ...newStillness(x, y),
    });
    created++;
  }
  return created;
}

function ripeCreditCount(): number {
  let count = 0;
  for (const credit of credits) if (credit.readyAt <= simSeconds) count++;
  return count;
}

function rollSpawnEvent(ripe: number, dt: number): boolean {
  return Math.random() < Math.min(1, (ripe * dt) / SPAWN_MEAN_WAIT_SECONDS);
}

function deferRipeCredits(species: WildlifeHabitatSpecies): void {
  for (let i = 0; i < credits.length; i++) {
    if (credits[i].species !== species || credits[i].readyAt > simSeconds) continue;
    credits[i] = { species, readyAt: simSeconds + HABITAT_CENSUS_INTERVAL_SECONDS };
  }
}

function spawnOneGroup(world: HabitatWorld): boolean {
  for (let attempt = 0; attempt < WILDLIFE_HABITAT_SPECIES.length; attempt++) {
    const index = credits.findIndex((credit) => credit.readyAt <= simSeconds);
    if (index === -1) return false;

    const species = credits[index].species;
    const wanted = Math.min(
      profileOf(species).groupSize,
      creditsFor(species),
      WILDLIFE_POPULATION_CAP - entities.length,
    );
    const created = spawnGroup(world, species, wanted);

    if (created === 0) {
      deferRipeCredits(species);
      continue;
    }

    let removed = 0;
    for (let i = credits.length - 1; i >= 0 && removed < created; i--) {
      if (credits[i].species !== species || credits[i].readyAt > simSeconds) continue;
      credits.splice(i, 1);
      removed++;
    }
    return true;
  }
  return false;
}

function consumeCredits(world: HabitatWorld, dt: number): void {
  for (let group = 0; group < SPAWN_GROUPS_PER_TICK; group++) {
    if (entities.length >= WILDLIFE_POPULATION_CAP) return;
    const ripe = ripeCreditCount();
    if (ripe === 0) return;
    if (!rollSpawnEvent(ripe, dt)) return;
    if (!spawnOneGroup(world)) return;
  }
}

export function despawnWithCredit(index: number): void {
  const [removed] = entities.splice(index, 1);
  if (removed === undefined) return;
  credits.push({
    species: removed.species,
    readyAt: simSeconds + HABITAT_LOSS_RESPAWN_DELAY_SECONDS,
  });
}

export function despawnInvalidHabitat(world: HabitatWorld): number {
  let despawned = 0;
  for (let i = entities.length - 1; i >= 0; i--) {
    const entity = entities[i];
    if (isValidCellFor(world, entity.species, entity.x, entity.y)) continue;
    despawnWithCredit(i);
    despawned++;
  }
  return despawned;
}

export function despawnWedged(world: HabitatWorld): number {
  let despawned = 0;
  for (let i = entities.length - 1; i >= 0; i--) {
    const entity = entities[i];
    if (!spawnGroundConstrains(profileOf(entity.species).spawnGround)) continue;
    if (openDirectionCount(world, entity.species, entity.x, entity.y) > 0) continue;
    despawnWithCredit(i);
    despawned++;
  }
  return despawned;
}

export function applyNaturalTurnover(dt: number): void {
  const departureChance = dt / NATURAL_LIFESPAN_SECONDS;

  const rolled = new Set<number>();
  const departing = new Set<number>();
  for (const entity of entities) {
    if (rolled.has(entity.schoolId)) continue;
    rolled.add(entity.schoolId);
    if (Math.random() < departureChance) departing.add(entity.schoolId);
  }
  if (departing.size === 0) return;

  for (let i = entities.length - 1; i >= 0; i--) {
    if (!departing.has(entities[i].schoolId)) continue;
    entities.splice(i, 1);
    naturalDepartures++;
  }
}

const FIRE_CELL_REACH = 0.5;

export function burnableEntityAt(
  x: number,
  y: number,
): { entity: WildlifeEntity; distanceCells: number } | null {
  const nearest = nearestWithinReach(
    entities.filter((entity) => profileOf(entity.species).habitat === 'land'),
    x,
    y,
    FIRE_CELL_REACH,
    (entity) => entity,
  );
  return nearest === null ? null : { entity: nearest.item, distanceCells: nearest.distanceCells };
}

const CREATURE_BODY_RADIUS_CELLS = 0;

export function* flammableCreatures(): Generator<{
  id: number;
  x: number;
  y: number;
  radiusCells: number;
}> {
  for (const entity of entities) {
    if (profileOf(entity.species).habitat !== 'land') continue;
    yield {
      id: entity.id,
      x: entity.x,
      y: entity.y,
      radiusCells: CREATURE_BODY_RADIUS_CELLS,
    };
  }
}

export function entityPosition(id: number): { x: number; y: number } | null {
  const entity = entities.find((candidate) => candidate.id === id);
  return entity === undefined ? null : { x: entity.x, y: entity.y };
}

export function killEntities(ids: readonly number[]): number {
  if (ids.length === 0) return 0;
  const doomed = new Set(ids);
  let killed = 0;
  for (let i = entities.length - 1; i >= 0; i--) {
    if (!doomed.has(entities[i].id)) continue;
    entities.splice(i, 1);
    killed++;
  }
  return killed;
}

export function advancePopulation(world: HabitatWorld, dt: number): void {
  simSeconds += dt;
  applyNaturalTurnover(dt);

  if (simSeconds - lastCensusSeconds >= HABITAT_CENSUS_INTERVAL_SECONDS) {
    lastCensusSeconds = simSeconds;
    const census = reconcileCensus(world);
    spawnChunks = census.chunks;
    targets = targetsFor(census.cellsBySpecies);
    despawnWedged(world);
    reconcileToTargets();
  }

  consumeCredits(world, dt);
}

export function entityStates(worldSize: number): WildlifeEntityState[] {
  return entities.map((entity) => ({
    id: entity.id,
    species: entity.species,
    x: roundBroadcastCell(entity.x, worldSize),
    y: roundBroadcastCell(entity.y, worldSize),
    heading: roundBroadcastPosition(entity.heading),
    size: sizeClassIndex(entity.size),
    ...climbWireOf(entity.climb),
    ...stanceWireOf(entity),
  }));
}

export function replacePopulation(
  restored: readonly WildlifeEntity[],
  nextId: number,
  nextSchool: number,
): void {
  resetPopulation();
  for (const entity of restored) entities.push({ ...entity, climb: entity.climb ?? null });
  nextEntityId = nextId;
  let highestSchool = 0;
  for (const entity of entities) highestSchool = Math.max(highestSchool, entity.schoolId);
  nextSchoolId = Math.max(nextSchool, highestSchool + 1, 1);
}

import type { ClimbState } from '@terrace/shared';
import { newStillness } from '@terrace/shared';
import {
  MONSTER_KINDS,
  YETI_VARIANTS,
  type MonsterKind,
  type YetiVariant,
} from '../protocol.ts';
import {
  CELL_CENTRE_OFFSET,
  EMPTY_LAIR_SURVEY,
  HABITAT_REGIMES,
  type HabitatRegime,
  type HabitatRegimeId,
  type LairRegion,
  type LairSurvey,
  type LairWorld,
  isLairCell,
  isLairPose,
  reachesIntoHabitat,
  releaseSurveyScratch,
  surveyLairs,
} from './habitat.ts';
import { releaseHabitatIndex, syncedHabitatIndex } from './habitat-index.ts';
import {
  MAX_LIVING_MONSTERS_PER_KIND,
  type MonsterProfile,
  bodyRadiusCells,
  habitatKindIndex,
  kindsInHabitat,
  lairFitRulesInHabitat,
  profileOf,
  summonRatePerSecond,
} from './kinds.ts';
import { hashToIndex, monsterRandom, randomIndex, rollEvent } from './rng.ts';

export interface Monster {
  readonly id: number;
  readonly kind: MonsterKind;
  x: number;
  y: number;
  heading: number;
  idle: boolean;
  readonly variant?: YetiVariant;
  climb: ClimbState | null;
  stillSeconds: number;
  stillX: number;
  stillY: number;
}

export const LAIR_SURVEY_INTERVAL_SECONDS = 5;

export const LAIR_SURVEY_DEBOUNCE_SECONDS = 0.5;

interface KindState {
  living: Monster | null;
  cooldownSeconds: number;
}

function emptyKindState(): KindState {
  return { living: null, cooldownSeconds: 0 };
}

function emptyKindStates(): Record<MonsterKind, KindState> {
  return {
    cthulhu: emptyKindState(),
    kraken: emptyKindState(),
    yeti: emptyKindState(),
  };
}

let kindStates: Record<MonsterKind, KindState> = emptyKindStates();

function emptySurveys(): Record<HabitatRegimeId, LairSurvey> {
  return { water: EMPTY_LAIR_SURVEY, land: EMPTY_LAIR_SURVEY };
}

let surveys: Record<HabitatRegimeId, LairSurvey> = emptySurveys();

let simSeconds = 0;

function neverSurveyed(): Record<HabitatRegimeId, number> {
  return { water: Number.NEGATIVE_INFINITY, land: Number.NEGATIVE_INFINITY };
}

let lastSurveySeconds: Record<HabitatRegimeId, number> = neverSurveyed();

function noTerrainPending(): Record<HabitatRegimeId, number | null> {
  return { water: null, land: null };
}

let terrainSettledDeadlineSeconds: Record<HabitatRegimeId, number | null> = noTerrainPending();

let nextMonsterId = 1;

export interface MonsterTransition {
  readonly event: 'arrived' | 'departed';
  readonly kind: MonsterKind;
  readonly x: number;
  readonly y: number;
}

let pendingTransitions: MonsterTransition[] = [];

export function drainMonsterTransitions(): MonsterTransition[] {
  const drained = pendingTransitions;
  pendingTransitions = [];
  return drained;
}

function stateOf(kind: MonsterKind): KindState {
  return kindStates[kind];
}

export function livingMonsterOfKind(kind: MonsterKind): Monster | null {
  return stateOf(kind).living;
}

export function livingMonstersIn(regime: HabitatRegime): Monster[] {
  const alive: Monster[] = [];
  for (const kind of kindsInHabitat(regime)) {
    const monster = stateOf(kind).living;
    if (monster !== null) alive.push(monster);
  }
  return alive;
}

export function livingMonsters(): Monster[] {
  const alive: Monster[] = [];
  for (const kind of MONSTER_KINDS) {
    const monster = stateOf(kind).living;
    if (monster !== null) alive.push(monster);
  }
  return alive;
}

export function livingMonsterCount(): number {
  let count = 0;
  for (const kind of MONSTER_KINDS) {
    if (stateOf(kind).living !== null) count++;
  }
  return count;
}

export function livingCountOfKind(kind: MonsterKind): number {
  return stateOf(kind).living === null ? 0 : 1;
}

export function cooldownRemainingSecondsFor(kind: MonsterKind): number {
  return stateOf(kind).cooldownSeconds;
}

export function lastLairSurvey(regime: HabitatRegime): LairSurvey {
  return surveys[regime.id];
}

export function nextMonsterIdValue(): number {
  return nextMonsterId;
}

export function summoningSimSeconds(): number {
  return simSeconds;
}

export function resetSummoning(): void {
  kindStates = emptyKindStates();
  surveys = emptySurveys();
  simSeconds = 0;
  lastSurveySeconds = neverSurveyed();
  terrainSettledDeadlineSeconds = noTerrainPending();
  nextMonsterId = 1;
  pendingTransitions = [];
  releaseSurveyScratch();
  releaseHabitatIndex();
}

export function invalidateSurvey(): void {
  for (const regime of HABITAT_REGIMES) {
    terrainSettledDeadlineSeconds[regime.id] = simSeconds + LAIR_SURVEY_DEBOUNCE_SECONDS;
  }
}

function habitatSurveyHasReader(regime: HabitatRegime): boolean {
  for (const kind of kindsInHabitat(regime)) {
    const state = stateOf(kind);
    if (state.living === null) {
      if (state.cooldownSeconds <= 0) return true;
      continue;
    }
    const banishment = profileOf(kind).banishment;
    if (banishment !== null && banishment.lairCollapseCells !== null) return true;
  }
  return false;
}

function variantFor(kind: MonsterKind): YetiVariant | undefined {
  if (kind !== 'yeti') return undefined;
  return YETI_VARIANTS[randomIndex(YETI_VARIANTS.length)];
}

function summon(profile: MonsterProfile, cellX: number, cellY: number): Monster | null {
  const state = stateOf(profile.kind);
  if (livingCountOfKind(profile.kind) >= MAX_LIVING_MONSTERS_PER_KIND) return null;

  const variant = variantFor(profile.kind);

  state.living = {
    id: nextMonsterId++,
    kind: profile.kind,
    climb: null,
    ...(variant === undefined ? {} : { variant }),
    x: cellX + CELL_CENTRE_OFFSET,
    y: cellY + CELL_CENTRE_OFFSET,
    heading: monsterRandom() * Math.PI * 2,
    idle: false,
    ...newStillness(cellX + CELL_CENTRE_OFFSET, cellY + CELL_CENTRE_OFFSET),
  };
  pendingTransitions.push({ event: 'arrived', kind: profile.kind, x: cellX, y: cellY });
  return state.living;
}

export function banish(monster: Monster): boolean {
  const profile = profileOf(monster.kind);
  const state = stateOf(profile.kind);
  if (state.living !== monster) return false;
  const rule = profile.banishment;
  if (rule === null) return false;
  state.cooldownSeconds = rule.respawnCooldownSeconds;
  state.living = null;
  pendingTransitions.push({
    event: 'departed',
    kind: monster.kind,
    x: Math.floor(monster.x),
    y: Math.floor(monster.y),
  });
  return true;
}

export function enforceHabitat(world: LairWorld): boolean {
  let banished = false;
  for (const monster of livingMonsters()) {
    const profile = profileOf(monster.kind);
    if (isLairCell(profile.habitat, world, monster.x, monster.y)) continue;
    if (banish(monster)) banished = true;
  }
  return banished;
}

function bestLairFor(kind: MonsterKind): LairRegion | null {
  const profile = profileOf(kind);
  const fitIndex = habitatKindIndex(kind);
  const { regions } = surveys[profile.habitat.id];
  let best: LairRegion | null = null;
  for (const region of regions) {
    if (region.cells < profile.minLairCells) continue;
    if (!reachesIntoHabitat(profile.habitat, region.extremeHeight, profile.minLairReachBands)) {
      continue;
    }
    if ((region.fittingCells[fitIndex] ?? 0) < profile.minLairFittingCells) continue;
    if ((region.summonableCells[fitIndex] ?? 0) <= 0) continue;
    if (best !== null && region.cells <= best.cells) continue;
    best = region;
  }
  return best;
}

function summonCellIn(
  profile: MonsterProfile,
  world: LairWorld,
  region: LairRegion,
  fitIndex: number,
): { readonly x: number; readonly y: number } | null {
  const candidates = region.summonCandidates[fitIndex] ?? [];
  if (candidates.length === 0) return null;

  const size = world.worldSize;
  const radiusCells = bodyRadiusCells(profile);
  const start = hashToIndex(nextMonsterId, candidates.length);

  for (let step = 0; step < candidates.length; step++) {
    const index = candidates[(start + step) % candidates.length]!;
    const x = index % size;
    const y = (index - x) / size;
    if (!isLairCell(profile.habitat, world, x, y)) continue;
    if (!reachesIntoHabitat(profile.habitat, world.heightAt(x, y), profile.minLairReachBands)) {
      continue;
    }
    if (
      !isLairPose(
        profile.range,
        world,
        x + CELL_CENTRE_OFFSET,
        y + CELL_CENTRE_OFFSET,
        radiusCells,
      )
    ) {
      continue;
    }
    return { x, y };
  }
  return null;
}

function trySummon(kind: MonsterKind, world: LairWorld, dt: number): void {
  const state = stateOf(kind);
  if (state.cooldownSeconds > 0) return;

  const profile = profileOf(kind);
  const cell = bestLairFor(kind);
  if (cell === null) return;
  if (!rollEvent(summonRatePerSecond(profile), dt)) return;

  if (!isLairCell(profile.habitat, world, cell.x, cell.y)) {
    invalidateSurvey();
    return;
  }

  const spot = summonCellIn(profile, world, cell, habitatKindIndex(kind));
  if (spot === null) {
    invalidateSurvey();
    return;
  }

  summon(profile, spot.x, spot.y);
}

export function summonNow(
  kind: MonsterKind,
  world: LairWorld,
): { readonly monster: Monster | null; readonly detail: string } {
  const profile = profileOf(kind);
  if (livingCountOfKind(kind) >= MAX_LIVING_MONSTERS_PER_KIND) {
    return { monster: null, detail: `a ${kind} is already in the world` };
  }
  const cell = bestLairFor(kind);
  if (cell === null) {
    return {
      monster: null,
      detail: `no lair for a ${kind}: the last survey found no region big and deep enough (it re-runs every ${LAIR_SURVEY_INTERVAL_SECONDS}s)`,
    };
  }
  const spot = summonCellIn(profile, world, cell, habitatKindIndex(kind));
  if (spot === null) {
    invalidateSurvey();
    return { monster: null, detail: `the ${kind}'s lair no longer qualifies — re-surveying; try again` };
  }
  const monster = summon(profile, spot.x, spot.y);
  if (monster === null) return { monster: null, detail: `a ${kind} is already in the world` };
  return { monster, detail: `${kind} ${monster.id} surfaced at (${spot.x}, ${spot.y})` };
}

export function advanceSummoning(world: LairWorld, dt: number): void {
  simSeconds += dt;

  for (const kind of MONSTER_KINDS) {
    const state = stateOf(kind);
    if (state.cooldownSeconds > 0) state.cooldownSeconds = Math.max(0, state.cooldownSeconds - dt);
  }

  const due = HABITAT_REGIMES.filter((regime) => {
    const deadline = terrainSettledDeadlineSeconds[regime.id];
    const periodicDue =
      simSeconds - lastSurveySeconds[regime.id] >= LAIR_SURVEY_INTERVAL_SECONDS;
    const settledDue = deadline !== null && simSeconds >= deadline;
    if (!periodicDue && !settledDue) return false;
    return habitatSurveyHasReader(regime);
  });

  if (due.length > 0) {
    const index = syncedHabitatIndex(
      world,
      HABITAT_REGIMES.map((regime) => ({ regime, fitRules: lairFitRulesInHabitat(regime) })),
    );

    for (const regime of due) {
      lastSurveySeconds[regime.id] = simSeconds;
      terrainSettledDeadlineSeconds[regime.id] = null;
      const occupants = livingMonstersIn(regime);
      const survey = surveyLairs(
        regime,
        world,
        occupants,
        lairFitRulesInHabitat(regime),
        index,
      );
      surveys[regime.id] = survey;

      for (let i = 0; i < occupants.length; i++) {
        const monster = occupants[i];
        const banishment = profileOf(monster.kind).banishment;
        if (banishment === null || banishment.lairCollapseCells === null) continue;
        if (survey.occupiedRegionCells[i]! < banishment.lairCollapseCells) {
          banish(monster);
        }
      }
    }
  }

  for (const kind of MONSTER_KINDS) {
    if (stateOf(kind).living === null) trySummon(kind, world, dt);
  }
}

export function restoreSummoning(
  monsters: readonly Monster[],
  nextId: number,
  cooldowns: Partial<Record<MonsterKind, number>>,
): void {
  resetSummoning();

  for (const monster of monsters) {
    const state = stateOf(monster.kind);
    if (state.living !== null) continue;
    state.living = { ...monster };
  }

  for (const kind of MONSTER_KINDS) {
    const cooldown = cooldowns[kind];
    if (cooldown !== undefined) stateOf(kind).cooldownSeconds = cooldown;
  }

  nextMonsterId = nextId;
}

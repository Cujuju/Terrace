import { climbWireOf, moverStanceOf, stanceWireOf } from '@terrace/shared';
import type { CellDiff, SculptIntent } from '@terrace/shared';
import type {
  IntentVerdict,
  PersistenceSlice,
  PluginActionOutcome,
  SliceLoadOutcome,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  MONSTER_KINDS,
  MONSTERS_PLUGIN_NAME,
  MONSTERS_STATE_MESSAGE,
  isMonsterKind,
  type MonsterState,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '../protocol.ts';
import { noteTerrainChangedInIndex, releaseHabitatIndex } from './habitat-index.ts';
import { advanceLurking } from './lurk.ts';
import { MONSTERS_SLICE_VERSION, loadMonsters, saveMonsters } from './persistence.ts';
import { RAISE_BLOCKED_REASON, reachesProtectedGround } from './protection.ts';
import {
  advanceSummoning,
  banish,
  drainMonsterTransitions,
  enforceHabitat,
  invalidateSurvey,
  livingMonsterOfKind,
  livingMonsters,
  resetSummoning,
  summonNow,
} from './summoning.ts';

export const BROADCAST_TICK_INTERVAL = 10;

let tickCount = 0;

export function monsterStates(): MonsterState[] {
  return livingMonsters().map((monster) => ({
    id: monster.id,
    kind: monster.kind,
    x: roundBroadcastPosition(monster.x),
    y: roundBroadcastPosition(monster.y),
    heading: roundBroadcastPosition(monster.heading),
    ...(monster.variant === undefined ? {} : { variant: monster.variant }),
    ...(monster.climb === null ? {} : climbWireOf(monster.climb)),
    ...(moverStanceOf(monster) === 'walk' ? {} : stanceWireOf(monster)),
  }));
}

function emitTransitions(world: WorldApi): void {
  for (const transition of drainMonsterTransitions()) {
    world.emitEvent(transition.event, {
      kind: transition.kind,
      x: transition.x,
      y: transition.y,
    });
  }
}

function emitPositions(world: WorldApi): void {
  const living = livingMonsters();
  if (living.length === 0) return;
  world.emitEvent('positions', {
    monsters: living.map((monster) => ({
      kind: monster.kind,
      x: monster.x,
      y: monster.y,
    })),
  });
}

function simulate(world: WorldApi, dt: number): void {
  advanceSummoning(world, dt);
  advanceLurking(world, dt);
  enforceHabitat(world);
  emitTransitions(world);
  emitPositions(world);

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;

  const onTheMap = monsterStates().map((monster) => ({
    ...monster,
    x: roundBroadcastCell(monster.x, world.worldSize),
    y: roundBroadcastCell(monster.y, world.worldSize),
  }));
  world.broadcastVisible(
    MONSTERS_STATE_MESSAGE,
    onTheMap,
    (monster) => ({ x: monster.x, y: monster.y }),
    (visible) => ({ monsters: visible }),
  );
}

function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (diff.length === 0) return;
  noteTerrainChangedInIndex(diff);
  enforceHabitat(world);
  emitTransitions(world);
  invalidateSurvey();
}

function guardGround(intent: SculptIntent): IntentVerdict | void {
  for (const monster of livingMonsters()) {
    if (!reachesProtectedGround(intent, monster)) continue;
    return { kind: 'deny', reason: RAISE_BLOCKED_REASON };
  }
}

function selfDescribedSliceVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const version = (data as { version?: unknown }).version;
  return Number.isSafeInteger(version) ? (version as number) : undefined;
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return saveMonsters();
  },
  version: MONSTERS_SLICE_VERSION,
  load(data: unknown, fromVersion: number): SliceLoadOutcome {
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > MONSTERS_SLICE_VERSION) {
      return 'refuse';
    }
    loadMonsters(data);
    return undefined;
  },
};

export const plugin: TerracePlugin = {
  name: MONSTERS_PLUGIN_NAME,

  archetype: 'creatures',
  actions: MONSTER_KINDS.map((kind) => ({
    key: kind,
    label: `Summon the ${kind}`,
    description: `The ${kind} surfaces in its best lair now, cooldown or no cooldown; the arrival is announced as any other.`,
  })),

  onAction(world: WorldApi, key: string): PluginActionOutcome {
    if (!isMonsterKind(key)) return { ok: false, detail: `no such action "${key}"` };
    const { monster, detail } = summonNow(key, world);
    if (monster === null) return { ok: false, detail };
    return { ok: true, detail };
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onWorldCreate(): void {
    releaseHabitatIndex();
  },

  onIntent(intent: SculptIntent): IntentVerdict | void {
    return guardGround(intent);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onWorldEvent(world: WorldApi, event: string, payload: unknown): void {
    if (event !== 'boats:defeated') return;
    if (typeof payload !== 'object' || payload === null) return;
    const { kind } = payload as { kind?: unknown };
    if (typeof kind !== 'string') return;
    if (!isMonsterKind(kind)) return;
    const monster = livingMonsterOfKind(kind);
    if (monster === null) return;
    if (banish(monster)) emitTransitions(world);
  },

  persistence,
};

export function resetMonstersState(): void {
  tickCount = 0;
  resetSummoning();
}

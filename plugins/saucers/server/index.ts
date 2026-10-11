import type {
  Player,
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { interpolateByDifficulty } from '../../../server/src/plugins/kit/difficultyCurve.ts';
import {
  MAX_LASER_BOLTS,
  SAUCERS_CRASHED_EVENT,
  SAUCERS_PLUGIN_NAME,
  SAUCERS_STATE_MESSAGE,
  type CrashState,
  type LaserBolt,
  type SaucerState,
  roundBroadcastPosition,
} from '../protocol.ts';
import {
  advanceEncounter,
  encounterBolts,
  encounterCrashes,
  encounterSaucers,
  forceEncounterNear,
  hasEncounter,
  resetEncounter,
  trySpawnEncounter,
  type EncounterKind,
  type EncounterStart,
} from './encounter.ts';
import { clearFireBridge, loadFireBridge, resetFireBridge } from './fire-bridge.ts';
import {
  clearStructuresBridge,
  loadStructuresBridge,
  resetStructuresBridge,
} from './structures-bridge.ts';
import { resetEncounterSeeds, rollEncounter } from './rng.ts';
import { ADMIN_SEARCH_RADIUS_CELLS } from './site.ts';

export const ENCOUNTER_MEAN_INTERVAL_AT_EASIEST_SECONDS = 300;
export const ENCOUNTER_MEAN_INTERVAL_AT_HARDEST_SECONDS = 180;

export const FLYBY_MEAN_INTERVAL_AT_EASIEST_SECONDS = ENCOUNTER_MEAN_INTERVAL_AT_EASIEST_SECONDS / 2;
export const FLYBY_MEAN_INTERVAL_AT_HARDEST_SECONDS = ENCOUNTER_MEAN_INTERVAL_AT_HARDEST_SECONDS / 2;

export function meanEncounterIntervalSeconds(difficulty: number): number {
  return interpolateByDifficulty(
    ENCOUNTER_MEAN_INTERVAL_AT_EASIEST_SECONDS,
    ENCOUNTER_MEAN_INTERVAL_AT_HARDEST_SECONDS,
    difficulty,
  );
}

export function meanFlybyIntervalSeconds(difficulty: number): number {
  return interpolateByDifficulty(
    FLYBY_MEAN_INTERVAL_AT_EASIEST_SECONDS,
    FLYBY_MEAN_INTERVAL_AT_HARDEST_SECONDS,
    difficulty,
  );
}

export const BROADCAST_TICK_INTERVAL = 1;

export { SAUCERS_CRASHED_EVENT };

export { MAX_LASER_BOLTS };

let tickCount = 0;

let broadcastPending = false;

type VisibleItem =
  | { readonly kind: 'saucer'; readonly saucer: SaucerState; readonly x: number; readonly y: number }
  | { readonly kind: 'bolt'; readonly bolt: LaserBolt; readonly x: number; readonly y: number }
  | { readonly kind: 'crash'; readonly crash: CrashState; readonly x: number; readonly y: number };

function visibleItems(): VisibleItem[] {
  const items: VisibleItem[] = [];
  const saucers = encounterSaucers();

  for (const saucer of saucers) {
    const x = roundBroadcastPosition(saucer.x);
    const y = roundBroadcastPosition(saucer.y);
    items.push({
      kind: 'saucer',
      saucer: {
        id: saucer.id,
        variant: saucer.variant,
        x,
        y,
        alt: roundBroadcastPosition(saucer.alt),
        heading: roundBroadcastPosition(saucer.heading),
        speed: roundBroadcastPosition(saucer.speed),
        phase: saucer.phase,
        hp: saucer.hp,
      },
      x,
      y,
    });
  }

  for (const bolt of encounterBolts()) {
    const shooter = saucers.find((saucer) => saucer.id === bolt.from);
    if (shooter === undefined) continue;
    items.push({
      kind: 'bolt',
      bolt: {
        from: bolt.from,
        to: bolt.to,
        x: roundBroadcastPosition(bolt.x),
        y: roundBroadcastPosition(bolt.y),
        alt: roundBroadcastPosition(bolt.alt),
        aimX: roundBroadcastPosition(bolt.aimX),
        aimY: roundBroadcastPosition(bolt.aimY),
        aimAlt: roundBroadcastPosition(bolt.aimAlt),
        age: roundBroadcastPosition(bolt.age),
      },
      x: roundBroadcastPosition(shooter.x),
      y: roundBroadcastPosition(shooter.y),
    });
  }

  for (const crash of encounterCrashes()) {
    items.push({
      kind: 'crash',
      crash: {
        id: crash.id,
        x: crash.x,
        y: crash.y,
        water: crash.water,
        age: roundBroadcastPosition(crash.age),
      },
      x: crash.x,
      y: crash.y,
    });
  }

  return items;
}

function broadcastState(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    SAUCERS_STATE_MESSAGE,
    visibleItems(),
    (item) => ({ x: item.x, y: item.y }),
    (visible) => {
      const saucers: SaucerState[] = [];
      const lasers: LaserBolt[] = [];
      const crashes: CrashState[] = [];
      for (const item of visible) {
        if (item.kind === 'saucer') saucers.push(item.saucer);
        else if (item.kind === 'bolt') lasers.push(item.bolt);
        else crashes.push(item.crash);
      }
      return { saucers, lasers, crashes };
    },
    { skipEmpty: false, onlyPlayerId },
  );
}

function rollArrival(world: WorldApi, dt: number): void {
  if (hasEncounter()) return;
  if (rollEncounter(1 / meanEncounterIntervalSeconds(world.difficulty), dt)) {
    logArrival(trySpawnEncounter(world, 'dogfight'));
  }
  if (hasEncounter()) return;
  if (rollEncounter(1 / meanFlybyIntervalSeconds(world.difficulty), dt)) {
    logArrival(trySpawnEncounter(world, 'flyby'));
  }
}

function logArrival(started: EncounterStart | null): void {
  if (started === null) return;
  console.info(
    `[${SAUCERS_PLUGIN_NAME}] ${describeStart(started)} came in over the map ` +
      `(encounter seed 0x${(started.seed >>> 0).toString(16)})`,
  );
}

function describeStart(started: EncounterStart): string {
  return started.kind === 'flyby'
    ? `a fly-by of ${started.saucers} saucers`
    : `${started.saucers} saucers in ${started.factions} factions`;
}

function simulate(world: WorldApi, dt: number): void {
  tickCount++;

  rollArrival(world, dt);

  const tick = advanceEncounter(world, dt);
  for (const crash of tick.crashed) {
    world.emitEvent(SAUCERS_CRASHED_EVENT, { x: crash.x, y: crash.y, water: crash.water });
    console.info(
      `[${SAUCERS_PLUGIN_NAME}] a saucer went ${crash.water ? 'into the sea' : 'down'} at (${crash.x}, ${crash.y})`,
    );
  }

  if (tick.changed) broadcastPending = true;
  if (tickCount % BROADCAST_TICK_INTERVAL === 0 && broadcastPending) {
    broadcastPending = false;
    broadcastState(world);
  }
}

function resetSessionState(): void {
  tickCount = 0;
  broadcastPending = false;
  resetEncounter();
  clearFireBridge();
  clearStructuresBridge();
}

function actionKind(key: string): EncounterKind | null {
  return key === 'dogfight' || key === 'flyby' ? key : null;
}

export const plugin: TerracePlugin = {
  name: SAUCERS_PLUGIN_NAME,

  archetype: 'visitors',
  actions: [
    {
      key: 'dogfight',
      label: 'Start a saucer dogfight',
      description:
        'Rival saucer factions come in over the nearest open land to where you are looking, ' +
        'fight, and every one shot down leaves a burning crater.',
    },
    {
      key: 'flyby',
      label: 'Start a saucer fly-by',
      description:
        'A formation of saucers passes over the nearest open land to where you are looking ' +
        'and leaves. No fight, no craters.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    const kind = actionKind(key);
    if (kind === null) return { ok: false, detail: `no such action "${key}"` };
    if (hasEncounter()) return { ok: false, detail: 'saucers are already in the sky' };

    const started = forceEncounterNear(world, kind, site);
    if (started === null) {
      return {
        ok: false,
        detail:
          `no open, unlocked land clear of towns within ${ADMIN_SEARCH_RADIUS_CELLS} cells of ` +
          `(${site.x}, ${site.y}) big enough for an arena`,
      };
    }
    broadcastPending = false;
    broadcastState(world);
    return {
      ok: true,
      detail:
        `${describeStart(started)} coming in over ` +
        `(${started.site.centreX}, ${started.site.centreY})`,
    };
  },

  onWorldCreate(world: WorldApi): void {
    resetSessionState();
    resetEncounterSeeds();
    loadFireBridge(world);
    loadStructuresBridge(world);

    console.info(
      `[${SAUCERS_PLUGIN_NAME}] difficulty ${world.difficulty} → a dogfight every ~${Math.round(
        meanEncounterIntervalSeconds(world.difficulty) / 60,
      )} min, a fly-by every ~${Math.round(meanFlybyIntervalSeconds(world.difficulty) / 60)} min`,
    );
  },

  onWorldClose(): void {
    resetSessionState();
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    broadcastState(world, player.id);
  },
};

export function resetSaucersState(): void {
  resetSessionState();
  resetEncounterSeeds();
  resetFireBridge();
  resetStructuresBridge();
}

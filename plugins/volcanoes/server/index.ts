import type {
  PersistenceSlice,
  PluginActionOutcome,
  PluginActionSite,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import type { CellDiff } from '@terrace/shared';
import {
  VOLCANOES_ALL_MESSAGE,
  VOLCANOES_ACTIVITY_SETTING_KEY,
  VOLCANOES_CHANGES_MESSAGE,
  VOLCANOES_PLUGIN_NAME,
  VOLCANIC_ACTIVITIES,
  DEFAULT_VOLCANIC_ACTIVITY,
  parseActivity,
  type LavaCellState,
  type VentState,
  type VolcanicActivity,
} from '../protocol.ts';
import { igniteLavaCell, loadFireBridge } from './fire-bridge.ts';
import { isLavaExposed, isSiteClear, MAX_VENTS_PER_WORLD } from './siting.ts';
import { loadVolcanoes, saveVolcanoes, VOLCANOES_SLICE_VERSION } from './persistence.ts';
import {
  advanceVolcanoes,
  drainPendingConeSculpts,
  forceEruption,
  forgetLavaAt,
  GENESIS_CONE_BANDS,
  isSelfSculpting,
  lavaStates,
  nearestVent,
  openVent,
  resetVolcanoes,
  rollSpontaneousBirth,
  seedGenesisVents,
  ventCount,
  ventSites,
  ventStates,
} from './vents.ts';

export const KEEPALIVE_TICK_INTERVAL = 600;

const ERUPT_ACTION = 'erupt';
const VENT_ACTION = 'vent';

export const ERUPTION_EVENT = 'eruption';
export const QUIET_EVENT = 'quiet';
export const LAVA_EVENT = 'lava';

let tickCount = 0;

let activity: VolcanicActivity = DEFAULT_VOLCANIC_ACTIVITY;

const pendingDugSites = new Set<number>();

function siteKey(x: number, y: number): number {
  return y * 0x10000 + x;
}

function resetSessionState(): void {
  tickCount = 0;
  activity = DEFAULT_VOLCANIC_ACTIVITY;
  pendingDugSites.clear();
  resetVolcanoes();
}

type VisibleItem =
  | { readonly kind: 'vent'; readonly vent: VentState }
  | { readonly kind: 'molten'; readonly cell: LavaCellState }
  | { readonly kind: 'forgotten'; readonly cell: { x: number; y: number } };

function positionOf(item: VisibleItem): { x: number; y: number } {
  if (item.kind === 'vent') return { x: item.vent.x, y: item.vent.y };
  return { x: item.cell.x, y: item.cell.y };
}

function broadcastAll(world: WorldApi, onlyPlayerId?: string): void {
  const items: VisibleItem[] = [
    ...ventStates().map((vent) => ({ kind: 'vent', vent }) as const),
    ...lavaStates().map((cell) => ({ kind: 'molten', cell }) as const),
  ];

  world.broadcastVisible(
    VOLCANOES_ALL_MESSAGE,
    items,
    positionOf,
    (visible) => ({
      vents: visible.filter((item) => item.kind === 'vent').map((item) => item.vent),
      lava: visible.filter((item) => item.kind === 'molten').map((item) => item.cell),
    }),
    { skipEmpty: false, onlyPlayerId },
  );
}

function broadcastChanges(
  world: WorldApi,
  vents: readonly VentState[],
  molten: readonly LavaCellState[],
  forgotten: ReadonlyArray<{ x: number; y: number }>,
): void {
  const items: VisibleItem[] = [
    ...vents.map((vent) => ({ kind: 'vent', vent }) as const),
    ...molten.map((cell) => ({ kind: 'molten', cell }) as const),
    ...forgotten.map((cell) => ({ kind: 'forgotten', cell }) as const),
  ];

  world.broadcastVisible(
    VOLCANOES_CHANGES_MESSAGE,
    items,
    positionOf,
    (visible) => ({
      vents: visible.filter((item) => item.kind === 'vent').map((item) => item.vent),
      molten: visible.filter((item) => item.kind === 'molten').map((item) => item.cell),
      forgotten: visible.filter((item) => item.kind === 'forgotten').map((item) => item.cell),
    }),
    { skipEmpty: true },
  );
}

function openDugVents(world: WorldApi): boolean {
  if (pendingDugSites.size === 0) return false;

  let opened = false;
  for (const key of pendingDugSites) {
    const x = key % 0x10000;
    const y = Math.floor(key / 0x10000);
    if (ventCount() >= MAX_VENTS_PER_WORLD) break;
    if (!isLavaExposed(world.heightAt(x, y))) continue;
    if (!isSiteClear({ x, y }, ventSites())) continue;
    if (openVent(world, x, y, GENESIS_CONE_BANDS, 'deferred') !== null) opened = true;
  }
  pendingDugSites.clear();
  return opened;
}

function simulate(world: WorldApi, dt: number): void {
  tickCount++;

  let ventsChanged = openDugVents(world);

  if (activity === 'active' && rollSpontaneousBirth(world, dt) !== null) {
    ventsChanged = true;
  }

  const tick = advanceVolcanoes(world, dt, activity === 'active');
  ventsChanged = ventsChanged || tick.ventsChanged;

  for (const vent of tick.erupted) {
    world.emitEvent(ERUPTION_EVENT, { ventId: vent.id, x: vent.x, y: vent.y });
  }
  for (const vent of tick.quieted) {
    world.emitEvent(QUIET_EVENT, { ventId: vent.id, x: vent.x, y: vent.y });
  }

  if (tick.molten.length > 0) {
    world.emitEvent(LAVA_EVENT, {
      cells: tick.molten.map((cell) => ({ x: cell.x, y: cell.y })),
    });
    for (const cell of tick.molten) igniteLavaCell(cell.x, cell.y);
  }

  if (ventsChanged || tick.molten.length > 0 || tick.forgotten.length > 0) {
    broadcastChanges(world, ventStates(), tick.molten, tick.forgotten);
  }

  if (tickCount % KEEPALIVE_TICK_INTERVAL === 0) broadcastAll(world);
}

const persistence: PersistenceSlice = {
  version: VOLCANOES_SLICE_VERSION,
  save(): unknown {
    return saveVolcanoes();
  },
  load(data: unknown): void {
    loadVolcanoes(data);
  },
};

export const plugin: TerracePlugin = {
  name: VOLCANOES_PLUGIN_NAME,

  settings: [
    {
      key: VOLCANOES_ACTIVITY_SETTING_KEY,
      values: VOLCANIC_ACTIVITIES,
      defaultValue: DEFAULT_VOLCANIC_ACTIVITY,
    },
  ],

  archetype: 'terrain',
  actions: [
    {
      key: ERUPT_ACTION,
      label: 'Erupt the nearest volcano',
      description: 'The vent closest to where you are looking erupts now: the cone grows and a lava front runs downhill for a minute.',
    },
    {
      key: VENT_ACTION,
      label: 'Open a vent here',
      description: 'Raises a new cone with a dormant vent at the cell you are looking at, on revealed ground clear of other vents.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key === ERUPT_ACTION) {
      const vent = nearestVent(site.x, site.y);
      if (vent === null) return { ok: false, detail: 'this world has no vent — open one first' };
      if (!forceEruption(vent, world)) {
        return { ok: false, detail: `vent ${vent.id} at (${vent.x}, ${vent.y}) is already erupting` };
      }
      world.emitEvent(ERUPTION_EVENT, { ventId: vent.id, x: vent.x, y: vent.y });
      broadcastChanges(world, ventStates(), [], []);
      return { ok: true, detail: `vent ${vent.id} at (${vent.x}, ${vent.y}) is erupting` };
    }
    if (key === VENT_ACTION) {
      if (!world.isCellUnlocked(site.x, site.y)) {
        return { ok: false, detail: `(${site.x}, ${site.y}) is not revealed — nothing may sculpt fog` };
      }
      if (ventCount() >= MAX_VENTS_PER_WORLD) {
        return { ok: false, detail: `this world already has its ${MAX_VENTS_PER_WORLD} vents` };
      }
      const vent = openVent(world, site.x, site.y, GENESIS_CONE_BANDS, 'deferred');
      if (vent === null) {
        return { ok: false, detail: `(${site.x}, ${site.y}) is too close to another vent` };
      }
      broadcastChanges(world, ventStates(), [], []);
      return { ok: true, detail: `vent ${vent.id} opened at (${site.x}, ${site.y}); its cone rises over the next ticks` };
    }
    return { ok: false, detail: `no such action "${key}"` };
  },

  onWorldCreate(world: WorldApi): void {
    resetSessionState();
    activity = parseActivity(world.setting(VOLCANOES_ACTIVITY_SETTING_KEY));
    loadFireBridge(world);

    if (activity === 'none') return;
    const created = seedGenesisVents(world);
    if (created.length > 0) {
      console.info(
        `[volcanoes] sited ${created.length} vent(s) at genesis (activity: ${activity})`,
      );
    }
  },

  onWorldClose(): void {
    resetSessionState();
  },

  onTick(world: WorldApi, dt: number): void {
    drainPendingConeSculpts(world);

    if (activity === 'none') return;
    simulate(world, dt);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    if (activity === 'none') return;

    if (!isSelfSculpting()) {
      const forgotten = forgetLavaAt(diff);
      if (forgotten.length > 0) broadcastChanges(world, ventStates(), [], forgotten);
    }

    if (ventCount() >= MAX_VENTS_PER_WORLD) return;

    for (const cell of diff) {
      if (!isLavaExposed(cell.h)) continue;
      pendingDugSites.add(siteKey(cell.x, cell.y));
    }
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    if (activity === 'none') return;
    broadcastAll(world, player.id);
  },

  persistence,
};

export function resetVolcanoesState(): void {
  resetSessionState();
}

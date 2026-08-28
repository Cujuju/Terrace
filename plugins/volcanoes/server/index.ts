// volcanoes — cones, eruptions and lava flows, as a plugin (issue #214).
//
// Core knows nothing about volcanoes, and the design record is explicit that it
// must not: the Deep Strata decision (docs/DESIGN.md, 2026-08-19) shipped the
// basalt/obsidian/lava stack into core and closed with "Hazards are NOT core.
// Heat, eruptions, anything gamey in the deep is a future plugin reading these
// same boundary constants." This is that plugin. It reads MIN_HEIGHT and
// DEEP_LAVA_DEPTH (./siting.ts) and nothing else about the strata.
//
// SHAPE OF THE TICK:
//   1. any vent a player DUG open last tick is opened (see THE DEFERRED BIRTH);
//   2. the world rolls its rare spontaneous birth, under `active` only;
//   3. every vent advances — dormancy, eruption, front (./vents.ts);
//   4. newly molten cells are handed to fire, and announced as world events;
//   5. clients are told, on the cadence.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONLY THING IT WRITES TO THE WORLD IS `sculpt`.
//
// Cones and flows are ordinary terrain edits through the authoritative path,
// which is issue #214's own constraint ("terrain changes only via
// WorldApi.sculpt") and the reason a volcano needs no core support at all: the
// heights it writes are relaxed, diffed, mask-filtered and persisted by exactly
// the machinery a player's click goes through. It never denies an intent, never
// unlocks a chunk, and never writes a raw height — it could not if it wanted to.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFERRED BIRTH, and why a dug vent is not opened where it is noticed.
//
// Birth route 3 (./siting.ts) fires from `onTerrainChanged`, which is called
// from inside a sculpt. Opening the vent there would call `sculpt` again — a
// whole cone of it — from inside that same call, recursively, on a hook the
// host only guards against runaway depth rather than against being re-entered
// at all. So the cell is REMEMBERED and the vent is opened at the top of the
// next tick, where a sculpt is an ordinary thing to do. It costs one tick of
// latency on a mechanic whose unit of time is an eruption.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT REACTS TO AN ERUPTION, AND WHAT THIS PLUGIN DOES ABOUT IT.
//
// Fire is wired directly, because fire publishes a server-side entry point and
// this plugin is one more cause of fire (./fire-bridge.ts). Everything else
// issue #214 lists — flora and structures destroyed, wildlife and pilgrims
// fleeing, weather dimming the sky with ash, the chronicle recording it — is
// reached the way plugins always reach each other: this plugin EMITS, and a
// consumer subscribes by name and validates structurally. No consumer for these
// events exists yet; they are the seam those follow-ups attach to, and emitting
// them costs one fan-out per eruption.

import type {
  PersistenceSlice,
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
  GENESIS_CONE_BANDS,
  lavaStates,
  openVent,
  resetVolcanoes,
  rollSpontaneousBirth,
  seedGenesisVents,
  ventCount,
  ventSites,
  ventStates,
} from './vents.ts';

/**
 * Ticks between the FULL-STATE keepalive — 600 → once every 60 s at the shipped
 * TICK_HZ of 10.
 *
 * A REPAIR CADENCE, NOT A SYNC MECHANISM, and the distinction is flora's and
 * structures' (see either plugin's header). Clients are kept current by the
 * delta stream; this exists so that a client which missed a delta — a dropped
 * message, a reconnect that raced the join snapshot — converges within a minute
 * instead of holding a wrong flow until the next eruption.
 */
export const KEEPALIVE_TICK_INTERVAL = 600;

/** Events this plugin emits. Namespaced `volcanoes:` by the host. */
export const ERUPTION_EVENT = 'eruption';
export const QUIET_EVENT = 'quiet';
export const LAVA_EVENT = 'lava';

let tickCount = 0;

/**
 * The world's setting, read ONCE in onWorldCreate.
 *
 * WorldApi.setting's own instruction: the value is fixed for the life of a
 * session (changing it persists the row and REOPENS the world, which replays
 * restore + worldCreate), so a plugin that re-read it every tick would be
 * reading a value that cannot move at a cost that can.
 */
let activity: VolcanicActivity = DEFAULT_VOLCANIC_ACTIVITY;

/**
 * Cells a sculpt exposed the lava band in, waiting for the next tick — see THE
 * DEFERRED BIRTH above.
 *
 * A SET, so a single stroke that bottoms out a dozen cells against the floor
 * (which one Quake does) proposes each site once rather than a dozen times; the
 * separation rule in ./siting.ts then rejects all but the first of them anyway,
 * and doing that against a set is a handful of comparisons rather than a
 * hundred.
 */
const pendingDugSites = new Set<number>();

/** Packs a cell for `pendingDugSites`. The world edge is well under 2^16. */
function siteKey(x: number, y: number): number {
  return y * 0x10000 + x;
}

function resetSessionState(): void {
  tickCount = 0;
  activity = DEFAULT_VOLCANIC_ACTIVITY;
  pendingDugSites.clear();
  resetVolcanoes();
}

/**
 * One item in a fog-of-war broadcast. Categories travel TAGGED and are
 * re-partitioned inside buildPayload — WorldApi.broadcastVisible's own
 * instruction for a message with more than one item category, and the shape
 * flora's grown/felled delta already uses.
 */
type VisibleItem =
  | { readonly kind: 'vent'; readonly vent: VentState }
  | { readonly kind: 'molten'; readonly cell: LavaCellState }
  | { readonly kind: 'forgotten'; readonly cell: { x: number; y: number } };

function positionOf(item: VisibleItem): { x: number; y: number } {
  if (item.kind === 'vent') return { x: item.vent.x, y: item.vent.y };
  return { x: item.cell.x, y: item.cell.y };
}

/**
 * Sends the complete state to one player (a join) or to everyone (the
 * keepalive).
 *
 * `skipEmpty: false` — a FULL-STATE REPLACE message, so a recipient whose
 * filtered subset is empty must still be sent the empty list. That is the only
 * way a client learns the flow it could see is gone; omitting the send would
 * leave its last non-empty payload standing forever.
 */
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

/**
 * Sends one delta.
 *
 * `skipEmpty: true` — safe for exactly the reason WorldApi.broadcastVisible
 * gives for flora's and structures' deltas: per-player masks only ever GROW, so
 * a position invisible to a player right now was equally invisible whenever it
 * last changed, and there is nothing an empty send could have corrected. The
 * `forgotten` list is a removal, which is the case that looks like it breaks
 * the rule and does not: a cell a player cannot see is a cell they were never
 * told about, so there is nothing of theirs to remove.
 */
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

/** Opens whatever a player's digging exposed last tick. See THE DEFERRED BIRTH. */
function openDugVents(world: WorldApi): boolean {
  if (pendingDugSites.size === 0) return false;

  let opened = false;
  for (const key of pendingDugSites) {
    const x = key % 0x10000;
    const y = Math.floor(key / 0x10000);
    if (ventCount() >= MAX_VENTS_PER_WORLD) break;
    // Re-checked HERE and not only when it was noticed: the terrain may have
    // been filled back in during the intervening tick, and a vent opened in
    // ground that is no longer showing lava is a vent nothing justifies.
    if (!isLavaExposed(world.heightAt(x, y))) continue;
    if (!isSiteClear({ x, y }, ventSites())) continue;
    if (openVent(world, x, y, GENESIS_CONE_BANDS) !== null) opened = true;
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
    // Announced as ONE event carrying the tick's cells, not one per cell: a
    // consumer's question is "what did the lava reach", and a fan-out per cell
    // would run every installed plugin's onWorldEvent up to
    // FLOW_SPEED_CELLS_PER_SECOND times a second for the whole eruption.
    world.emitEvent(LAVA_EVENT, {
      cells: tick.molten.map((cell) => ({ x: cell.x, y: cell.y })),
    });
    // Fire is called rather than notified, because fire owns the one entry
    // point every cause of fire goes through (./fire-bridge.ts).
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

  onWorldCreate(world: WorldApi): void {
    resetSessionState();
    activity = parseActivity(world.setting(VOLCANOES_ACTIVITY_SETTING_KEY));
    loadFireBridge(world);

    // The snapshot has already been restored by the time this runs, so `seeded`
    // is either false (a fresh world) or true (a restored one) and the siting
    // below happens exactly once per world however many times this replays.
    if (activity === 'none') return;
    const created = seedGenesisVents(world);
    if (created.length > 0) {
      console.info(
        `[volcanoes] sited ${created.length} vent(s) at genesis (activity: ${activity})`,
      );
    }
  },

  onWorldClose(): void {
    // The plugin holds no WorldApi at module scope, so there is nothing to
    // release — but its sim state belongs to the world that is closing, and
    // leaving it standing would hand the next world this one's mountains.
    resetSessionState();
  },

  onTick(world: WorldApi, dt: number): void {
    if (activity === 'none') return;
    simulate(world, dt);
  },

  onTerrainChanged(_world: WorldApi, diff: readonly CellDiff[]): void {
    // BIRTH ROUTE 3 — a dig that reaches core's lava band opens a vent. Under
    // `dormant` as much as `active`: siting a vent is geology, and only
    // erupting is an event (./siting.ts's header).
    if (activity === 'none') return;
    if (ventCount() >= MAX_VENTS_PER_WORLD) return;

    for (const cell of diff) {
      if (!isLavaExposed(cell.h)) continue;
      // Deferred rather than opened here — see THE DEFERRED BIRTH. The
      // separation check runs at that point too; doing it now would only
      // duplicate it, since the set may hold several cells of one stroke.
      pendingDugSites.add(siteKey(cell.x, cell.y));
    }
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    if (activity === 'none') return;
    broadcastAll(world, player.id);
  },

  persistence,
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetVolcanoesState(): void {
  resetSessionState();
}

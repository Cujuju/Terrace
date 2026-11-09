import assert from 'node:assert/strict';
import {
  BAND_HEIGHT, CHUNK_SIZE, MAX_STEP, NO_FRESHWATER, chunkIndex, createChunkMask,
  createHeightmap, unlockChunk, type FreshwaterMap,
} from '@terrace/shared';
import type { Player } from '../../../server/src/player.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { createWorldApi } from '../../../server/src/plugins/world-api.ts';
import { World } from '../../../server/src/world/world.ts';
import { RecordingSink, asLoadedPlugin, asLoadedPluginExporting } from '../../../server/test/support/harness.ts';
import { GENESIS_CONE_BANDS, LAVA_COOL_SECONDS, lavaKey, parseAllPayload, parseChangesPayload, type VolcanicActivity } from '../protocol.ts';
import { plugin, resetVolcanoesState } from '../server/index.ts';
import { loadVolcanoes } from '../server/persistence.ts';
import { LAVA_BAND_CEILING } from '../server/siting.ts';
import { MAX_TRACKED_FLOW_CELLS } from '../server/flow.ts';
import {
  ERUPTION_SECONDS, advanceVolcanoes, forceEruption, lavaStates, openVent,
  ventStates, volcanoSnapshot, type VolcanoSnapshot,
} from '../server/vents.ts';

const WORLD_SIZE = 448;
const SLOPE_START_HEIGHT = 900;
const DT = 0.1;
const SITE = { x: 80, y: 80 };
const OWNER: Player = { id: 'owner', token: 'owner-token', name: 'Owner' };
const OWNER_TAB: Player = { ...OWNER, id: 'owner-tab' };
const OTHER: Player = { id: 'other', token: 'other-token', name: 'Other' };

function emptySnapshot(): VolcanoSnapshot {
  return { seeded: true, nextVentId: 1, rngState: 123, vents: [], lava: [], pendingConeSculpts: [] };
}

function boot(activity: VolcanicActivity, saved: unknown = emptySnapshot(), ownerMask?: Uint8Array) {
  resetVolcanoesState();
  const map = createHeightmap(WORLD_SIZE);
  for (let y = 0; y < WORLD_SIZE; y++) for (let x = 0; x < WORLD_SIZE; x++) {
    map.cells[y * WORLD_SIZE + x] = Math.max(BAND_HEIGHT, SLOPE_START_HEIGHT - MAX_STEP * x);
  }
  const mask = createChunkMask(WORLD_SIZE);
  for (let cy = 0; cy < WORLD_SIZE / CHUNK_SIZE; cy++) for (let cx = 0; cx < WORLD_SIZE / CHUNK_SIZE; cx++) {
    unlockChunk(mask, chunkIndex(WORLD_SIZE, cx, cy));
  }
  const tokens = new Map([[OWNER.token, ownerMask ?? mask], [OTHER.token, mask]]);
  const world = World.restore(WORLD_SIZE, map.cells, mask, 1, 'Volcano contracts', tokens);
  world.freshwaterMap = () => NO_FRESHWATER;
  for (const player of [OWNER, OWNER_TAB, OTHER]) world.addPlayer(player);
  const sink = new RecordingSink();
  world.setSink(sink);
  const ignited: Array<{ x: number; y: number }> = [];
  const events: Array<{ type: string; payload: unknown }> = [];
  const host = new PluginHost(world, [
    asLoadedPlugin(plugin),
    asLoadedPluginExporting({ name: 'fire' }, {
      igniteAt(x: number, y: number): boolean { ignited.push({ x, y }); return true; },
    }),
    asLoadedPlugin({ name: 'probe', onWorldEvent: (_world, type, payload) => events.push({ type, payload }) }),
  ], undefined, { volcanoes: { activity } });
  host.restorePersistence({ volcanoes: { v: 1, data: saved } });
  host.worldCreate();
  const binding = createWorldApi(world, host, 'volcanoes', { activity });
  return {
    world, host, api: binding.api, sink, ignited, events,
    close(): void { host.closeWorld(); binding.revoke(); host.revokeApis(); },
  };
}

export function refusesUnreadableSnapshots(): void {
  const valid: VolcanoSnapshot = {
    ...emptySnapshot(), nextVentId: 2,
    vents: [{ id: 1, ...SITE, erupting: false, phaseSeconds: 120, coneBands: GENESIS_CONE_BANDS }],
    lava: [{ x: SITE.x + 1, y: SITE.y, ageSeconds: LAVA_COOL_SECONDS }],
  };
  const h = boot('none', valid);
  try {
    const malformed = { ...valid, pendingConeSculpts: [{ x: 'invalid', y: SITE.y, radius: 1, amount: 1 }] };
    assert.equal(loadVolcanoes(malformed), false);
    assert.deepEqual(volcanoSnapshot(), valid);
    const envelope = { v: 1, data: malformed };
    h.host.restorePersistence({ volcanoes: envelope });
    assert.equal(h.host.isSliceParked('volcanoes'), true);
    assert.deepEqual(h.host.collectPersistence().volcanoes, envelope);
    const { pendingConeSculpts: _legacyAbsent, ...legacy } = valid;
    h.host.restorePersistence({ volcanoes: legacy });
    assert.equal(h.host.isSliceParked('volcanoes'), false);
    assert.deepEqual(volcanoSnapshot(), valid);
  } finally { h.close(); }
}

export function announcesReheatedCells(): void {
  const h = boot('none');
  try {
    assert(openVent(h.api, SITE.x, SITE.y, GENESIS_CONE_BANDS, 'immediate'));
    let reheated = 0;
    const ERUPTIONS_TO_REVISIT_FLOW = 4;
    for (let eruption = 0; eruption < ERUPTIONS_TO_REVISIT_FLOW; eruption++) {
      const action = h.host.invokeAction('volcanoes', 'erupt', SITE);
      assert(typeof action === 'object' && action.ok);
      for (let tick = 0; tick <= Math.ceil(ERUPTION_SECONDS / DT); tick++) {
        const before = new Map(lavaStates().map(cell => [lavaKey(cell.x, cell.y), cell.ageSeconds]));
        h.sink.clear(); h.events.length = 0; h.ignited.length = 0;
        h.host.tick(DT);
        for (const cell of lavaStates()) {
          if ((before.get(lavaKey(cell.x, cell.y)) ?? 0) < LAVA_COOL_SECONDS || cell.ageSeconds > DT) continue;
          reheated++;
          const deltas = h.sink.ofType('volcanoes:changes').map(message => parseChangesPayload(message.payload));
          assert(deltas.some(delta => delta?.molten.some(one => one.x === cell.x && one.y === cell.y && one.ageSeconds === 0)));
          assert.deepEqual(h.events.find(event => event.type === 'volcanoes:lava')?.payload, { cells: [{ x: cell.x, y: cell.y }] });
          assert(h.ignited.some(one => one.x === cell.x && one.y === cell.y));
        }
      }
      for (let tick = 0; tick < Math.ceil((LAVA_COOL_SECONDS + DT) / DT); tick++) {
        h.sink.clear(); h.host.tick(DT);
      }
    }
    assert(reheated > 0, 'fixture must revisit cooled lava');
  } finally { h.close(); }
}

export function followsCurrentFreshwater(): void {
  for (const waterArrives of [true, false]) {
    const h = boot('none');
    try {
      const pool: FreshwaterMap = { at: () => 'pool' };
      let currentWater = waterArrives ? NO_FRESHWATER : pool;
      h.world.freshwaterMap = () => currentWater;
      const vent = openVent(h.api, SITE.x, SITE.y, GENESIS_CONE_BANDS, 'immediate');
      assert(vent);
      assert(forceEruption(vent, h.api));
      currentWater = waterArrives ? pool : NO_FRESHWATER;
      const tick = advanceVolcanoes(h.api, 0.5, false);
      assert.equal(tick.molten.length, waterArrives ? 0 : 1);
    } finally { h.close(); }
  }
}

export function keepsEvictedReheatsOutOfStateDeltas(): void {
  const oldCell = { x: SITE.x + 1, y: SITE.y - 1, ageSeconds: LAVA_COOL_SECONDS };
  const otherSite = { x: 200, y: SITE.y };
  const saved: VolcanoSnapshot = {
    ...emptySnapshot(), nextVentId: 3,
    vents: [SITE, otherSite].map((site, index) => ({
      id: index + 1, ...site, erupting: false, phaseSeconds: 120, coneBands: GENESIS_CONE_BANDS,
    })),
    lava: [oldCell, ...Array.from({ length: MAX_TRACKED_FLOW_CELLS - 1 }, (_, x) => ({ x, y: 300, ageSeconds: LAVA_COOL_SECONDS }))],
  };
  const h = boot('none', saved);
  try {
    for (const site of [SITE, otherSite]) {
      const outcome = h.host.invokeAction('volcanoes', 'erupt', site);
      assert(typeof outcome === 'object' && outcome.ok);
    }
    h.sink.clear();
    h.host.tick(0.5);
    assert(h.ignited.some(cell => cell.x === oldCell.x && cell.y === oldCell.y), JSON.stringify(h.ignited));
    assert(!lavaStates().some(cell => cell.x === oldCell.x && cell.y === oldCell.y));
    const deltas = h.sink.ofType('volcanoes:changes').map(message => parseChangesPayload(message.payload));
    assert(deltas.some(delta => delta?.forgotten.some(cell => cell.x === oldCell.x && cell.y === oldCell.y)));
    assert(deltas.every(delta => delta?.molten.every(cell => cell.x !== oldCell.x || cell.y !== oldCell.y)));
  } finally { h.close(); }
}

export function replaysVisibleStateOnUnlock(): void {
  const initialMask = createChunkMask(WORLD_SIZE);
  unlockChunk(initialMask, chunkIndex(WORLD_SIZE, 0, 0));
  const oldCell = { x: 8, y: 8, ageSeconds: LAVA_COOL_SECONDS };
  const newCell = { x: 2 * CHUNK_SIZE + 1, y: 2 * CHUNK_SIZE, ageSeconds: LAVA_COOL_SECONDS };
  const h = boot('none', { ...emptySnapshot(), lava: [oldCell, newCell] }, initialMask);
  try {
    h.host.playerJoined(OWNER);
    const initial = parseAllPayload(h.sink.ofType('volcanoes:all')[0]!.payload);
    assert.deepEqual(initial?.lava, [oldCell]);
    h.sink.clear();
    assert(h.api.unlockChunkForToken(OWNER.token, 2, 2));
    const replays = h.sink.ofType('volcanoes:all');
    assert.deepEqual(replays.map(message => message.target).sort(), [OWNER.id, OWNER_TAB.id].sort());
    for (const message of replays) assert.deepEqual(parseAllPayload(message.payload)?.lava, [oldCell, newCell]);
    h.sink.clear();
    assert.equal(h.api.unlockChunkForToken(OWNER.token, 2, 2), false);
    assert.equal(h.sink.ofType('volcanoes:all').length, 0);
  } finally { h.close(); }
}

export function completesManualEruptionsWithNoActivity(): void {
  const h = boot('none');
  try {
    assert.equal(ventStates().length, 0);
    const opened = h.host.invokeAction('volcanoes', 'vent', SITE);
    const erupted = h.host.invokeAction('volcanoes', 'erupt', SITE);
    assert(typeof opened === 'object' && opened.ok);
    assert(typeof erupted === 'object' && erupted.ok);
    for (let tick = 0; tick <= Math.ceil(ERUPTION_SECONDS / DT); tick++) {
      h.sink.clear(); h.host.tick(DT);
    }
    assert(lavaStates().length > 0);
    assert.deepEqual(ventStates().map(vent => vent.erupting), [false]);
    assert.equal(h.events.filter(event => event.type === 'volcanoes:quiet').length, 1);
    h.sink.clear(); h.host.playerJoined(OWNER);
    assert((parseAllPayload(h.sink.ofType('volcanoes:all')[0]!.payload)?.lava.length ?? 0) > 0);
    const dug = { x: 200, y: 200, h: LAVA_BAND_CEILING };
    h.world.map.cells[dug.y * WORLD_SIZE + dug.x] = dug.h;
    h.host.notifyTerrainChanged([dug]);
    for (let tick = 0; tick < Math.ceil(LAVA_COOL_SECONDS / DT); tick++) { h.sink.clear(); h.host.tick(DT); }
    assert.equal(ventStates().length, 1);
    assert(lavaStates().every(cell => cell.ageSeconds >= LAVA_COOL_SECONDS));
  } finally { h.close(); }
}

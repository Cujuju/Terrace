import assert from 'node:assert/strict';
import { CHUNK_SIZE, createChunkMask, createHeightmap, MAX_HEIGHT } from '@terrace/shared';
import { createWorldApi } from '../../../server/src/plugins/world-api.ts';
import { World } from '../../../server/src/world/world.ts';
import { RecordingSink } from '../../../server/test/support/harness.ts';
import { parseSaucersPayload } from '../protocol.ts';
import { plugin } from '../server/index.ts';
import { FlightTerrain } from '../server/flight-terrain.ts';
import { CENTRE, isolated, LAND_HEIGHT, TICK_SECONDS, WORLD_SIZE } from './support.ts';

export function privateTerrain(): void {
  isolated(() => {
    const boundary = 18 * CHUNK_SIZE;
    let reads = 0;
    const terrain = new FlightTerrain();
    terrain.includeCorridor({
      worldSize: WORLD_SIZE,
      isCellUnlocked: (x, y) => x < boundary || y < boundary,
      heightAt: (x, y) => {
        assert(x < boundary || y < boundary, 'locked heights must never be sampled');
        reads++;
        return LAND_HEIGHT;
      },
    }, CENTRE, { x: boundary + CHUNK_SIZE, y: boundary + CHUNK_SIZE });
    assert(reads > 0);
    assert.equal(terrain.visibleTo({ isChunkVisibleTo: () => false }, 'unknown'), false);
  });

  isolated(() => {
    const full = createChunkMask(WORLD_SIZE);
    full.fill(255);
    const partial = full.slice();
    const hiddenChunk = { x: 18, y: 18 };
    const index = hiddenChunk.y * (WORLD_SIZE / CHUNK_SIZE) + hiddenChunk.x;
    partial[index >> 3] &= ~(1 << (index & 7));
    const cells = createHeightmap(WORLD_SIZE).cells;
    cells.fill(LAND_HEIGHT);
    cells[290 * WORLD_SIZE + 290] = MAX_HEIGHT;
    const world = World.restore(WORLD_SIZE, cells, full, 50, 'Visibility audit',
      new Map([['full', full], ['partial', partial]]));
    const completeViewer = { id: 'complete', token: 'full', name: 'Complete' };
    const limitedViewer = { id: 'limited', token: 'partial', name: 'Limited' };
    world.addPlayer(completeViewer);
    world.addPlayer(limitedViewer);
    const sink = new RecordingSink();
    world.setSink(sink);
    const view = createWorldApi(world, {
      notifyTerrainChanged() {}, notifyChunkUnlockedForToken() {}, notifyWorldEvent() {},
    }, 'saucers', undefined, (name) => name === 'structures'
      ? { standingStructures: () => [] } : { igniteAt: () => true });
    plugin.onWorldCreate?.(view.api);
    assert(plugin.onAction?.(view.api, 'flyby', CENTRE).ok);
    for (let tick = 0; tick < 40; tick++) plugin.onTick?.(view.api, TICK_SECONDS);
    const messages = sink.ofType('saucers:state');
    const complete = messages.filter((m) => m.target === completeViewer.id)
      .map((m) => parseSaucersPayload(m.payload));
    assert(complete.some((state) => state?.saucers.some((s) =>
      world.isCellVisibleTo(limitedViewer.id, s.x, s.y))), 'positional filtering alone would disclose altitude');
    const limited = messages.filter((m) => m.target === limitedViewer.id)
      .map((m) => parseSaucersPayload(m.payload));
    assert(limited.length > 0);
    assert(limited.every((state) => state !== null && state.saucers.length === 0 &&
      state.lasers.length === 0 && state.crashes.length === 0));
    world.unlockChunkForToken(limitedViewer.token, hiddenChunk.x, hiddenChunk.y);
    sink.clear();
    plugin.onTick?.(view.api, TICK_SECONDS);
    assert(sink.ofType('saucers:state').some((m) => m.target === limitedViewer.id &&
      (parseSaucersPayload(m.payload)?.saucers.length ?? 0) > 0));
    plugin.onWorldClose?.(view.api);
    sink.clear();
    plugin.onPlayerJoin?.(view.api, limitedViewer);
    assert.equal(parseSaucersPayload(sink.ofType('saucers:state')[0]!.payload)?.saucers.length, 0);
    view.revoke();
  });
}

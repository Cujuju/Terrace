import { beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, NO_FRESHWATER, chunkIndex, createChunkMask, createHeightmap, unlockChunk } from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { createWorldApi } from '../../../server/src/plugins/world-api.ts';
import { World } from '../../../server/src/world/world.ts';
import { RecordingSink, asLoadedPlugin } from '../../../server/test/support/harness.ts';
import { plugin, resetMudslidesState } from '../server/index.ts';
import { loadSlides, saveSlides } from '../server/persistence.ts';
import {
  MAX_TRACKED_SITES,
  MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS,
  advanceSlides,
  isSaturated,
  livingSlides,
  slidesSnapshot,
  soakSites,
  startSlide,
  surveySites,
  trackedSites,
} from '../server/slides.ts';
import { footprintUnlocked, sculptGuarded, type MudslideWorld } from '../server/terrain.ts';

const WORLD_SIZE = 512;
const DT = 0.1;
const MAX_FINISH_TICKS = 1000;
const SURVEY_SECONDS = 5;

function fixture(gradient: number, unlocked = (_cx: number, _cy: number): boolean => true) {
  const map = createHeightmap(WORLD_SIZE);
  const mask = createChunkMask(WORLD_SIZE);
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) map.cells[y * WORLD_SIZE + x] = Math.max(-1000, 800 - gradient * x);
  }
  for (let cy = 0; cy < WORLD_SIZE / CHUNK_SIZE; cy++) {
    for (let cx = 0; cx < WORLD_SIZE / CHUNK_SIZE; cx++) {
      if (unlocked(cx, cy)) unlockChunk(mask, chunkIndex(WORLD_SIZE, cx, cy));
    }
  }
  const world = World.restore(WORLD_SIZE, map.cells, mask, 1, 'Mudslide regression');
  const { api } = createWorldApi(world, {
    notifyTerrainChanged() {},
    notifyChunkUnlockedForToken() {},
    notifyWorldEvent() {},
  }, 'mudslides');
  const terrain: MudslideWorld = {
    worldSize: WORLD_SIZE,
    chunksPerEdge: world.chunksPerEdge,
    freshwater: NO_FRESHWATER,
    heightAt: api.heightAt,
    isCellUnlocked: api.isCellUnlocked,
    isChunkUnlocked: api.isChunkUnlocked,
    sculpt: api.sculpt,
  };
  return { world, api, terrain };
}

function totalHeight(world: World): number {
  return world.heightsForPersistence().reduce((sum, height) => sum + height, 0);
}

function finish(terrain: MudslideWorld): void {
  for (let tick = 0; tick < MAX_FINISH_TICKS && livingSlides().length > 0; tick++) {
    advanceSlides(terrain, DT);
  }
  expect(livingSlides()).toHaveLength(0);
}

beforeEach(resetMudslidesState);

describe('mudslide deposits', () => {
  it('accepts an atomic core refusal when relaxation would leave unlocked terrain', () => {
    const { world, terrain } = fixture(4, (cx) => cx >= 1);
    const before = world.heightsForPersistence().slice();
    expect(footprintUnlocked(terrain, 22, 64, 6)).toBe(true);
    expect(sculptGuarded(terrain, 22, 64, 6, -16).changedCells).toBe(0);
    expect(world.heightsForPersistence()).toEqual(before);
  });

  it('deposits back along the path when its toe reaches the map rim', () => {
    const { world, terrain } = fixture(4);
    const before = totalHeight(world);
    const slide = startSlide(terrain, 32, 64)!;
    expect(slide).not.toBeNull();
    finish(terrain);
    expect(slide.carried).toBeLessThanOrEqual(MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS);
    expect(totalHeight(world) - before).toBe(-slide.carried);
  });

  it('retains mass and successful-dump budget across refusals and persistence', () => {
    const { world, api, terrain } = fixture(4);
    const before = totalHeight(world);
    let refuseDeposits = false;
    terrain.sculpt = (x, y, radius, amount) => api.sculpt(
      x, y, radius, amount, refuseDeposits && amount > 0 ? () => false : undefined,
    );
    const slide = startSlide(terrain, 64, 128)!;
    expect(slide).not.toBeNull();
    for (let tick = 0; tick < 9; tick++) advanceSlides(terrain, DT);
    slide.stop = 'basin';
    refuseDeposits = true;
    const carried = slide.carried;
    const toeSteps = slide.toeSteps;
    const ground = world.heightsForPersistence().slice();
    for (let tick = 0; tick < 40; tick++) advanceSlides(terrain, DT);
    expect(slide.carried).toBe(carried);
    expect(slide.toeSteps).toBe(toeSteps);
    expect(world.heightsForPersistence()).toEqual(ground);
    const saved = structuredClone(saveSlides());
    resetMudslidesState();
    loadSlides(saved);
    const restored = livingSlides()[0]!;
    expect(restored.carried).toBe(carried);
    expect(restored.toeSteps).toBe(toeSteps);
    expect(restored.toeCursor).toBe(slide.toeCursor);
    refuseDeposits = false;
    finish(terrain);
    expect(restored.carried).toBeLessThanOrEqual(MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS);
    expect(totalHeight(world) - before).toBe(-restored.carried);
  });

  it('reads existing slices without a toe search cursor', () => {
    const { terrain } = fixture(4);
    startSlide(terrain, 64, 128);
    const legacy = structuredClone(slidesSnapshot());
    const { toeCursor: _cursor, ...saved } = legacy.slides[0]!;
    resetMudslidesState();
    loadSlides({ ...legacy, slides: [saved] });
    expect(livingSlides()[0]?.toeCursor).toBe(0);
  });
});

describe('bounded site discovery', () => {
  it('replaces dry sites with newly revealed wet hillsides', () => {
    const { world, terrain } = fixture(3, (cx) => cx < 4);
    for (let survey = 0; survey < 30; survey++) surveySites(terrain, SURVEY_SECONDS);
    expect(trackedSites().size).toBe(MAX_TRACKED_SITES);
    expect([...trackedSites().values()].every((site) => site.x < 64)).toBe(true);
    world.mask.fill(255);
    const wetTerrain: MudslideWorld = {
      ...terrain,
      freshwater: { at: (x) => x >= 96 ? 'pool' : 'none' },
    };
    for (let survey = 0; survey < 100; survey++) {
      surveySites(wetTerrain, SURVEY_SECONDS);
      soakSites(SURVEY_SECONDS);
    }
    expect(trackedSites().size).toBe(MAX_TRACKED_SITES);
    expect([...trackedSites().values()].some((site) => site.x >= 96 && isSaturated(site))).toBe(true);
  });

  it('keeps currently wet sites even before their first soaking tick', () => {
    const { world, terrain } = fixture(3, (cx) => cx < 4);
    const wetTerrain: MudslideWorld = { ...terrain, freshwater: { at: () => 'pool' } };
    for (let survey = 0; survey < 30; survey++) surveySites(wetTerrain, SURVEY_SECONDS);
    const keys = [...trackedSites().keys()];
    expect(keys).toHaveLength(MAX_TRACKED_SITES);
    world.mask.fill(255);
    for (let survey = 0; survey < 10; survey++) surveySites(wetTerrain, SURVEY_SECONDS);
    expect([...trackedSites().keys()]).toEqual(keys);
  });
});

it('replays only the newly revealed debris to every session of the unlocking token', () => {
  const { world } = fixture(3);
  const sink = new RecordingSink();
  world.setSink(sink);
  const players = [
    { id: 'one', token: 'target', name: 'One' },
    { id: 'two', token: 'target', name: 'Two' },
    { id: 'other', token: 'other', name: 'Other' },
  ];
  for (const player of players) {
    world.addPlayer(player);
    world.unlockChunkForToken(player.token, 1, 1);
  }
  world.unlockChunkForToken('other', 6, 4);
  const host = new PluginHost(world, [asLoadedPlugin(plugin)]);
  host.restorePersistence({ mudslides: { v: 1, data: {
    ...slidesSnapshot(),
    debris: [{ x: 16, y: 16, depth: 16 }, { x: 100, y: 64, depth: 16 }, { x: 200, y: 200, depth: 16 }],
  } } });
  host.worldCreate();
  for (const player of players) host.playerJoined(player);
  sink.clear();
  const { api } = createWorldApi(world, host, 'reveal');
  expect(api.unlockChunkForToken('target', 6, 4)).toBe(true);
  const messages = sink.ofType('mudslides:debris');
  expect(messages.map((message) => message.target)).toEqual(['one', 'two']);
  for (const message of messages) expect(message.payload).toEqual({ cells: [{ x: 100, y: 64, depth: 16 }] });
  expect(api.unlockChunkForToken('target', 6, 4)).toBe(false);
  expect(sink.ofType('mudslides:debris')).toHaveLength(2);
  host.closeWorld();
  host.revokeApis();
});

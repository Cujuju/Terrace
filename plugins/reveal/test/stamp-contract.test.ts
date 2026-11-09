import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySculpt, bandLevelHeight, chunksPerEdge, createHeightmap, DEFAULT_SCULPT_AMOUNT,
  displacementOf, sculptOptionsOf, snapshotSolidUnits, strokeSolidMeasure, strokeSweep,
  sweepAt, type SculptIntent, type SculptProfile,
} from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { RecordingSink, asLoadedPlugin, asLoadedPluginExporting, worldWithUnlockedChunks } from '../../../server/test/support/harness.ts';
import * as revealModule from '../server/index.ts';
import {
  MANA_CAPACITY, MANA_PER_BAND_CELL, manaBalanceOf, plugin as mana, resetManaState,
} from '../../mana/server/index.ts';
import { CHUNK_UNLOCK_MANA, nominalStrokeCost, strokeChargeCost } from '../../mana/pricing.ts';
import { openedChunkCount } from '../../mana/test/support/chunkPricing.ts';
import { plugin as relics } from '../../relics/server/index.ts';
import { claimWardCells, resetWards, wardedCellCount, wardHolderAgainst } from '../../relics/server/ward.ts';

const SIZE = 128;
const CENTRE = { x: 48, y: 48 };
const FLANK = { x: CENTRE.x + 10, y: CENTRE.y };
const PLAYER = { id: 'sculptor', token: 'stamp-token', name: 'Sculptor' };
const OWNER = 'ward-owner';
const PROFILES: readonly SculptProfile[] = ['soft', 'stepped'];
const TOP_BAND = 8;

function intent(profile: SculptProfile): SculptIntent {
  return { type: 'sculpt', ...CENTRE, radius: 4, dir: 1, tool: 'stamp', profile, seq: 1 };
}

function boot(peak = true) {
  const world = worldWithUnlockedChunks(SIZE, [[3, 3]], undefined, bandLevelHeight(0));
  if (peak) world.map.cells[CENTRE.y * SIZE + CENTRE.x] = bandLevelHeight(TOP_BAND);
  world.setSink(new RecordingSink());
  world.addPlayer(PLAYER);
  world.seedChunkForToken(PLAYER.token, 3, 3);
  const host = new PluginHost(world, [asLoadedPlugin(mana), asLoadedPluginExporting(revealModule.plugin, revealModule)]);
  host.worldCreate();
  host.playerJoined(PLAYER);
  return { world, host };
}

beforeEach(() => { resetManaState(); resetWards(); });

describe('stamp effects share protection and unlock contracts', () => {
  it.each(PROFILES)('refuses %s flanks that reach another player\'s ward', (profile) => {
    const { world } = boot();
    const host = new PluginHost(world, [asLoadedPlugin(relics)]);
    claimWardCells(SIZE, OWNER, [{ ...FLANK, h: bandLevelHeight(0) }]);
    const before = world.map.cells.slice();
    const outcome = handleSculptIntent({ world, interceptors: host }, PLAYER, intent(profile));
    expect(outcome.applied).toBe(false);
    expect(world.map.cells).toEqual(before);
  });

  it.each(PROFILES)('wards exactly the ground a %s stamp changed', (profile) => {
    const map = createHeightmap(SIZE);
    map.cells.fill(bandLevelHeight(0));
    map.cells[CENTRE.y * SIZE + CENTRE.x] = bandLevelHeight(TOP_BAND);
    const stroke = intent(profile);
    const diff = applySculpt(map, stroke.x, stroke.y, stroke.radius, DEFAULT_SCULPT_AMOUNT, sculptOptionsOf(stroke));
    claimWardCells(SIZE, OWNER, diff);
    expect(wardedCellCount()).toBe(diff.length);
    expect(wardHolderAgainst(SIZE, PLAYER.id, sweepAt(FLANK.x, FLANK.y, 1))).toBe(OWNER);
    expect(wardHolderAgainst(SIZE, PLAYER.id, sweepAt(0, 0, 1))).toBeNull();
  });

  it.each(PROFILES)('charges every newly opened %s flank chunk, and only opened chunks', (profile) => {
    for (const peak of [false, true]) {
      const { world, host } = boot(peak);
      const stroke = intent(profile);
      const coreCount = openedChunkCount(SIZE, strokeSweep(stroke), (cx, cy) => world.isChunkUnlockedForToken(PLAYER.token, cx, cy));
      const measure = strokeSolidMeasure('stamp');
      const before = snapshotSolidUnits(world.map, 0, 0, SIZE - 1, SIZE - 1, measure);
      const outcome = handleSculptIntent({ world, interceptors: host }, PLAYER, stroke);
      expect(outcome.applied).toBe(true);
      if (!outcome.applied) throw new Error('stamp was denied');
      let opened = -1;
      const edge = chunksPerEdge(SIZE);
      for (let cy = 0; cy < edge; cy++) {
        for (let cx = 0; cx < edge; cx++) if (world.isChunkUnlockedForToken(PLAYER.token, cx, cy)) opened++;
      }
      if (peak) expect(opened).toBeGreaterThan(coreCount);
      else expect(opened).toBe(coreCount);
      const units = displacementOf(before, world.map, outcome.diff, measure);
      expect(MANA_CAPACITY - (manaBalanceOf(PLAYER.id) ?? 0)).toBe(
        strokeChargeCost(units, MANA_PER_BAND_CELL, stroke) + opened * CHUNK_UNLOCK_MANA,
      );
      expect(nominalStrokeCost(MANA_PER_BAND_CELL, stroke)).toBe(
        nominalStrokeCost(MANA_PER_BAND_CELL, intent('hard')),
      );
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  CARVE_DEFAULT_DEPTH_BANDS,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  DRAWN_SHORE_HEIGHT,
  MAX_BRUSH_RADIUS,
  bandLevelHeight,
  displacementOf,
  forEachFootprintOffset,
  snapshotSolidUnits,
  strokeReachBox,
  type SculptIntent,
} from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import { MANA_PER_BAND_CELL } from '../server/scale.ts';
import {
  MANA_CAPACITY,
  manaBalanceOf,
  manaCostFor,
  plugin as manaPlugin,
  resetManaState,
  spendMana,
} from '../server/index.ts';
import { displacementManaCost } from '../pricing.ts';

const WORLD_SIZE = 64;

const SEA_FLOOR = 0;

const GROUND_BAND = 8;

const CENTRE = { x: 24, y: 24 } as const;

const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

const EVERY_CHUNK: ReadonlyArray<readonly [number, number]> = (() => {
  const edge = WORLD_SIZE / CHUNK_SIZE;
  const chunks: Array<readonly [number, number]> = [];
  for (let cy = 0; cy < edge; cy++) for (let cx = 0; cx < edge; cx++) chunks.push([cx, cy]);
  return chunks;
})();

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly api: WorldApi;
}

function boot(fillHeight: number): Harness {
  resetManaState();
  const world = worldWithUnlockedChunks(WORLD_SIZE, EVERY_CHUNK, undefined, fillHeight);
  world.setSink(new RecordingSink());

  let api: WorldApi | null = null;
  const bystander: TerracePlugin = {
    name: 'zzz-bystander',
    onWorldCreate(given: WorldApi): void {
      api = given;
    },
  };
  const host = new PluginHost(world, [manaPlugin, bystander].map(asLoadedPlugin));
  host.worldCreate();
  world.addPlayer(PLAYER);
  for (const chunk of EVERY_CHUNK) world.seedChunkForToken(PLAYER.token, ...chunk);
  host.playerJoined(PLAYER);
  if (api === null) throw new Error('onWorldCreate never ran');
  return { world, host, api };
}

interface Stroke {
  readonly applied: boolean;
  readonly units: number;
  readonly charged: number;
  readonly cells: number;
}

/** Runs one stroke and measures what it moved beside the server, not from it. */
function sculpt(harness: Harness, intent: SculptIntent): Stroke {
  const balanceBefore = manaBalanceOf(PLAYER.id) ?? 0;
  const box = strokeReachBox(harness.world.size, intent);
  const solids = snapshotSolidUnits(
    harness.world.map,
    box.minX,
    box.minY,
    box.maxX,
    box.maxY,
  );
  const outcome = handleSculptIntent(
    { world: harness.world, interceptors: harness.host },
    PLAYER,
    intent,
  );
  const units = outcome.applied
    ? displacementOf(solids, harness.world.map, outcome.diff)
    : 0;
  return {
    applied: outcome.applied,
    units,
    cells: outcome.applied ? outcome.diff.length : 0,
    charged: balanceBefore - (manaBalanceOf(PLAYER.id) ?? 0),
  };
}

function press(radius: number, profile: 'soft' | 'hard', dir: 1 | -1 = 1): SculptIntent {
  return { type: 'sculpt', x: CENTRE.x, y: CENTRE.y, radius, dir, tool: 'stamp', profile };
}

function footprintCells(radius: number): number {
  let cells = 0;
  forEachFootprintOffset(radius, () => {
    cells++;
  });
  return cells;
}

const expectedCharge = (units: number): number =>
  displacementManaCost(units, MANA_PER_BAND_CELL);

describe('the charge is the material the stroke moved', () => {
  it('a raise out of the sea pays for one unit a cell, not a whole band', () => {
    const harness = boot(SEA_FLOOR);
    const radius = 4;
    const onSea = sculpt(harness, press(radius, 'hard'));

    expect(onSea.applied).toBe(true);
    expect(onSea.units).toBe(footprintCells(radius) * DRAWN_SHORE_HEIGHT);
    expect(onSea.charged).toBe(expectedCharge(onSea.units));

    const onLand = sculpt(boot(bandLevelHeight(GROUND_BAND)), press(radius, 'hard'));
    expect(onLand.units).toBe(onSea.units * BAND_HEIGHT);
    expect(onSea.units * BAND_HEIGHT).toBe(footprintCells(radius) * DEFAULT_SCULPT_AMOUNT);
  });

  it('a soft stamp pays the graduated volume it moved, less than the flat fill', () => {
    const radius = 4;
    const soft = sculpt(boot(bandLevelHeight(GROUND_BAND)), press(radius, 'soft'));
    const hard = sculpt(boot(bandLevelHeight(GROUND_BAND)), press(radius, 'hard'));

    expect(soft.units).toBeGreaterThan(0);
    expect(soft.units).toBeLessThan(hard.units);
    expect(soft.charged).toBe(expectedCharge(soft.units));
    expect(hard.charged).toBe(expectedCharge(hard.units));
  });

  it('a carve pays the material it removed, at every radius it can open', () => {
    let opened = 0;
    for (const radius of [1, 2, 4, 8]) {
      const harness = boot(bandLevelHeight(GROUND_BAND));
      // A plateau first: a carve needs a face, and flat ground shows none.
      for (let n = 0; n < 2; n++) {
        sculpt(harness, { ...press(8, 'hard'), x: CENTRE.x, y: CENTRE.y });
      }
      const rim = { x: CENTRE.x + 5, y: CENTRE.y };
      const carved = sculpt(harness, {
        type: 'sculpt',
        x: rim.x,
        y: rim.y,
        radius,
        dir: -1,
        tool: 'carve',
        spanBand: GROUND_BAND + 1,
        depthBands: CARVE_DEFAULT_DEPTH_BANDS,
      });

      expect(carved.applied).toBe(true);
      if (carved.cells === 0) continue;
      opened++;
      expect(carved.units).toBe(carved.cells * CARVE_DEFAULT_DEPTH_BANDS * BAND_HEIGHT);
      expect(carved.charged).toBe(expectedCharge(carved.units));
    }
    expect(opened).toBeGreaterThan(0);
  });

  it('a stroke that moved nothing is charged nothing, with no special case', () => {
    const harness = boot(bandLevelHeight(GROUND_BAND));
    const noOp = sculpt(harness, {
      type: 'sculpt',
      x: CENTRE.x,
      y: CENTRE.y,
      radius: 4,
      dir: -1,
      tool: 'carve',
      spanBand: GROUND_BAND,
      depthBands: CARVE_DEFAULT_DEPTH_BANDS,
    });

    expect(noOp.applied).toBe(true);
    expect(noOp.cells).toBe(0);
    expect(noOp.units).toBe(0);
    expect(noOp.charged).toBe(0);
  });

  it('admits on the nominal and charges the actual, so a sea raise leaves change', () => {
    const harness = boot(SEA_FLOOR);
    const intent = press(MAX_BRUSH_RADIUS, 'hard');
    const nominal = manaCostFor(PLAYER.id, intent);

    const stroke = sculpt(harness, intent);
    expect(stroke.applied).toBe(true);
    expect(stroke.charged).toBeLessThan(nominal);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - stroke.charged);
  });

  it('denies a player who could afford the actual but not the nominal', () => {
    const harness = boot(SEA_FLOOR);
    const intent = press(MAX_BRUSH_RADIUS, 'hard');
    const nominal = manaCostFor(PLAYER.id, intent);
    const actual = expectedCharge(footprintCells(MAX_BRUSH_RADIUS) * DRAWN_SHORE_HEIGHT);
    expect(actual).toBeLessThan(nominal);

    // Enough for what the stroke will move, short of what it might have moved.
    const kept = Math.floor((actual + nominal) / 2);
    expect(spendMana(harness.api, PLAYER.id, MANA_CAPACITY - kept)).toBe(true);

    const denied = sculpt(harness, intent);
    expect(denied.applied).toBe(false);
    expect(manaBalanceOf(PLAYER.id)).toBe(kept);
  });
});

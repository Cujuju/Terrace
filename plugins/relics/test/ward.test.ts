import { beforeEach, describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT, MAX_HEIGHT, bandLevelHeight, chunkIndex, chunksPerEdge, createChunkMask,
  forEachSweptCell, sweepAt, sweepBetween, unlockChunk,
  type CellDiff, type StrokeSweep,
} from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { World } from '../../../server/src/world/world.ts';
import { asLoadedPlugin, grantTokenEveryUnlockedChunk, RecordingSink } from '../../../server/test/support/harness.ts';
import { cooldownOf, currentRelics, plugin, resetRelicsState } from '../server/index.ts';
import { resetManaBridge } from '../server/mana-bridge.ts';
import type { Player } from '../../../server/src/player.ts';
import type { SkillId } from '../protocol.ts';
import {
  resetWards,
  claimWardCells,
  wardHolderAgainst,
  wardedCellCount,
  BEDROCK_WARD_SECONDS,
  isCellWardedAgainst,
} from '../server/ward.ts';

const WORLD_SIZE = 128;

const HOLDER = 'session-holder';

const ACTOR = 'session-actor';

const BRUSH_RADIUS = 4;

const LEG_FROM = { x: 20, y: 20 } as const;

const LEG_TO = { x: 60, y: 20 } as const;

/** Mid-leg, far outside the disc at either end. */
const MIDWAY_CELL = { x: 40, y: 20 } as const;

function stampWard(size: number, owner: string, sweep: StrokeSweep): void {
  const diff: CellDiff[] = [];
  forEachSweptCell(sweep, (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) diff.push({ x, y, h: 0 });
  });
  claimWardCells(size, owner, diff);
}

describe('a bedrock ward sees the whole swept shape', () => {
  beforeEach(() => {
    resetWards();
  });

  it('refuses a leg that starts and ends clear of the ward but crosses it', () => {
    stampWard(WORLD_SIZE, HOLDER, sweepAt(MIDWAY_CELL.x, MIDWAY_CELL.y, 1));

    const leg = sweepBetween(LEG_FROM.x, LEG_FROM.y, LEG_TO.x, LEG_TO.y, BRUSH_RADIUS);
    expect(wardHolderAgainst(WORLD_SIZE, ACTOR, leg)).toBe(HOLDER);
  });

  it('lets the disc at either end of that leg through, which is why the disc alone missed it', () => {
    stampWard(WORLD_SIZE, HOLDER, sweepAt(MIDWAY_CELL.x, MIDWAY_CELL.y, 1));

    for (const end of [LEG_FROM, LEG_TO]) {
      expect(wardHolderAgainst(WORLD_SIZE, ACTOR, sweepAt(end.x, end.y, BRUSH_RADIUS))).toBeNull();
    }
  });

  it('allows a leg that misses the ward by one cell', () => {
    const outside = { x: MIDWAY_CELL.x, y: MIDWAY_CELL.y + BRUSH_RADIUS };
    const inside = { x: MIDWAY_CELL.x, y: MIDWAY_CELL.y + BRUSH_RADIUS - 1 };
    const leg = sweepBetween(LEG_FROM.x, LEG_FROM.y, LEG_TO.x, LEG_TO.y, BRUSH_RADIUS);

    stampWard(WORLD_SIZE, HOLDER, sweepAt(outside.x, outside.y, 1));
    expect(wardHolderAgainst(WORLD_SIZE, ACTOR, leg)).toBeNull();

    resetWards();
    stampWard(WORLD_SIZE, HOLDER, sweepAt(inside.x, inside.y, 1));
    expect(wardHolderAgainst(WORLD_SIZE, ACTOR, leg)).toBe(HOLDER);
  });

  it('never refuses its own holder', () => {
    stampWard(WORLD_SIZE, HOLDER, sweepAt(MIDWAY_CELL.x, MIDWAY_CELL.y, 1));
    const leg = sweepBetween(LEG_FROM.x, LEG_FROM.y, LEG_TO.x, LEG_TO.y, BRUSH_RADIUS);
    expect(wardHolderAgainst(WORLD_SIZE, HOLDER, leg)).toBeNull();
  });

  it('stamps every cell of the capsule a leg swept', () => {
    const leg = sweepBetween(LEG_FROM.x, LEG_FROM.y, LEG_TO.x, LEG_TO.y, BRUSH_RADIUS);
    stampWard(WORLD_SIZE, HOLDER, leg);

    let swept = 0;
    forEachSweptCell(leg, (x, y) => {
      swept++;
      expect(wardHolderAgainst(WORLD_SIZE, ACTOR, sweepAt(x, y, 1))).toBe(HOLDER);
    });
    expect(wardedCellCount()).toBe(swept);
    expect(swept).toBeGreaterThan(
      (() => {
        let disc = 0;
        forEachSweptCell(sweepAt(LEG_TO.x, LEG_TO.y, BRUSH_RADIUS), () => {
          disc++;
        });
        return disc;
      })(),
    );
  });

  it('clips a capsule that runs off the world', () => {
    stampWard(WORLD_SIZE, HOLDER, sweepBetween(0, 0, 0, 8, BRUSH_RADIUS));
    expect(wardedCellCount()).toBeGreaterThan(0);
    expect(wardHolderAgainst(WORLD_SIZE, ACTOR, sweepAt(0, 4, 1))).toBe(HOLDER);
  });
});

describe('a relic cast respects the ward on every settled cell', () => {
  const SIZE = 128;
  const TOP_BAND = 8;
  const MID_BAND_HEIGHT = TOP_BAND * BAND_HEIGHT + BAND_HEIGHT / 2;
  const SPELL_CENTRE = { x: SIZE / 2, y: SIZE / 2 };
  // Outside every Genesis disc; the second step's settle cascade reaches it.
  const SPILL_CELL = { x: 45, y: 48 };
  const CASTER: Player = { id: 'caster', token: 'caster-token', name: 'Caster' };
  const WARD_OWNER: Player = { id: 'ward-owner', token: 'ward-token', name: 'Owner' };

  function castHarness(options: {
    readonly owner?: Player;
    readonly height?: number;
    readonly withWard?: boolean;
    readonly lockedChunk?: readonly [number, number];
  } = {}) {
    const { owner = WARD_OWNER, height = MID_BAND_HEIGHT, withWard = true, lockedChunk } = options;
    resetRelicsState();
    resetManaBridge();
    const cells = new Int16Array(SIZE * SIZE).fill(height);
    if (withWard) cells[(SPILL_CELL.y - 1) * SIZE + SPILL_CELL.x] = bandLevelHeight(TOP_BAND - 1);
    const mask = createChunkMask(SIZE);
    for (let cy = 0; cy < chunksPerEdge(SIZE); cy++) {
      for (let cx = 0; cx < chunksPerEdge(SIZE); cx++) {
        if (lockedChunk !== undefined && cx === lockedChunk[0] && cy === lockedChunk[1]) continue;
        unlockChunk(mask, chunkIndex(SIZE, cx, cy));
      }
    }
    const world = World.restore(SIZE, cells, mask, undefined, 'Ward regression');
    const sink = new RecordingSink();
    world.setSink(sink);
    const host = new PluginHost(world, [asLoadedPlugin(plugin)]);
    host.worldCreate();
    for (const player of [CASTER, WARD_OWNER]) {
      world.addPlayer(player);
      grantTokenEveryUnlockedChunk(world, player.token);
      host.playerJoined(player);
    }
    const collect = (player: Player, skill: SkillId): void => {
      const relic = currentRelics().find((entry) => entry.skill === skill)!;
      host.handlerFor('relics:collect')!(player, { id: relic.id });
    };
    collect(CASTER, 'genesis');
    if (withWard) {
      collect(owner, 'bedrock-ward');
      const carve = handleSculptIntent({ world, interceptors: host }, owner, {
        type: 'sculpt', ...SPILL_CELL, radius: 1, dir: -1, tool: 'carve', spanBand: TOP_BAND,
      });
      expect(carve.applied).toBe(true);
      if (!carve.applied) throw new Error('ward fixture carve was refused');
      expect(carve.diff).toEqual([{ ...SPILL_CELL, h: bandLevelHeight(TOP_BAND - 1) }]);
    }
    sink.clear();
    return {
      world, host, sink,
      cast: () => host.handlerFor('relics:cast')!(CASTER, { skill: 'genesis', ...SPELL_CENTRE }),
    };
  }

  it('refuses a later-step spill atomically and spends no cooldown, then permits an expired ward', () => {
    const live = castHarness();
    try {
      const before = live.world.map.cells.slice();
      expect(isCellWardedAgainst(SIZE, CASTER.id, SPILL_CELL.x, SPILL_CELL.y)).toBe(true);
      live.cast();
      expect(live.world.map.cells).toEqual(before);
      expect(live.sink.ofType('terrainDiff')).toHaveLength(0);
      expect(cooldownOf(CASTER.id, 'genesis')).toBe(0);
      expect(live.sink.ofType('relics:denied')[0]?.payload).toEqual({ skill: 'bedrock-ward', reason: 'warded' });

      live.host.tick(BEDROCK_WARD_SECONDS);
      live.sink.clear();
      live.cast();
      expect(live.world.map.cells).not.toEqual(before);
      expect(live.sink.ofType('relics:denied')).toHaveLength(0);
      expect(cooldownOf(CASTER.id, 'genesis')).toBeGreaterThan(0);
    } finally {
      live.host.closeWorld();
    }
  });

  it('permits the holder to terraform their own ward', () => {
    const live = castHarness({ owner: CASTER });
    try {
      const before = live.world.map.cells.slice();
      expect(isCellWardedAgainst(SIZE, CASTER.id, SPILL_CELL.x, SPILL_CELL.y)).toBe(false);
      live.cast();
      expect(live.world.map.cells).not.toEqual(before);
      expect(live.sink.ofType('relics:denied')).toHaveLength(0);
      expect(cooldownOf(CASTER.id, 'genesis')).toBeGreaterThan(0);
    } finally {
      live.host.closeWorld();
    }
  });

  it('refuses a locked later step without committing the earlier steps or starting cooldown', () => {
    const LOCKED_LATER_STEP_CHUNK = [5, 4] as const;
    const live = castHarness({ withWard: false, lockedChunk: LOCKED_LATER_STEP_CHUNK });
    try {
      const before = live.world.map.cells.slice();
      live.cast();
      expect(live.world.map.cells).toEqual(before);
      expect(live.sink.ofType('terrainDiff')).toHaveLength(0);
      expect(cooldownOf(CASTER.id, 'genesis')).toBe(0);
      expect(live.sink.ofType('relics:denied')[0]?.payload).toEqual({ skill: 'genesis', reason: 'target' });
    } finally {
      live.host.closeWorld();
    }
  });

  it('preserves cooldown for an accepted cast that cannot raise ground past the world ceiling', () => {
    const live = castHarness({ withWard: false, height: MAX_HEIGHT });
    try {
      const before = live.world.map.cells.slice();
      live.cast();
      expect(live.world.map.cells).toEqual(before);
      expect(live.sink.ofType('relics:denied')).toHaveLength(0);
      expect(cooldownOf(CASTER.id, 'genesis')).toBeGreaterThan(0);
    } finally {
      live.host.closeWorld();
    }
  });
});

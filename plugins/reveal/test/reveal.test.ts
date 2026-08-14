// reveal, driven through the REAL intent pipeline and the REAL plugin host with
// both shipped example plugins registered. This is MVP criterion 5's test: the
// PLUGIN unlocks territory (core never decides when), and clients see the new
// chunk stream in.

import { chunkIndex } from '@terrace/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import {
  MANA_CAPACITY,
  MANA_COST_PER_SCULPT,
  manaBalanceOf,
  plugin as manaPlugin,
  resetManaState,
} from '../../mana/server/index.ts';
import {
  FRONTIER_PRESSURE_CELLS_PER_UNLOCK,
  REVEAL_SLICE_VERSION,
  frontierPressureAt,
  plugin as revealPlugin,
  resetRevealState,
} from '../server/index.ts';

/** 64² cells = 4×4 chunks. */
const WORLD_SIZE = 64;

/** The one unlocked chunk; cells (16..31, 16..31). */
const HOME_CHUNK: readonly [number, number] = [1, 1];

/** The locked chunk east of home; cells (32..47, 16..31). */
const FRONTIER_CHUNK: readonly [number, number] = [2, 1];

/** Border column of HOME_CHUNK — sculpting here reaches into FRONTIER_CHUNK. */
const BORDER_CELL = { x: 31, y: 24 } as const;

/** Centre of HOME_CHUNK, 8 cells from every border. */
const INTERIOR_CELL = { x: 24, y: 24 } as const;

/**
 * Interior sculpts used by the "reveals nothing" test. A hill grows a wider
 * relaxation skirt every time it is raised, and at the 8th stacked radius-4
 * sculpt even a centred hill finally reaches a border — correct policy
 * behaviour, but not what that test is about, so it stops short of it.
 */
const INTERIOR_SCULPTS = 6;

/**
 * Upper bound on border sculpts allowed before the frontier chunk must unlock.
 * Measured today: 8 radius-4 sculpts. The bound is deliberately loose because
 * the exact count is a product of feel-tuned terrain constants (MAX_STEP,
 * DEFAULT_SCULPT_AMOUNT) that Phase 2 may still retune; the contract under test
 * is "sustained frontier work unlocks, a single edit does not".
 */
const BORDER_SCULPT_BUDGET = 20;

/** Default server tick period (TICK_HZ = 10). */
const TICK_DT = 0.1;

/** Safety cap on the regen wait, so a broken economy fails instead of hanging. */
const MAX_REGEN_TICKS = 1000;

const PLAYER: Player = { id: 'session-1', name: 'Tester' };

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/** Boots both example plugins in real discovery order (mana, then reveal). */
function boot(): Harness {
  resetManaState();
  resetRevealState();

  const world = worldWithUnlockedChunks(WORLD_SIZE, [HOME_CHUNK]);
  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [manaPlugin, revealPlugin].map(asLoadedPlugin));
  host.worldCreate();

  world.addPlayer(PLAYER);
  host.playerJoined(PLAYER);

  return { world, host, sink };
}

/**
 * One sculpt, paid for. The mana plugin is live in this host, so the test ticks
 * the world forward until the player can afford the edit — which is exactly
 * what a real player does, and proves the two plugins compose rather than
 * merely coexist.
 */
function paidSculpt(harness: Harness, x: number, y: number, radius: number) {
  let ticks = 0;
  while ((manaBalanceOf(PLAYER.id) ?? 0) < MANA_COST_PER_SCULPT) {
    harness.host.tick(TICK_DT);
    if (++ticks > MAX_REGEN_TICKS) throw new Error('mana never regenerated');
  }
  return handleSculptIntent(
    { world: harness.world, interceptors: harness.host },
    PLAYER,
    { type: 'sculpt', x, y, radius, dir: 1 },
  );
}

describe('reveal plugin', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('unlocks the frontier chunk after sustained sculpting at the border', () => {
    expect(harness.world.isChunkUnlocked(...FRONTIER_CHUNK)).toBe(false);

    // One edit is never enough: the threshold is a chunk's worth of cell
    // changes, and a single border sculpt contributes a few dozen.
    expect(paidSculpt(harness, BORDER_CELL.x, BORDER_CELL.y, 4).applied).toBe(true);
    expect(harness.world.isChunkUnlocked(...FRONTIER_CHUNK)).toBe(false);
    expect(frontierPressureAt(chunkIndex(WORLD_SIZE, ...FRONTIER_CHUNK))).toBeGreaterThan(0);

    let sculpts = 1;
    while (!harness.world.isChunkUnlocked(...FRONTIER_CHUNK)) {
      expect(sculpts).toBeLessThan(BORDER_SCULPT_BUDGET);
      paidSculpt(harness, BORDER_CELL.x, BORDER_CELL.y, 4);
      sculpts++;
    }

    // CRITERION 5: clients see the new chunk stream in. Core does that when the
    // mask bit flips, but only the plugin decided that it should.
    const streamed = harness.sink.ofType('chunkUnlock');
    expect(streamed).toHaveLength(1);
    expect(streamed[0].target).toBe('broadcast');
    expect(streamed[0].payload).toMatchObject({
      type: 'chunkUnlock',
      chunks: [{ cx: FRONTIER_CHUNK[0], cy: FRONTIER_CHUNK[1] }],
    });

    // Pressure bookkeeping is released once a chunk is no longer frontier.
    expect(frontierPressureAt(chunkIndex(WORLD_SIZE, ...FRONTIER_CHUNK))).toBe(0);
  });

  it('reveals nothing when the sculpting stays away from the border', () => {
    for (let n = 0; n < INTERIOR_SCULPTS; n++) {
      expect(paidSculpt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y, 4).applied).toBe(true);
    }

    expect(harness.sink.ofType('chunkUnlock')).toHaveLength(0);
    for (let cy = 0; cy < WORLD_SIZE / 16; cy++) {
      for (let cx = 0; cx < WORLD_SIZE / 16; cx++) {
        if (cx === HOME_CHUNK[0] && cy === HOME_CHUNK[1]) continue;
        expect(harness.world.isChunkUnlocked(cx, cy)).toBe(false);
        expect(frontierPressureAt(chunkIndex(WORLD_SIZE, cx, cy))).toBe(0);
      }
    }
  });

  it('accrues nothing from an intent another plugin denied', () => {
    const frontierIndex = chunkIndex(WORLD_SIZE, ...FRONTIER_CHUNK);

    // Earn some frontier pressure, then spend the rest of the pool inland so
    // the border chunk is left part-way to its threshold with an empty wallet.
    // The drain ALTERNATES raise and lower at one interior cell: the wallet
    // empties at full speed while the terrain stays put, so however large the
    // pool is tuned (it has grown once already), the drain can never stack an
    // interior hill whose relaxation skirt reaches a border and muddies the
    // pressure this test reasons about.
    paidSculpt(harness, BORDER_CELL.x, BORDER_CELL.y, 4);
    const affordableFromFull = Math.floor(MANA_CAPACITY / MANA_COST_PER_SCULPT);
    let drained = 0;
    for (;;) {
      const outcome = handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        {
          type: 'sculpt',
          x: INTERIOR_CELL.x,
          y: INTERIOR_CELL.y,
          radius: 4,
          dir: drained % 2 === 0 ? 1 : -1,
        },
      );
      if (!outcome.applied) break;
      expect(++drained).toBeLessThanOrEqual(affordableFromFull);
    }

    const pressureWhenBroke = frontierPressureAt(frontierIndex);
    expect(pressureWhenBroke).toBeGreaterThan(0);
    expect(harness.world.isChunkUnlocked(...FRONTIER_CHUNK)).toBe(false);

    // Denied intents never reach the terrain, so they generate no diff and
    // therefore no reveal pressure — the policy cannot be farmed by spamming
    // intents you cannot pay for.
    for (let n = 0; n < 10; n++) {
      const outcome = handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        { type: 'sculpt', x: BORDER_CELL.x, y: BORDER_CELL.y, radius: 4, dir: 1 },
      );
      expect(outcome).toMatchObject({ applied: false, reason: 'plugin-denied' });
    }
    expect(frontierPressureAt(frontierIndex)).toBe(pressureWhenBroke);
  });

  it('never accrues pressure on a chunk that is already unlocked', () => {
    paidSculpt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y, 4);
    expect(frontierPressureAt(chunkIndex(WORLD_SIZE, ...HOME_CHUNK))).toBe(0);
  });

  it('carries frontier progress across a snapshot restore', () => {
    paidSculpt(harness, BORDER_CELL.x, BORDER_CELL.y, 4);
    const frontierIndex = chunkIndex(WORLD_SIZE, ...FRONTIER_CHUNK);
    const earned = frontierPressureAt(frontierIndex);
    expect(earned).toBeGreaterThan(0);
    expect(earned).toBeLessThan(FRONTIER_PRESSURE_CELLS_PER_UNLOCK);

    const slice = revealPlugin.persistence?.save();
    expect(slice).toMatchObject({ version: REVEAL_SLICE_VERSION });

    // Simulate a process restart: fresh state, then the host's restore step.
    resetRevealState();
    expect(frontierPressureAt(frontierIndex)).toBe(0);
    revealPlugin.persistence?.load(slice);

    expect(frontierPressureAt(frontierIndex)).toBe(earned);
  });

  it('survives a corrupt persistence slice instead of bricking the world', () => {
    for (const junk of [null, undefined, 42, 'nope', { version: 99 }, { version: REVEAL_SLICE_VERSION, pressure: 'x' }]) {
      expect(() => revealPlugin.persistence?.load(junk)).not.toThrow();
      expect(frontierPressureAt(0)).toBe(0);
    }
  });
});

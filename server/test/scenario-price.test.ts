import { MAX_HEIGHT } from '@terrace/shared';
import { beforeEach, describe, expect, it } from 'vitest';
// The runner is plugin-agnostic; a price only exists with the mana plugin in
// the chain, so this scenario loads the real one beside reveal.
import { CHUNK_UNLOCK_MANA, sculptManaCost } from '../../plugins/mana/pricing.ts';
import {
  MANA_CAPACITY,
  MANA_PER_BAND_CELL,
  manaBalanceOf,
  plugin as manaPlugin,
  resetManaState,
} from '../../plugins/mana/server/index.ts';
import { plugin as revealPlugin } from '../../plugins/reveal/server/index.ts';
import type { Player } from '../src/player.ts';
import {
  entriesOfKind,
  EVERY_CHUNK,
  pluginEntries,
  Scenario,
  sculptMessage,
  type ChunkRef,
  type TranscriptEntry,
} from './support/scenario.ts';

const SCULPTOR: Player = { id: 'session-1', token: 'token-1', name: 'Sculptor' };

const HOME_CHUNK: readonly ChunkRef[] = [[1, 1]];

const MANA_BALANCE = 'mana:balance';

const STROKE_RADIUS = 2;

const STAMP_DISPLACEMENT = sculptManaCost(
  MANA_PER_BAND_CELL,
  STROKE_RADIUS,
  'hard',
  'stamp',
);

/** Inside HOME_CHUNK, so the reveal reach spills onto frontier chunks around it. */
const FRONTIER_CELL = { x: 24, y: 24 } as const;

/** On the fixture's MAX_HEIGHT plateau: a raise there moves nothing. */
const CEILING_CELL = { x: 62, y: 24 } as const;

function frontierScenario(owned: readonly ChunkRef[] = HOME_CHUNK): Scenario {
  resetManaState();
  return new Scenario({
    terrain: 'terrace',
    unlocked: EVERY_CHUNK,
    owned,
    players: [SCULPTOR],
    plugins: [manaPlugin, revealPlugin],
  });
}

function openedChunksIn(entries: readonly TranscriptEntry[]): number {
  const seen = new Set<string>();
  for (const entry of entriesOfKind(entries, 'chunks')) {
    for (const [cx, cy] of entry.chunks) seen.add(`${cx},${cy}`);
  }
  return seen.size;
}

function chargedIn(entries: readonly TranscriptEntry[]): number {
  const pushes = pluginEntries(entries, MANA_BALANCE);
  expect(pushes).toHaveLength(1);
  return MANA_CAPACITY - (pushes[0]!.payload as { balance: number }).balance;
}

describe('a frontier stroke pays displacement plus a flat fee per chunk it opens', () => {
  beforeEach(() => {
    resetManaState();
  });

  it('charges both halves, and the balance push tells the client the same number', () => {
    const scenario = frontierScenario();

    const step = scenario.send(
      SCULPTOR,
      sculptMessage({ ...FRONTIER_CELL, radius: STROKE_RADIUS, profile: 'hard', seq: 1 }),
    );

    expect(step.outcome?.applied).toBe(true);
    const opened = openedChunksIn(step.entries);
    expect(opened).toBeGreaterThan(0);

    const expected = STAMP_DISPLACEMENT + opened * CHUNK_UNLOCK_MANA;
    expect(chargedIn(step.entries)).toBe(expected);
    expect(manaBalanceOf(SCULPTOR.id)).toBe(MANA_CAPACITY - expected);
  });

  it('charges a no-op frontier stroke the unlock fee and nothing else', () => {
    const scenario = frontierScenario();
    expect(scenario.world.heightAt(CEILING_CELL.x, CEILING_CELL.y)).toBe(MAX_HEIGHT);

    const step = scenario.send(
      SCULPTOR,
      sculptMessage({ ...CEILING_CELL, radius: STROKE_RADIUS, profile: 'hard', dir: 1, seq: 2 }),
    );

    expect(step.outcome?.applied).toBe(true);
    if (step.outcome?.applied === true) expect(step.outcome.diff).toHaveLength(0);
    expect(entriesOfKind(step.entries, 'diff')).toHaveLength(0);

    const opened = openedChunksIn(step.entries);
    expect(opened).toBeGreaterThan(0);
    expect(chargedIn(step.entries)).toBe(opened * CHUNK_UNLOCK_MANA);
  });

  it('charges displacement only once the land is already owned', () => {
    const scenario = frontierScenario(EVERY_CHUNK);

    const step = scenario.send(
      SCULPTOR,
      sculptMessage({ ...FRONTIER_CELL, radius: STROKE_RADIUS, profile: 'hard', seq: 3 }),
    );

    expect(step.outcome?.applied).toBe(true);
    expect(openedChunksIn(step.entries)).toBe(0);
    expect(chargedIn(step.entries)).toBe(STAMP_DISPLACEMENT);
  });

  it('bills the frontier once: the second stroke on the same ground pays displacement only', () => {
    const scenario = frontierScenario();
    const first = scenario.send(
      SCULPTOR,
      sculptMessage({ ...FRONTIER_CELL, radius: STROKE_RADIUS, profile: 'hard', seq: 4 }),
    );
    const firstCharge = chargedIn(first.entries);

    const balanceBefore = manaBalanceOf(SCULPTOR.id)!;
    const second = scenario.send(
      SCULPTOR,
      sculptMessage({ ...FRONTIER_CELL, radius: STROKE_RADIUS, profile: 'hard', dir: -1, seq: 5 }),
    );

    expect(openedChunksIn(second.entries)).toBe(0);
    expect(balanceBefore - manaBalanceOf(SCULPTOR.id)!).toBe(STAMP_DISPLACEMENT);
    expect(firstCharge).toBeGreaterThan(STAMP_DISPLACEMENT);
  });
});

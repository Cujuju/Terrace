import { afterEach, describe, expect, it } from 'vitest';
import { advanceClimb, beginClimb, climbSeed, newStillness } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { plugin, resetMonstersState } from '../server/index.ts';
import { profileOf } from '../server/kinds.ts';
import { MONSTERS_SLICE_VERSION, loadMonsters, saveMonsters } from '../server/persistence.ts';
import { livingMonsterOfKind, restoreSummoning, type Monster } from '../server/summoning.ts';

const DT = 0.1;
const MAX_TICKS = 200;
const LOW = 576;
const HIGH = 704;
const DOOMED_YETI_ID = 12;

afterEach(resetMonstersState);

function climbing(mode: 'ascent' | 'descent' | 'fall'): Monster {
  const id = mode === 'fall' ? DOOMED_YETI_ID : 1;
  const world = {
    worldSize: 64,
    heightAt: (x: number) => (x < 34) === (mode !== 'descent') ? LOW : HIGH,
  };
  const climb = beginClimb(world, profileOf('yeti').traversal, 33.5, 32.5, 34, 32, climbSeed(id, 33, 32, 34, 32));
  if (climb === null) throw new Error('climb fixture rejected');
  const monster: Monster = {
    id, kind: 'yeti', x: 33.5, y: 32.5, heading: 0, climb, idle: false, ...newStillness(33.5, 32.5),
  };
  for (let tick = 0; tick < MAX_TICKS; tick++) {
    advanceClimb(monster, DT);
    if (mode === 'fall' ? climb.falling : climb.legElapsed > 0) return monster;
  }
  throw new Error('climb fixture never reached its saved phase');
}

describe('canonical climb persistence', () => {
  it.each(['ascent', 'descent', 'fall'] as const)('resumes %s exactly after save/close/load/reopen', (mode) => {
    const monster = climbing(mode);
    restoreSummoning([monster], monster.id + 1, {});
    const expected = structuredClone(monster);
    const saved = saveMonsters();
    const bytes = JSON.stringify(saved);
    plugin.onWorldClose?.({} as WorldApi);
    expect(plugin.persistence!.load(JSON.parse(bytes), MONSTERS_SLICE_VERSION)).toBeUndefined();
    plugin.onWorldCreate?.({} as WorldApi);
    const restored = livingMonsterOfKind('yeti')!;
    expect(restored.climb).toEqual(expected.climb);
    let terminal = false;
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      const expectedOutcome = advanceClimb(expected, DT);
      expect(advanceClimb(restored, DT)).toBe(expectedOutcome);
      expect({ x: restored.x, y: restored.y, heading: restored.heading, climb: restored.climb }).toEqual({
        x: expected.x, y: expected.y, heading: expected.heading, climb: expected.climb,
      });
      if (expectedOutcome !== 'climbing') { terminal = true; break; }
    }
    expect(terminal).toBe(true);
    expect(JSON.stringify(saved)).toBe(bytes);
  });

  it('refuses incomplete current climb data and future slices without replacing live state', () => {
    const monster = climbing('ascent');
    restoreSummoning([monster], monster.id + 1, {});
    const saved = saveMonsters();
    const invalid = { ...saved, monsters: saved.monsters.map((entry) => ({ ...entry, climb: { height: LOW } })) };
    expect(plugin.persistence!.load(invalid, MONSTERS_SLICE_VERSION)).toBe('refuse');
    expect(livingMonsterOfKind('yeti')!.climb).toEqual(monster.climb);
    expect(plugin.persistence!.load({ ...saved, version: MONSTERS_SLICE_VERSION + 1 }, MONSTERS_SLICE_VERSION + 1)).toBe('refuse');
    expect(plugin.persistence!.load(null, MONSTERS_SLICE_VERSION)).toBe('refuse');
  });

  it('retains the legacy grounded default without reconstructing a missing climb', () => {
    const monster = climbing('ascent');
    restoreSummoning([monster], monster.id + 1, {});
    const saved = saveMonsters();
    const legacy = { ...saved, version: 3, monsters: saved.monsters.map(({ climb: _climb, ...entry }) => entry) };
    expect(loadMonsters(legacy)).toBeUndefined();
    expect(livingMonsterOfKind('yeti')!.climb).toBeNull();
    expect(livingMonsterOfKind('yeti')!.x).toBe(monster.x);
  });
});

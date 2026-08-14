// The wire contract both halves share: the roster's own invariants, and the
// defensive parsers that stand between untrusted bytes and everything else.

import { describe, expect, it } from 'vitest';
import { MAX_BRUSH_RADIUS } from '@terrace/shared';
import {
  SKILLS,
  SKILL_IDS,
  isCellCoordinate,
  isSkillId,
  parseCastPayload,
  parseCollectPayload,
  parseRelicsPayload,
  parseSkillsPayload,
  skillInfo,
} from '../protocol.ts';

const WORLD_SIZE = 64;

describe('skill roster', () => {
  it('has unique ids and covers all three categories', () => {
    expect(new Set(SKILL_IDS).size).toBe(SKILL_IDS.length);
    expect(new Set(SKILLS.map((skill) => skill.kind))).toEqual(
      new Set(['passive', 'active', 'perk']),
    );
  });

  it('gives every skill a name and a description', () => {
    for (const skill of SKILLS) {
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skillInfo(skill.id)).toBe(skill);
    }
  });

  it('narrows only roster ids', () => {
    for (const id of SKILL_IDS) expect(isSkillId(id)).toBe(true);
    for (const value of ['', 'Quake', 'quake ', 42, null, undefined, {}]) {
      expect(isSkillId(value)).toBe(false);
    }
  });
});

describe('isCellCoordinate', () => {
  it('accepts integers inside the grid and nothing else', () => {
    expect(isCellCoordinate(0, WORLD_SIZE)).toBe(true);
    expect(isCellCoordinate(WORLD_SIZE - 1, WORLD_SIZE)).toBe(true);
    expect(isCellCoordinate(WORLD_SIZE, WORLD_SIZE)).toBe(false);
    expect(isCellCoordinate(-1, WORLD_SIZE)).toBe(false);
    expect(isCellCoordinate(1.5, WORLD_SIZE)).toBe(false);
    expect(isCellCoordinate(Number.NaN, WORLD_SIZE)).toBe(false);
    expect(isCellCoordinate('4', WORLD_SIZE)).toBe(false);
  });
});

describe('parseCollectPayload', () => {
  it('accepts a non-empty string id', () => {
    expect(parseCollectPayload({ id: 'r7' })).toEqual({ id: 'r7' });
  });

  it('rejects everything else', () => {
    for (const payload of [null, undefined, 'r7', 7, {}, { id: '' }, { id: 7 }]) {
      expect(parseCollectPayload(payload)).toBeNull();
    }
  });
});

describe('parseCastPayload', () => {
  it('accepts a roster skill at an in-bounds integer cell', () => {
    expect(parseCastPayload({ skill: 'quake', x: 3, y: 4 }, WORLD_SIZE)).toEqual({
      skill: 'quake',
      x: 3,
      y: 4,
    });
  });

  it('rejects an unknown skill, and out-of-bounds or non-integer cells', () => {
    expect(parseCastPayload({ skill: 'nope', x: 3, y: 4 }, WORLD_SIZE)).toBeNull();
    expect(parseCastPayload({ skill: 'quake', x: WORLD_SIZE, y: 4 }, WORLD_SIZE)).toBeNull();
    expect(parseCastPayload({ skill: 'quake', x: 3, y: -1 }, WORLD_SIZE)).toBeNull();
    expect(parseCastPayload({ skill: 'quake', x: 3.5, y: 4 }, WORLD_SIZE)).toBeNull();
    expect(parseCastPayload(null, WORLD_SIZE)).toBeNull();
  });

  it('bounds-checks against the LIVE world size, not a constant', () => {
    // The brush throws on an out-of-bounds centre rather than clamping, so a
    // small world must reject a cell a large world would accept.
    expect(parseCastPayload({ skill: 'quake', x: 40, y: 0 }, WORLD_SIZE)).not.toBeNull();
    expect(parseCastPayload({ skill: 'quake', x: 40, y: 0 }, 32)).toBeNull();
    // Unrelated to the brush radius, but the same family of bound.
    expect(MAX_BRUSH_RADIUS).toBeGreaterThan(0);
  });
});

describe('parseRelicsPayload', () => {
  it('keeps well-formed entries and drops the rest', () => {
    const parsed = parseRelicsPayload({
      relics: [
        { id: 'r1', x: 1, y: 2, skill: 'quake' },
        { id: '', x: 1, y: 2, skill: 'quake' },
        { id: 'r2', x: 1.5, y: 2, skill: 'quake' },
        { id: 'r3', x: 1, y: 2, skill: 'gone-from-the-roster' },
        'not an object',
      ],
    });
    expect(parsed).toEqual([{ id: 'r1', x: 1, y: 2, skill: 'quake' }]);
  });

  it('degrades to an empty list rather than throwing', () => {
    for (const payload of [null, undefined, 'x', {}, { relics: 'x' }]) {
      expect(parseRelicsPayload(payload)).toEqual([]);
    }
  });
});

describe('parseSkillsPayload', () => {
  it('takes the category from the local roster, never from the wire', () => {
    // A version-skewed server calling a passive skill 'active' must not make
    // the HUD render a cast button for it.
    const parsed = parseSkillsPayload({
      skills: [{ id: 'titans-hand', kind: 'active', cooldownS: 9, cooldownRemainingS: 4 }],
    });
    expect(parsed).toEqual([
      { id: 'titans-hand', kind: 'passive', cooldownS: 9, cooldownRemainingS: 4 },
    ]);
  });

  it('clamps unusable cooldowns to zero', () => {
    const parsed = parseSkillsPayload({
      skills: [
        { id: 'quake', cooldownS: -1, cooldownRemainingS: Number.NaN },
        { id: 'genesis', cooldownS: '30', cooldownRemainingS: Number.POSITIVE_INFINITY },
      ],
    });
    expect(parsed).toEqual([
      { id: 'quake', kind: 'active', cooldownS: 0, cooldownRemainingS: 0 },
      { id: 'genesis', kind: 'active', cooldownS: 0, cooldownRemainingS: 0 },
    ]);
  });

  it('degrades to an empty list rather than throwing', () => {
    for (const payload of [null, 'x', {}, { skills: 3 }]) {
      expect(parseSkillsPayload(payload)).toEqual([]);
    }
  });
});

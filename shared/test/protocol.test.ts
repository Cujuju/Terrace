import { describe, expect, it } from 'vitest';
import {
  EDGELESS_SCULPT_PROFILE,
  MAX_BAND,
  MAX_BRUSH_RADIUS,
  MAX_ROLLBACK_KEY_LENGTH,
  MIN_BAND,
  SCULPT_TOOLS,
  sculptOptionsOf,
  TOOLS_WITHOUT_EDGE_PROFILE,
  validateRestorePointsRequest,
  validateRollbackRequest,
  validateSculptIntent,
  WIRE_DEFAULT_SCULPT_OPTIONS,
} from '../src/index.ts';

const WORLD = 128;

describe('validateSculptIntent', () => {
  it('accepts a well-formed intent and returns it typed', () => {
    const intent = validateSculptIntent(
      { type: 'sculpt', x: 10, y: 20, radius: 2, dir: -1 },
      WORLD,
    );
    expect(intent).toEqual({ type: 'sculpt', x: 10, y: 20, radius: 2, dir: -1 });
  });

  it('accepts the boundary values', () => {
    expect(
      validateSculptIntent({ type: 'sculpt', x: 0, y: WORLD - 1, radius: 1, dir: 1 }, WORLD),
    ).not.toBeNull();
    expect(
      validateSculptIntent({ type: 'sculpt', x: 5, y: 5, radius: 4, dir: 1 }, WORLD),
    ).not.toBeNull();
  });

  it('rejects non-objects and wrong types', () => {
    expect(validateSculptIntent(null, WORLD)).toBeNull();
    expect(validateSculptIntent('sculpt', WORLD)).toBeNull();
    expect(validateSculptIntent(42, WORLD)).toBeNull();
    expect(validateSculptIntent({ type: 'nuke', x: 1, y: 1, radius: 1, dir: 1 }, WORLD)).toBeNull();
  });

  it('rejects out-of-bounds and non-integer coordinates', () => {
    const base = { type: 'sculpt', radius: 1, dir: 1 };
    expect(validateSculptIntent({ ...base, x: -1, y: 0 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, x: WORLD, y: 0 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, x: 1.5, y: 0 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, x: 0, y: Number.NaN }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, x: 0 }, WORLD)).toBeNull();
  });

  it('rejects invalid radius and direction', () => {
    const base = { type: 'sculpt', x: 1, y: 1 };
    expect(validateSculptIntent({ ...base, radius: 0, dir: 1 }, WORLD)).toBeNull();
    expect(
      validateSculptIntent({ ...base, radius: MAX_BRUSH_RADIUS + 1, dir: 1 }, WORLD),
    ).toBeNull();
    expect(validateSculptIntent({ ...base, radius: 2.5, dir: 1 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, radius: 1, dir: 0 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, radius: 1, dir: 2 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, radius: 1, dir: '-1' }, WORLD)).toBeNull();
  });
});

describe('validateSculptIntent seq correlation', () => {
  const base = { type: 'sculpt', x: 10, y: 20, radius: 2, dir: 1 } as const;

  it('passes a safe-integer seq through verbatim', () => {
    expect(validateSculptIntent({ ...base, seq: 7 }, WORLD)).toEqual({ ...base, seq: 7 });
  });

  it('omits seq entirely when the intent carried none', () => {
    const intent = validateSculptIntent({ ...base }, WORLD);
    expect(intent).not.toBeNull();
    expect(Object.hasOwn(intent as object, 'seq')).toBe(false);
  });

  it('rejects the whole intent on a malformed seq', () => {
    for (const seq of [1.5, Number.NaN, Infinity, '7', {}, 2 ** 53]) {
      expect(validateSculptIntent({ ...base, seq }, WORLD)).toBeNull();
    }
  });
});

describe('validateSculptIntent brush tool and edge profile', () => {
  const base = { type: 'sculpt', x: 10, y: 20, radius: 2, dir: 1 } as const;

  it('passes every valid tool/profile combination through verbatim', () => {
    for (const tool of ['stamp', 'smooth'] as const) {
      for (const profile of ['soft', 'hard'] as const) {
        expect(validateSculptIntent({ ...base, tool, profile }, WORLD)).toEqual({
          ...base,
          tool,
          profile,
        });
      }
    }
  });

  it('accepts an intent that carries neither, and omits both fields', () => {
    const intent = validateSculptIntent({ ...base }, WORLD);
    expect(intent).not.toBeNull();
    expect(Object.hasOwn(intent as object, 'tool')).toBe(false);
    expect(Object.hasOwn(intent as object, 'profile')).toBe(false);
  });

  it('accepts one field without the other', () => {
    expect(validateSculptIntent({ ...base, tool: 'stamp' }, WORLD)).toEqual({
      ...base,
      tool: 'stamp',
    });
    expect(validateSculptIntent({ ...base, profile: 'hard' }, WORLD)).toEqual({
      ...base,
      profile: 'hard',
    });
  });

  it('rejects the WHOLE intent on any other tool or profile value', () => {
    for (const tool of ['STAMP', 'chisel', '', 0, 1, null, {}, ['stamp']]) {
      expect(validateSculptIntent({ ...base, tool }, WORLD)).toBeNull();
    }
    for (const profile of ['SOFT', 'medium', '', 0, 1, null, {}, ['soft']]) {
      expect(validateSculptIntent({ ...base, profile }, WORLD)).toBeNull();
    }
  });
});

describe('sculptOptionsOf — the normalisation contract', () => {
  const base = { type: 'sculpt', x: 10, y: 20, radius: 2, dir: 1 } as const;

  it('resolves an intent that names neither to the wire default (stamp + soft)', () => {
    expect(sculptOptionsOf(base)).toEqual({ tool: 'stamp', profile: 'soft', spill: 'banded', anchor: 'clicked', targetBand: null, spanBand: null, sweepFrom: null });
    expect(WIRE_DEFAULT_SCULPT_OPTIONS).toEqual({ tool: 'stamp', profile: 'soft', spill: 'banded', anchor: 'clicked', targetBand: null, spanBand: null, sweepFrom: null });
  });

  it('honours whatever the intent DID name, and defaults only the rest', () => {
    expect(sculptOptionsOf({ ...base, tool: 'smooth' })).toEqual({
      tool: 'smooth',
      profile: 'soft',
      spill: 'banded',
      anchor: 'clicked',
      targetBand: null,
      spanBand: null,
      sweepFrom: null,
    });
    expect(sculptOptionsOf({ ...base, profile: 'hard' })).toEqual({
      tool: 'stamp',
      profile: 'hard',
      spill: 'banded',
      anchor: 'clicked',
      targetBand: null,
      spanBand: null,
      sweepFrom: null,
    });
    expect(sculptOptionsOf({ ...base, tool: 'smooth', profile: 'hard' })).toEqual({
      tool: 'smooth',
      profile: 'hard',
      spill: 'banded',
      anchor: 'clicked',
      targetBand: null,
      spanBand: null,
      sweepFrom: null,
    });
  });
});

describe('validateRestorePointsRequest', () => {
  it('accepts a well-formed request', () => {
    expect(validateRestorePointsRequest({ type: 'restorePoints', key: 'a-real-key' })).toEqual({
      type: 'restorePoints',
      key: 'a-real-key',
    });
  });

  it('rejects a missing, empty, non-string or over-long key', () => {
    expect(validateRestorePointsRequest({ type: 'restorePoints' })).toBeNull();
    expect(validateRestorePointsRequest({ type: 'restorePoints', key: '' })).toBeNull();
    expect(validateRestorePointsRequest({ type: 'restorePoints', key: 42 })).toBeNull();
    expect(
      validateRestorePointsRequest({
        type: 'restorePoints',
        key: 'x'.repeat(MAX_ROLLBACK_KEY_LENGTH + 1),
      }),
    ).toBeNull();
  });

  it('rejects anything that is not this message', () => {
    expect(validateRestorePointsRequest(null)).toBeNull();
    expect(validateRestorePointsRequest('restorePoints')).toBeNull();
    expect(validateRestorePointsRequest({ type: 'sculpt', key: 'a-real-key' })).toBeNull();
  });

  it('does not trim the key', () => {
    expect(validateRestorePointsRequest({ type: 'restorePoints', key: ' key ' })?.key).toBe(
      ' key ',
    );
  });
});

describe('validateRollbackRequest', () => {
  it('accepts a well-formed request', () => {
    expect(validateRollbackRequest({ type: 'rollback', key: 'a-real-key', toId: 7 })).toEqual({
      type: 'rollback',
      key: 'a-real-key',
      toId: 7,
    });
  });

  it('rejects a toId that cannot name a row', () => {
    for (const toId of [0, -1, 1.5, Number.NaN, '3', null, undefined]) {
      expect(validateRollbackRequest({ type: 'rollback', key: 'a-real-key', toId })).toBeNull();
    }
  });

  it('rejects a bad key even when the id is fine', () => {
    expect(validateRollbackRequest({ type: 'rollback', key: '', toId: 7 })).toBeNull();
  });
});

describe('targetBand — the drag field on the wire', () => {
  const base = { type: 'sculpt', x: 10, y: 20, radius: 1, dir: 1 } as const;
  const drag = { ...base, tool: 'drag' } as const;

  it('accepts a band the world could hold, and carries it through verbatim', () => {
    for (const targetBand of [MIN_BAND, -1, 0, 1, MAX_BAND]) {
      expect(validateSculptIntent({ ...drag, targetBand }, WORLD)).toEqual({
        ...drag,
        targetBand,
      });
    }
  });

  it('rejects a band carried by anything but a drag, the absent tool included', () => {
    expect(validateSculptIntent({ ...base, targetBand: 3 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, tool: 'stamp', targetBand: 3 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, tool: 'smooth', targetBand: 3 }, WORLD)).toBeNull();
    expect(
      validateSculptIntent({ ...base, dir: -1, tool: 'carve', targetBand: 3 }, WORLD),
    ).toBeNull();
    expect(validateSculptIntent({ ...drag, targetBand: 3 }, WORLD)).not.toBeNull();
  });

  it('is optional — an intent without one is a stamp, exactly as before', () => {
    const validated = validateSculptIntent({ ...base }, WORLD);
    expect(validated).not.toBeNull();
    expect(validated).not.toHaveProperty('targetBand');
  });

  it('rejects a band outside the range the world can hold', () => {
    for (const targetBand of [MIN_BAND - 1, MAX_BAND + 1, 10_000]) {
      expect(validateSculptIntent({ ...drag, targetBand }, WORLD)).toBeNull();
    }
  });

  it('rejects a non-integer band WITH THE WHOLE INTENT, never defaulting it', () => {
    for (const targetBand of [1.5, NaN, Infinity, '3', null, {}]) {
      expect(validateSculptIntent({ ...drag, targetBand }, WORLD)).toBeNull();
    }
  });

  it('flips the anchor to the drag, and only ever together with the band', () => {
    const pulled = sculptOptionsOf({ ...drag, targetBand: 4 });
    expect(pulled.anchor).toBe('band');
    expect(pulled.targetBand).toBe(4);

    const stamp = sculptOptionsOf(base);
    expect(stamp.anchor).toBe('clicked');
    expect(stamp.targetBand).toBeNull();
  });

  it('drops a band any tool but the drag carries, anchor and level both', () => {
    for (const tool of ['stamp', 'smooth', 'carve'] as const) {
      const resolved = sculptOptionsOf({ ...base, tool, targetBand: 4 });
      expect(resolved.anchor).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.anchor);
      expect(resolved.targetBand).toBeNull();
    }
    const bare = sculptOptionsOf({ ...base, targetBand: 4 });
    expect(bare.anchor).toBe(WIRE_DEFAULT_SCULPT_OPTIONS.anchor);
    expect(bare.targetBand).toBeNull();
  });
});

describe('the tool set is the wire contract, not a local list', () => {
  const base = { type: 'sculpt', x: 10, y: 20, radius: 2, dir: -1 } as const;

  it('is exactly the four tools, in wire/UI order', () => {
    expect(SCULPT_TOOLS).toEqual(['stamp', 'smooth', 'drag', 'carve']);
  });

  it('validates the two newest tools, not only the brushes', () => {
    expect(validateSculptIntent({ ...base, tool: 'carve' }, WORLD)).toEqual({
      ...base,
      tool: 'carve',
    });
    expect(validateSculptIntent({ ...base, tool: 'drag' }, WORLD)).toEqual({
      ...base,
      tool: 'drag',
    });
  });

  it('rejects a raising carve WITH the whole intent, never flipping it', () => {
    expect(validateSculptIntent({ ...base, dir: 1, tool: 'carve' }, WORLD)).toBeNull();
    for (const tool of ['stamp', 'smooth', 'drag'] as const) {
      expect(validateSculptIntent({ ...base, dir: 1, tool }, WORLD)).not.toBeNull();
    }
  });

  it('resolves an edgeless tool to one profile whatever the intent carried', () => {
    for (const tool of TOOLS_WITHOUT_EDGE_PROFILE) {
      for (const profile of ['soft', 'hard'] as const) {
        expect(sculptOptionsOf({ ...base, tool, profile }).profile).toBe(EDGELESS_SCULPT_PROFILE);
      }
    }
    expect(sculptOptionsOf({ ...base, tool: 'stamp', profile: 'hard' }).profile).toBe('hard');
  });
});

describe('spanBand — the grasp on the wire', () => {
  const base = { type: 'sculpt', x: 10, y: 20, radius: 2, dir: -1 } as const;

  it('accepts any band this world could hold, on any tool, verbatim', () => {
    for (const spanBand of [MIN_BAND, -1, 0, 1, MAX_BAND]) {
      expect(validateSculptIntent({ ...base, tool: 'carve', spanBand }, WORLD)).toEqual({
        ...base,
        tool: 'carve',
        spanBand,
      });
    }
    expect(validateSculptIntent({ ...base, tool: 'stamp', spanBand: 3 }, WORLD)).not.toBeNull();
  });

  it('rejects a band outside the range, or one that is not a band at all', () => {
    for (const spanBand of [MIN_BAND - 1, MAX_BAND + 1, 1.5, Number.NaN, Infinity, '3', null, {}]) {
      expect(validateSculptIntent({ ...base, spanBand }, WORLD)).toBeNull();
    }
  });

  it('is optional — an intent without one omits the field entirely', () => {
    const validated = validateSculptIntent({ ...base }, WORLD);
    expect(validated).not.toBeNull();
    expect(Object.hasOwn(validated as object, 'spanBand')).toBe(false);
    expect(sculptOptionsOf({ ...base }).spanBand).toBeNull();
  });

  it('travels through the resolver untouched — the map resolves it, not this', () => {
    expect(sculptOptionsOf({ ...base, tool: 'carve', spanBand: MIN_BAND }).spanBand).toBe(MIN_BAND);
    expect(sculptOptionsOf({ ...base, tool: 'carve', spanBand: MAX_BAND }).spanBand).toBe(MAX_BAND);
  });
});

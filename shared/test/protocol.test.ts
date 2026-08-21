import { describe, expect, it } from 'vitest';
import {
  MAX_BRUSH_RADIUS,
  MAX_ROLLBACK_KEY_LENGTH,
  sculptOptionsOf,
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
    expect(validateSculptIntent({ ...base, x: 0 }, WORLD)).toBeNull(); // missing y
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
    // An older client sends no tool/profile at all; it must stay valid.
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
    expect(sculptOptionsOf(base)).toEqual({ tool: 'stamp', profile: 'soft', spill: 'banded', anchor: 'clicked' });
    expect(WIRE_DEFAULT_SCULPT_OPTIONS).toEqual({ tool: 'stamp', profile: 'soft', spill: 'banded', anchor: 'clicked' });
  });

  it('honours whatever the intent DID name, and defaults only the rest', () => {
    expect(sculptOptionsOf({ ...base, tool: 'smooth' })).toEqual({
      tool: 'smooth',
      profile: 'soft',
      spill: 'banded',
      anchor: 'clicked',
    });
    expect(sculptOptionsOf({ ...base, profile: 'hard' })).toEqual({
      tool: 'stamp',
      profile: 'hard',
      spill: 'banded',
      anchor: 'clicked',
    });
    expect(sculptOptionsOf({ ...base, tool: 'smooth', profile: 'hard' })).toEqual({
      tool: 'smooth',
      profile: 'hard',
      spill: 'banded',
      anchor: 'clicked',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WORLD ROLLBACK validators (2026-08-21). These guard the two messages that
// can destroy a world, so the bar is the same as validateSculptIntent's: a
// malformed field rejects the WHOLE message rather than being defaulted.
// ─────────────────────────────────────────────────────────────────────────────

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
    // A padded key must stay padded, so it fails the server's comparison
    // instead of silently widening the secret to its whitespace variants.
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
    // Snapshot ids are positive AUTOINCREMENT integers. Each of these would
    // reach the query as a value that matches nothing, which is a silent
    // "restore point not found" for a message that was malformed.
    for (const toId of [0, -1, 1.5, Number.NaN, '3', null, undefined]) {
      expect(validateRollbackRequest({ type: 'rollback', key: 'a-real-key', toId })).toBeNull();
    }
  });

  it('rejects a bad key even when the id is fine', () => {
    expect(validateRollbackRequest({ type: 'rollback', key: '', toId: 7 })).toBeNull();
  });
});

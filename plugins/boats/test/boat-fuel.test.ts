import { afterEach, describe, expect, it } from 'vitest';
import { worldWithSibling } from '../../../server/test/support/harness.ts';
import { plugin, resetBoatsState } from '../server/index.ts';
import { closeFireBridge, resetFireBridge, type NamedFuelSource } from '../server/fire-bridge.ts';
import { restoreFleet } from '../server/fleet.ts';

afterEach(() => { closeFireBridge(); resetFireBridge(); resetBoatsState(); });

describe('the boat fuel predicate adapter', () => {
  it('filters eligibility before selecting the nearest hull and preserves two-argument callers', () => {
    const registered: NamedFuelSource[] = [];
    plugin.onWorldCreate?.(worldWithSibling('fire', {
      registerEntityFuel: (source: NamedFuelSource) => registered.push(source),
      unregisterEntityFuel: () => {},
    }));
    restoreFleet({ villages: [], nextBoatId: 3, boats: [
      { id: 1, homeX: 0, homeY: 0, x: 12, y: 12, heading: 0, fighting: false },
      { id: 2, homeX: 0, homeY: 0, x: 13, y: 12, heading: 0, fighting: false },
    ] });
    const entityAt = registered[0]!.entityAt as (
      x: number, y: number, accepts?: (id: number) => boolean,
    ) => { id: number } | null;
    expect(entityAt(12, 12)?.id).toBe(1);
    expect(entityAt(12, 12, (id) => id !== 1)?.id).toBe(2);
    expect(entityAt(12, 12, () => false)).toBeNull();
  });
});

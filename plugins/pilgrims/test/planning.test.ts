import { afterEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, ROUTE_NODE_BUDGET, createRouteBudget } from '@terrace/shared';
import { worldWithSibling } from '../../../server/test/support/harness.ts';
import { planRoute, type PilgrimWorld } from '../server/pilgrimage.ts';
import { SETTLE_RING_SAMPLES, canDispatchSettler } from '../server/settling.ts';
import { loadStructuresBridge, resetStructuresBridge } from '../server/structures-bridge.ts';

afterEach(resetStructuresBridge);

describe('caller-owned route allowance', () => {
  it('charges short searches and does no further terrain work after exhaustion', () => {
    let reads = 0;
    const world: PilgrimWorld = {
      worldSize: 512,
      heightAt: () => { reads++; return 6 * BAND_HEIGHT; },
    };
    const budget = createRouteBudget(1);
    expect(planRoute(world, 40.5, 40.5, 60.5, 40.5, budget)).toBeNull();
    expect(budget.remaining).toBe(0);
    const readsAtExhaustion = reads;
    expect(planRoute(world, 40.5, 40.5, 60.5, 40.5, budget)).toBeNull();
    expect(reads).toBe(readsAtExhaustion);
    expect(planRoute(world, 40.5, 40.5, 60.5, 40.5)).not.toBeNull();
  });

  it('stops settlement candidate searches when the scan allowance is spent', () => {
    loadStructuresBridge(worldWithSibling('structures', {
      standingStructures: () => [],
      setBlessedStructureCells: () => {},
      canFoundStructure: (_world: unknown, x: number) => x > 256,
    }));
    let reads = 0;
    const world: PilgrimWorld = {
      worldSize: 512,
      heightAt: (x, y) => {
        reads++;
        if (x === 256 && y <= 400) return 0;
        return 6 * BAND_HEIGHT;
      },
    };
    const temple = { x: 250, y: 250, doorX: 250.5, doorY: 250.5 };
    expect(canDispatchSettler(world, temple)).toBe(false);
    // A loose read bound permits the flood but excludes trials restarted for every candidate.
    const MAX_BUDGETED_SCAN_READS = ROUTE_NODE_BUDGET * SETTLE_RING_SAMPLES;
    expect(reads).toBeLessThan(MAX_BUDGETED_SCAN_READS);
  });

  it('still accepts a reachable ordinary founding site', () => {
    loadStructuresBridge(worldWithSibling('structures', {
      standingStructures: () => [],
      setBlessedStructureCells: () => {},
      canFoundStructure: () => true,
    }));
    const world: PilgrimWorld = { worldSize: 512, heightAt: () => 6 * BAND_HEIGHT };
    expect(canDispatchSettler(world, { x: 128, y: 128 })).toBe(true);
  });
});

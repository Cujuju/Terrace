import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  BAND_HEIGHT,
  createHeightmap,
  forEachFootprintOffset,
  MAX_BRUSH_RADIUS,
  MAX_STEP,
  MIN_BRUSH_RADIUS,
  SEA_LEVEL,
  cellsAcross,
  cellsOverArea,
  type CellDiff,
} from '@terrace/shared';
import { PLUGIN_SCULPT_OPTIONS } from '../../../server/src/plugins/world-api.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import {
  AZURE_HEART_COST_MULTIPLIER,
  NEUTRAL_MULTIPLIER,
  SPRING_OF_AETHER_REGEN_MULTIPLIER,
  composeManaPerk,
  isPerkSkill,
} from '../server/perk.ts';
import {
  RELIC_PREFERRED_TERRAIN_ATTEMPTS,
  RELIC_RNG_DEFAULT_SEED,
  RELIC_SPAWN_ATTEMPTS,
  SHORE_HEIGHT_MARGIN,
  chooseRelicCell,
  createRelicRng,
  terrainClassOf,
  type SpawnWorld,
} from '../server/spawn.ts';
import {
  BULWARK_STEPS,
  GENESIS_STEPS,
  QUAKE_CORE_DEPTH_BANDS,
  QUAKE_STEPS,
  TERRAFORM_BY_SKILL,
  TERRAFORM_RING_OFFSET,
  applyTerraform,
} from '../server/terraform.ts';

describe('mana perk composition', () => {
  it('is neutral for a player holding no perk skills', () => {
    expect(composeManaPerk([])).toEqual({
      costMultiplier: NEUTRAL_MULTIPLIER,
      regenMultiplier: NEUTRAL_MULTIPLIER,
    });
    expect(composeManaPerk(['bedrock-ward', 'quake'])).toEqual({
      costMultiplier: NEUTRAL_MULTIPLIER,
      regenMultiplier: NEUTRAL_MULTIPLIER,
    });
  });

  it('applies each perk on its own axis', () => {
    expect(composeManaPerk(['azure-heart'])).toEqual({
      costMultiplier: AZURE_HEART_COST_MULTIPLIER,
      regenMultiplier: NEUTRAL_MULTIPLIER,
    });
    expect(composeManaPerk(['spring-of-aether'])).toEqual({
      costMultiplier: NEUTRAL_MULTIPLIER,
      regenMultiplier: SPRING_OF_AETHER_REGEN_MULTIPLIER,
    });
  });

  it('is order-independent — which is why it multiplies', () => {
    expect(composeManaPerk(['azure-heart', 'spring-of-aether'])).toEqual(
      composeManaPerk(['spring-of-aether', 'azure-heart']),
    );
  });

  it('knows which roster skills carry a perk', () => {
    expect(isPerkSkill('azure-heart')).toBe(true);
    expect(isPerkSkill('spring-of-aether')).toBe(true);
    expect(isPerkSkill('quake')).toBe(false);
    expect(isPerkSkill('bedrock-ward')).toBe(false);
  });
});

describe('relic rng', () => {
  it('is seeded, so a world replays the same sequence', () => {
    const a = createRelicRng(RELIC_RNG_DEFAULT_SEED);
    const b = createRelicRng(RELIC_RNG_DEFAULT_SEED);
    for (let n = 0; n < 100; n++) expect(a.next()).toBe(b.next());
  });

  it('resumes from a persisted state, so a restored world continues its sequence', () => {
    const original = createRelicRng(RELIC_RNG_DEFAULT_SEED);
    for (let n = 0; n < 10; n++) original.next();

    const saved = original.state();
    const expected = [original.next(), original.next(), original.next()];

    const resumed = createRelicRng(saved);
    expect([resumed.next(), resumed.next(), resumed.next()]).toEqual(expected);
    expect(resumed.state()).toBe(original.state());

    const restarted = createRelicRng(RELIC_RNG_DEFAULT_SEED);
    expect([restarted.next(), restarted.next(), restarted.next()]).not.toEqual(expected);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRelicRng(1);
    for (let n = 0; n < 10000; n++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('terrainClassOf', () => {
  it('classifies by distance from the waterline', () => {
    expect(terrainClassOf(SEA_LEVEL)).toBe('shore');
    expect(terrainClassOf(SEA_LEVEL + SHORE_HEIGHT_MARGIN)).toBe('shore');
    expect(terrainClassOf(SEA_LEVEL - SHORE_HEIGHT_MARGIN)).toBe('shore');
    expect(terrainClassOf(SEA_LEVEL + SHORE_HEIGHT_MARGIN + 1)).toBe('land');
    expect(terrainClassOf(SEA_LEVEL - SHORE_HEIGHT_MARGIN - 1)).toBeNull();
  });
});

function stubWorld(options: { size: number; height: number; locked?: (x: number, y: number) => boolean }): SpawnWorld {
  return {
    worldSize: options.size,
    heightAt: () => options.height,
    isCellUnlocked: (x, y) => !(options.locked?.(x, y) ?? false),
  };
}

describe('chooseRelicCell', () => {
  const rng = () => createRelicRng(RELIC_RNG_DEFAULT_SEED);

  it('never returns a locked cell', () => {
    const world = stubWorld({
      size: 64,
      height: 0,
      locked: (x, y) => x >= 32 || y >= 32,
    });

    const generator = rng();
    for (let n = 0; n < 50; n++) {
      const cell = chooseRelicCell(world, generator, new Set(), 'shore');
      if (cell === null) continue;
      expect(cell.x).toBeLessThan(32);
      expect(cell.y).toBeLessThan(32);
    }
  });

  it('never returns an occupied cell', () => {
    const size = 4;
    const world = stubWorld({ size, height: 0 });
    const occupied = new Set<number>();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (x === 3 && y === 3) continue;
        occupied.add(y * size + x);
      }
    }

    const cell = chooseRelicCell(world, rng(), occupied, 'shore');
    expect(cell).toEqual({ x: 3, y: 3 });
  });

  it('honours the preferred terrain when the world offers it', () => {
    const world = stubWorld({ size: 32, height: SEA_LEVEL + BAND_HEIGHT * 4 });
    expect(chooseRelicCell(world, rng(), new Set(), 'land')).not.toBeNull();
  });

  it('relaxes to any unlocked cell rather than starving on a flat new world', () => {
    const world = stubWorld({ size: 32, height: SEA_LEVEL });
    expect(chooseRelicCell(world, rng(), new Set(), 'land')).not.toBeNull();
    expect(RELIC_PREFERRED_TERRAIN_ATTEMPTS).toBeLessThan(RELIC_SPAWN_ATTEMPTS);
  });

  it('gives up rather than looping when nothing qualifies', () => {
    const world = stubWorld({ size: 32, height: 0, locked: () => true });
    expect(chooseRelicCell(world, rng(), new Set(), 'shore')).toBeNull();

    const drowned = stubWorld({ size: 32, height: SEA_LEVEL - SHORE_HEIGHT_MARGIN - 1 });
    expect(chooseRelicCell(drowned, rng(), new Set(), 'shore')).toBeNull();
  });

  it('handles a world with no size at all', () => {
    expect(chooseRelicCell(stubWorld({ size: 0, height: 0 }), rng(), new Set(), 'shore')).toBeNull();
  });
});

describe('terraform shapes', () => {
  const allSteps = [...QUAKE_STEPS, ...GENESIS_STEPS, ...BULWARK_STEPS];

  it('never asks the shared brush for a radius it throws on', () => {
    for (const step of allSteps) {
      expect(Number.isInteger(step.radius)).toBe(true);
      expect(step.radius).toBeGreaterThanOrEqual(MIN_BRUSH_RADIUS);
      expect(step.radius).toBeLessThanOrEqual(MAX_BRUSH_RADIUS);
      expect(Number.isInteger(step.amount)).toBe(true);
      expect(Math.abs(step.amount % BAND_HEIGHT)).toBe(0);
    }
  });

  it('composes past the single-brush cap', () => {
    for (const steps of [QUAKE_STEPS, GENESIS_STEPS]) {
      expect(steps.length).toBeGreaterThan(1);
      const reach = Math.max(...steps.map((step) => Math.abs(step.dx) + step.radius));
      expect(reach).toBeGreaterThan(MAX_BRUSH_RADIUS);
    }
    expect(TERRAFORM_RING_OFFSET).toBe(MAX_BRUSH_RADIUS);
  });

  it('digs with Quake and raises with Genesis', () => {
    for (const step of QUAKE_STEPS) expect(step.amount).toBeLessThan(0);
    for (const step of GENESIS_STEPS) expect(step.amount).toBeGreaterThan(0);
  });

  it('centres each shape on the target cell exactly once', () => {
    for (const steps of [QUAKE_STEPS, GENESIS_STEPS]) {
      const centres = steps.filter((step) => step.dx === 0 && step.dy === 0);
      expect(centres).toHaveLength(1);
    }
    expect(Math.abs(QUAKE_STEPS[0].amount)).toBe(QUAKE_CORE_DEPTH_BANDS * BAND_HEIGHT);
  });

  it('is defined for exactly the active skills', () => {
    expect([...TERRAFORM_BY_SKILL.keys()].sort()).toEqual([
      'bulwark',
      'genesis',
      'landslide',
      'quake',
    ]);
  });

  it('stays inside a small footprint on real terrain, through the plugin sculpt path', { timeout: 60_000 }, () => {
    const OVER_STEEP_SLOPE = Math.ceil(MAX_STEP * 1.5);
    const LEGAL_SLOPE = Math.floor(MAX_STEP * 0.75);

    const CAST_CELL_BUDGET = cellsOverArea(600);
    const size = cellsAcross(64);
    const cx = size / 2;
    const cy = size / 2;
    const mkMap = (slope: number) => {
      const map = createHeightmap(size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
          map.cells[y * size + x] = Math.max(0, 512 - d * slope);
        }
      }
      return map;
    };
    const mkWorld = (map: ReturnType<typeof createHeightmap>) =>
      ({ worldSize: size,
        heightAt(x: number, y: number): number {
          return map.cells[y * size + x] ?? 0;
        },
        sculpt(x: number, y: number, radius: number, amount: number): CellDiff[] {
        return applySculpt(map, x, y, radius, amount, PLUGIN_SCULPT_OPTIONS);
      } }) as unknown as WorldApi;

    for (const [skill, spec] of TERRAFORM_BY_SKILL) {
      {
        const map = mkMap(OVER_STEEP_SLOPE);
        const world = mkWorld(map);
        const steps = spec.plan(world, cx, cy);

        const footprint = new Set<number>();
        for (const step of steps) {
          forEachFootprintOffset(step.radius, (dx, dy) => {
            const x = cx + step.dx + dx;
            const y = cy + step.dy + dy;
            if (x >= 0 && y >= 0 && x < size && y < size) footprint.add(y * size + x);
          });
        }

        const before = map.cells.slice();
        applyTerraform(world, cx, cy, steps);

        let maxOutsideDelta = 0;
        for (let i = 0; i < map.cells.length; i++) {
          if (footprint.has(i)) continue;
          maxOutsideDelta = Math.max(maxOutsideDelta, Math.abs(map.cells[i] - before[i]));
        }
        expect(maxOutsideDelta).toBeLessThanOrEqual(BAND_HEIGHT - 1);
      }

      {
        const map = mkMap(LEGAL_SLOPE);
        const world = mkWorld(map);
        const steps = spec.plan(world, cx, cy);
        expect(applyTerraform(world, cx, cy, steps)).toBeLessThanOrEqual(CAST_CELL_BUDGET);
      }

      expect(['bulwark', 'genesis', 'landslide', 'quake']).toContain(skill);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { cellsAcross, createSeededRng } from '@terrace/shared';
import {
  DISC_DESPAWN_MARGIN_RADII,
  DISC_EQUILIBRIUM_OCCUPANCY,
  DISC_SPAWN_MARGIN_RADII,
  type DiscSystem,
  discActiveCapFor,
  discHasLeftWorld,
  discMeanFootprintCells,
  discMeanRadiusFor,
} from '../src/plugins/kit/discGeometry.ts';
import { createDiscSystems } from '../src/plugins/kit/discSystems.ts';

const COVERAGE_FRACTION = 0.09;

const CEILING = 7;

const DISC_RADIUS = cellsAcross(24);

const NUDGE_CELLS = 1;

const SHIPPED_WORLD = cellsAcross(512);

const TRIPLED_AREA_SCALE = 3;

function realisedCoverage(worldSize: number, areaScale: number, population: number): number {
  const edge = worldSize + 2 * discMeanRadiusFor(worldSize, areaScale) * DISC_SPAWN_MARGIN_RADII;
  return (
    (population * discMeanFootprintCells(worldSize, areaScale) * DISC_EQUILIBRIUM_OCCUPANCY) /
    (edge * edge)
  );
}

function discAt(x: number, y: number): DiscSystem {
  return { id: 1, x, y, radius: DISC_RADIUS, peakIntensity: 1, envelope: 1, retiring: false };
}

describe('discActiveCapFor', () => {
  it('grows with the world at coverage 0.09 under a ceiling of 7', () => {
    expect(discActiveCapFor(512, COVERAGE_FRACTION, CEILING)).toBe(1);
    expect(discActiveCapFor(1024, COVERAGE_FRACTION, CEILING)).toBe(2);
    expect(discActiveCapFor(2048, COVERAGE_FRACTION, CEILING)).toBe(7);
  });

  it('derives the population from the scaled footprint, so coverage holds (2026-09-15)', () => {
    const spec = {
      coverageFraction: COVERAGE_FRACTION,
      maxActiveSystems: CEILING,
      random: createSeededRng(1).next,
    };
    const base = createDiscSystems({ ...spec, footprintAreaScale: 1 });
    const tripled = createDiscSystems({ ...spec, footprintAreaScale: TRIPLED_AREA_SCALE });
    const population = tripled.capFor(SHIPPED_WORLD);
    expect(population).toBeLessThan(base.capFor(SHIPPED_WORLD));

    const realised = realisedCoverage(SHIPPED_WORLD, TRIPLED_AREA_SCALE, population);
    const oneSystem = realisedCoverage(SHIPPED_WORLD, TRIPLED_AREA_SCALE, 1);
    expect(Math.abs(realised - COVERAGE_FRACTION)).toBeLessThanOrEqual(oneSystem / 2);
  });
});

describe('discHasLeftWorld', () => {
  const WORLD_SIZE = cellsAcross(512);
  const margin = DISC_RADIUS * DISC_DESPAWN_MARGIN_RADII;

  it('holds a disc until its centre passes 1.5 radii beyond the edge', () => {
    expect(discHasLeftWorld(discAt(-margin + NUDGE_CELLS, WORLD_SIZE / 2), WORLD_SIZE)).toBe(false);
    expect(discHasLeftWorld(discAt(-margin - NUDGE_CELLS, WORLD_SIZE / 2), WORLD_SIZE)).toBe(true);
    expect(
      discHasLeftWorld(discAt(WORLD_SIZE / 2, WORLD_SIZE + margin - NUDGE_CELLS), WORLD_SIZE),
    ).toBe(false);
    expect(
      discHasLeftWorld(discAt(WORLD_SIZE / 2, WORLD_SIZE + margin + NUDGE_CELLS), WORLD_SIZE),
    ).toBe(true);
  });

  it('never fires on a disc the kit has just sited', () => {
    const engine = createDiscSystems({
      coverageFraction: COVERAGE_FRACTION,
      maxActiveSystems: CEILING,
      random: createSeededRng(2).next,
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      const born = engine.spawnOne(WORLD_SIZE)!;
      expect(discHasLeftWorld(born, WORLD_SIZE)).toBe(false);
      engine.reset();
    }
  });
});

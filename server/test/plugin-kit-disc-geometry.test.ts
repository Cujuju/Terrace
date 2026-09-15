import { describe, expect, it } from 'vitest';
import { cellsAcross, createSeededRng } from '@terrace/shared';
import {
  DISC_DESPAWN_MARGIN_RADII,
  type DiscSystem,
  discActiveCapFor,
  discHasLeftWorld,
} from '../src/plugins/kit/discGeometry.ts';
import { createDiscSystems } from '../src/plugins/kit/discSystems.ts';

const COVERAGE_FRACTION = 0.09;

const CEILING = 7;

const DISC_RADIUS = cellsAcross(24);

const NUDGE_CELLS = 1;

function discAt(x: number, y: number): DiscSystem {
  return { id: 1, x, y, radius: DISC_RADIUS, peakIntensity: 1, envelope: 1, retiring: false };
}

describe('discActiveCapFor', () => {
  it('grows with the world at coverage 0.09 under a ceiling of 7', () => {
    expect(discActiveCapFor(512, COVERAGE_FRACTION, CEILING)).toBe(1);
    expect(discActiveCapFor(1024, COVERAGE_FRACTION, CEILING)).toBe(2);
    expect(discActiveCapFor(2048, COVERAGE_FRACTION, CEILING)).toBe(7);
  });

  it('ignores footprintAreaScale — population is fixed, coverage scales (d73f7f62)', () => {
    const spec = {
      coverageFraction: COVERAGE_FRACTION,
      maxActiveSystems: CEILING,
      random: createSeededRng(1).next,
    };
    const base = createDiscSystems({ ...spec, footprintAreaScale: 1 });
    const tripled = createDiscSystems({ ...spec, footprintAreaScale: 3 });
    expect(tripled.capFor(2048)).toBe(base.capFor(2048));
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

import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import {
  createWorkshop,
  ellipsoid,
  surfaceArraysOf,
  type SkinFinish,
  type SurfaceArrays,
} from '../client/geometry.ts';
import { buildTemplate, type TemplateKey } from '../client/models.ts';
import { YETI_VARIANTS } from '../protocol.ts';

const SKIN: SkinFinish = {
  wrinkleDepth: 0.02,
  wrinkleFrequency: 9,
  shadeVariation: 0.1,
  shadeFrequency: 4,
};

const SEGMENTS = 12;
const RINGS = 9;

const parts = (): BufferGeometry[] => [ellipsoid(1, 2, 1, SEGMENTS, RINGS), ellipsoid(0.5, 0.5, 0.5, SEGMENTS, RINGS)];

const arraysOf = (geometry: BufferGeometry) => ({
  attributes: Object.fromEntries(
    Object.entries(geometry.attributes).map(([name, attribute]) => [name, Array.from(attribute.array as ArrayLike<number>)]),
  ),
  index: Array.from((geometry.index?.array ?? []) as ArrayLike<number>),
});

function recorded(): { bank: Map<string, SurfaceArrays>; local: BufferGeometry } {
  const bank = new Map<string, SurfaceArrays>();
  const local = createWorkshop({ record: (key, geometry) => bank.set(key, surfaceArraysOf(geometry)) }).organicSurface(
    parts(),
    SKIN,
  );
  return { bank, local };
}

describe('organic surfaces handed over from the template worker', () => {
  it('a banked surface is identical to the one built locally', () => {
    const { bank, local } = recorded();
    const banked = createWorkshop({ bank }).organicSurface(parts(), SKIN);
    expect(bank.size).toBe(1);
    expect(arraysOf(banked)).toEqual(arraysOf(local));
  });

  it('any change to the inputs misses the bank and builds locally', () => {
    const { bank } = recorded();
    let misses = 0;
    const record = (): void => void misses++;
    const moved = parts();
    moved[0]!.translate(0, 1e-6, 0);
    createWorkshop({ bank, record }).organicSurface(moved, SKIN);
    createWorkshop({ bank, record }).organicSurface(parts(), { ...SKIN, shadeVariation: SKIN.shadeVariation * 2 });
    createWorkshop({ bank, record }).organicSurface(parts().slice(0, 1), SKIN);
    expect(misses).toBe(3);
  });

  it('every template finds each of its surfaces in a bank another run filled', () => {
    const keys: TemplateKey[] = [...YETI_VARIANTS.map((variant) => `yeti:${variant}` as const), 'cthulhu', 'kraken'];
    for (const key of keys) {
      const bank = new Map<string, SurfaceArrays>();
      buildTemplate(createWorkshop({ record: (surfaceKey, geometry) => bank.set(surfaceKey, surfaceArraysOf(geometry)) }), key);
      let misses = 0;
      buildTemplate(createWorkshop({ bank, record: () => void misses++ }), key);
      expect({ key, misses, surfaces: bank.size > 0 }).toEqual({ key, misses: 0, surfaces: true });
    }
  });
});

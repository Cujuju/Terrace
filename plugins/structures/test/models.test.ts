import './support/headlessCanvas.ts';

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Vector3 } from 'three';
import {
  MAX_STRUCTURE_TIER,
  STRUCTURE_SCALE_MAX,
  STRUCTURE_SURVEYED_GROUND_RADIUS,
  STRUCTURE_TIERS,
  STRUCTURE_TIER_COUNT,
  type SettlerRace,
} from '../protocol.ts';
import {
  STRUCTURE_FOOTPRINT_RADIUS,
  createStructureModels,
  type StructurePlacement,
} from '../client/models.ts';
import { isDurandsCell } from '../client/durands.ts';
import { FISHING_HUT_BUILDERS, FISHING_HUT_NAMES, fishingHutVariantIndex } from '../client/fishingHuts.ts';
import { mergeParts, partsReach } from '../client/parts.ts';
import type { SiteKind } from '../client/site.ts';

function placementAt(
  cellX: number,
  cellY: number,
  tier: number,
  site: SiteKind,
  race: SettlerRace = 'rudy',
): StructurePlacement {
  return { x: 0, z: 0, cellX, cellY, groundY: 0, tier, scale: 1, yaw: 0, race, site };
}

interface Extent {
  readonly axis: number;
  readonly radial: number;
  readonly top: number;
  readonly drawCalls: number;
}

function measureDrawn(root: { traverse(cb: (o: unknown) => void): void }): Extent {
  const vertex = new Vector3();
  const instance = new Matrix4();
  let axis = 0;
  let radial = 0;
  let top = 0;
  let drawCalls = 0;

  root.traverse((object) => {
    if (!(object instanceof InstancedMesh) || object.count === 0) return;
    drawCalls++;
    const position = object.geometry.getAttribute('position');
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, instance);
      for (let v = 0; v < position.count; v++) {
        vertex.fromBufferAttribute(position, v).applyMatrix4(instance);
        axis = Math.max(axis, Math.abs(vertex.x), Math.abs(vertex.z));
        radial = Math.max(radial, Math.hypot(vertex.x, vertex.z));
        top = Math.max(top, vertex.y);
      }
    }
  });

  return { axis, radial, top, drawCalls };
}

const HUT_LIT_PART_ALLOWANCE = 1;

function cellRollingVariant(variant: number): { x: number; y: number } {
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (fishingHutVariantIndex(x, y) === variant) return { x, y };
    }
  }
  throw new Error(`no cell in the search window rolls fishing-hut variant ${variant}`);
}

describe('the footprint bound, measured rather than asserted', () => {
  it('every standard tier draws inside STRUCTURE_FOOTPRINT_RADIUS', () => {
    const models = createStructureModels();
    try {
      for (let tier = 0; tier < STRUCTURE_TIER_COUNT; tier++) {
        models.apply([placementAt(1, 1, tier, 'inland')]);
        const extent = measureDrawn(models.root);
        expect(extent.drawCalls, `${STRUCTURE_TIERS[tier]} drew nothing`).toBeGreaterThan(0);
        expect(
          extent.axis,
          `tier ${tier} (${STRUCTURE_TIERS[tier]}) reaches ${extent.axis.toFixed(3)} wu, bound ${STRUCTURE_FOOTPRINT_RADIUS.toFixed(3)}`,
        ).toBeLessThanOrEqual(STRUCTURE_FOOTPRINT_RADIUS);
      }
    } finally {
      models.dispose();
    }
  });

  it('every fishing-hut variant draws inside STRUCTURE_FOOTPRINT_RADIUS — fish, drying racks and all', () => {
    const models = createStructureModels();
    try {
      for (let variant = 0; variant < FISHING_HUT_BUILDERS.length; variant++) {
        const cell = cellRollingVariant(variant);
        models.apply([placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER, 'coastal')]);
        const extent = measureDrawn(models.root);
        expect(extent.drawCalls, `${FISHING_HUT_NAMES[variant]} drew nothing`).toBeGreaterThan(0);
        expect(
          extent.axis,
          `${FISHING_HUT_NAMES[variant]} reaches ${extent.axis.toFixed(3)} wu, bound ${STRUCTURE_FOOTPRINT_RADIUS.toFixed(3)}`,
        ).toBeLessThanOrEqual(STRUCTURE_FOOTPRINT_RADIUS);
      }
    } finally {
      models.dispose();
    }
  });

  it('the bound holds on the model as BUILT, not only as drawn — every builder, straight from the source', () => {
    for (let variant = 0; variant < FISHING_HUT_BUILDERS.length; variant++) {
      const parts = FISHING_HUT_BUILDERS[variant]();
      const reach = partsReach(parts);
      expect(
        reach,
        `${FISHING_HUT_NAMES[variant]} reaches ${reach.toFixed(3)} wu, bound ${STRUCTURE_FOOTPRINT_RADIUS.toFixed(3)}`,
      ).toBeLessThanOrEqual(STRUCTURE_FOOTPRINT_RADIUS);
      for (const part of parts) part.geometry.dispose();
    }
  });

  it('no model can sweep past the ground the server surveyed, at ANY yaw or scale', () => {
    const maxRadial = STRUCTURE_SURVEYED_GROUND_RADIUS / STRUCTURE_SCALE_MAX;
    const models = createStructureModels();
    try {
      const cases: Array<{ name: string; placement: StructurePlacement }> = [];
      for (let tier = 0; tier < STRUCTURE_TIER_COUNT; tier++) {
        cases.push({ name: `tier ${tier} (${STRUCTURE_TIERS[tier]})`, placement: placementAt(1, 1, tier, 'inland') });
      }
      for (let variant = 0; variant < FISHING_HUT_BUILDERS.length; variant++) {
        const cell = cellRollingVariant(variant);
        cases.push({
          name: FISHING_HUT_NAMES[variant],
          placement: placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER, 'coastal'),
        });
      }
      let durands: { x: number; y: number } | null = null;
      for (let y = 0; y < 64 && durands === null; y++) {
        for (let x = 0; x < 64; x++) {
          if (isDurandsCell(MAX_STRUCTURE_TIER, x, y)) { durands = { x, y }; break; }
        }
      }
      expect(durands, 'no Durand’s cell in the search window').not.toBeNull();
      cases.push({ name: "Durand's", placement: placementAt(durands!.x, durands!.y, MAX_STRUCTURE_TIER, 'inland') });

      for (const { name, placement } of cases) {
        models.apply([placement]);
        const extent = measureDrawn(models.root);
        expect(
          extent.radial,
          `${name} sweeps ${extent.radial.toFixed(3)} wu when yawed; the server only surveys ${maxRadial.toFixed(3)} (× scale ${STRUCTURE_SCALE_MAX})`,
        ).toBeLessThanOrEqual(maxRadial);
      }
    } finally {
      models.dispose();
    }
  });

  it('a building at maximum variation scale is still no wider than its own world unit', () => {
    expect(STRUCTURE_FOOTPRINT_RADIUS * STRUCTURE_SCALE_MAX * 2).toBeCloseTo(1, 10);
  });
});

describe('the fishing-hut variant roll', () => {
  it('is deterministic and independent of the yaw/scale/Durand rolls it shares a cell hash with', () => {
    for (let i = 0; i < 50; i++) {
      const first = fishingHutVariantIndex(i, i * 7);
      expect(fishingHutVariantIndex(i, i * 7)).toBe(first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(FISHING_HUT_BUILDERS.length);
    }
  });

  it('spreads reasonably evenly across the ten models', () => {
    const counts = new Array<number>(FISHING_HUT_BUILDERS.length).fill(0);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) counts[fishingHutVariantIndex(x, y)]++;
    }
    const expected = (64 * 64) / FISHING_HUT_BUILDERS.length;
    for (let variant = 0; variant < counts.length; variant++) {
      expect(counts[variant], `${FISHING_HUT_NAMES[variant]} rolled ${counts[variant]} of 4096`).toBeGreaterThan(expected * 0.65);
      expect(counts[variant], `${FISHING_HUT_NAMES[variant]} rolled ${counts[variant]} of 4096`).toBeLessThan(expected * 1.35);
    }
  });

  it('neighbouring cells do not share a model, so a shoreline is not a row of clones', () => {
    let matches = 0;
    const samples = 64 * 63;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 63; x++) {
        if (fishingHutVariantIndex(x, y) === fishingHutVariantIndex(x + 1, y)) matches++;
      }
    }
    expect(matches / samples).toBeLessThan(0.2);
  });
});

describe('merging: the authored part list is not the drawn part list', () => {
  it('collapses parts to one per material without moving a single vertex', () => {
    for (let variant = 0; variant < FISHING_HUT_BUILDERS.length; variant++) {
      const parts = FISHING_HUT_BUILDERS[variant]();
      const materials = new Set(parts.map((part) => part.material));
      expect(materials.size, `${FISHING_HUT_NAMES[variant]} has a duplicate material after merging`).toBe(parts.length);
      for (const part of parts) {
        expect(part.localMatrices).toHaveLength(1);
        expect(part.localMatrices[0].equals(new Matrix4())).toBe(true);
      }
      for (const part of parts) part.geometry.dispose();
    }
  });

  it('preserves geometry exactly: merging a part list does not change its reach', () => {
    const models = createStructureModels();
    try {
      for (let variant = 0; variant < FISHING_HUT_BUILDERS.length; variant++) {
        const cell = cellRollingVariant(variant);
        models.apply([placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER, 'coastal')]);
        const drawn = measureDrawn(models.root);
        const built = partsReach(FISHING_HUT_BUILDERS[variant]());
        expect(drawn.axis).toBeCloseTo(built, 5);
      }
    } finally {
      models.dispose();
    }
  });

  it('no hut costs meaningfully more draw calls than the priciest standard tier it stands beside', () => {
    const models = createStructureModels();
    try {
      let tierCeiling = 0;
      for (let tier = 0; tier < STRUCTURE_TIER_COUNT; tier++) {
        models.apply([placementAt(1, 1, tier, 'inland')]);
        tierCeiling = Math.max(tierCeiling, measureDrawn(models.root).drawCalls);
      }

      for (let variant = 0; variant < FISHING_HUT_BUILDERS.length; variant++) {
        const cell = cellRollingVariant(variant);
        models.apply([placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER, 'coastal')]);
        const extent = measureDrawn(models.root);
        const ceiling = tierCeiling + HUT_LIT_PART_ALLOWANCE;
        expect(
          extent.drawCalls,
          `${FISHING_HUT_NAMES[variant]} draws in ${extent.drawCalls} calls; the priciest standard tier draws in ${tierCeiling}, allowance ${HUT_LIT_PART_ALLOWANCE}`,
        ).toBeLessThanOrEqual(ceiling);
      }
    } finally {
      models.dispose();
    }
  });

  it('a whole shoreline of one variant still costs one hut’s worth of draw calls', () => {
    const models = createStructureModels();
    try {
      const cell = cellRollingVariant(0);
      models.apply([placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER, 'coastal')]);
      const one = measureDrawn(models.root).drawCalls;

      const shoreline: StructurePlacement[] = [];
      for (let i = 0; i < 40; i++) {
        shoreline.push({ ...placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER, 'coastal'), x: i * 0.25 });
      }
      models.apply(shoreline);
      expect(measureDrawn(models.root).drawCalls).toBe(one);
    } finally {
      models.dispose();
    }
  });

  it('merges nothing away: an empty part list stays empty', () => {
    expect(mergeParts([])).toEqual([]);
  });
});

describe('site variants replace the top tier, and only the top tier', () => {
  it('a coastal settlement below the top tier renders its ordinary tier model', () => {
    const models = createStructureModels();
    try {
      const cell = cellRollingVariant(0);
      models.apply([placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER - 1, 'coastal')]);
      const coastal = measureDrawn(models.root);
      models.apply([placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER - 1, 'inland')]);
      const inland = measureDrawn(models.root);
      expect(coastal.axis).toBeCloseTo(inland.axis, 10);
      expect(coastal.top).toBeCloseTo(inland.top, 10);
    } finally {
      models.dispose();
    }
  });

  it('a coastal top-tier settlement is a hut, not the watchtower', () => {
    const models = createStructureModels();
    try {
      const cell = cellRollingVariant(3);
      models.apply([placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER, 'coastal')]);
      const coastal = measureDrawn(models.root);
      models.apply([placementAt(cell.x, cell.y, MAX_STRUCTURE_TIER, 'inland')]);
      const inland = measureDrawn(models.root);
      expect(coastal.top).toBeLessThan(inland.top);
    } finally {
      models.dispose();
    }
  });

  it('site wins over the Durand’s roll on a cell that rolled both', () => {
    let conflicted: { x: number; y: number } | null = null;
    for (let y = 0; y < 64 && conflicted === null; y++) {
      for (let x = 0; x < 64; x++) {
        if (isDurandsCell(MAX_STRUCTURE_TIER, x, y)) { conflicted = { x, y }; break; }
      }
    }
    expect(conflicted, 'no Durand’s cell in the search window').not.toBeNull();

    const models = createStructureModels();
    try {
      models.apply([placementAt(conflicted!.x, conflicted!.y, MAX_STRUCTURE_TIER, 'coastal')]);
      const asCoastal = measureDrawn(models.root);
      models.apply([placementAt(conflicted!.x, conflicted!.y, MAX_STRUCTURE_TIER, 'inland')]);
      const asDurands = measureDrawn(models.root);
      expect(asCoastal.top).toBeLessThan(asDurands.top);
    } finally {
      models.dispose();
    }
  });
});

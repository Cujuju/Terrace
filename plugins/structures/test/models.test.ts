import './support/headlessCanvas.ts';

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Vector3 } from 'three';
import {
  STRUCTURE_LEGACY_SURVEYED_GROUND_RADIUS,
  STRUCTURE_SCALE_MAX,
  type SettlerRace,
} from '../protocol.ts';
import {
  STRUCTURE_FOOTPRINT_RADIUS,
  createStructureModels,
  type StructurePlacement,
} from '../client/models.ts';
import { FISHING_HUT_BUILDERS, FISHING_HUT_NAMES } from '../client/fishingHuts.ts';
import { mergeParts, partsReach } from '../client/parts.ts';
import type { SiteKind } from '../client/site.ts';
import { baseModelOf } from '../buildingKinds.ts';
import {
  BUILDING_KIND_COUNT,
  buildingIdOf,
  buildingKindOf,
  isLandmarkKind,
  tierOfKind,
} from '../settlementRules.ts';

function placementOf(kind: number, site: SiteKind = 'inland', race: SettlerRace = 'rudy'): StructurePlacement {
  return { x: 0, z: 0, cellX: 1, cellY: 1, groundY: 0, tier: tierOfKind(kind), kind, scale: 1, yaw: 0, race, site };
}

const ALL_KINDS: readonly number[] = Array.from({ length: BUILDING_KIND_COUNT }, (_, kind) => kind);

// client/models.ts has no procedural stand-in for these; only the GLB kit draws them.
const KIT_ONLY_BUILDINGS: ReadonlySet<string> = new Set(['ricks', 'flipper-shrimp']);

const PROCEDURAL_KINDS = ALL_KINDS.filter((kind) => !KIT_ONLY_BUILDINGS.has(buildingIdOf(kind)));

function isFishingHut(kind: number): boolean {
  return FISHING_HUT_NAMES.includes(baseModelOf(buildingIdOf(kind)));
}

/** Standard buildings: neither a fishing hut nor a landmark. */
const LADDER_KINDS = ALL_KINDS.filter((kind) => !isFishingHut(kind) && !isLandmarkKind(kind));

/** The building kind each fishing-hut builder draws. */
function hutKind(variant: number): number {
  return buildingKindOf(FISHING_HUT_NAMES[variant]!)!;
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

describe('the footprint bound, measured rather than asserted', () => {
  it('every standard building and fishing hut draws inside STRUCTURE_FOOTPRINT_RADIUS', () => {
    const models = createStructureModels();
    try {
      for (const kind of ALL_KINDS.filter((k) => !isLandmarkKind(k))) {
        const id = buildingIdOf(kind);
        models.apply([placementOf(kind)]);
        const extent = measureDrawn(models.root);
        expect(extent.drawCalls, `${id} drew nothing`).toBeGreaterThan(0);
        expect(
          extent.axis,
          `${id} reaches ${extent.axis.toFixed(3)} wu, bound ${STRUCTURE_FOOTPRINT_RADIUS.toFixed(3)}`,
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

  it('no procedural model can sweep past the ground the server surveyed, at ANY yaw or scale', () => {
    const maxRadial = STRUCTURE_LEGACY_SURVEYED_GROUND_RADIUS / STRUCTURE_SCALE_MAX;
    const models = createStructureModels();
    try {
      for (const kind of PROCEDURAL_KINDS) {
        const id = buildingIdOf(kind);
        models.apply([placementOf(kind)]);
        const extent = measureDrawn(models.root);
        expect(extent.drawCalls, `${id} drew nothing`).toBeGreaterThan(0);
        expect(
          extent.radial,
          `${id} sweeps ${extent.radial.toFixed(3)} wu when yawed; the server only surveys ${maxRadial.toFixed(3)} (× scale ${STRUCTURE_SCALE_MAX})`,
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
        models.apply([placementOf(hutKind(variant), 'coastal')]);
        const drawn = measureDrawn(models.root);
        const built = partsReach(FISHING_HUT_BUILDERS[variant]());
        expect(drawn.axis).toBeCloseTo(built, 5);
      }
    } finally {
      models.dispose();
    }
  });

  it('no hut costs meaningfully more draw calls than the priciest standard building it stands beside', () => {
    const models = createStructureModels();
    try {
      let ladderCeiling = 0;
      for (const kind of LADDER_KINDS) {
        models.apply([placementOf(kind)]);
        ladderCeiling = Math.max(ladderCeiling, measureDrawn(models.root).drawCalls);
      }

      for (let variant = 0; variant < FISHING_HUT_BUILDERS.length; variant++) {
        models.apply([placementOf(hutKind(variant), 'coastal')]);
        const extent = measureDrawn(models.root);
        const ceiling = ladderCeiling + HUT_LIT_PART_ALLOWANCE;
        expect(
          extent.drawCalls,
          `${FISHING_HUT_NAMES[variant]} draws in ${extent.drawCalls} calls; the priciest standard building draws in ${ladderCeiling}, allowance ${HUT_LIT_PART_ALLOWANCE}`,
        ).toBeLessThanOrEqual(ceiling);
      }
    } finally {
      models.dispose();
    }
  });

  it('a whole shoreline of one variant still costs one hut’s worth of draw calls', () => {
    const models = createStructureModels();
    try {
      const hut = placementOf(hutKind(0), 'coastal');
      models.apply([hut]);
      const one = measureDrawn(models.root).drawCalls;

      const shoreline: StructurePlacement[] = [];
      for (let i = 0; i < 40; i++) shoreline.push({ ...hut, x: i * 0.25 });
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

describe('the client draws the building the server chose', () => {
  it('site never changes the model: one kind draws alike on the coast and inland', () => {
    const models = createStructureModels();
    try {
      for (const kind of ALL_KINDS) {
        models.apply([placementOf(kind, 'coastal')]);
        const coastal = measureDrawn(models.root);
        models.apply([placementOf(kind, 'inland')]);
        const inland = measureDrawn(models.root);
        expect(coastal, buildingIdOf(kind)).toEqual(inland);
      }
    } finally {
      models.dispose();
    }
  });

  it('the kind, not the tier, picks the model: two tier-1 buildings draw differently', () => {
    const hut = buildingKindOf('hut')!;
    const aFrame = buildingKindOf('lashed-a-frame')!;
    expect(tierOfKind(hut)).toBe(tierOfKind(aFrame));

    const models = createStructureModels();
    try {
      models.apply([placementOf(hut)]);
      const ladderHut = measureDrawn(models.root);
      models.apply([placementOf(aFrame)]);
      const fishingHut = measureDrawn(models.root);
      expect(fishingHut).not.toEqual(ladderHut);
    } finally {
      models.dispose();
    }
  });
});

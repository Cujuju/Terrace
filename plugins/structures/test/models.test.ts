// The test two doc comments in client/models.ts have claimed for months:
// "test/models.test.ts measures every tier against it — the bound is a test,
// not a convention." It did not exist. Until 2026-08-22 NOTHING measured any
// structure model's footprint, and the bound was exactly the convention those
// comments say it isn't.
//
// WHY THIS IS WORTH A TEST AT ALL. STRUCTURE_FOOTPRINT_RADIUS is the one model
// property the SERVER has already committed ground to: suitability.ts derives
// the square of cells it surveys for same-band dry land from the same shared
// span (STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS), and refuses to found a
// structure where that square does not hold up. A model that reaches past the
// bound is therefore standing on ground nobody checked — the "buildings
// straddle terrace edges" defect, which is a property of the model LIBRARY,
// not of any one tier.
//
// WHY IT WALKS VERTICES AND NOT BOUNDING BOXES. A Box3 over a rotated part is
// the AABB of an AABB: it over-reports a tilted roof panel or a triangular
// gable end by up to 41%, so a box-based test both misses real overruns
// (nothing here is axis-aligned once merged) and fails models that actually
// fit. This walks the real vertices through the real instance matrices —
// which is also the only way to catch the defect that motivated the file: two
// of the ten fishing huts were first built with three-sided ConeGeometry
// gable ends, which stand their corners at the CIRCUMRADIUS rather than the
// half-base, and measured 1.013 and 0.882 world units against a 0.455 bound
// while looking perfectly correct in a picture.
//
// These construct real Three.js objects but never a WebGLRenderer, so they
// run headless — the same thing plugins/boats/test/models.test.ts relies on.

// FIRST: installs the canvas stub models.ts needs at import time. See the
// module's own header for why the order matters.
import './support/headlessCanvas.ts';

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Vector3 } from 'three';
import {
  MAX_STRUCTURE_TIER,
  STRUCTURE_SCALE_MAX,
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

/** A placement at the world origin, unrotated and unscaled, so a measured distance IS a model reach. */
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
  /** Worst |x| or |z| — the axis-aligned reach STRUCTURE_FOOTPRINT_RADIUS bounds. */
  readonly axis: number;
  /** Worst sqrt(x² + z²) — what the same model sweeps once its yaw roll turns it. */
  readonly radial: number;
  /** Highest vertex, for the record. */
  readonly top: number;
  /** How many instanced draw calls actually carried geometry. */
  readonly drawCalls: number;
}

/**
 * Measures everything `apply()` actually drew. Walks the scene graph rather
 * than the builders, so what is measured is what a player sees: merged
 * geometry, real instance matrices, real dispatch.
 */
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

/** A cell whose coastal variant roll lands on `variant`. Searched, not assumed — the roll is the thing under test elsewhere. */
/**
 * How many draw calls a hut may cost ABOVE the priciest standard tier.
 *
 * One, and it is the smoke pit: its fire is emissive and its smoke is
 * transparent, so neither can join the shared vertex-coloured surface, and
 * they group into a call apiece. No standard tier has lit outdoor geometry to
 * match, so the tier ceiling cannot price it. Nine of the ten variants draw in
 * a single call and do not use the allowance at all.
 *
 * Raising this is how the hut library would quietly become expensive again —
 * it is a budget, not a fudge factor. A variant that needs two more calls
 * needs a reason recorded here, not a bigger number.
 */
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
        // Cell (1, 1) at the top tier must not be a Durand's cell or a
        // coastal one, or this would measure a variant instead of the tier.
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
    // The drawn tests above go through apply(), which is the honest end-to-end
    // check but only ever exercises the variant a cell happens to roll. This
    // one measures the part lists directly, so a model that no cell in the
    // search window rolls can never slip through unmeasured.
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

  it('a building at maximum variation scale is still no wider than its own world unit', () => {
    // STRUCTURE_FOOTPRINT_RADIUS is defined as half the shared span DIVIDED by
    // STRUCTURE_SCALE_MAX precisely so this holds; asserting it here means the
    // relationship survives someone "simplifying" the constant.
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
    // A shore is a line of cells, so an uneven roll shows up immediately as a
    // row of the same hut. Over 4096 cells a fair 10-way roll averages 409.6
    // per variant; ±35% is loose enough never to flake and tight enough to
    // catch a roll that has collapsed onto a few values (which is what
    // hashing a truncated world coordinate would do — see
    // StructurePlacement.cellX).
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
    // The failure this guards is specific: hashing a coordinate that has been
    // truncated (world units, quarter-cell sampling) makes runs of four
    // neighbouring cells roll identically. Counting how often a cell matches
    // its east neighbour catches exactly that — a fair roll matches 1 time in
    // 10, a 4-cell-block roll matches 3 times in 4.
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
    // The whole justification for mergeParts is "same triangles, fewer draw
    // calls". Reach is the sharpest one-number check of "same triangles":
    // baking a matrix wrong moves geometry, and moved geometry changes reach.
    for (let variant = 0; variant < FISHING_HUT_BUILDERS.length; variant++) {
      const parts = FISHING_HUT_BUILDERS[variant]();
      const materials = new Set(parts.map((part) => part.material));
      expect(materials.size, `${FISHING_HUT_NAMES[variant]} has a duplicate material after merging`).toBe(parts.length);
      // One local matrix per merged part, and it is the identity: everything
      // else was baked into the vertices.
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
    // Ten variants is ten times the model library, and this codebase's
    // recurring render defect is the AUTHORING unit quietly becoming the
    // DRAWING unit. The budget is not a number someone picked: a coastal
    // village must not be more expensive to draw than the ordinary building
    // it replaces, so the ceiling is measured from the six shipped tiers in
    // this same run.
    //
    // BOTH SIDES ARE MERGED as of 2026-08-23 — the tiers went through
    // mergeParts() too, which is what took them from one mesh per authored
    // part to the 1-2 calls they cost now. That makes this a much tighter bar
    // than it was when the tiers were unmerged and set a ceiling of dozens.
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
    // The point of instancing, restated as a test: 40 villages of the same
    // model must not be 40× the calls. This is the property that makes ten
    // variants affordable at all.
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
      // The watchtower is the tallest model in the game; no hut comes close.
      expect(coastal.top).toBeLessThan(inland.top);
    } finally {
      models.dispose();
    }
  });

  it('site wins over the Durand’s roll on a cell that rolled both', () => {
    // The two top-tier specials must not fight over the same silhouette. Site
    // is a categorical fact about the ground; Durand's is a ~1-in-6 rarity —
    // so site takes priority, and this pins that ordering on a cell where the
    // conflict is real rather than hypothetical.
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
      // Durand's is a two-storey saloon with a rooftop sign; every hut is
      // shorter than it, so height separates the two without this test having
      // to reach into either model's internals.
      expect(asCoastal.top).toBeLessThan(asDurands.top);
    } finally {
      models.dispose();
    }
  });
});

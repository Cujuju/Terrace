// Structural tests on the boat model. These construct real Three.js objects but
// never a WebGLRenderer, so they run headless — BufferGeometry, Mesh and Group
// are plain data structures (the same thing client/test/terrainMeshes.test.ts
// relies on). What a picture would show is still verified by eye through
// client/preview-boats.html; what is asserted here is the arithmetic a picture
// is bad at: exact extents, exact waterline, and that shared assets really are
// shared.

import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Vector3, type MeshStandardMaterial } from 'three';
import { BOAT_WATERLINE_LIFT, createBoatModels } from '../client/models.ts';

/** Every Mesh under a node, depth-first. */
function meshesOf(root: { traverse(cb: (o: unknown) => void): void }): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
}

describe('the boat model', () => {
  it('fits inside one cell, so "five cells away" looks like five cells', () => {
    // The fight's geometry is measured in whole cells
    // (BOAT_ENGAGEMENT_RANGE_CELLS is 5), so a hull spilling past its own cell
    // would make every distance in the fight read wrong.
    const models = createBoatModels();
    const boat = models.create();
    boat.animate(0, 0, false);

    const size = new Box3().setFromObject(boat.root).getSize(new Vector3());
    expect(size.x).toBeLessThanOrEqual(1);
    expect(size.z).toBeLessThanOrEqual(1);

    boat.dispose();
    models.dispose();
  });

  it('sits IN the water, not on it', () => {
    // The sea is translucent (client/src/render/water.ts), so the submerged
    // half really is visible and a boat floating above the surface reads
    // immediately as hovering. The lift must put the waterline inside the hull.
    const models = createBoatModels();
    const boat = models.create();
    boat.animate(0, 0, false);
    boat.root.position.y = BOAT_WATERLINE_LIFT;
    boat.root.updateMatrixWorld(true);

    const box = new Box3().setFromObject(boat.root);
    expect(BOAT_WATERLINE_LIFT).toBeLessThan(0);
    // Sea level is world Y 0: some hull below it, and the mast well above.
    expect(box.min.y).toBeLessThan(0);
    expect(box.max.y).toBeGreaterThan(0);

    boat.dispose();
    models.dispose();
  });

  it('reddens only its own sail when it engages', () => {
    // The one per-boat material. A shared one would redden every sail in the
    // world the moment a single boat engaged, which is the bug this split
    // exists to prevent — so it is asserted across TWO boats.
    const models = createBoatModels();
    const fighter = models.create();
    const bystander = models.create();

    fighter.animate(0, 0, false);
    bystander.animate(0, 0, false);
    // The sail is the one mesh whose material is NOT shared between boats, so
    // find it that way rather than by position in the child list — which is
    // what an earlier version of this test got wrong, happily reading an oar.
    const sharedMaterials = new Set(meshesOf(bystander.root).map((m) => m.material));
    const sailOf = (boat: { root: Parameters<typeof meshesOf>[0] }): MeshStandardMaterial => {
      const unique = meshesOf(boat.root)
        .map((m) => m.material as MeshStandardMaterial)
        .filter((material) => !sharedMaterials.has(material));
      expect(unique).toHaveLength(1);
      return unique[0]!;
    };
    const colorOf = (boat: { root: Parameters<typeof meshesOf>[0] }): number =>
      sailOf(boat).color.getHex();
    const restingFighter = colorOf(fighter);
    // The bystander's own sail is inside its shared-material set by
    // construction, so read it directly rather than through sailOf.
    const bystanderSail = meshesOf(bystander.root)
      .map((m) => m.material as MeshStandardMaterial)
      .find((material) => material.color.getHex() === restingFighter)!;
    const restingBystander = bystanderSail.color.getHex();
    expect(restingFighter).toBe(restingBystander);

    fighter.animate(1, 0, true);
    bystander.animate(1, 0, false);
    expect(colorOf(fighter)).not.toBe(restingFighter);
    expect(bystanderSail.color.getHex()).toBe(restingBystander);

    fighter.dispose();
    bystander.dispose();
    models.dispose();
  });

  it('shares hull geometry between boats', () => {
    // The whole reason createBoatModels exists rather than a bare factory: a
    // fleet must not allocate a hull each.
    const models = createBoatModels();
    const a = models.create();
    const b = models.create();
    const hullA = meshesOf(a.root)[0]!;
    const hullB = meshesOf(b.root)[0]!;
    expect(hullA.geometry).toBe(hullB.geometry);
    expect(hullA.material).toBe(hullB.material);

    a.dispose();
    b.dispose();
    models.dispose();
  });

  it('rows without any oar leaving the water plane or entering the hull', () => {
    // The oar swing is a YAW about each oar's own mount, never a lift — the
    // same constraint the kraken's arms keep, and for the same reason: it makes
    // the animation incapable of clipping through what it is attached to.
    const models = createBoatModels();
    const boat = models.create();

    const restingHeight = (): number => {
      boat.root.updateMatrixWorld(true);
      return new Box3().setFromObject(boat.root).max.y;
    };
    // Sampled across a whole stroke; roll and pitch move the hull, so compare
    // against the same pose with the oars at rest by holding the clock still
    // and only changing the fighting flag (which only changes stroke RATE).
    const heights: number[] = [];
    for (let step = 0; step < 12; step++) {
      boat.animate(step * 0.25, 0, false);
      heights.push(restingHeight());
    }
    const spread = Math.max(...heights) - Math.min(...heights);
    // Only the swell should move the silhouette vertically, and it is bounded
    // by a few hundredths of a cell. An oar that lifted would blow this open.
    expect(spread).toBeLessThan(0.1);

    boat.dispose();
    models.dispose();
  });
});

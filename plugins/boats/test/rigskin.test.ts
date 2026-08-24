// Pins the rigSkin port's win. Like models.test.ts this constructs real
// Three.js objects and never a WebGLRenderer, so it runs headless — a
// SkinnedMesh is drawable data whether or not a GPU is present.
//
// The number asserted here IS the deliverable: before the port one boat was 9
// Meshes (hull, deck, mast, sail, yard, 4 oars) = 9 draw calls; after it, the
// hull/deck/mast/yard/oars are ONE baked skinned surface and only the sail
// stays separate (its per-boat colour cannot live in shared vertex data — see
// the comment on the sail in client/models.ts). So: 2.

import { describe, expect, it } from 'vitest';
import { Bone, Mesh } from 'three';
import { createBoatModels } from '../client/models.ts';

/** Every Mesh under a node, depth-first — the renderer's unit of charging. */
function drawablesOf(root: { traverse(cb: (o: unknown) => void): void }): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
}

/** Every Bone under a node — the baked rig's animated handles. */
function bonesOf(root: { traverse(cb: (o: unknown) => void): void }): Bone[] {
  const found: Bone[] = [];
  root.traverse((object) => {
    if (object instanceof Bone) found.push(object);
  });
  return found;
}

describe('the boat as a rigged drawable', () => {
  it('draws TWO objects per boat: the rig surface plus the sail', () => {
    // One boat must cost its two draws and no more. A regression to per-part
    // meshes (or a second surface group in the bake — an indexed cylinder
    // beside a non-indexed extrusion would do it) shows up here immediately.
    const models = createBoatModels();
    const boat = models.create();
    boat.animate(0, 0, false);

    expect(drawablesOf(boat.root)).toHaveLength(2);

    boat.dispose();
    models.dispose();
  });

  it('keeps the rig at ONE surface, so nothing but the sail was left behind', () => {
    // Both boats share the same baked geometry; if the bake ever emits two
    // surfaces the total goes to 3 and this catches which side regressed.
    const models = createBoatModels();
    const a = models.create();
    const b = models.create();

    const [rigA, sailA] = drawablesOf(a.root);
    const [rigB] = drawablesOf(b.root);
    expect(rigA!.geometry).toBe(rigB!.geometry);
    expect(rigA!.material).toBe(rigB!.material);
    expect(sailA!.material).not.toBe(rigA!.material);

    a.dispose();
    b.dispose();
    models.dispose();
  });

  it('counter-swings the oars through their baked bones', () => {
    // The oar pivots are Bones now, not Groups, and userData does NOT survive
    // the bake — the side lives in a parallel array captured at author time.
    // Whatever the plumbing, the observable pose rule stands: port and
    // starboard pivot yaw in OPPOSITE senses each frame.
    const models = createBoatModels();
    const boat = models.create();

    // Step until the stroke is clearly away from zero so both signs are real,
    // not float noise around rest.
    let swings: number[] = [];
    for (let step = 0; step < 12 && swings.every((s) => s === 0); step++) {
      boat.animate(step * 0.25, 0, false);
      swings = bonesOf(boat.root)
        .map((bone) => bone.rotation.y)
        .filter((yaw) => yaw !== 0);
    }
    // Four oars were animated; anything else means animate() reached a bone it
    // should not have (a shaft or the root).
    expect(swings).toHaveLength(4);
    expect(new Set(swings.map((yaw) => Math.sign(yaw)))).toEqual(new Set([-1, 1]));

    boat.dispose();
    models.dispose();
  });
});

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
import { readFile } from 'node:fs/promises';
import { createBoatModels, installBoatKit } from '../client/models.ts';
import { parseRigAsset } from '../../../client/src/render/rigAsset.ts';

/**
 * three's ImageLoader decodes through the DOM `Image` API, which does not
 * exist under Vitest's plain Node — so a stub that reports every image as
 * loaded. The parsed texture's PIXELS are never read here (counts, names and
 * anchors only), which is what makes a stub honest instead of a lie.
 */
function stubImageLoading(): void {
  const scope = globalThis as unknown as { document?: unknown; self?: unknown };
  // `self` (the worker/global alias GLTFLoader reads its URL constructor
  // from) does not exist in Node; the global object is the honest stand-in.
  if (scope.self === undefined) scope.self = globalThis;
  if (scope.document !== undefined) return;
  scope.document = {
    createElementNS: (): unknown => {
      const listeners = new Map<string, Array<() => void>>();
      const image = {
        width: 256,
        height: 256,
        addEventListener(type: string, listener: (this: unknown) => void): void {
          listeners.set(type, [...(listeners.get(type) ?? []), () => listener.call(image)]);
        },
        removeEventListener(type: string, listener: (this: unknown) => void): void {
          listeners.set(
            type,
            (listeners.get(type) ?? []).filter((kept) => kept !== listener),
          );
        },
        set src(_url: string) {
          queueMicrotask(() => {
            for (const listener of listeners.get('load') ?? []) listener();
          });
        },
      };
      return image;
    },
  };
}

// The boats are baked from the real asset file, read off disk: under Vitest
// (plain Node, no Vite pipeline) there is no `.glb?url` import and no fetch,
// so the bytes go through parseRigAsset — the SAME GLTFLoader class and the
// SAME validation as the browser's loadRigAsset, transport aside.
stubImageLoading();
const assetUrl = new URL('../client/assets/war-boat.glb', import.meta.url);
const assetBuffer = await readFile(assetUrl);
const assetBytes = assetBuffer.buffer.slice(
  assetBuffer.byteOffset,
  assetBuffer.byteOffset + assetBuffer.byteLength,
);
installBoatKit(await parseRigAsset(assetBytes, 'war-boat.glb'));

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
  it('draws THREE objects per boat: two rig surfaces plus the sail', () => {
    // One boat must cost its three draws and no more. The hand-built boat was
    // 2 (one baked surface plus the sail); the authored hull carries the
    // texture, and map identity is in rigSkin's merge key, so the textured
    // hull bakes as its own surface beside the merged flat set — 2 + the
    // sail's 1. A regression to per-part meshes (or a second flat surface —
    // an indexed part beside a non-indexed one would do it) shows up here.
    const models = createBoatModels();
    const boat = models.create();
    boat.animate(0, 0, false);

    expect(drawablesOf(boat.root)).toHaveLength(3);

    boat.dispose();
    models.dispose();
  });

  it('keeps the rig at TWO surfaces, so nothing but the sail was left behind', () => {
    // The textured hull is one surface, every flat part merges into the
    // other, and both boats share both baked geometries; if the bake ever
    // emits a third surface the total goes to 4 and this catches which side
    // regressed.
    const models = createBoatModels();
    const a = models.create();
    const b = models.create();

    const [rigA1, rigA2, sailA] = drawablesOf(a.root);
    const [rigB1, rigB2] = drawablesOf(b.root);
    expect(rigA1!.geometry).toBe(rigB1!.geometry);
    expect(rigA1!.material).toBe(rigB1!.material);
    expect(rigA2!.geometry).toBe(rigB2!.geometry);
    expect(rigA2!.material).toBe(rigB2!.material);
    expect(sailA!.material).not.toBe(rigA1!.material);
    expect(sailA!.material).not.toBe(rigA2!.material);

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

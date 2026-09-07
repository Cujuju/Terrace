// Pins the rigSkin port's win. Like models.test.ts this constructs real
// Three.js objects and never a WebGLRenderer, so it runs headless — a
// SkinnedMesh is drawable data whether or not a GPU is present.
//
// The number asserted here IS the deliverable: before the port one boat was 9
// Meshes (hull, deck, mast, sail, yard, 4 oars) = 9 draw calls; after it, the
// hull/deck/mast/yard/oars are ONE baked skinned surface and only the sail
// stays separate (its per-boat colour cannot live in shared vertex data — see
// the comment on the sail in client/models.ts), and the sail is now one
// InstancedMesh for the whole fleet. So: 1.

import { describe, expect, it } from 'vitest';
import { InstancedMesh } from 'three';
import { readFile } from 'node:fs/promises';
import {
  BOAT_SHAPE,
  HULL_MESH_NAME,
  SAIL_MESH_NAME,
  createBoatModels,
  installBoatKit,
  type BoatModels,
} from '../client/models.ts';
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

/** One of the fleet's two drawn meshes, by name rather than by its index. */
function meshNamed(models: BoatModels, name: string): InstancedMesh {
  const found = models.objects.find((object) => object.name === name);
  if (!(found instanceof InstancedMesh)) throw new Error(`no InstancedMesh named ${name}`);
  return found;
}

describe('the boat as a rigged drawable', () => {
  it('draws ONE object per hull, and the whole fleet\'s sails in ONE more', () => {
    // What a fleet COSTS, which is the number drawBudget is built from. Map
    // identity is in rigSkin's merge key, so a textured hull beside untextured
    // spars used to bake as its own second surface; every baked part now
    // samples one atlas and the whole hull is 1. The sail was a third, per
    // boat, then one InstancedMesh for every boat in the world. A regression
    // to per-part meshes — or to a second surface, which splitting the atlas
    // or putting a non-indexed part beside an indexed one would do — shows up
    // here, and so does putting the sail back on the per-boat path.
    const models = createBoatModels();
    models.beginFrame();
    const boat = models.create();
    boat.draw(0, 0, 0, 0, 0, 0, 0, false);

    // TWO objects for the whole fleet: the hull herd's one baked surface and
    // the sails' one mesh. Not two PER BOAT — that is the point of the count.
    expect(models.objects).toHaveLength(2);
    expect(BOAT_SHAPE.drawObjects).toBe(1);

    const second = models.create();
    second.draw(5, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();
    // Still the same two meshes, now carrying two instances each.
    expect(models.objects).toHaveLength(2);
    expect(meshNamed(models, HULL_MESH_NAME).count).toBe(2);
    expect(meshNamed(models, SAIL_MESH_NAME).count).toBe(2);

    second.dispose();
    boat.dispose();
    models.dispose();
  });

  it('keeps the rig at ONE surface, shared by every boat', () => {
    // Every part merges into one surface, and two boats are two INSTANCES of
    // it rather than two meshes. If the bake ever emits a second surface the
    // herd grows a second mesh and this catches it.
    const models = createBoatModels();
    models.beginFrame();
    const a = models.create();
    const b = models.create();
    a.draw(0, 0, 0, 0, 0, 0, 0, false);
    b.draw(5, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const hulls = models.objects.filter((object) => object.name === HULL_MESH_NAME);
    expect(hulls).toHaveLength(1);
    expect(meshNamed(models, HULL_MESH_NAME).count).toBe(2);

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
    // not float noise around rest. The pose lives on the herd's scratch rig
    // now — there is no per-boat skeleton left to read.
    let swings: number[] = [];
    for (let step = 0; step < 12 && swings.every((s) => s === 0); step++) {
      models.beginFrame();
      boat.draw(0, 0, 0, 0, 0, 0, 0.25, false);
      models.commitFrame();
      swings = models.joints.map((bone) => bone.rotation.y).filter((yaw) => yaw !== 0);
    }
    // Four oars were animated; anything else means animate() reached a bone it
    // should not have (a shaft or the root).
    expect(swings).toHaveLength(4);
    expect(new Set(swings.map((yaw) => Math.sign(yaw)))).toEqual(new Set([-1, 1]));

    boat.dispose();
    models.dispose();
  });
});

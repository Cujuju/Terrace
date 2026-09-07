// Structural tests on the boat model. These construct real Three.js objects but
// never a WebGLRenderer, so they run headless — BufferGeometry, Mesh and Group
// are plain data structures (the same thing client/test/terrainMeshes.test.ts
// relies on). What a picture would show is still verified by eye through
// client/preview-boats.html; what is asserted here is the arithmetic a picture
// is bad at: exact extents, exact waterline, and that shared assets really are
// shared.

import { describe, expect, it } from 'vitest';
import {
  Box3,
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import { readFile } from 'node:fs/promises';
import {
  BOAT_SHAPE,
  HULL_MESH_NAME,
  SAIL_MESH_NAME,
  createBoatModels,
  installBoatKit,
  type BoatModels,
} from '../client/models.ts';
import {
  ASSET_FIT_TOLERANCE_WORLD_UNITS,
  parseRigAsset,
  type RigAsset,
} from '../../../client/src/render/rigAsset.ts';

/**
 * three's ImageLoader decodes through the DOM `Image` API, which does not
 * exist under Vitest's plain Node — so a stub that reports every image as
 * loaded. The parsed texture's PIXELS are never read here (extents,
 * waterline and sail behaviour only), which is what makes a stub honest
 * instead of a lie.
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

/**
 * Where the two boats of the tint test are parked, and how close an instance
 * has to be to count as one of them. Far enough apart that no swell or oar
 * swing could confuse the two.
 */
const FIGHTER_X = 0;
const BYSTANDER_X = 10;
const SAIL_MATCH_WORLD_UNITS = 1;

/** One of the fleet's two drawn meshes, by name rather than by its index. */
function meshNamed(models: BoatModels, name: string): InstancedMesh {
  const found = models.objects.find((object) => object.name === name);
  if (!(found instanceof InstancedMesh)) throw new Error(`no InstancedMesh named ${name}`);
  return found;
}

/**
 * The world box of everything the fleet DRAWS this frame.
 *
 * Measured off the instanced meshes, which is what the renderer submits — a
 * boat has no node of its own to measure any more.
 */
function drawnBox(models: BoatModels): Box3 {
  const box = new Box3();
  for (const object of models.objects) box.union(new Box3().setFromObject(object));
  return box;
}

describe('the boat model', () => {
  it('fits inside one cell, so "five cells away" looks like five cells', () => {
    // The fight's geometry is measured in whole cells
    // (BOAT_ENGAGEMENT_RANGE_CELLS is 5), so a hull spilling past its own cell
    // would make every distance in the fight read wrong.
    const models = createBoatModels();
    models.beginFrame();
    const boat = models.create();
    boat.draw(0, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const size = drawnBox(models).getSize(new Vector3());
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
    models.beginFrame();
    const boat = models.create();
    boat.draw(0, BOAT_SHAPE.waterlineLift, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const box = drawnBox(models);
    expect(BOAT_SHAPE.waterlineLift).toBeLessThan(0);
    // Sea level is world Y 0: some hull below it, and the mast well above.
    expect(box.min.y).toBeLessThan(0);
    expect(box.max.y).toBeGreaterThan(0);

    boat.dispose();
    models.dispose();
  });

  it('reddens only its own sail when it engages', () => {
    // Every sail in the world is now ONE InstancedMesh with ONE material, so
    // the tint has to be per INSTANCE — a material-level recolour would redden
    // every sail afloat the moment a single boat engaged, which is the bug this
    // asserts across TWO boats.
    //
    // Neither boat's slot is named anywhere, so each is identified by WHERE ITS
    // SAIL IS: the boats are parked far apart and the instances are matched to
    // them by the translation of the matrix animate() wrote.
    const models = createBoatModels();
    const fighter = models.create();
    const bystander = models.create();

    models.beginFrame();
    fighter.draw(FIGHTER_X, 0, 0, 0, 0, 0, 0, false);
    bystander.draw(BYSTANDER_X, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const sails = meshNamed(models, SAIL_MESH_NAME);
    const matrix = new Matrix4();
    const tint = new Color();
    /** The instance whose sail sits over `x`, by its matrix's translation. */
    const sailNear = (x: number): Color => {
      for (let slot = 0; slot < sails.count; slot++) {
        sails.getMatrixAt(slot, matrix);
        if (Math.abs(matrix.elements[12]! - x) < SAIL_MATCH_WORLD_UNITS) {
          sails.getColorAt(slot, tint);
          return tint.clone();
        }
      }
      throw new Error(`no sail instance near x=${x}`);
    };

    const restingFighter = sailNear(FIGHTER_X);
    const restingBystander = sailNear(BYSTANDER_X);
    expect(restingFighter.getHex()).toBe(restingBystander.getHex());

    models.beginFrame();
    fighter.draw(FIGHTER_X, 0, 0, 0, 1, 0, 1, true);
    bystander.draw(BYSTANDER_X, 0, 0, 0, 1, 0, 1, false);
    models.commitFrame();
    expect(sailNear(FIGHTER_X).getHex()).not.toBe(restingFighter.getHex());
    expect(sailNear(BYSTANDER_X).getHex()).toBe(restingBystander.getHex());

    fighter.dispose();
    bystander.dispose();
    models.dispose();
  });

  it('stops drawing a sunk boat\'s sail', () => {
    // A freed slot that kept its last matrix would leave a sail hanging over
    // open water, which is the failure mode parking exists to design out.
    const models = createBoatModels();
    const boat = models.create();
    models.beginFrame();
    boat.draw(FIGHTER_X, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const sails = meshNamed(models, SAIL_MESH_NAME);
    const matrix = new Matrix4();
    const scaleOfSlotZero = (): number => {
      sails.getMatrixAt(0, matrix);
      return matrix.getMaxScaleOnAxis();
    };
    expect(scaleOfSlotZero()).toBeGreaterThan(0);

    boat.dispose();
    models.beginFrame();
    models.commitFrame();
    // Parked: zero scale, so it rasterises nothing even if it were submitted.
    expect(scaleOfSlotZero()).toBe(0);
    // And it is not submitted: the drawn prefix fell back over it.
    expect(sails.count).toBe(0);
    // The hull went with it — a sunk boat that stopped drawing is simply not
    // in the frame the herd rebuilt.
    expect(meshNamed(models, HULL_MESH_NAME).count).toBe(0);

    models.dispose();
  });

  it('shares hull geometry between boats', () => {
    // The whole reason createBoatModels exists rather than a bare factory: a
    // fleet must not allocate a hull each. Sharing is now structural rather
    // than merely observed — two boats are two INSTANCE MATRICES in one mesh,
    // so there is no second geometry for them to fail to share.
    const models = createBoatModels();
    const a = models.create();
    const b = models.create();
    models.beginFrame();
    a.draw(0, 0, 0, 0, 0, 0, 0, false);
    b.draw(BYSTANDER_X, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    expect(models.objects.filter((object) => object.name === HULL_MESH_NAME)).toHaveLength(1);
    expect(meshNamed(models, HULL_MESH_NAME).count).toBe(2);

    a.dispose();
    b.dispose();
    models.dispose();
  });

  it('rows without any oar leaving the water plane or entering the hull', () => {
    // The oar swing is a YAW about each oar's own mount, never a lift — the
    // same constraint the kraken's arms keep, and for the same reason: it makes
    // the animation incapable of clipping through what it is attached to.
    // ASSERTED ON THE BONES, not on the silhouette. The drawn geometry is
    // posed in the vertex shader from the herd's palette, so a CPU-side box
    // measures the REST hull and could no longer see an oar move at all — a
    // test that cannot fail would be worse than none. The rule itself is a
    // statement about the joints: a swing is a yaw, so nothing but rotation.y
    // may ever differ from rest.
    const models = createBoatModels();
    const boat = models.create();

    // Against REST, not against zero: the asset authors an oar's mount with a
    // dip already in it (OAR_DIP_RADIANS, tools/blender/build_war_boat.py), so
    // a rest pitch of zero was never the rule. The rule is that posing moves
    // nothing but the yaw.
    const rest = models.joints.map((bone) => ({
      position: bone.position.clone(),
      x: bone.rotation.x,
      z: bone.rotation.z,
    }));
    for (let step = 0; step < 12; step++) {
      models.beginFrame();
      boat.draw(0, 0, 0, 0, step * 0.25, 0, 0.25, false);
      models.commitFrame();
      models.joints.forEach((bone, index) => {
        // No lift and no slide: an oar that translated would leave its mount.
        expect(bone.position.equals(rest[index]!.position)).toBe(true);
        // No added pitch and no roll: either would dip the blade through the
        // water plane or swing it up into the hull.
        expect(bone.rotation.x).toBe(rest[index]!.x);
        expect(bone.rotation.z).toBe(rest[index]!.z);
      });
    }
    // And the swing really did happen — otherwise the above is vacuous.
    expect(models.joints.some((bone) => bone.rotation.y !== 0)).toBe(true);

    boat.dispose();
    models.dispose();
  });
});

// ─── what installBoatKit refuses to install ──────────────────────────────────
//
// Both rejections happen BEFORE the kit is replaced (client/models.ts:183-198,
// all above the `disposeBoatKit()` at :212), so these leave the real asset
// installed above still standing — which is itself the contract they rest on.

/** The deck plane both anchor cases are measured against. */
const DECK_TOP_Y = 0.165;
/** A masthead the right way up, for the case where the fire column is fine. */
const VALID_FIRE_TOP_Y = 0.779;

/**
 * A stand-in asset shaped exactly like what rigAsset hands back: a scene whose
 * bounding box is the silhouette, plus the anchors and pivot nodes
 * installBoatKit reads. Built here rather than loaded because the point is the
 * install's own checks, not the parser's.
 */
function fakeBoatAsset(options: { silhouetteCells: number; fireTopY: number }): RigAsset {
  const scene = new Group();
  const hull = new Mesh(
    new BoxGeometry(options.silhouetteCells, 0.3, options.silhouetteCells),
    new MeshStandardMaterial(),
  );
  hull.name = 'hull';
  scene.add(hull);
  const sail = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
  sail.name = 'sail';
  scene.add(sail);
  for (const name of ['oar_port_1', 'oar_port_2', 'oar_starboard_1', 'oar_starboard_2']) {
    const pivot = new Object3D();
    pivot.name = name;
    scene.add(pivot);
  }
  const anchors = new Map<string, Vector3>([
    ['waterline', new Vector3(0, -0.11, 0)],
    ['deck_top', new Vector3(0, DECK_TOP_Y, 0)],
    ['fire_top', new Vector3(0, options.fireTopY, 0)],
  ]);
  return {
    scene,
    node(name: string) {
      const found = scene.getObjectByName(name);
      if (found === undefined) throw new Error(`fake boat asset: node "${name}" not found`);
      return found;
    },
    anchor(name: string) {
      const found = anchors.get(name);
      if (found === undefined) throw new Error(`fake boat asset: anchor "${name}" not found`);
      return found.clone();
    },
    dispose(): void {},
  };
}

describe('installBoatKit', () => {
  it('refuses a silhouette wider than one cell plus the fit tolerance', () => {
    // The fight's geometry is counted in whole cells, so a hull spilling past
    // its own cell makes every distance in the fight read wrong. The tolerance
    // absorbs float dust in the bounding box, never a real overhang — so a
    // silhouette one whole tolerance past it is an overhang.
    const overhang = 1 + ASSET_FIT_TOLERANCE_WORLD_UNITS * 2;
    expect(() =>
      installBoatKit(fakeBoatAsset({ silhouetteCells: overhang, fireTopY: VALID_FIRE_TOP_Y })),
    ).toThrow(/one-cell fit budget/);
  });

  it('refuses a fire_top that is not above deck_top', () => {
    // BOAT_FIRE_COLUMN's height is fire_top.y - deck_top.y; inverted anchors
    // give a negative height and the flame burns downward through the hull.
    expect(() =>
      installBoatKit(fakeBoatAsset({ silhouetteCells: 0.9, fireTopY: DECK_TOP_Y - 0.1 })),
    ).toThrow(/is not above deck_top/);
  });
});

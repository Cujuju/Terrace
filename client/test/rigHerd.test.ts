// The rig-herd contract — the module's own behaviour, never a caller's use of it.
//
// SCOPE. These cover the two things a herd promises that a caller cannot check
// for itself: that a placement lands in the instance buffer as given, and that
// a captured pose lives exactly as long as the caller said it would. Both were
// added for the boats fleet (GH #369), and boats' own suite cannot guard
// either — it asserts on the scratch rig, which is the INPUT to a pose, not on
// what the palette retained across a frame boundary.
//
// Headless: real Three.js objects, no WebGLRenderer, the same footing
// rigSkin.test.ts stands on.

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  DataTexture,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Vector3,
  type Material,
} from 'three';
import { bakeRig, type RigBlueprint } from '../src/render/rigSkin.ts';
import { createRigHerd } from '../src/render/rigHerd.ts';

/** Floats in a 4x4 matrix, the stride of one instance in the buffer. */
const MATRIX_ELEMENTS = 16;

/** Placement agreement tolerance, in world units. */
const PLACEMENT_EPSILON = 1e-6;

/**
 * The smallest rig with a joint under the root: one static part and one part
 * on a bone. A herd needs no more shape than that — what varies between these
 * tests is how individuals are PLACED and how long poses LIVE, neither of which
 * depends on how many limbs the blueprint has.
 *
 * Baked fresh per test on purpose: createRigHerd writes a per-instance
 * attribute onto the blueprint's surface geometries and refuses a blueprint
 * that already drives a herd, so a shared one would make these tests ordering
 * dependent.
 */
function bakeTestRig(): RigBlueprint {
  const root = new Group();
  const body = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshLambertMaterial({ color: 0x88aa66 }));
  root.add(body);

  const joint = new Group();
  joint.position.set(0, 0.4, 0);
  root.add(joint);
  const limb = new Mesh(new BoxGeometry(0.1, 0.4, 0.1), new MeshLambertMaterial({ color: 0x6d5334 }));
  limb.position.set(0, 0.2, 0);
  joint.add(limb);

  return bakeRig(root);
}

/** The sixteen floats of one instance, straight out of the shared buffer. */
function instanceMatrixAt(
  herd: ReturnType<typeof createRigHerd>,
  index: number,
): number[] {
  const array = herd.meshes[0]!.instanceMatrix.array as Float32Array;
  return Array.from(array.subarray(index * MATRIX_ELEMENTS, (index + 1) * MATRIX_ELEMENTS));
}

/**
 * The herd's pose palette, reached the way the renderer reaches it.
 *
 * The texture is private to the closure that patches the material, and its
 * upload flag is the whole observable of the staticPoses contract — so the
 * material's own `onBeforeCompile` is run over a stand-in shader to collect the
 * uniform, exactly as terrainMeshes.test.ts drives a patched material.
 */
function paletteOf(herd: ReturnType<typeof createRigHerd>): DataTexture {
  const material = herd.meshes[0]!.material as Material;
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\n#include <begin_vertex>\n#include <beginnormal_vertex>',
    fragmentShader: '',
  };
  material.onBeforeCompile(shader as never, null as never);
  const palette = shader.uniforms.rigPosePalette?.value;
  if (!(palette instanceof DataTexture)) throw new Error('the herd exposed no pose palette');
  return palette;
}

describe('placeMatrix', () => {
  it('carries a transform place() has no arguments for', () => {
    // THE REASON IT EXISTS. place() composes its matrix from a yaw and a
    // uniform scale, so a hull that rolls and pitches on the swell cannot be
    // expressed through it at all — the tilt would simply be dropped.
    const herd = createRigHerd(bakeTestRig(), { capacity: 4, poseSlots: 8 });
    herd.beginFrame();
    herd.capturePose(0);

    const tilted = new Matrix4().makeRotationFromEuler(new Euler(0.21, -0.6, 0.13, 'XYZ'));
    tilted.setPosition(3, -1.5, 7);
    herd.placeMatrix(0, tilted, 1);
    herd.endFrame();

    expect(herd.meshes[0]!.count).toBe(1);
    instanceMatrixAt(herd, 0).forEach((value, index) => {
      expect(value).toBeCloseTo(tilted.elements[index]!, 5);
    });

    herd.dispose();
  });

  it('copies the matrix, so the caller may reuse its scratch', () => {
    // Callers place every individual of a frame through ONE scratch Matrix4
    // (plugins/boats/client/models.ts does). Holding a reference instead of
    // copying would give every instance the last boat's placement.
    const herd = createRigHerd(bakeTestRig(), { capacity: 4, poseSlots: 8 });
    herd.beginFrame();
    herd.capturePose(0);

    const scratch = new Matrix4().setPosition(1, 0, 0);
    herd.placeMatrix(0, scratch, 1);
    scratch.setPosition(9, 9, 9);
    herd.placeMatrix(0, scratch, 1);
    herd.endFrame();

    expect(instanceMatrixAt(herd, 0)[12]).toBeCloseTo(1, 5);
    expect(instanceMatrixAt(herd, 1)[12]).toBeCloseTo(9, 5);

    herd.dispose();
  });

  it('agrees with place() on a placement they can both express', () => {
    // The two paths must not be two definitions of "where an individual is".
    // A yaw, a uniform scale and a translation go through both; the sixteen
    // floats have to come out identical.
    const yaw = 0.9;
    const scale = 1.7;
    const at = new Vector3(2, 3, -4);

    const byArguments = createRigHerd(bakeTestRig(), { capacity: 2, poseSlots: 8 });
    byArguments.beginFrame();
    byArguments.capturePose(0);
    byArguments.place(0, at.x, at.y, at.z, yaw, scale);
    byArguments.endFrame();

    const byMatrix = createRigHerd(bakeTestRig(), { capacity: 2, poseSlots: 8 });
    byMatrix.beginFrame();
    byMatrix.capturePose(0);
    const composed = new Matrix4()
      .makeRotationFromEuler(new Euler(0, yaw, 0, 'XYZ'))
      .scale(new Vector3(scale, scale, scale))
      .setPosition(at.x, at.y, at.z);
    byMatrix.placeMatrix(0, composed, scale);
    byMatrix.endFrame();

    instanceMatrixAt(byArguments, 0).forEach((value, index) => {
      expect(Math.abs(value - instanceMatrixAt(byMatrix, 0)[index]!)).toBeLessThan(
        PLACEMENT_EPSILON,
      );
    });

    byArguments.dispose();
    byMatrix.dispose();
  });

  it('feeds ONE frustum bound with the individuals place() placed', () => {
    // Both paths share the herd's extent bookkeeping. If they did not, a fleet
    // placed through both would be culled against a box that knew of only half
    // of it — and the half it forgot would vanish at the screen edge.
    const herd = createRigHerd(bakeTestRig(), { capacity: 4, poseSlots: 8 });
    herd.beginFrame();
    herd.capturePose(0);
    herd.place(0, -10, 0, 0, 0, 1);
    herd.placeMatrix(0, new Matrix4().setPosition(10, 0, 0), 1);
    herd.endFrame();

    // Centred between the two, not on either.
    expect(herd.meshes[0]!.boundingSphere!.center.x).toBeCloseTo(0, 5);
    // And wide enough to hold both: half their separation, plus one rig's reach.
    expect(herd.meshes[0]!.boundingSphere!.radius).toBeGreaterThanOrEqual(10);

    herd.dispose();
  });

  it('grows that bound by the reach it is given', () => {
    // `reach` is the scale the geometry is drawn at, and the bound has to carry
    // it — an individual drawn at 3x with a 1x bound is culled while still on
    // screen.
    const radiusAtReach = (reach: number): number => {
      const herd = createRigHerd(bakeTestRig(), { capacity: 2, poseSlots: 8 });
      herd.beginFrame();
      herd.capturePose(0);
      herd.placeMatrix(0, new Matrix4(), reach);
      herd.endFrame();
      const radius = herd.meshes[0]!.boundingSphere!.radius;
      herd.dispose();
      return radius;
    };

    expect(radiusAtReach(3)).toBeGreaterThan(radiusAtReach(1));
  });

  it('drops an individual past capacity rather than overrunning the buffer', () => {
    // The same refusal place() makes: a creature that is not drawn is a smaller
    // failure than a frame that throws.
    const herd = createRigHerd(bakeTestRig(), { capacity: 1, poseSlots: 8 });
    herd.beginFrame();
    herd.capturePose(0);
    herd.placeMatrix(0, new Matrix4().setPosition(1, 0, 0), 1);
    expect(() => herd.placeMatrix(0, new Matrix4().setPosition(2, 0, 0), 1)).not.toThrow();
    herd.endFrame();

    expect(herd.meshes[0]!.count).toBe(1);
    // The one that fit is the one that was placed first, unclobbered.
    expect(instanceMatrixAt(herd, 0)[12]).toBeCloseTo(1, 5);

    herd.dispose();
  });
});

describe('staticPoses', () => {
  it('keeps a captured row across frames when the caller declares it static', () => {
    // THE CONTRACT. The caller has promised the pose depends only on the slot
    // phase, so row k is right for ever — and a herd that re-asked for it every
    // frame would re-upload a palette that never changed.
    const herd = createRigHerd(bakeTestRig(), { capacity: 2, poseSlots: 8, staticPoses: true });
    herd.beginFrame();
    expect(herd.needsPose(3)).toBe(true);
    herd.capturePose(3);
    herd.endFrame();

    herd.beginFrame();
    expect(herd.needsPose(3)).toBe(false);
    // A row nobody has captured is still owed, static or not.
    expect(herd.needsPose(4)).toBe(true);

    herd.dispose();
  });

  it('re-asks for every row each frame by default', () => {
    // The default caller's pose reads the wall clock (a fish's tail is
    // seconds * HZ + phase), so last frame's row is the wrong pose this frame.
    // Defaulting the other way would freeze every existing herd's animation.
    const herd = createRigHerd(bakeTestRig(), { capacity: 2, poseSlots: 8 });
    herd.beginFrame();
    herd.capturePose(3);
    herd.endFrame();

    herd.beginFrame();
    expect(herd.needsPose(3)).toBe(true);

    herd.dispose();
  });

  it('uploads the palette only on a frame that actually captured a row', () => {
    // The point of the whole option: a static herd pays ONE upload for the life
    // of the palette. The flags that decide it are separate — the captured rows
    // persist, the per-frame counter does not — and confusing the two would
    // either upload every frame (no saving) or never upload a newly captured
    // row (a creature drawn in a pose of all zeroes).
    const herd = createRigHerd(bakeTestRig(), { capacity: 2, poseSlots: 8, staticPoses: true });
    const palette = paletteOf(herd);

    // `needsUpdate` is set-only on a three Texture; the version it bumps is the
    // readable side of the same flag.
    const uploadedAfterFrame = (capture: number | null): number => {
      herd.beginFrame();
      // Guarded by needsPose, which is the caller protocol — capturePose itself
      // is unconditional and would re-write a row that was already right.
      if (capture !== null && herd.needsPose(capture)) herd.capturePose(capture);
      herd.placeMatrix(0, new Matrix4(), 1);
      herd.endFrame();
      return palette.version;
    };

    const first = uploadedAfterFrame(0);
    expect(first).toBeGreaterThan(0);
    // A second row is new data and must reach the GPU.
    expect(uploadedAfterFrame(1)).toBeGreaterThan(first);

    // Nothing new captured: the palette is already right, so it must not be
    // re-sent. This is the saving the option exists for.
    const settled = palette.version;
    expect(uploadedAfterFrame(null)).toBe(settled);
    expect(uploadedAfterFrame(null)).toBe(settled);
    // And a row already held is not re-captured, so it does not re-upload either.
    expect(uploadedAfterFrame(0)).toBe(settled);

    herd.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Vector3,
  type Material,
} from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { bakeRig, type RigBlueprint } from '../src/render/rigSkin.ts';
import { createRigHerd } from '../src/render/rigHerd.ts';

const MATRIX_ELEMENTS = 16;

const PLACEMENT_EPSILON = 1e-6;

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

function instanceMatrixAt(
  herd: ReturnType<typeof createRigHerd>,
  index: number,
): number[] {
  const array = herd.meshes[0]!.instanceMatrix.array as Float32Array;
  return Array.from(array.subarray(index * MATRIX_ELEMENTS, (index + 1) * MATRIX_ELEMENTS));
}

function paletteOf(herd: ReturnType<typeof createRigHerd>): StorageBufferAttribute {
  const palette = herd.posePalette;
  if (!(palette instanceof StorageBufferAttribute)) {
    throw new Error('the herd exposed no pose palette');
  }
  return palette;
}

describe('placeMatrix', () => {
  it('carries a transform place() has no arguments for', () => {
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
    const herd = createRigHerd(bakeTestRig(), { capacity: 4, poseSlots: 8 });
    herd.beginFrame();
    herd.capturePose(0);
    herd.place(0, -10, 0, 0, 0, 1);
    herd.placeMatrix(0, new Matrix4().setPosition(10, 0, 0), 1);
    herd.endFrame();

    expect(herd.meshes[0]!.boundingSphere!.center.x).toBeCloseTo(0, 5);
    expect(herd.meshes[0]!.boundingSphere!.radius).toBeGreaterThanOrEqual(10);

    herd.dispose();
  });

  it('grows that bound by the reach it is given', () => {
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
    const herd = createRigHerd(bakeTestRig(), { capacity: 1, poseSlots: 8 });
    herd.beginFrame();
    herd.capturePose(0);
    herd.placeMatrix(0, new Matrix4().setPosition(1, 0, 0), 1);
    expect(() => herd.placeMatrix(0, new Matrix4().setPosition(2, 0, 0), 1)).not.toThrow();
    herd.endFrame();

    expect(herd.meshes[0]!.count).toBe(1);
    expect(instanceMatrixAt(herd, 0)[12]).toBeCloseTo(1, 5);

    herd.dispose();
  });
});

describe('staticPoses', () => {
  it('keeps a captured row across frames when the caller declares it static', () => {
    const herd = createRigHerd(bakeTestRig(), { capacity: 2, poseSlots: 8, staticPoses: true });
    herd.beginFrame();
    expect(herd.needsPose(3)).toBe(true);
    herd.capturePose(3);
    herd.endFrame();

    herd.beginFrame();
    expect(herd.needsPose(3)).toBe(false);
    expect(herd.needsPose(4)).toBe(true);

    herd.dispose();
  });

  it('re-asks for every row each frame by default', () => {
    const herd = createRigHerd(bakeTestRig(), { capacity: 2, poseSlots: 8 });
    herd.beginFrame();
    herd.capturePose(3);
    herd.endFrame();

    herd.beginFrame();
    expect(herd.needsPose(3)).toBe(true);

    herd.dispose();
  });

  it('uploads the palette only on a frame that actually captured a row', () => {
    const herd = createRigHerd(bakeTestRig(), { capacity: 2, poseSlots: 8, staticPoses: true });
    const palette = paletteOf(herd);

    const uploadedAfterFrame = (capture: number | null): number => {
      herd.beginFrame();
      if (capture !== null && herd.needsPose(capture)) herd.capturePose(capture);
      herd.placeMatrix(0, new Matrix4(), 1);
      herd.endFrame();
      return palette.version;
    };

    const first = uploadedAfterFrame(0);
    expect(first).toBeGreaterThan(0);
    expect(uploadedAfterFrame(1)).toBeGreaterThan(first);

    const settled = palette.version;
    expect(uploadedAfterFrame(null)).toBe(settled);
    expect(uploadedAfterFrame(null)).toBe(settled);
    expect(uploadedAfterFrame(0)).toBe(settled);

    herd.dispose();
  });
});

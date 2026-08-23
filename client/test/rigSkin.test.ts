// The rig-skinning contract.
//
// THE TEST THAT MATTERS is the differential one: for a pose, every vertex of
// the skinned creature must land where the authored scene-graph put it. Skinning
// is only worth doing if it is invisible, and "invisible" is a numeric claim —
// a wrong bind pose is a limb in the wrong place, which reads as bad art rather
// than as a bug and can survive a screenshot pass. Everything else here guards a
// specific way the bake could be wrong while still looking plausible.
//
// Headless: real Three.js objects, no WebGLRenderer, same as terrainMeshes.test.ts.

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
} from 'three';
import { bakeRig, instantiateRig } from '../src/render/rigSkin.ts';

/** Vertex agreement tolerance, in world units. */
const POSITION_EPSILON = 1e-5;

/**
 * A rig with the shape every creature in this codebase has: static parts in rig
 * space, a joint carrying a part, and a nested joint under that one — the
 * kraken's tentacle-and-tip, the yeti's hip-and-ankle, the bird's shoulder.
 *
 * Two colours on one material class (so they must merge into a single surface
 * with vertex colours) plus one unlit part (so it must NOT).
 */
function authorRig(): {
  root: Group;
  hip: Group;
  knee: Group;
  parts: Mesh[];
} {
  const root = new Group();

  const body = new Mesh(new SphereGeometry(0.5, 6, 4), new MeshLambertMaterial({ color: 0x88aa66 }));
  body.position.set(0, 1, 0);
  root.add(body);

  const head = new Mesh(new ConeGeometry(0.2, 0.4, 4), new MeshLambertMaterial({ color: 0xddccaa }));
  head.position.set(0.4, 1.3, 0);
  root.add(head);

  // A glowing eye: unlit and transparent, so it can never share the body's draw.
  const eye = new Mesh(
    new SphereGeometry(0.05, 4, 3),
    new MeshBasicMaterial({ color: 0xa8fbff, transparent: true, opacity: 0.8 }),
  );
  eye.position.set(0.55, 1.35, 0.08);
  root.add(eye);

  const hip = new Group();
  hip.position.set(0, 0.8, 0.2);
  root.add(hip);
  const thigh = new Mesh(new BoxGeometry(0.14, 0.5, 0.14), new MeshLambertMaterial({ color: 0x6d5334 }));
  thigh.position.set(0, -0.25, 0);
  hip.add(thigh);

  const knee = new Group();
  knee.position.set(0, -0.5, 0);
  hip.add(knee);
  const shin = new Mesh(new BoxGeometry(0.12, 0.45, 0.12), new MeshLambertMaterial({ color: 0x6d5334 }));
  shin.position.set(0, -0.22, 0);
  knee.add(shin);

  return { root, hip, knee, parts: [body, head, eye, thigh, shin] };
}

/** Every vertex of an authored tree, in the tree root's space. */
function authoredVertices(root: Object3D): Vector3[] {
  root.updateMatrixWorld(true);
  const out: Vector3[] = [];
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const positions = mesh.geometry.getAttribute('position');
    for (let v = 0; v < positions.count; v++) {
      out.push(
        new Vector3(positions.getX(v), positions.getY(v), positions.getZ(v)).applyMatrix4(
          mesh.matrixWorld,
        ),
      );
    }
  });
  return out;
}

/** Every vertex of a skinned instance, in the instance root's space. */
function skinnedVertices(instance: ReturnType<typeof instantiateRig>): Vector3[] {
  instance.root.updateMatrixWorld(true);
  for (const mesh of instance.meshes) mesh.skeleton.update();
  const out: Vector3[] = [];
  for (const mesh of instance.meshes) {
    const positions = mesh.geometry.getAttribute('position');
    for (let v = 0; v < positions.count; v++) {
      // applyBoneTransform reads the vertex it is given IN the target vector
      // (three 0.185: `_baseVector.set(...target, 1)`), and returns the skinned
      // position in the mesh's own local space; localToWorld then lifts it into
      // the space the authored vertices were measured in.
      const point = new Vector3(positions.getX(v), positions.getY(v), positions.getZ(v));
      mesh.applyBoneTransform(v, point);
      out.push(mesh.localToWorld(point));
    }
  }
  return out;
}

/** Sorted lexicographically, because a merge is free to reorder vertices. */
function sortedKeys(points: Vector3[]): string[] {
  return points
    .map((p) => `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`)
    .sort();
}

function expectSameCloud(actual: Vector3[], expected: Vector3[]): void {
  expect(actual).toHaveLength(expected.length);
  const a = sortedKeys(actual);
  const b = sortedKeys(expected);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    // Fall back to a numeric compare so a last-bit difference is not a failure.
    const [ax, ay, az] = a[i]!.split(',').map(Number) as [number, number, number];
    const [bx, by, bz] = b[i]!.split(',').map(Number) as [number, number, number];
    expect(Math.abs(ax - bx)).toBeLessThan(POSITION_EPSILON);
    expect(Math.abs(ay - by)).toBeLessThan(POSITION_EPSILON);
    expect(Math.abs(az - bz)).toBeLessThan(POSITION_EPSILON);
  }
}

describe('bakeRig', () => {
  it('puts every vertex where the authored rig put it, at rest', () => {
    const authored = authorRig();
    const expected = authoredVertices(authored.root);

    const blueprint = bakeRig(authored.root);
    const instance = instantiateRig(blueprint);
    expectSameCloud(skinnedVertices(instance), expected);
  });

  it('puts every vertex where the authored rig put it, in an animated pose', () => {
    // THE CONTRACT. Drive the same joints by the same angles on both, and the
    // two vertex clouds must agree — nested joints included, which is where a
    // wrong inverse-bind matrix shows up and a rest-pose test would not.
    const hipAngle = 0.6;
    const kneeAngle = -0.9;

    const reference = authorRig();
    reference.hip.rotation.z = hipAngle;
    reference.knee.rotation.z = kneeAngle;
    const expected = authoredVertices(reference.root);

    const authored = authorRig();
    const hipJoint = { index: 0 };
    const kneeJoint = { index: 0 };
    const blueprint = bakeRig(authored.root);
    hipJoint.index = blueprint.jointIndex(authored.hip);
    kneeJoint.index = blueprint.jointIndex(authored.knee);

    const instance = instantiateRig(blueprint);
    instance.joints[hipJoint.index]!.rotation.z = hipAngle;
    instance.joints[kneeJoint.index]!.rotation.z = kneeAngle;

    expectSameCloud(skinnedVertices(instance), expected);
  });

  it('follows the root wherever the caller puts it', () => {
    // The caller places and yaws the root every frame; three's AttachedBindMode
    // re-derives the bind inverse from the mesh's world matrix, and this is the
    // assertion that pins that behaviour rather than trusting the note about it.
    const reference = authorRig();
    reference.root.position.set(12, 3, -7);
    reference.root.rotation.y = 1.1;
    reference.root.scale.setScalar(0.6);
    const expected = authoredVertices(reference.root);

    const authored = authorRig();
    const blueprint = bakeRig(authored.root);
    const instance = instantiateRig(blueprint);
    instance.root.position.set(12, 3, -7);
    instance.root.rotation.y = 1.1;
    instance.root.scale.setScalar(0.6);

    expectSameCloud(skinnedVertices(instance), expected);
  });

  it('draws parts that differ only by colour in one call, and keeps the unlit part out of it', () => {
    const authored = authorRig();
    const blueprint = bakeRig(authored.root);

    // Four Lambert parts in three colours merge to one surface; the transparent
    // unlit eye cannot share a draw with them whatever its colour.
    expect(blueprint.surfaceCount).toBe(2);

    const instance = instantiateRig(blueprint);
    expect(instance.meshes).toHaveLength(2);
    for (const mesh of instance.meshes) {
      expect(mesh.geometry.getAttribute('color')).toBeDefined();
      expect(mesh.material).toHaveProperty('vertexColors', true);
    }
  });

  it('carries each part\'s own colour into the merged surface', () => {
    const authored = authorRig();
    const blueprint = bakeRig(authored.root);
    const instance = instantiateRig(blueprint);

    const merged = instance.meshes.find((mesh) => mesh.geometry.getAttribute('position').count > 50);
    expect(merged).toBeDefined();
    const colors = merged!.geometry.getAttribute('color');
    const seen = new Set<string>();
    for (let v = 0; v < colors.count; v++) {
      seen.add(`${colors.getX(v).toFixed(3)},${colors.getY(v).toFixed(3)},${colors.getZ(v).toFixed(3)}`);
    }
    // Body, head and the two leg segments: three distinct colours survived the
    // merge rather than everything taking the first part's.
    expect(seen.size).toBe(3);
  });

  it('binds every vertex rigidly to the joint it was authored under', () => {
    const authored = authorRig();
    const blueprint = bakeRig(authored.root);
    const instance = instantiateRig(blueprint);

    for (const mesh of instance.meshes) {
      const weights = mesh.geometry.getAttribute('skinWeight');
      for (let v = 0; v < weights.count; v++) {
        expect(weights.getX(v)).toBe(1);
        expect(weights.getY(v)).toBe(0);
        expect(weights.getZ(v)).toBe(0);
        expect(weights.getW(v)).toBe(0);
      }
    }
  });

  it('bounds the creature for every pose, not just the rest pose', () => {
    // A bind-pose bounding sphere culls a creature whose limb has swung outside
    // it while it is still on screen. The baked radius must cover the worst case
    // the chain can reach, so swinging every joint may not escape it.
    const authored = authorRig();
    const blueprint = bakeRig(authored.root);
    const instance = instantiateRig(blueprint);
    const radius = instance.meshes[0]!.geometry.boundingSphere!.radius;

    for (const [hip, knee] of [[0, 0], [1.5, -2.2], [-2.9, 3.0], [Math.PI, Math.PI]] as const) {
      const reference = authorRig();
      reference.hip.rotation.z = hip;
      reference.knee.rotation.z = knee;
      for (const point of authoredVertices(reference.root)) {
        expect(point.length()).toBeLessThanOrEqual(radius);
      }
    }
  });

  it('shares one blueprint across creatures that each animate separately', () => {
    // The pooling contract wildlife/client/models.ts depends on: one set of
    // buffers per species, one skeleton per individual.
    const authored = authorRig();
    const blueprint = bakeRig(authored.root);
    const hip = blueprint.jointIndex(authored.hip);

    const first = instantiateRig(blueprint);
    const second = instantiateRig(blueprint);
    expect(first.meshes[0]!.geometry).toBe(second.meshes[0]!.geometry);
    expect(first.meshes[0]!.material).toBe(second.meshes[0]!.material);
    expect(first.meshes[0]!.skeleton).not.toBe(second.meshes[0]!.skeleton);

    first.joints[hip]!.rotation.z = 1;
    expect(Math.abs(second.joints[hip]!.rotation.z)).toBe(0);
  });

  it('refuses a root that has already been placed', () => {
    // A placed root would bake its placement into geometry every creature shares,
    // which puts the whole species wherever the first one happened to stand.
    const authored = authorRig();
    const parent = new Group();
    parent.add(authored.root);
    expect(() => bakeRig(authored.root)).toThrow(/unparented/);
  });

  it('refuses a joint it never baked', () => {
    const authored = authorRig();
    const blueprint = bakeRig(authored.root);
    expect(() => blueprint.jointIndex(new Group())).toThrow(/not part of the baked rig/);
  });
});

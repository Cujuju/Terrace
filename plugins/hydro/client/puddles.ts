import {
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Discard,
  Fn,
  attribute,
  float,
  length,
  mix,
  positionGeometry,
  sin,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { radianceForDisplay } from '../../../client/src/render/displayRadiance.ts';
import {
  HYDRO_PATCH_CAP,
  HYDRO_PATCH_CORE_FRACTION,
  HYDRO_PATCH_RADIUS_WORLD_UNITS,
} from '../protocol.ts';

const PUDDLE_HOVER_HEIGHT = 0.02;

const PUDDLE_QUAD_HALF_WIDTH = 1;

const PUDDLE_DEEP_COLOR: readonly [number, number, number] = [0.05, 0.09, 0.13];
const PUDDLE_SHEEN_COLOR: readonly [number, number, number] = [0.42, 0.58, 0.68];

const PUDDLE_ALPHA_PEAK = 0.55;
const PUDDLE_ALPHA_DISCARD_THRESHOLD = 0.004;

const PUDDLE_SHEEN_AT_RIM = 0.75;

const PUDDLE_RIPPLE_CYCLES = 1.5;
const PUDDLE_RIPPLE_HZ = 0.33;
const PUDDLE_RIPPLE_DEPTH = 0.12;

const PUDDLE_RENDER_ORDER = -1;

export interface PuddleInstance {
  readonly x: number;
  readonly z: number;
  readonly drawnY: number;
  readonly wetness: number;
}

export interface Puddles {
  readonly root: Group;
  apply(patches: readonly PuddleInstance[]): void;
  update(elapsed: number): void;
  dispose(): void;
}

export function createPuddles(): Puddles {
  const root = new Group();
  root.name = 'hydro:puddles';

  const geometry = new PlaneGeometry(
    2 * PUDDLE_QUAD_HALF_WIDTH,
    2 * PUDDLE_QUAD_HALF_WIDTH,
    1,
    1,
  );
  geometry.rotateX(-Math.PI / 2);

  const material = new NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;

  const elapsedUniform = uniform(0);
  const aWetness = attribute<'float'>('aWetness', 'float');

  // The quad lies in XZ, two units across, so position.xz is the offset from the centre in radii.
  const vPlan = positionGeometry.xz;

  // The vertex stage is three's own: projection * modelView * instanceMatrix * position.
  material.fragmentNode = Fn(() => {
    // Nominal radii, through hydroFalloff's own curve, so the drawn patch and the doused one agree.
    const radius = length(vPlan);
    const falloff = float(1.0).sub(smoothstep(HYDRO_PATCH_CORE_FRACTION, 1.0, radius));
    Discard(falloff.lessThanEqual(0.0));

    // Rings ride on top of the falloff, never multiplied in, so the ripple cannot move the edge.
    const ripple = sin(
      radius.mul(PUDDLE_RIPPLE_CYCLES).sub(elapsedUniform.mul(PUDDLE_RIPPLE_HZ)).mul(6.2831853),
    );

    const color = mix(
      vec3(...PUDDLE_DEEP_COLOR),
      vec3(...PUDDLE_SHEEN_COLOR),
      radius.mul(PUDDLE_SHEEN_AT_RIM),
    );

    const alpha = falloff
      .mul(aWetness)
      .mul(PUDDLE_ALPHA_PEAK)
      .mul(float(1.0).add(ripple.mul(PUDDLE_RIPPLE_DEPTH)));
    Discard(alpha.lessThanEqual(PUDDLE_ALPHA_DISCARD_THRESHOLD));
    // The GLSL wrote display bytes straight to the framebuffer, bypassing tone mapping.
    return vec4(radianceForDisplay(color), alpha);
  })();

  const mesh = new InstancedMesh(geometry, material, HYDRO_PATCH_CAP);
  mesh.name = 'hydro:puddles:discs';
  mesh.count = 0;
  mesh.renderOrder = PUDDLE_RENDER_ORDER;
  mesh.frustumCulled = false;
  root.add(mesh);

  const wetness = new InstancedBufferAttribute(new Float32Array(HYDRO_PATCH_CAP), 1);
  geometry.setAttribute('aWetness', wetness);

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  return {
    root,

    apply(patches: readonly PuddleInstance[]): void {
      const count = Math.min(patches.length, HYDRO_PATCH_CAP);
      for (let i = 0; i < count; i++) {
        const patch = patches[i]!;
        position.set(patch.x, patch.drawnY + PUDDLE_HOVER_HEIGHT, patch.z);
        scale.setScalar(HYDRO_PATCH_RADIUS_WORLD_UNITS);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(i, matrix);
        wetness.setX(i, patch.wetness);
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      wetness.needsUpdate = true;
    },

    update(elapsed: number): void {
      elapsedUniform.value = elapsed;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
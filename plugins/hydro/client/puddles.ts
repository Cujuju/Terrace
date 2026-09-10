import {
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
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

const PUDDLE_VERTEX_SHADER =  `
  attribute float aWetness;

  varying vec2 vPlan;
  varying float vWetness;

  void main() {
    // The quad is authored two units across and lying in XZ, so position.xz IS
    // the offset from the patch's centre in radii — no division, no uniform.
    vPlan = position.xz;
    vWetness = aWetness;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const PUDDLE_FRAGMENT_SHADER =  `
  uniform float uElapsed;

  varying vec2 vPlan;
  varying float vWetness;

  void main() {
    // Distance from the centre in NOMINAL RADII — the same input
    // ../protocol.ts's hydroFalloff takes, and the same curve applied to it, so
    // what is drawn here and what the server douses inside cannot disagree.
    float radius = length(vPlan);
    float falloff = 1.0 - smoothstep(${HYDRO_PATCH_CORE_FRACTION.toFixed(2)}, 1.0, radius);
    if (falloff <= 0.0) discard;

    // Rings travelling outward. They ride ON TOP of the falloff rather than
    // being multiplied into it, so the ripple can never move the patch's edge —
    // which is the one thing about this disc that is not a rendering decision.
    float ripple = sin(
      (radius * ${PUDDLE_RIPPLE_CYCLES.toFixed(2)} - uElapsed * ${PUDDLE_RIPPLE_HZ.toFixed(2)})
      * 6.2831853);

    vec3 color = mix(
      vec3(${PUDDLE_DEEP_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      vec3(${PUDDLE_SHEEN_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      radius * ${PUDDLE_SHEEN_AT_RIM.toFixed(2)});

    float alpha = falloff * vWetness * ${PUDDLE_ALPHA_PEAK.toFixed(2)}
      * (1.0 + ripple * ${PUDDLE_RIPPLE_DEPTH.toFixed(2)});
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

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

  const uniforms = { uElapsed: { value: 0 } };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: PUDDLE_VERTEX_SHADER,
    fragmentShader: PUDDLE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });

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
      uniforms.uElapsed.value = elapsed;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
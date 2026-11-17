import {
  DataTexture,
  Group,
  LinearFilter,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  RedFormat,
  UnsignedByteType,
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
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { radianceForDisplay } from '../../../client/src/render/displayRadiance.ts';
import {
  HYDRO_PATCH_CAP,
  HYDRO_PATCH_CORE_FRACTION,
  HYDRO_PATCH_RADIUS_CELLS,
  HYDRO_PATCH_RADIUS_WORLD_UNITS,
} from '../protocol.ts';

/** Mask samples per cell along each axis, so the cut follows the smoothed lip rather than whole cells. */
export const PUDDLE_MASK_SAMPLES_PER_CELL = 4;
/** Samples across one puddle's footprint, centre sample included. */
export const PUDDLE_MASK_SPAN = 2 * HYDRO_PATCH_RADIUS_CELLS * PUDDLE_MASK_SAMPLES_PER_CELL + 1;
export const PUDDLE_MASK_CELLS = PUDDLE_MASK_SPAN * PUDDLE_MASK_SPAN;
const PUDDLE_MASK_HALF_SPAN = HYDRO_PATCH_RADIUS_CELLS * PUDDLE_MASK_SAMPLES_PER_CELL;
// The filtered mask crosses 0.5 at the lip; this band anti-aliases the cut edge.
const MASK_EDGE_LOW = 0.25;
const MASK_EDGE_HIGH = 0.75;

const MASK_ON_STEP_BYTE = 255;

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
  /** One byte per mask sample, row-major from the -x,-z corner: 1 where the ground shares the centre's step. */
  readonly onStep: Uint8Array;
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
  const aRow = attribute<'float'>('aRow', 'float');

  // One SPAN x SPAN tile per instance slot, stacked in z, so bilinear filtering blends both axes.
  const maskBytes = new Uint8Array(PUDDLE_MASK_CELLS * HYDRO_PATCH_CAP);
  const maskTexture = new DataTexture(
    maskBytes, PUDDLE_MASK_SPAN, PUDDLE_MASK_SPAN * HYDRO_PATCH_CAP, RedFormat, UnsignedByteType,
  );
  maskTexture.magFilter = LinearFilter;
  maskTexture.minFilter = LinearFilter;

  // The quad lies in XZ, two units across, so position.xz is the offset from the centre in radii.
  const vPlan = positionGeometry.xz;

  // The vertex stage is three's own: projection * modelView * instanceMatrix * position.
  material.fragmentNode = Fn(() => {
    // Nominal radii, through hydroFalloff's own curve, so the drawn patch and the doused one agree.
    const radius = length(vPlan);
    const falloff = float(1.0).sub(smoothstep(HYDRO_PATCH_CORE_FRACTION, 1.0, radius));
    Discard(falloff.lessThanEqual(0.0));

    // Past a riser the flat disc would float a band above the lower step, so that part is not drawn.
    const texel = vPlan.mul(PUDDLE_MASK_HALF_SPAN).add(PUDDLE_MASK_HALF_SPAN + 0.5);
    const onStep = smoothstep(MASK_EDGE_LOW, MASK_EDGE_HIGH, texture(
      maskTexture,
      vec2(texel.x.div(PUDDLE_MASK_SPAN), aRow.mul(PUDDLE_MASK_SPAN).add(texel.y).div(PUDDLE_MASK_SPAN * HYDRO_PATCH_CAP)),
    ).r);
    Discard(onStep.lessThanEqual(0.0));

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
      .mul(onStep)
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
  const rows = new InstancedBufferAttribute(Float32Array.from({ length: HYDRO_PATCH_CAP }, (_, i) => i), 1);
  geometry.setAttribute('aRow', rows);

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
        const row = i * PUDDLE_MASK_CELLS;
        for (let c = 0; c < PUDDLE_MASK_CELLS; c++) maskBytes[row + c] = patch.onStep[c] === 1 ? MASK_ON_STEP_BYTE : 0;
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      wetness.needsUpdate = true;
      maskTexture.needsUpdate = true;
    },

    update(elapsed: number): void {
      elapsedUniform.value = elapsed;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
      maskTexture.dispose();
      mesh.dispose();
    },
  };
}
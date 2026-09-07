// THE WATER ON THE GROUND — every patch the server says exists, in ONE draw
// call.
//
// ─────────────────────────────────────────────────────────────────────────────
// A DECAL, NOT A SURFACE. Wet ground is not a body of water: it has no shore,
// no depth and nothing under it, so it is drawn the way plugins/fire/client/
// scar.ts draws scorched ground — one flat instanced quad per patch, its shape
// entirely in the fragment shader, lying on the terrain's OWN DRAWN SURFACE.
//
// PLACED BY `drawnGroundYAt`, NEVER `terrainHeightAt`, and the distinction is
// the one the water work paid four rewrites to learn (scar.ts's header). A
// flame STANDS on the ground and is seen against the sky, so the cell lattice's
// answer will do; a puddle LIES ON the ground and is seen against the very
// surface it is supposed to be part of, and the two oracles disagree by a whole
// band wherever a cell falls on the wrong side of its own drawn contour.
//
// THE RESIDUAL THIS LEAVES, stated rather than hidden: the decal is one flat
// quad and terraced ground is flat caps separated by one-unit risers, so a
// patch whose disc overhangs a lip has that sliver floating a band above the
// cap below. It is bounded and small — the alpha is nearly nothing out there
// (../protocol.ts's `hydroFalloff`) — and the alternative, one conformed draw
// per wet cell, is disqualified by the frame budget.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BUDGET. ONE InstancedMesh, ONE draw call for every patch in the world,
// its capacity HYDRO_PATCH_CAP. No texture, no ramp table, no light of its own,
// and no per-frame allocation: the scratch below is built once and written in
// place forever, and a Map entry is allocated only when a NEW patch arrives,
// which is a server delta and not a frame event.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE EDGE IS THE PROTOCOL'S, NOT THIS FILE'S. The fragment shader is handed
// HYDRO_PATCH_CORE_FRACTION and runs the same smoothstep `hydroFalloff` runs,
// so the rim the player can see and the rim the server douses fires inside are
// one rim. Nothing here invents a falloff of its own — see ../protocol.ts.

import {
  DynamicDrawUsage,
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

/**
 * How far above the drawn cap the disc floats, in world units.
 *
 * Coplanar geometry z-fights, and on terraced ground the fight is visible as a
 * flickering band. This is ../../fire/client/torchMarker.ts's RING_HOVER_HEIGHT
 * — the same question, on the same surface, at the same camera distances — and
 * restating it as a different number would mean a puddle and a ring drawn on
 * one cell could disagree about which of them is on top.
 */
const PUDDLE_HOVER_HEIGHT = 0.02;

/**
 * The quad's half-width, in patch radii. EXACTLY 1: unlike a burn scar, whose
 * noise pushes its outline outward and needs margin to bulge into, a patch's
 * boundary is `hydroFalloff` and that reaches exactly the radius and no
 * further. Any margin here would be fragments that only ever discard.
 */
const PUDDLE_QUAD_HALF_WIDTH = 1;

/**
 * The two ends of wet ground's colour: the deep tint in the middle of a patch,
 * and the thin sheen at its edge.
 *
 * DARK AND DESATURATED, not blue water. This decal is multiplied over grass,
 * rock and sand alike and its job is to make them look SOAKED — which in life
 * is the same ground, darker and shinier. A saturated blue disc would read as a
 * pond somebody dropped on the hillside, which is the one thing poured water is
 * not.
 */
const PUDDLE_DEEP_COLOR: readonly [number, number, number] = [0.05, 0.09, 0.13];
const PUDDLE_SHEEN_COLOR: readonly [number, number, number] = [0.42, 0.58, 0.68];

/**
 * Alpha at the centre of a patch at full wetness.
 *
 * WELL SHORT OF 1, and further short than fire's scar (0.82) for the opposite
 * reason: scorched ground is opaque MATTER and replaces what was there, while
 * wet ground is the same ground seen through a film. The terrain's own colour,
 * its band edges and its shoreline all have to read through this or the patch
 * stops being on the terrain and becomes a hole in it.
 */
const PUDDLE_ALPHA_PEAK = 0.55;

/**
 * How much of the disc's alpha is the bright sheen rather than the dark soak,
 * at the rim.
 *
 * The soak is strongest in the middle and the sheen is strongest at the edge,
 * which is what a puddle drying from its rim inwards actually looks like and
 * what stops the disc reading as a single flat wash.
 */
const PUDDLE_SHEEN_AT_RIM = 0.75;

/**
 * Ripples per patch radius, and how fast they travel outward.
 *
 * ONE AND A HALF cycles across the radius, so a patch carries two or three
 * rings — enough that the surface is alive, few enough that it does not read as
 * corduroy at the default orbit. A third of a cycle per second is slow enough
 * to be water settling rather than water boiling.
 */
const PUDDLE_RIPPLE_CYCLES = 1.5;
const PUDDLE_RIPPLE_HZ = 0.33;
/** How much of the alpha the ripple may move. Small: it is a shimmer, not a shape. */
const PUDDLE_RIPPLE_DEPTH = 0.12;

/**
 * Where the puddle sits in the transparent pass.
 *
 * NEGATIVE, so it is submitted before every other transparent thing in the
 * scene. It lies flat on the ground with depth writing off, so submission order
 * IS composite order — and a film on the ground must be painted under the smoke
 * and the flames standing in it, never over them.
 */
const PUDDLE_RENDER_ORDER = -1;

/** One patch as this renderer holds it: a world position and a wetness. */
export interface PuddleInstance {
  /** World-space centre of the patch. */
  readonly x: number;
  readonly z: number;
  /** The Y the terrain DREW at that centre — see the header. */
  readonly drawnY: number;
  /** 0…1, ../protocol.ts's `hydroWetness` at this patch's own age. */
  readonly wetness: number;
}

export interface Puddles {
  /** Everything this renderer draws. The plugin adds it to its layer. */
  readonly root: Group;
  /**
   * Draws exactly these patches, this frame. The whole list every frame rather
   * than a delta: a patch's wetness moves continuously, so "what changed" is
   * "all of it", and the list is at most HYDRO_PATCH_CAP long.
   */
  apply(patches: readonly PuddleInstance[]): void;
  /** Advances the ripple phase. `elapsed` is the plugin's animation clock. */
  update(elapsed: number): void;
  dispose(): void;
}

const PUDDLE_VERTEX_SHADER = /* glsl */ `
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

const PUDDLE_FRAGMENT_SHADER = /* glsl */ `
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

  // Sized so the instance's scale is the patch's radius. One quad, no
  // tessellation: the disc is flat by definition and every bit of its shape is
  // in the fragment shader, so extra vertices would buy nothing at all.
  const geometry = new PlaneGeometry(
    2 * PUDDLE_QUAD_HALF_WIDTH,
    2 * PUDDLE_QUAD_HALF_WIDTH,
    1,
    1,
  );
  // PlaneGeometry is authored in the XY plane; the ground is XZ.
  geometry.rotateX(-Math.PI / 2);

  const uniforms = { uElapsed: { value: 0 } };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: PUDDLE_VERTEX_SHADER,
    fragmentShader: PUDDLE_FRAGMENT_SHADER,
    transparent: true,
    // A film ON the ground, not a surface of its own: writing depth would let a
    // patch occlude the flame it is putting out and the marker ring over it.
    depthWrite: false,
  });

  const mesh = new InstancedMesh(geometry, material, HYDRO_PATCH_CAP);
  mesh.name = 'hydro:puddles:discs';
  mesh.count = 0;
  mesh.renderOrder = PUDDLE_RENDER_ORDER;
  // The quad's own bounds are honest (nothing displaces a vertex here), but the
  // instance matrices are written every frame and three caches the bounding
  // sphere from the first upload; culling against a stale sphere would drop a
  // patch that is plainly on screen.
  mesh.frustumCulled = false;
  root.add(mesh);

  const wetness = new InstancedBufferAttribute(new Float32Array(HYDRO_PATCH_CAP), 1);
  wetness.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aWetness', wetness);

  // Scratch — built once and written in place forever.
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
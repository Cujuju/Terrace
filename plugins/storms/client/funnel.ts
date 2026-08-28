// THE FUNNEL — a tornado, and the only part of this plugin that has to read as
// something with a shape rather than as weather.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE WHOLE FUNNEL IS ONE DRAW CALL, AND THE CPU DOES NOT ANIMATE IT.
//
// Each particle's instance matrix holds only WHERE ITS TORNADO IS. The climb,
// the rotation, the taper and the fade are functions of one uniform (elapsed
// time) and three per-instance attributes (a phase, a seed and the storm's
// strength), computed in the vertex shader. So a funnel costs one matrix write
// per particle per push and nothing at all per frame between pushes.
//
// That is this project's standing render defect written down (see
// docs/DESIGN.md and the draw-call budget): the streaming/authoring unit keeps
// becoming the drawing unit, and low triangles-per-call over a shared material
// is the tell. A per-particle Sprite would have been MAX_FUNNELS ×
// PARTICLES_PER_FUNNEL draw calls of two triangles each against a 7 ms frame
// budget (140 fps is the project benchmark). One InstancedMesh is one call.
//
// BILLBOARDED IN THE SHADER, not by writing rotations from the CPU: the quad is
// authored in XY and offset in VIEW space, which faces it at the camera exactly
// and for free, and — unlike a CPU billboard — cannot lag the camera by a frame.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PARTICLE COLUMN AND NOT A CONE MESH.
//
// A tornado is a visibly TURBULENT thing; a smooth cone reads as a traffic
// bollard however it is textured. The particles are what make it churn, and
// they cost the same one call a cone would.

import {
  DoubleSide,
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
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  TORNADO_HEIGHT_WORLD_UNITS,
  TORNADO_RADIUS_CELLS,
  WORLD_UNITS_PER_BAND,
} from '../protocol.ts';

/**
 * Particles in one funnel.
 *
 * NINETY-SIX, against the volcano plume's 48, because a funnel is seen from the
 * side as a continuous SURFACE rather than as a rising cloud: at 48 the spiral
 * reads as a string of beads, and the count is what closes the gaps. It is
 * still one draw call.
 */
export const PARTICLES_PER_FUNNEL = 96;

/**
 * How many funnels can be drawn at once — the server's tornado cap.
 *
 * Restated rather than imported (that constant is in ../server/, which nothing
 * under client/ imports) and deliberately one HIGHER than it: a funnel that has
 * stopped being broadcast is still dispersing here for
 * FUNNEL_DISPERSE_SECONDS, so at the moment one tornado dies and another forms
 * the renderer legitimately holds one more than the server does.
 */
export const MAX_FUNNELS = 3;

/** Seconds one particle takes to climb the whole funnel. */
export const FUNNEL_PARTICLE_LIFE_SECONDS = 2.2;

/**
 * The funnel's radius at the ground and at the cloud, in world units.
 *
 * THE GROUND END IS THE SERVER'S OWN DAMAGE RADIUS, converted — so the wind
 * that flattens a cell and the vortex a player can see are the same width, by
 * construction rather than by eye. The cloud end is four times that: a tornado
 * is a cone that opens upward into the storm it came out of, and the ratio is
 * what makes the silhouette read as one from any distance.
 */
export const FUNNEL_GROUND_RADIUS_WORLD_UNITS = TORNADO_RADIUS_CELLS * CELL_WORLD_SIZE;
export const FUNNEL_CLOUD_RADIUS_WORLD_UNITS = FUNNEL_GROUND_RADIUS_WORLD_UNITS * 4;

/**
 * Turns of the spiral a particle makes on its way up.
 *
 * TWO AND A HALF. Fewer and the column looks like it is leaning rather than
 * rotating; many more and adjacent particles alias into a barber's pole at any
 * distance, which is worse than no rotation at all.
 */
export const FUNNEL_SPIRAL_TURNS = 2.5;

/**
 * Turns per second the whole funnel rotates, on top of the spiral above.
 *
 * 0.9 — just under one full turn a second. It is the difference between a
 * static twisted shape and something spinning; faster and it strobes at frame
 * rates that are multiples of it.
 */
export const FUNNEL_SPIN_TURNS_PER_SECOND = 0.9;

/** Particle size at the ground and at the cloud, in world units. */
export const FUNNEL_PARTICLE_SIZE_WORLD_UNITS = WORLD_UNITS_PER_BAND * 2.2;

/**
 * Seconds a funnel takes to appear when a tornado touches down, and to
 * disperse after it lifts.
 *
 * ASYMMETRIC: a touchdown is sudden (1.5 s) and the debris hangs afterwards
 * (5 s). A symmetric fade makes the end look like somebody switched it off.
 */
export const FUNNEL_TOUCHDOWN_SECONDS = 1.5;
export const FUNNEL_DISPERSE_SECONDS = 5;

/**
 * Where the funnel sits in the transparent pass. Above the ground and below the
 * cyclone deck (../client/spiral.ts's SPIRAL_RENDER_ORDER): both are
 * depth-write-off transparent geometry, so submission order IS composite order,
 * and a funnel seen from under an overcast must be painted over the overcast.
 */
export const FUNNEL_RENDER_ORDER = 2;

const FUNNEL_VERTEX_SHADER = /* glsl */ `
  uniform float uElapsed;

  attribute float aPhase;
  attribute float aSeed;
  attribute float aStrength;

  varying float vLife;
  varying float vStrength;
  varying vec2 vQuad;

  void main() {
    // 0 at the ground, 1 at the cloud. fract() is what makes one instance a
    // REPEATING particle rather than a single puff — the phase attribute spaces
    // the instances evenly around the cycle, so the column is continuous with
    // no CPU respawning anything.
    float life = fract(uElapsed / ${FUNNEL_PARTICLE_LIFE_SECONDS.toFixed(2)} + aPhase);
    vLife = life;
    vStrength = aStrength;
    vQuad = position.xy;

    // The instance matrix carries ONLY where the tornado is standing.
    vec3 base = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

    // THE TAPER. Quadratic rather than linear so the funnel is PINCHED near the
    // ground and flares late — the shape a tornado actually has. A linear cone
    // reads as a megaphone.
    float taper = life * life;
    float radius = mix(
      ${FUNNEL_GROUND_RADIUS_WORLD_UNITS.toFixed(3)},
      ${FUNNEL_CLOUD_RADIUS_WORLD_UNITS.toFixed(3)},
      taper);

    // THE SPIRAL, plus the whole column's own rotation. The seed offsets each
    // particle around the circle so they do not stack into a ribbon.
    float angle = 6.28318 * (
      life * ${FUNNEL_SPIRAL_TURNS.toFixed(2)} +
      uElapsed * ${FUNNEL_SPIN_TURNS_PER_SECOND.toFixed(2)} +
      aSeed);

    // A WOBBLE OF THE WHOLE AXIS, so the funnel snakes instead of standing
    // plumb. Two sines at incommensurate rates, which never repeat visibly.
    float sway = ${(FUNNEL_GROUND_RADIUS_WORLD_UNITS * 1.6).toFixed(3)} * taper;
    vec2 axis = vec2(
      sin(uElapsed * 0.7 + aSeed * 0.4) * sway,
      cos(uElapsed * 0.53) * sway);

    vec3 world = base + vec3(
      cos(angle) * radius + axis.x,
      life * ${TORNADO_HEIGHT_WORLD_UNITS.toFixed(2)},
      sin(angle) * radius + axis.y);

    // BILLBOARD IN VIEW SPACE: offset the vertex after the view transform, so
    // the quad faces the camera exactly with no rotation written from the CPU.
    // The particle grows a little with height, matching the flare.
    float size = ${FUNNEL_PARTICLE_SIZE_WORLD_UNITS.toFixed(3)} * (0.7 + 0.6 * taper);
    vec4 viewPosition = viewMatrix * vec4(world, 1.0);
    viewPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const FUNNEL_FRAGMENT_SHADER = /* glsl */ `
  varying float vLife;
  varying float vStrength;
  varying vec2 vQuad;

  void main() {
    // A soft round puff. The quad is authored two units across, so vQuad is the
    // offset from its centre in half-widths and everything past 1 discards.
    float radius = length(vQuad);
    float puff = 1.0 - smoothstep(0.1, 1.0, radius);
    if (puff <= 0.0) discard;

    // DIRT AT THE BOTTOM, CLOUD AT THE TOP. The debris a funnel picks up is the
    // colour of the ground it is standing on and the top of it is the storm
    // base it hangs from; one smoothstep between the two is what makes a grey
    // column read as a tornado rather than as smoke.
    vec3 debris = vec3(0.42, 0.35, 0.26);
    vec3 cloud = vec3(0.33, 0.34, 0.38);
    vec3 color = mix(debris, cloud, smoothstep(0.05, 0.65, vLife));

    // Denser at the bottom, where the debris is, thinning toward the cloud.
    float fade = (1.0 - 0.45 * vLife);

    // NORMAL BLENDING, NEVER ADDITIVE — plugins/fire/client/smoke.ts's rule.
    // A funnel must be able to DARKEN what is behind it: seen against daylight
    // it is a silhouette, and additive blending can only ever lighten. The
    // alpha is high for a particle system because forty overlapping quads under
    // normal blending converge on the colour rather than running away to white.
    float alpha = puff * fade * vStrength * 0.42;
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** One tornado, as this renderer remembers it. */
interface Funnel {
  x: number;
  /** World-space Y of the ground the funnel is standing on. */
  groundY: number;
  z: number;
  /** Stable 0…1 from the storm id — offsets the spiral so two do not match. */
  readonly seed: number;
  /** True while the server is still broadcasting this tornado. */
  alive: boolean;
  /** 0…1, ramping over FUNNEL_TOUCHDOWN_SECONDS / FUNNEL_DISPERSE_SECONDS. */
  presence: number;
  /** The storm's own intensity, as last broadcast. */
  intensity: number;
}

/** One live tornado, as ./index.ts hands it over. */
export interface FunnelSource {
  readonly id: number;
  /** World-space X/Z of the eye, and the Y of the ground under it. */
  readonly x: number;
  readonly groundY: number;
  readonly z: number;
  readonly intensity: number;
}

export interface FunnelRenderer {
  readonly root: Group;
  /**
   * Tells the renderer which tornadoes exist right now. A funnel is created for
   * an id it has not seen, moved for one it has, and left to DISPERSE for one
   * that has stopped appearing — which is why a tornado dying needs no message
   * of its own.
   */
  apply(live: readonly FunnelSource[]): void;
  /** Advances every funnel's presence and the shared clock. `dt` in seconds. */
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

/** Stable 0…1 from a storm id. */
function unitFromId(id: number): number {
  let h = id >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

export function createFunnel(): FunnelRenderer {
  const root = new Group();
  root.name = 'storms:funnel';

  const capacity = MAX_FUNNELS * PARTICLES_PER_FUNNEL;

  // Authored two units across so the fragment shader's vQuad is in half-widths;
  // the real size is applied in view space, per particle, from its height.
  const geometry = new PlaneGeometry(2, 2, 1, 1);

  const material = new ShaderMaterial({
    uniforms: { uElapsed: { value: 0 } },
    vertexShader: FUNNEL_VERTEX_SHADER,
    fragmentShader: FUNNEL_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'storms:funnel:particles';
  mesh.count = 0;
  mesh.renderOrder = FUNNEL_RENDER_ORDER;
  // Every vertex is displaced in the shader, so three's bounding sphere — which
  // it computes from the undisplaced quad — describes nothing this mesh draws.
  mesh.frustumCulled = false;
  root.add(mesh);

  const phases = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const seeds = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  phases.setUsage(DynamicDrawUsage);
  seeds.setUsage(DynamicDrawUsage);
  strengths.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aPhase', phases);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aStrength', strengths);

  const funnels = new Map<number, Funnel>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);

  return {
    root,

    apply(live): void {
      // Everything is presumed finished until this call says otherwise — the
      // rule that turns "the tornado stopped being broadcast", which arrives as
      // an ABSENCE, into the start of a dispersal.
      for (const funnel of funnels.values()) funnel.alive = false;

      for (const storm of live) {
        const existing = funnels.get(storm.id);
        if (existing !== undefined) {
          existing.alive = true;
          existing.x = storm.x;
          existing.groundY = storm.groundY;
          existing.z = storm.z;
          existing.intensity = storm.intensity;
          continue;
        }
        if (funnels.size >= MAX_FUNNELS) continue;
        funnels.set(storm.id, {
          x: storm.x,
          groundY: storm.groundY,
          z: storm.z,
          seed: unitFromId(storm.id),
          alive: true,
          presence: 0,
          intensity: storm.intensity,
        });
      }
    },

    update(dt, elapsed): void {
      material.uniforms.uElapsed!.value = elapsed;

      if (funnels.size === 0) {
        mesh.count = 0;
        return;
      }

      const phaseArray = phases.array as Float32Array;
      const seedArray = seeds.array as Float32Array;
      const strengthArray = strengths.array as Float32Array;
      let drawn = 0;

      for (const [id, funnel] of funnels) {
        if (funnel.alive) {
          funnel.presence = Math.min(1, funnel.presence + dt / FUNNEL_TOUCHDOWN_SECONDS);
        } else {
          funnel.presence -= dt / FUNNEL_DISPERSE_SECONDS;
          if (funnel.presence <= 0) {
            // Dispersed. Deleting DURING the iteration is safe on a Map.
            funnels.delete(id);
            continue;
          }
        }

        position.set(funnel.x, funnel.groundY, funnel.z);
        matrix.compose(position, rotation, scale);
        // The storm's own intensity times how far into its touchdown it is:
        // a weak tornado is a thin funnel, and a dispersing one thins out.
        const strength = funnel.presence * funnel.intensity;

        for (let i = 0; i < PARTICLES_PER_FUNNEL; i++) {
          mesh.setMatrixAt(drawn, matrix);
          // Evenly spaced around the life cycle, so the column is continuous.
          phaseArray[drawn] = i / PARTICLES_PER_FUNNEL;
          // Offset by the golden ratio per particle, so two tornadoes with
          // adjacent ids do not put their particles in the same places.
          seedArray[drawn] = (funnel.seed + i * 0.6180339887) % 1;
          strengthArray[drawn] = strength;
          drawn++;
        }
      }

      mesh.count = drawn;
      mesh.instanceMatrix.needsUpdate = true;
      phases.needsUpdate = true;
      seeds.needsUpdate = true;
      strengths.needsUpdate = true;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
      funnels.clear();
    },
  };
}

// THE PLUME — the ash column over an erupting vent, and the only part of this
// plugin a player can see from across the map.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE WHOLE COLUMN IS ONE DRAW CALL, AND THE CPU DOES NOT ANIMATE IT.
//
// Each particle's instance matrix holds only WHERE ITS VENT IS. The rise, the
// drift, the growth and the fade are all functions of one uniform (elapsed
// time) and two per-instance attributes (a phase and a seed), computed in the
// vertex shader. So a plume costs one matrix write per particle when a vent
// STARTS erupting and nothing at all per frame afterwards.
//
// That is not micro-optimisation, it is this project's standing render defect
// written down: the streaming/authoring unit keeps becoming the drawing unit,
// and low triangles-per-call over a shared material is the tell. A per-particle
// Sprite would have been MAX_VENTS × PARTICLES_PER_PLUME draw calls of two
// triangles each, against a 7 ms frame budget (140 fps is the project
// benchmark). One InstancedMesh is one call.
//
// ─────────────────────────────────────────────────────────────────────────────
// BILLBOARDED IN THE SHADER, not by writing rotations from the CPU. The quad is
// authored in XY and offset in VIEW space, which faces it at the camera exactly
// and for free — and, unlike a CPU billboard, cannot lag the camera by a frame.
//
// NO WIND FROM THE WEATHER PLUGIN, deliberately. Ash blowing downwind is the
// right picture and weather owns the only wind in the game, but a plugin does
// not import another plugin's internals (this plugin's rng.ts sets the rule
// out), and weather publishes its wind to CLIENTS as part of a system list this
// plugin has no business parsing. So each vent leans its column a fixed way,
// derived from its own id. If the two are ever to agree, the honest way is a
// published pose or a world event, not a reach across the boundary.

import {
  AdditiveBlending,
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

/** Particles in one vent's column. */
export const PARTICLES_PER_PLUME = 48;

/**
 * How many plumes can be drawn at once — the server's MAX_VENTS_PER_WORLD.
 *
 * Restated rather than imported (that constant is in ./server/, which nothing
 * under client/ imports) and kept equal to it: a smaller cap would silently
 * drop a plume for a vent the server is erupting.
 */
export const MAX_PLUMES = 8;

/** Seconds one particle takes to travel the whole column. */
export const PLUME_PARTICLE_LIFE_SECONDS = 6;

/**
 * How high the column rises, in world units.
 *
 * 18 — comfortably above a genesis cone's own ten bands of relief (ten world
 * units, since BAND_HEIGHT is one world unit of rise), so the column clears the
 * mountain that made it and is visible from ground level on the far side of it.
 * That is the whole job of this feature: an eruption you cannot see from
 * anywhere else is an eruption nobody attends.
 */
export const PLUME_HEIGHT_WORLD_UNITS = 18;

/** How far the column leans over its rise, in world units. */
export const PLUME_LEAN_WORLD_UNITS = 7;

/** Particle size at the vent mouth and at the top of the column, world units. */
export const PLUME_START_SIZE = CELL_WORLD_SIZE * 0.9;
export const PLUME_END_SIZE = CELL_WORLD_SIZE * 5;

/**
 * Seconds a column takes to build when an eruption starts, and to disperse
 * after it stops.
 *
 * ASYMMETRIC ON PURPOSE: an eruption's column arrives fast (3 s) because the
 * event is sudden, and clears slowly (12 s) because ash hangs. A symmetric fade
 * makes the end of an eruption look like somebody switched the plume off.
 */
export const PLUME_RISE_SECONDS = 3;
export const PLUME_DISPERSE_SECONDS = 12;

/**
 * Where the plume sits in the transparent pass — above ./lavaFlow.ts's decals.
 * Both are depth-write-off transparent geometry, so submission order IS
 * composite order, and ash rising out of a flow must be painted over it.
 */
export const PLUME_RENDER_ORDER = 2;

const PLUME_VERTEX_SHADER = /* glsl */ `
  uniform float uElapsed;

  attribute float aPhase;
  attribute float aSeed;
  attribute float aStrength;

  varying float vLife;
  varying float vSeed;
  varying float vStrength;
  varying vec2 vQuad;

  void main() {
    // 0 at the mouth, 1 at the top of the column. fract() is what makes one
    // instance a REPEATING particle rather than a single puff — the phase
    // attribute spaces the instances evenly around that cycle, so the column is
    // continuous with no CPU respawning anything.
    float life = fract(uElapsed / ${PLUME_PARTICLE_LIFE_SECONDS.toFixed(1)} + aPhase);
    vLife = life;
    vSeed = aSeed;
    vStrength = aStrength;
    vQuad = position.xy;

    // The instance matrix carries ONLY the vent's position; everything else
    // about where this particle is happens here.
    vec3 base = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

    // Rise, eased so particles bunch near the mouth and thin out at the top —
    // a column that is dense where it leaves the vent, which is what a real one
    // looks like and what a linear rise conspicuously does not.
    float rise = pow(life, 0.75) * ${PLUME_HEIGHT_WORLD_UNITS.toFixed(1)};

    // Lean, fixed per vent by its seed. Quadratic in life so the column goes up
    // before it goes sideways, instead of setting off at an angle.
    float leanAngle = aSeed * 6.28318;
    vec2 lean = vec2(cos(leanAngle), sin(leanAngle)) *
      life * life * ${PLUME_LEAN_WORLD_UNITS.toFixed(1)};

    // Per-particle scatter, so the column is a column and not a rope. It widens
    // with life for the same reason the size does: the plume spreads as it goes.
    float scatterAngle = fract(aSeed * 31.7 + aPhase * 17.3) * 6.28318;
    float scatter = life * ${(CELL_WORLD_SIZE * 2).toFixed(2)} * fract(aSeed * 7.13 + 0.31);
    vec2 wobble = vec2(cos(scatterAngle), sin(scatterAngle)) * scatter;

    vec3 world = base + vec3(lean.x + wobble.x, rise, lean.y + wobble.y);

    // BILLBOARD IN VIEW SPACE: offset the vertex after the view transform, so
    // the quad faces the camera exactly, with no rotation written from the CPU
    // and no chance of lagging the camera by a frame.
    float size = mix(
      ${PLUME_START_SIZE.toFixed(2)},
      ${PLUME_END_SIZE.toFixed(2)},
      life);
    vec4 viewPosition = viewMatrix * vec4(world, 1.0);
    viewPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const PLUME_FRAGMENT_SHADER = /* glsl */ `
  varying float vLife;
  varying float vSeed;
  varying float vStrength;
  varying vec2 vQuad;

  void main() {
    // A soft round puff. The quad is authored two units across, so vQuad is the
    // offset from its centre in half-widths and everything past 1 discards.
    float radius = length(vQuad);
    float puff = 1.0 - smoothstep(0.15, 1.0, radius);
    if (puff <= 0.0) discard;

    // GLOWING AT THE MOUTH, ASH ABOVE IT. The first fifth of the column is
    // lit by what it came out of; past that it is cooling dust. Two colours
    // and one smoothstep, because the transition is the whole picture: a
    // uniformly grey column reads as smoke from a chimney, and a uniformly
    // orange one as a fire that happens to be very tall.
    vec3 ember = vec3(1.0, 0.45, 0.12);
    vec3 ash = vec3(0.34, 0.31, 0.30);
    vec3 color = mix(ember, ash, smoothstep(0.0, 0.22, vLife));

    // In fast, out slow — a particle that appears at full opacity pops.
    float fade = smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));
    float alpha = puff * fade * vStrength * 0.5;
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** One vent's column, as this renderer remembers it. */
interface Plume {
  readonly x: number;
  readonly y: number;
  readonly groundY: number;
  /** Stable 0…1 from the vent id — decides the column's lean. */
  readonly seed: number;
  /** True while the server says this vent is erupting. */
  alive: boolean;
  /** 0…1. Rises over PLUME_RISE_SECONDS, falls over PLUME_DISPERSE_SECONDS. */
  strength: number;
}

/** One erupting vent, as ./index.ts hands it over. */
export interface PlumeSource {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** World-space Y of the ground at the vent mouth. */
  readonly groundY: number;
}

export interface PlumeRenderer {
  readonly root: Group;
  /**
   * Tells the renderer which vents are ERUPTING right now. A column is created
   * for an id it has not seen, kept for one it has, and left to DISPERSE for
   * one that has stopped appearing — which is why an eruption ending needs no
   * message of its own.
   */
  apply(erupting: readonly PlumeSource[]): void;
  /** Advances every column's strength and the shared clock. `dt` in seconds. */
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

export function createPlume(): PlumeRenderer {
  const root = new Group();
  root.name = 'volcanoes:plume';

  const capacity = MAX_PLUMES * PARTICLES_PER_PLUME;

  // Authored two units across so the fragment shader's vQuad is in half-widths;
  // the real size is applied in view space, per particle, from its life.
  const geometry = new PlaneGeometry(2, 2, 1, 1);

  const material = new ShaderMaterial({
    uniforms: { uElapsed: { value: 0 } },
    vertexShader: PLUME_VERTEX_SHADER,
    fragmentShader: PLUME_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // ADDITIVE, unlike ./lavaFlow.ts's decal and for the opposite reason: ash
    // and embers are a thin volume seen THROUGH, lit from inside, and stacking
    // them must brighten. (Normal blending over a dark sky would make the
    // column a grey slab, which is the defect fire's smoke plugin documents.)
    blending: AdditiveBlending,
  });

  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'volcanoes:plume:particles';
  mesh.count = 0;
  mesh.renderOrder = PLUME_RENDER_ORDER;
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

  const plumes = new Map<number, Plume>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);

  /** Stable 0…1 from a vent id. */
  function unitFromId(id: number): number {
    let h = id >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
  }

  return {
    root,

    apply(erupting): void {
      // Everything is presumed finished until this call says otherwise — fire's
      // smoke rule, and what turns "the vent stopped appearing in the erupting
      // list", which arrives as an ABSENCE, into the start of a dispersal.
      for (const plume of plumes.values()) plume.alive = false;

      for (const vent of erupting) {
        const existing = plumes.get(vent.id);
        if (existing !== undefined) {
          existing.alive = true;
          continue;
        }
        if (plumes.size >= MAX_PLUMES) continue;
        plumes.set(vent.id, {
          x: vent.x,
          y: vent.y,
          groundY: vent.groundY,
          seed: unitFromId(vent.id),
          alive: true,
          strength: 0,
        });
      }
    },

    update(dt, elapsed): void {
      material.uniforms.uElapsed!.value = elapsed;

      if (plumes.size === 0) {
        mesh.count = 0;
        return;
      }

      const phaseArray = phases.array as Float32Array;
      const seedArray = seeds.array as Float32Array;
      const strengthArray = strengths.array as Float32Array;
      let drawn = 0;

      for (const [id, plume] of plumes) {
        if (plume.alive) {
          plume.strength = Math.min(1, plume.strength + dt / PLUME_RISE_SECONDS);
        } else {
          plume.strength -= dt / PLUME_DISPERSE_SECONDS;
          if (plume.strength <= 0) {
            // Dispersed. Deleting DURING the iteration is safe on a Map.
            plumes.delete(id);
            continue;
          }
        }

        position.set(plume.x * CELL_WORLD_SIZE, plume.groundY, plume.y * CELL_WORLD_SIZE);
        matrix.compose(position, rotation, scale);

        for (let i = 0; i < PARTICLES_PER_PLUME; i++) {
          mesh.setMatrixAt(drawn, matrix);
          // Evenly spaced around the life cycle, so the column is continuous.
          phaseArray[drawn] = i / PARTICLES_PER_PLUME;
          // Offset by the particle index so two vents with adjacent ids do not
          // scatter their particles into the same places.
          seedArray[drawn] = (plume.seed + i * 0.6180339887) % 1;
          strengthArray[drawn] = plume.strength;
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
      plumes.clear();
    },
  };
}

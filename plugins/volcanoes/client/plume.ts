import {
  DoubleSide,
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
import { VENT_SUMMIT_WORLD_UNITS } from '../protocol.ts';
import {
  PUFF_ALPHA_DISCARD_GLSL,
  PUFF_BILLBOARD_GLSL,
  PUFF_INSTANCE_BASE_GLSL,
  puffMaskGlsl,
} from '../../../client/src/plugins/kit/puffDeck.ts';

export const PARTICLES_PER_PLUME = 48;

export const MAX_PLUMES = 8;

export const PLUME_PARTICLE_LIFE_SECONDS = 6;

export const PLUME_HEIGHT_IN_SUMMITS = 2.4;

export const PLUME_HEIGHT_WORLD_UNITS = VENT_SUMMIT_WORLD_UNITS * PLUME_HEIGHT_IN_SUMMITS;

export const PLUME_LEAN_WORLD_UNITS = PLUME_HEIGHT_WORLD_UNITS * 0.4;

export const PLUME_START_SIZE = VENT_SUMMIT_WORLD_UNITS * 0.28;
export const PLUME_END_SIZE = VENT_SUMMIT_WORLD_UNITS * 0.95;

export const PLUME_RISE_SECONDS = 3;
export const PLUME_DISPERSE_SECONDS = 12;

export const PLUME_RENDER_ORDER = 2;

const PLUME_VERTEX_SHADER =  `
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
    ${PUFF_INSTANCE_BASE_GLSL}

    // Rise, eased so particles bunch near the MOUTH and thin out at the top —
    // a column dense where it leaves the vent, which is what a real one looks
    // like and what a linear rise conspicuously does not.
    //
    // THE EXPONENT WAS 0.75 AND THAT BUNCHED THEM AT THE WRONG END: above 1,
    // pow(life, e) < life, so particles climb slowly at first and spread out
    // near the top; below 1 they shoot up and pile at the ceiling, which —
    // with additive blending and a size that grows with life — stacked forty
    // large bright quads on top of each other and blew the whole column out to
    // a white ball. Verified in preview-volcano.html, which is what a preview
    // harness is for.
    float rise = pow(life, 1.25) * ${PLUME_HEIGHT_WORLD_UNITS.toFixed(1)};

    // Lean, fixed per vent by its seed. Quadratic in life so the column goes up
    // before it goes sideways, instead of setting off at an angle.
    float leanAngle = aSeed * 6.28318;
    vec2 lean = vec2(cos(leanAngle), sin(leanAngle)) *
      life * life * ${PLUME_LEAN_WORLD_UNITS.toFixed(1)};

    // Per-particle scatter, so the column is a COLUMN and not a rope. It widens
    // with life for the same reason the size does: the plume spreads as it
    // goes. The first value here was half a summit and left the plume a
    // vertical thread — at this world's vertical scale the spread has to be
    // comparable to the mountain, not to a cell.
    float scatterAngle = fract(aSeed * 31.7 + aPhase * 17.3) * 6.28318;
    // A FLOOR ON THE SPREAD, not pure growth: with scatter proportional to life
    // alone every particle leaves the mouth on the same axis, and forty
    // additive quads on one axis is a searchlight beam, not a vent. The floor
    // is what gives the column a throat.
    float scatter = (0.28 + life) *
      ${(VENT_SUMMIT_WORLD_UNITS * 0.85).toFixed(2)} * fract(aSeed * 7.13 + 0.31);
    vec2 wobble = vec2(cos(scatterAngle), sin(scatterAngle)) * scatter;

    vec3 world = base + vec3(lean.x + wobble.x, rise, lean.y + wobble.y);

    // BILLBOARD IN VIEW SPACE: offset the vertex after the view transform, so
    // the quad faces the camera exactly, with no rotation written from the CPU
    // and no chance of lagging the camera by a frame.
    float size = mix(
      ${PLUME_START_SIZE.toFixed(2)},
      ${PLUME_END_SIZE.toFixed(2)},
      life);
    ${PUFF_BILLBOARD_GLSL}
  }
`;

const PLUME_FRAGMENT_SHADER =  `
  varying float vLife;
  varying float vSeed;
  varying float vStrength;
  varying vec2 vQuad;

  void main() {
    // A soft round puff. The quad is authored two units across, so vQuad is the
    // offset from its centre in half-widths and everything past 1 discards.
    ${puffMaskGlsl('0.15')}

    // GLOWING AT THE MOUTH, ASH ABOVE IT. The first fifth of the column is
    // lit by what it came out of; past that it is cooling dust. Two colours
    // and one smoothstep, because the transition is the whole picture: a
    // uniformly grey column reads as smoke from a chimney, and a uniformly
    // orange one as a fire that happens to be very tall.
    vec3 ember = vec3(1.0, 0.45, 0.12);
    vec3 ash = vec3(0.30, 0.28, 0.28);
    vec3 color = mix(ember, ash, smoothstep(0.0, 0.14, vLife));

    // In fast, out slow — a particle that appears at full opacity pops.
    // FADE IN SLOWLY. A fast ramp puts every particle at full strength while it
    // is still bunched at the mouth, and additive blending turns that into a
    // clipped white disc sitting on the summit.
    float fade = smoothstep(0.0, 0.20, vLife) * (1.0 - smoothstep(0.30, 0.95, vLife));

    // Far higher than the additive version's, and that is the blend mode's doing:
    // under normal blending each particle CONTRIBUTES ITS OWN COLOUR rather than
    // adding light, so a column of forty converges on the ash colour instead of
    // running away to white. Still well under 1 so the column is something you
    // see the sky through, which is what fire's smoke means by a thin volume.
    float alpha = puff * fade * vStrength * 0.30;
    ${PUFF_ALPHA_DISCARD_GLSL}
    gl_FragColor = vec4(color, alpha);
  }
`;

interface Plume {
  readonly x: number;
  readonly y: number;
  readonly groundY: number;
  readonly seed: number;
  alive: boolean;
  strength: number;
  slotBase: number;
  writtenStrength: number;
}

export interface PlumeSource {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly groundY: number;
}

export interface PlumeRenderer {
  readonly root: Group;
  apply(erupting: readonly PlumeSource[]): void;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

export function createPlume(): PlumeRenderer {
  const root = new Group();
  root.name = 'volcanoes:plume';

  const capacity = MAX_PLUMES * PARTICLES_PER_PLUME;

  const geometry = new PlaneGeometry(2, 2, 1, 1);

  const material = new ShaderMaterial({
    uniforms: { uElapsed: { value: 0 } },
    vertexShader: PLUME_VERTEX_SHADER,
    fragmentShader: PLUME_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'volcanoes:plume:particles';
  mesh.count = 0;
  mesh.renderOrder = PLUME_RENDER_ORDER;
  mesh.frustumCulled = false;
  root.add(mesh);

  const phases = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const seeds = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  geometry.setAttribute('aPhase', phases);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aStrength', strengths);

  const plumes = new Map<number, Plume>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);

  let layoutDirty = false;
  let drawn = 0;

  function markUploaded(attribute: InstancedBufferAttribute, instances: number): void {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, instances * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  function writeLayout(): void {
    const phaseArray = phases.array as Float32Array;
    const seedArray = seeds.array as Float32Array;
    const strengthArray = strengths.array as Float32Array;
    drawn = 0;

    for (const plume of plumes.values()) {
      position.set(plume.x * CELL_WORLD_SIZE, plume.groundY, plume.y * CELL_WORLD_SIZE);
      matrix.compose(position, rotation, scale);
      plume.slotBase = drawn;
      plume.writtenStrength = plume.strength;

      for (let i = 0; i < PARTICLES_PER_PLUME; i++) {
        mesh.setMatrixAt(drawn, matrix);
        phaseArray[drawn] = i / PARTICLES_PER_PLUME;
        seedArray[drawn] = (plume.seed + i * 0.6180339887) % 1;
        strengthArray[drawn] = plume.strength;
        drawn++;
      }
    }

    mesh.count = drawn;
    markUploaded(mesh.instanceMatrix, drawn);
    markUploaded(phases, drawn);
    markUploaded(seeds, drawn);
    markUploaded(strengths, drawn);
  }

  function unitFromId(id: number): number {
    let h = id >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
  }

  return {
    root,

    apply(erupting): void {
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
          slotBase: 0,
          writtenStrength: Number.NaN,
        });
        layoutDirty = true;
      }
    },

    update(dt, elapsed): void {
      material.uniforms.uElapsed!.value = elapsed;

      if (plumes.size === 0) {
        mesh.count = 0;
        drawn = 0;
        return;
      }

      for (const [id, plume] of plumes) {
        if (plume.alive) {
          plume.strength = Math.min(1, plume.strength + dt / PLUME_RISE_SECONDS);
        } else {
          plume.strength -= dt / PLUME_DISPERSE_SECONDS;
          if (plume.strength <= 0) {
            plumes.delete(id);
            layoutDirty = true;
          }
        }
      }

      if (plumes.size === 0) {
        mesh.count = 0;
        drawn = 0;
        layoutDirty = false;
        return;
      }

      if (layoutDirty) {
        writeLayout();
        layoutDirty = false;
        return;
      }

      const strengthArray = strengths.array as Float32Array;
      let touched = false;
      for (const plume of plumes.values()) {
        if (plume.strength === plume.writtenStrength) continue;
        strengthArray.fill(plume.strength, plume.slotBase, plume.slotBase + PARTICLES_PER_PLUME);
        plume.writtenStrength = plume.strength;
        touched = true;
      }
      if (touched) markUploaded(strengths, drawn);
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

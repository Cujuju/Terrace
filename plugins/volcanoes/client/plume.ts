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
import { VENT_SUMMIT_WORLD_UNITS } from '../protocol.ts';

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
 * How tall the column is, MEASURED IN SUMMITS — how many times the height of
 * the mountain it comes out of.
 *
 * 2.4, so a genesis volcano throws a column two and a half times its own height
 * above the sea. Real plumes run ten times their mountain and more; this is
 * compressed, because a column that tall in a world whose ENTIRE relief is 16
 * world units would be a wall across the sky rather than a landmark on it.
 */
export const PLUME_HEIGHT_IN_SUMMITS = 2.4;

/**
 * How high the column rises, in world units — 6, and DERIVED, never written.
 *
 * THE NUMBER THIS REPLACED WAS 18, AND 18 WAS IMPOSSIBLE. It was reasoned as
 * "comfortably above a genesis cone's own ten bands of relief (ten world units,
 * since BAND_HEIGHT is one world unit of rise)" — and BAND_HEIGHT has not been
 * one world unit of rise since 2026-08-20. A band draws a QUARTER of a world
 * unit, so ten bands is 2.5 units, not 10; the column was seven times the
 * mountain, and at 72 bands it was taller than the world's whole 64-band range
 * could ever be. Nothing would have failed — it would just have rendered, wrong.
 *
 * So it is derived from VENT_SUMMIT_WORLD_UNITS now, which is itself derived
 * from the bands the server actually sculpts. The way to change how tall a
 * plume is is to change the factor above, not this.
 */
export const PLUME_HEIGHT_WORLD_UNITS = VENT_SUMMIT_WORLD_UNITS * PLUME_HEIGHT_IN_SUMMITS;

/**
 * How far the column leans over its rise, in world units.
 *
 * Four tenths of its height: enough that the column is plainly blowing one way
 * rather than standing straight up (which reads as a special effect), and not
 * so much that it stops reading as a column at all.
 */
export const PLUME_LEAN_WORLD_UNITS = PLUME_HEIGHT_WORLD_UNITS * 0.4;

/** Particle size at the vent mouth and at the top of the column, world units. */
/**
 * DERIVED FROM THE COLUMN, not from the cell, for the reason the height above
 * records: a cell is a quarter of a world unit and nothing about how wide a
 * cloud of ash is follows from how finely the ground is sampled. The mouth is
 * about a third of a summit across and the top of the column is a summit and a
 * half — a plume that opens out as it rises, which is the silhouette that reads
 * as one from a distance.
 */
export const PLUME_START_SIZE = VENT_SUMMIT_WORLD_UNITS * 0.28;
export const PLUME_END_SIZE = VENT_SUMMIT_WORLD_UNITS * 0.95;

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
 * Where the plume sits in the transparent pass, against other TRANSPARENT
 * geometry — which no longer includes ./lavaFlow.ts.
 *
 * That flow was transparent depth-write-off geometry sorted into the same list
 * as this column, and this number was what kept ash rising out of a flow
 * painted over it. The flow is opaque now (see lavaFlow.ts's header), and
 * three renders the whole opaque list before the transparent one, so the
 * column is drawn after the flow whatever either renderOrder says. What this
 * still orders is the plume against the other transparent things a world
 * draws — weather sheets, smoke, monster atmosphere — and against nothing in
 * this plugin at all.
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
  /**
   * First instance slot this column occupies, set by the last full rewrite —
   * so a frame that only needs to move one column's strength knows where to
   * write it without walking the others.
   */
  slotBase: number;
  /** The strength value currently sitting in the buffer for those slots. */
  writtenStrength: number;
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
    // NORMAL BLENDING, NEVER ADDITIVE — plugins/fire/client/smoke.ts's rule,
    // and this plugin made the exact mistake that file already wrote down.
    //
    // The reasoning was "ash and embers are a thin volume seen THROUGH, lit
    // from inside, so stacking them must brighten". That is true of the EMBERS
    // and false of the ASH, and the ash is most of the column: additive grey
    // over a lit sky is a paler sky, which is to say no ash at all. Ash is also
    // the one thing here that must be able to DARKEN what is behind it — a
    // column standing against daylight is a silhouette — and additive blending
    // can only ever lighten. On the harness the additive version rendered as a
    // small white puff on the summit however its alpha was tuned, because the
    // failure was the blend mode and not the number.
    //
    // The ember base still reads: it is a BRIGHT colour at high alpha against
    // dark rock, which normal blending shows exactly as painted.
    side: DoubleSide,
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

  /**
   * Set whenever the instance LAYOUT stops matching the buffers — a column
   * added or dropped. A vent never moves, so nothing else can dirty it.
   *
   * The matrix, phase and seed buffers are functions of that layout alone;
   * only `strength` moves between pushes, and it stops moving the moment a
   * column has finished rising. Without this the whole capacity-sized pool of
   * all four buffers was re-uploaded every frame. See ../../storms/client/
   * spiral.ts, which had the same defect at a larger scale.
   */
  let layoutDirty = false;
  /** Instances the buffers currently describe — mesh.count, remembered. */
  let drawn = 0;

  /** Queues `instances` worth of `attribute` for upload, and nothing beyond. */
  function markUploaded(attribute: InstancedBufferAttribute, instances: number): void {
    attribute.clearUpdateRanges();
    // In ARRAY ELEMENTS, not instances: three multiplies the start by the
    // array's BYTES_PER_ELEMENT itself, so the count carries the itemSize.
    attribute.addUpdateRange(0, instances * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  /** Writes every buffer for every live column, and records where each landed. */
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
    markUploaded(mesh.instanceMatrix, drawn);
    markUploaded(phases, drawn);
    markUploaded(seeds, drawn);
    markUploaded(strengths, drawn);
  }

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

      // ── The life cycle, which is the only thing a frame actually advances ──
      for (const [id, plume] of plumes) {
        if (plume.alive) {
          plume.strength = Math.min(1, plume.strength + dt / PLUME_RISE_SECONDS);
        } else {
          plume.strength -= dt / PLUME_DISPERSE_SECONDS;
          if (plume.strength <= 0) {
            // Dispersed. Deleting DURING the iteration is safe on a Map.
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

      // ── The steady state: one float per particle, and none once a column has
      // finished rising and is holding at full strength.
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

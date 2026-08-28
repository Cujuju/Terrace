// THE FLOW ON THE GROUND — one decal per cell the server says is (or was) lava.
//
// ─────────────────────────────────────────────────────────────────────────────
// DRAWN ON THE TERRAIN'S OWN DRAWN SURFACE, NEVER MODELLED BESIDE IT.
//
// A flow LIES ON the ground and is seen against the very surface it is supposed
// to be part of, so it is placed by ClientPluginCtx.drawnGroundYAt — the Y that
// was actually written into the terrain's vertex buffer here — and NOT by
// terrainHeightAt, which answers which band the CELL LATTICE puts the cell in.
// The two disagree by a full band wherever a cell falls on the wrong side of
// its own smoothed contour. That is the rule the water work paid for four
// rewrites to learn (docs/DESIGN.md), and fire's scar decal is the precedent
// this file follows in every particular.
//
// WHY A DECAL AND NOT A TINT ON THE TERRAIN'S VERTICES. Tinting terrain
// vertices would put a gameplay concern inside core, which "nothing gamey in
// core" forbids — and it is also what makes "cooled lava is an overlay, not a
// terrain band" true rather than merely stated (protocol.ts). Delete this
// plugin and the mountain stays; only the glow goes.
//
// THE RESIDUAL THIS LEAVES, stated rather than hidden, and it is scar.ts's: the
// decal is ONE FLAT QUAD, and terraced ground is flat caps separated by
// one-unit risers, so a cell whose disc overhangs the lip of a step has that
// overhanging sliver floating a band above the cap below it. The disc's alpha
// falls to nothing at its rim, so what overhangs is the faintest part of it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT RUNS THE COOLING CURVE ITSELF.
//
// The wire carries each cell's AGE, and protocol.ts's heatFromAge is the curve
// both halves run (see LAVA_COOL_SECONDS's comment there). So between server
// messages this renderer ages every cell by its own dt and re-derives the heat,
// which is what lets the keepalive be a once-a-minute REPAIR rather than a
// stream of numbers that only ever count down.

import {
  Color,
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
import { heatFromAge, lavaKey, type LavaCellState } from '../protocol.ts';

/**
 * Hard ceiling on decals drawn at once.
 *
 * MATCHED TO THE SERVER'S OWN MAX_TRACKED_FLOW_CELLS (192) rather than chosen
 * independently: the server will never send more than it tracks, so a smaller
 * cap here would silently drop cells the server thinks the client has, and a
 * larger one would be memory reserved for a message that cannot arrive. It is
 * restated rather than imported because that constant lives in ./server/, and
 * nothing under client/ imports the server half.
 */
export const LAVA_DECAL_CAP = 192;

/**
 * The decal's radius, in world units.
 *
 * 0.75 × the cell it marks, so neighbouring cells of a flow OVERLAP and read as
 * one continuous river rather than as a dotted line of discs. A flow is one
 * world unit wide by construction (the server's FLOW_BRUSH_RADIUS is one world
 * unit), so this is the width of the thing it is drawing, plus the overlap that
 * hides the seams between its cells.
 */
export const LAVA_DECAL_RADIUS = CELL_WORLD_SIZE * 0.75;

/**
 * How far above the drawn cap the decal floats, in world units.
 *
 * Coplanar geometry z-fights, so a decal cannot sit exactly on the surface it
 * marks. This is fire's SCAR_HOVER_HEIGHT restated (two pixels of a 1080-line
 * frame at the closest zoom the player can reach, which is the worst case by
 * construction) — restated rather than imported for the plugin-boundary reason
 * in this plugin's rng.ts, and kept EQUAL to it deliberately: a scar and a lava
 * cell can land on the same ground, and two different lifts would decide which
 * of them wins by an accident of arithmetic instead of by render order.
 */
export const LAVA_HOVER_HEIGHT = 0.019;

/**
 * Where the flow sits in the transparent pass.
 *
 * Above nothing in particular and below the plume: both are depth-write-off
 * transparent geometry, so submission order IS composite order, and ash rising
 * out of a flow must be painted over it.
 */
export const LAVA_RENDER_ORDER = 1;

/**
 * The two ends of the flow's colour.
 *
 * The molten end is deliberately PAST white-hot in red and green while staying
 * dark in blue: the terrain is lit by core's rig and this decal is not, so the
 * only way for it to read as a light source rather than as orange paint is for
 * it to be brighter than anything the rig can make the ground. The crust end is
 * a very dark warm grey — not black, because an absolutely black patch on a lit
 * world reads as a HOLE in the terrain, which is the one thing a player would
 * be certain was a bug (fire's scar found the same floor).
 */
const LAVA_MOLTEN_COLOR = new Color(1.0, 0.42, 0.08);
const LAVA_CRUST_COLOR = new Color(0.09, 0.075, 0.07);

/**
 * How fast the molten cracks pulse, in radians per second, and how deep.
 *
 * Slow and shallow: 0.9 rad/s is a cycle every seven seconds, and ±12% of the
 * heat. Lava does not flicker like flame — it is a heavy liquid with a skin
 * that breaks and heals — and a fast pulse would make a whole hillside strobe
 * in unison, which is the tell of a shader rather than of a fluid. The phase is
 * offset per cell by its own seed, so the hillside breathes unevenly.
 */
const LAVA_PULSE_RATE = 0.9;
const LAVA_PULSE_DEPTH = 0.12;

/** Below this heat a cell is cold crust and its glow is gone entirely. */
const LAVA_GLOW_FLOOR = 0.02;

const LAVA_VERTEX_SHADER = /* glsl */ `
  attribute float aHeat;
  attribute float aSeed;

  varying vec2 vPlan;
  varying float vHeat;
  varying float vSeed;

  void main() {
    // The quad is authored two units across and lying in XZ, so position.xz IS
    // the offset from the cell's centre in radii — no division, no uniform.
    vPlan = position.xz;
    vHeat = aHeat;
    vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

/**
 * A hash-based value noise, written out here rather than imported.
 *
 * The fire plugin has one (its valueNoiseGlsl.ts) and this does not import it,
 * for the plugin-boundary reason this plugin's rng.ts sets out: a plugin is a
 * distributable unit a self-hoster may install without its neighbours.
 */
const LAVA_NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
`;

const LAVA_FRAGMENT_SHADER = /* glsl */ `
  uniform float uElapsed;
  uniform vec3 uMolten;
  uniform vec3 uCrust;

  varying vec2 vPlan;
  varying float vHeat;
  varying float vSeed;

  ${LAVA_NOISE_GLSL}

  void main() {
    // Distance from the cell's centre in radii. The outline sits at 1 and
    // everything past it — the four corners included — discards.
    float radius = length(vPlan);
    // No traceable circle: the noise pushes the boundary in and out, so what
    // falls off is a ragged edge. A flow's edge is where a viscous liquid
    // stopped, which is lobed, never an arc.
    float edge = vnoise(vPlan * 1.7 + vSeed) - 0.5;
    float body = 1.0 - smoothstep(0.35, 1.0, radius + edge * 0.3);
    if (body <= 0.0) discard;

    // THE CRACKS. Cold crust floating on molten rock: the noise field is the
    // crust, and what shows between its plates is the glow. Raising the field
    // to a power concentrates the bright part into thin veins rather than
    // leaving a smooth mottle, which is what makes it read as a broken skin.
    float plates = vnoise(vPlan * 3.4 + vSeed * 1.7);
    float veins = pow(1.0 - abs(plates - 0.5) * 2.0, 4.0);

    // The pulse is per cell, offset by the seed — a hillside that breathes
    // unevenly rather than one that strobes in unison.
    float pulse = 1.0 + ${LAVA_PULSE_DEPTH.toFixed(2)} *
      sin(uElapsed * ${LAVA_PULSE_RATE.toFixed(2)} + vSeed * 6.28318);
    float glow = clamp(vHeat * pulse, 0.0, 1.0);

    // Where the veins are, the cell is as hot as it is; where the plates are,
    // it is already crust. So the SAME cell shows both, and cools by the veins
    // narrowing and dimming rather than by the whole disc fading uniformly.
    vec3 color = mix(uCrust, uMolten, clamp(glow * (0.35 + 0.65 * veins), 0.0, 1.0));

    // Opaque MATTER, not a stain: this is new ground, and a translucent flow
    // would show the old grass through the rock that buried it. It stops short
    // of 1 only so the terrace step under it still reads through.
    float alpha = body * 0.94;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** One cell of flow, as this renderer remembers it. */
interface FlowDecal {
  readonly x: number;
  readonly y: number;
  /** The drawn cap under the cell — drawnGroundYAt, not terrainHeightAt. */
  readonly drawnY: number;
  /** Simulated seconds since it went molten; aged locally between messages. */
  ageSeconds: number;
  /** Stable 0…1, decorrelating this cell's noise and pulse from its neighbours'. */
  readonly seed: number;
}

/**
 * Resolves the Y the terrain DRAWS at a CELL, or null while this client has no
 * terrain for it yet. A function rather than a value because nothing under
 * plugins/ imports client/src at runtime: ./index.ts closes over its
 * ClientPluginCtx and hands the answer down.
 */
export type DrawnGroundAtCell = (cellX: number, cellY: number) => number | null;

export interface LavaFlowRenderer {
  /** Everything this renderer draws. The plugin adds it to its layer. */
  readonly root: Group;
  /** Replaces the whole flow — the `volcanoes:all` message. */
  replaceAll(cells: readonly LavaCellState[], groundAt: DrawnGroundAtCell): void;
  /** Adds cells that have just gone molten — the delta's `molten`. */
  add(cells: readonly LavaCellState[], groundAt: DrawnGroundAtCell): void;
  /** Drops cells the server has stopped tracking — the delta's `forgotten`. */
  forget(cells: ReadonlyArray<{ x: number; y: number }>): void;
  /** How many cells are still waiting on terrain that has not streamed in. */
  readonly pendingGround: number;
  /** Re-tries every pending cell's ground. Cheap; call on a slow retry clock. */
  retryPending(groundAt: DrawnGroundAtCell): void;
  /** Ages every cell and rewrites the instance buffers. `dt` is seconds. */
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

export function createLavaFlow(): LavaFlowRenderer {
  const root = new Group();
  root.name = 'volcanoes:flow';

  // One quad, no tessellation: the decal is flat by definition and every bit of
  // its shape is in the fragment shader, so extra vertices would buy nothing.
  const geometry = new PlaneGeometry(2, 2, 1, 1);
  // PlaneGeometry is authored in the XY plane; the ground is XZ.
  geometry.rotateX(-Math.PI / 2);

  const material = new ShaderMaterial({
    uniforms: {
      uElapsed: { value: 0 },
      uMolten: { value: LAVA_MOLTEN_COLOR },
      uCrust: { value: LAVA_CRUST_COLOR },
    },
    vertexShader: LAVA_VERTEX_SHADER,
    fragmentShader: LAVA_FRAGMENT_SHADER,
    transparent: true,
    // A mark ON the ground, not a surface of its own: writing depth would let a
    // flow occlude the plume, a flame or a tree standing in it.
    depthWrite: false,
  });

  const mesh = new InstancedMesh(geometry, material, LAVA_DECAL_CAP);
  mesh.name = 'volcanoes:flow:cells';
  mesh.count = 0;
  mesh.renderOrder = LAVA_RENDER_ORDER;
  // The instance matrices are rewritten as the flow grows and three caches the
  // bounding sphere from the first upload; culling against a stale sphere would
  // drop a flow that is plainly on screen.
  mesh.frustumCulled = false;
  root.add(mesh);

  const heats = new InstancedBufferAttribute(new Float32Array(LAVA_DECAL_CAP), 1);
  const seeds = new InstancedBufferAttribute(new Float32Array(LAVA_DECAL_CAP), 1);
  heats.setUsage(DynamicDrawUsage);
  seeds.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aHeat', heats);
  geometry.setAttribute('aSeed', seeds);

  /** Placed decals, by packed cell. */
  const decals = new Map<number, FlowDecal>();
  /**
   * Cells whose ground has not streamed in yet. Held rather than dropped: the
   * join snapshot's flow arrives before any chunk does, and a decal placed at a
   * guessed height would be lava painted on the sea.
   */
  const pending = new Map<number, LavaCellState>();

  // Scratch — built once and written in place forever.
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(LAVA_DECAL_RADIUS, 1, LAVA_DECAL_RADIUS);

  /** Stable 0…1 from a cell key — the same integer hash fire's smoke uses. */
  function unitFromKey(key: number): number {
    let h = key >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
  }

  function place(cell: LavaCellState, groundAt: DrawnGroundAtCell): void {
    const key = lavaKey(cell.x, cell.y);
    const drawnY = groundAt(cell.x, cell.y);
    if (drawnY === null) {
      pending.set(key, cell);
      return;
    }
    pending.delete(key);
    // The cap is the server's own, so exceeding it means the two have drifted;
    // dropping the newest is the safe half of that (the oldest cells are the
    // cold ones, and losing a hot cell would be the visible failure).
    if (!decals.has(key) && decals.size >= LAVA_DECAL_CAP) return;
    decals.set(key, {
      x: cell.x,
      y: cell.y,
      drawnY,
      ageSeconds: cell.ageSeconds,
      seed: unitFromKey(key),
    });
  }

  return {
    root,

    replaceAll(cells, groundAt): void {
      decals.clear();
      pending.clear();
      for (const cell of cells) place(cell, groundAt);
    },

    add(cells, groundAt): void {
      for (const cell of cells) place(cell, groundAt);
    },

    forget(cells): void {
      for (const cell of cells) {
        const key = lavaKey(cell.x, cell.y);
        decals.delete(key);
        pending.delete(key);
      }
    },

    get pendingGround(): number {
      return pending.size;
    },

    retryPending(groundAt): void {
      if (pending.size === 0) return;
      // Copied out first: `place` writes to `pending`, and mutating a Map while
      // iterating the same Map's values is how a retry loop drops entries.
      for (const cell of [...pending.values()]) place(cell, groundAt);
    },

    update(dt, elapsed): void {
      material.uniforms.uElapsed!.value = elapsed;

      if (decals.size === 0) {
        // Leave the drawn count at zero rather than re-uploading empty buffers.
        mesh.count = 0;
        return;
      }

      const heatArray = heats.array as Float32Array;
      const seedArray = seeds.array as Float32Array;
      let drawn = 0;

      for (const decal of decals.values()) {
        // AGED LOCALLY, on the same curve the server runs — protocol.ts's
        // heatFromAge. A cell that has gone cold is still DRAWN (it is crust,
        // and the ground really did change), it simply stops glowing.
        decal.ageSeconds += dt;
        const heat = heatFromAge(decal.ageSeconds);

        position.set(
          decal.x * CELL_WORLD_SIZE,
          decal.drawnY + LAVA_HOVER_HEIGHT,
          decal.y * CELL_WORLD_SIZE,
        );
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(drawn, matrix);
        heatArray[drawn] = heat < LAVA_GLOW_FLOOR ? 0 : heat;
        seedArray[drawn] = decal.seed;
        drawn++;
      }

      mesh.count = drawn;
      mesh.instanceMatrix.needsUpdate = true;
      heats.needsUpdate = true;
      seeds.needsUpdate = true;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
      decals.clear();
      pending.clear();
    },
  };
}

// THE FLOW ON THE GROUND — one mesh that DRAPES over the terraces, cap by cap
// and riser by riser, the way the terrain itself is built.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT A DECAL ANY MORE.
//
// It was: one flat quad per flow cell, hovering just over the drawn cap, which
// is what plugins/fire/client/scar.ts does for a burn mark. That file names the
// residual honestly — "the decal is ONE FLAT QUAD, and terraced ground is flat
// caps separated by one-unit risers, so a scar whose disc overhangs the lip of
// a step has that overhanging sliver floating a band above the cap below it" —
// and accepts it, because a scar is small and its rim is nearly transparent
// where it hangs over.
//
// A LAVA FLOW BREAKS THAT BARGAIN IN BOTH HALVES. It is not small: it runs
// sixty-four cells down a hillside, crossing a terrace step every four cells at
// the steepest slope the terrain permits. And it is not transparent at its rim:
// it is opaque new rock. So the overhang was not a faint sliver, it was the
// whole flow, sitting on the air beside every step it crossed (visible in
// .volcano-shots/03-flow-close.png).
//
// The fix is to stop pretending the ground is flat. This builds ACTUAL GEOMETRY
// over the flow's footprint: a cap quad per covered cell at that cell's own
// drawn height, plus a riser quad wherever a covered cell steps down to a
// covered neighbour. It is the same cap-and-riser construction the terrain mesh
// uses, restricted to the cells the lava reached — so the flow pours over a
// terrace lip instead of flying off it.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE MESH, ONE DRAW CALL, REBUILT ON A SERVER DELTA AND NEVER PER FRAME.
//
// The geometry is in WORLD SPACE (no instancing, no per-instance matrices), so
// it is rebuilt when the flow CHANGES — a few times a second during an eruption,
// never at all the rest of the time. Nothing is written per frame: the cooling
// is a function of one uniform (the clock) and one per-vertex attribute (when
// that cell went molten), so a flow that is quietly going out costs a uniform
// update and nothing else.
//
// That is the same reasoning ./plume.ts's header sets out, and the same standing
// defect it is written against: the streaming unit keeps becoming the drawing
// unit. A quad per cell would have been one draw call too, but it would have
// been re-uploaded every frame to animate the heat.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Mesh,
  ShaderMaterial,
} from 'three';
import { CELL_WORLD_SIZE, cellsAcross } from '@terrace/shared';
import {
  FLOW_RADIUS_WORLD_UNITS,
  LAVA_COOL_SECONDS,
  lavaKey,
  type LavaCellState,
} from '../protocol.ts';

/**
 * Hard ceiling on flow cells held at once — the server's own
 * MAX_TRACKED_FLOW_CELLS (192).
 *
 * Restated rather than imported because that constant lives in ./server/, which
 * nothing under client/ imports, and kept EQUAL to it: the server will never
 * send more than it tracks, so a smaller cap here would silently drop cells the
 * server believes this client has.
 */
export const LAVA_CELL_CAP = 192;

/** The flow's nominal radius, in CELLS — the footprint the mesh is built over. */
export const FLOW_RADIUS_CELLS = cellsAcross(FLOW_RADIUS_WORLD_UNITS);

/**
 * How much of the footprint is at full strength before the edge starts to fall
 * off, as a fraction of the radius.
 *
 * 0.55, so a little under half the width is margin. A flow does not end at a
 * line — it thins as the lava ran out of the energy to spread — and a hard edge
 * would read as a stencil laid on the hillside. It also keeps the flow's OWN
 * silhouette off the terrace lips: what reaches furthest is the part that is
 * nearly gone.
 */
export const FLOW_CORE_FRACTION = 0.45;

/**
 * How far above the drawn cap the mesh sits, in world units.
 *
 * Coplanar geometry z-fights, so the flow cannot sit exactly on the surface it
 * covers. This is fire's SCAR_HOVER_HEIGHT restated — two pixels of a 1080-line
 * frame at the closest zoom the player can reach, which is the worst case by
 * construction — restated rather than imported for the plugin-boundary reason
 * this plugin's rng.ts sets out, and kept EQUAL to it deliberately: a scar and a
 * lava flow can land on the same ground, and two different lifts would decide
 * which of them wins by an accident of arithmetic instead of by render order.
 */
export const LAVA_HOVER_HEIGHT = 0.019;

/**
 * Vertices the mesh will hold. Preallocated ONCE and filled by `drawRange`, so
 * a rebuild writes into buffers it already owns instead of allocating new ones
 * several times a second.
 *
 * THE BUDGET: at most LAVA_CELL_CAP path cells, each covering a disc of
 * FLOW_RADIUS_CELLS — but a flow is a LINE, not a scatter, so its footprint is
 * a ribbon roughly 2 × FLOW_RADIUS_CELLS wide and LAVA_CELL_CAP long, which is
 * about 1 500 covered cells. Each contributes one cap (6 vertices) and, only
 * where it steps down to a covered neighbour, a riser (6 more). Steps happen
 * about every fourth cell at the steepest slope the terrain permits, so the
 * honest estimate is ~1 500 × 9 ≈ 13 500. This is four times that, which covers
 * a flow that doubles back on itself across a slope.
 */
export const LAVA_VERTEX_CAP = 54_000;

/**
 * Where the flow sits in the transparent pass — below ./plume.ts's column, so
 * that ash rising out of a flow is painted over it. Both are depth-write-off
 * transparent geometry, so submission order IS composite order.
 */
export const LAVA_RENDER_ORDER = 1;

/**
 * The two ends of the flow's colour, as GLSL literals.
 *
 * THE CRUST IS NEAR-BLACK AND FAINTLY BLUE, and it is deliberately NOT warm
 * (owner, 2026-08-27: darker, and nothing that looks brown). Cooled basalt is a
 * cold dark grey; the warm dark grey this started at read as mud the moment the
 * glow left it. It stops short of true black because an absolutely black patch
 * on a lit world reads as a HOLE in the terrain, which is the one thing a player
 * would be certain was a bug — fire's scar found the same floor.
 *
 * The molten end stays past white-hot in red and dark in blue: the terrain is
 * lit by core's rig and this mesh is not, so the only way for it to read as a
 * light source rather than as orange paint is to be brighter than anything the
 * rig can make the ground.
 */
const LAVA_CRUST_RGB = '0.043, 0.045, 0.052';
const LAVA_MOLTEN_RGB = '1.0, 0.42, 0.06';
/** The hottest cores, where the rock is glowing through yellow. */
const LAVA_CORE_RGB = '1.0, 0.80, 0.33';

/** How fast the molten cracks pulse, in radians/second, and how deep. */
const LAVA_PULSE_RATE = 0.9;
const LAVA_PULSE_DEPTH = 0.1;

const LAVA_VERTEX_SHADER = /* glsl */ `
  attribute float aBirth;
  attribute float aStrength;

  varying vec2 vPlan;
  varying float vBirth;
  varying float vStrength;

  void main() {
    // The geometry is authored in WORLD space, so position.xz IS the world
    // plan coordinate — which is what makes the crust pattern below continuous
    // across the whole flow instead of restarting in every cell.
    vPlan = position.xz;
    vBirth = aBirth;
    vStrength = aStrength;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

  varying vec2 vPlan;
  varying float vBirth;
  varying float vStrength;

  ${LAVA_NOISE_GLSL}

  void main() {
    if (vStrength <= 0.0) discard;

    // THE COOLING CURVE, RUN IN THE SHADER — protocol.ts's heatFromAge, restated
    // in GLSL. This is why nothing is written per frame: aBirth is when this
    // cell went molten and uElapsed is now, so the heat falls out of one
    // subtraction and no buffer has to be touched as a flow goes out.
    float age = uElapsed - vBirth;
    float heat = clamp(1.0 - age / ${LAVA_COOL_SECONDS.toFixed(1)}, 0.0, 1.0);

    // THE CRUST. Cold plates floating on molten rock: the noise field is the
    // plates, and what shows between them is the glow.
    float plates = vnoise(vPlan * 2.6);
    float seam = 1.0 - abs(plates - 0.5) * 2.0;

    // THE VEINS NARROW AS IT COOLS, rather than the colour washing out — and
    // that is the whole reason there is no brown anywhere in this shader
    // (owner, 2026-08-27). Fading hot orange toward dark rock passes THROUGH
    // brown, and a flow spends most of its life in exactly that middle. So the
    // lit colour never changes; only how much of the surface is lit does. A
    // half-cooled flow is thin bright cracks on near-black, which is both what
    // the real thing looks like and the one version of it that is never muddy.
    //
    // The exponent runs 2 (fresh: broad rivers of lava with plates riding on
    // them) to 18 (cold: hairline seams), so what changes across a flow's life
    // is the AREA that is lit and never the colour of it.
    float veins = pow(seam, 2.0 + (1.0 - heat) * 16.0);

    // A slow, shallow pulse, offset by position so a hillside breathes unevenly
    // rather than strobing in unison. Lava is a heavy liquid with a skin that
    // breaks and heals; it does not flicker like flame.
    float pulse = 1.0 + ${LAVA_PULSE_DEPTH.toFixed(2)} *
      sin(uElapsed * ${LAVA_PULSE_RATE.toFixed(2)} + vPlan.x * 1.7 + vPlan.y * 1.3);

    // Tightened with a smoothstep so most of the surface is decisively crust or
    // decisively lava and the band between them is thin — the other half of
    // keeping the midtones out of the mud.
    float lit = smoothstep(0.12, 0.62, veins * heat * pulse);

    vec3 color = mix(vec3(${LAVA_CRUST_RGB}), vec3(${LAVA_MOLTEN_RGB}), lit);
    // The hottest seams glow through toward yellow, which is what stops a fresh
    // flow reading as a single flat orange.
    color = mix(color, vec3(${LAVA_CORE_RGB}), smoothstep(0.86, 1.0, lit) * 0.7);

    // Opaque MATTER: this is new ground, and a translucent flow would show the
    // grass through the rock that buried it. It stops short of 1 only so the
    // terrace step under it still reads through.
    gl_FragColor = vec4(color, vStrength * 0.96);
  }
`;

/** One cell the server says is lava, as this renderer remembers it. */
interface FlowCell {
  readonly x: number;
  readonly y: number;
  /** The value of the client clock at which this cell went molten. */
  readonly birth: number;
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
  replaceAll(cells: readonly LavaCellState[], elapsed: number, groundAt: DrawnGroundAtCell): void;
  /**
   * Applies ONE `volcanoes:changes` message — the delta's `forgotten` (cells
   * the server has stopped tracking) and its `molten` (cells that have just
   * gone molten), together.
   *
   * ONE MESSAGE, AT MOST ONE REBUILD, which is why this is a single call and
   * not the `add()` + `forget()` pair it replaces. Each of those rebuilt the
   * mesh for itself, so every delta that evicted — which is every delta once a
   * flow stands at LAVA_CELL_CAP — rebuilt the whole mesh twice to draw one
   * frame; and `add()` rebuilt unconditionally, so a message that carried
   * nothing but a vent's `erupting` flag rebuilt it for no visible change at
   * all. Here a message whose cells did not change rebuilds nothing.
   *
   * Forgotten cells are dropped BEFORE molten ones are taken, so a cell the
   * server evicted and immediately re-melted in the same message survives.
   */
  apply(
    forgotten: ReadonlyArray<{ x: number; y: number }>,
    molten: readonly LavaCellState[],
    elapsed: number,
    groundAt: DrawnGroundAtCell,
  ): void;
  /** True while some covered cell's terrain has not streamed in yet. */
  readonly pendingGround: boolean;
  /** Rebuilds against terrain that may have arrived. Call on a slow retry clock. */
  retryPending(groundAt: DrawnGroundAtCell): void;
  /** Advances the shared clock. No buffer is touched. */
  update(elapsed: number): void;
  dispose(): void;
}

export function createLavaFlow(): LavaFlowRenderer {
  const root = new Group();
  root.name = 'volcanoes:flow';

  const positions = new Float32Array(LAVA_VERTEX_CAP * 3);
  const births = new Float32Array(LAVA_VERTEX_CAP);
  const strengths = new Float32Array(LAVA_VERTEX_CAP);

  const positionAttribute = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
  const birthAttribute = new BufferAttribute(births, 1).setUsage(DynamicDrawUsage);
  const strengthAttribute = new BufferAttribute(strengths, 1).setUsage(DynamicDrawUsage);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('aBirth', birthAttribute);
  geometry.setAttribute('aStrength', strengthAttribute);
  geometry.setDrawRange(0, 0);

  const material = new ShaderMaterial({
    uniforms: { uElapsed: { value: 0 } },
    vertexShader: LAVA_VERTEX_SHADER,
    fragmentShader: LAVA_FRAGMENT_SHADER,
    transparent: true,
    // Ground, not a surface of its own: writing depth would let the flow occlude
    // the plume, a flame or a tree standing in it.
    depthWrite: false,
    // Risers are vertical quads and a player can orbit to either side of one.
    side: DoubleSide,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'volcanoes:flow:crust';
  mesh.renderOrder = LAVA_RENDER_ORDER;
  // Vertices are rewritten whenever the flow grows and three caches the bounding
  // sphere from the first upload; culling against a stale sphere would drop a
  // flow that is plainly on screen.
  mesh.frustumCulled = false;
  root.add(mesh);

  /** The server's cells, by packed cell key. */
  const cells = new Map<number, FlowCell>();
  /** True when the last rebuild wanted ground it did not have. */
  let missingGround = false;

  /**
   * Rebuilds the whole mesh from `cells`.
   *
   * WHOLE, NOT INCREMENTAL, and deliberately: a new cell changes the coverage
   * and the risers of every cell within FLOW_RADIUS_CELLS of it, so an
   * incremental update would have to find and rewrite that neighbourhood
   * anyway. Rebuilding is O(covered cells), runs on a server delta rather than
   * a frame, and cannot leave a stale triangle behind.
   */
  function rebuild(groundAt: DrawnGroundAtCell): void {
    missingGround = false;

    if (cells.size === 0) {
      geometry.setDrawRange(0, 0);
      return;
    }

    // ── 1. The footprint ────────────────────────────────────────────────────
    // Every cell within FLOW_RADIUS_CELLS of some flow cell, carrying the
    // distance to the NEAREST one (which sets its edge falloff) and that
    // cell's birth (so the coverage cools with the lava that made it).
    const covered = new Map<number, { x: number; y: number; distance: number; birth: number }>();
    const radius = FLOW_RADIUS_CELLS;

    for (const cell of cells.values()) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const distance = Math.hypot(dx, dy);
          if (distance > radius) continue;
          const x = cell.x + dx;
          const y = cell.y + dy;
          if (x < 0 || y < 0) continue;
          const key = lavaKey(x, y);
          const existing = covered.get(key);
          // NEAREST WINS, and the birth travels with it: where two flows overlap
          // the ground belongs to whichever ran closer to it, which is also the
          // one whose heat it should be showing.
          if (existing !== undefined && existing.distance <= distance) continue;
          covered.set(key, { x, y, distance, birth: cell.birth });
        }
      }
    }

    // ── 2. The heights ──────────────────────────────────────────────────────
    const capY = new Map<number, number>();
    for (const [key, cell] of covered) {
      const y = groundAt(cell.x, cell.y);
      if (y === null) {
        // No terrain here yet (a join snapshot's flow arrives before any chunk
        // does). Noted rather than guessed: a cap placed at an invented height
        // would be lava hanging in the air.
        missingGround = true;
        continue;
      }
      capY.set(key, y + LAVA_HOVER_HEIGHT);
    }

    // ── 3. The mesh ─────────────────────────────────────────────────────────
    let vertex = 0;
    const half = CELL_WORLD_SIZE / 2;

    function push(x: number, y: number, z: number, birth: number, strength: number): void {
      if (vertex >= LAVA_VERTEX_CAP) return;
      positions[vertex * 3] = x;
      positions[vertex * 3 + 1] = y;
      positions[vertex * 3 + 2] = z;
      births[vertex] = birth;
      strengths[vertex] = strength;
      vertex++;
    }

    function strengthOf(distance: number): number {
      const inner = radius * FLOW_CORE_FRACTION;
      if (distance <= inner) return 1;
      const t = (distance - inner) / (radius - inner);
      // smoothstep, so the edge eases out instead of ending on a line.
      return 1 - t * t * (3 - 2 * t);
    }

    for (const [key, cell] of covered) {
      const y = capY.get(key);
      if (y === undefined) continue;
      const strength = strengthOf(cell.distance);
      if (strength <= 0) continue;

      const x0 = cell.x * CELL_WORLD_SIZE - half;
      const x1 = x0 + CELL_WORLD_SIZE;
      const z0 = cell.y * CELL_WORLD_SIZE - half;
      const z1 = z0 + CELL_WORLD_SIZE;

      // The cap — this cell's own tread, at its own height. Never wider than
      // the cell, which is what makes an overhang impossible rather than
      // unlikely: a quad that cannot cross a cell boundary cannot cross a
      // terrace lip.
      push(x0, y, z0, cell.birth, strength);
      push(x0, y, z1, cell.birth, strength);
      push(x1, y, z1, cell.birth, strength);
      push(x0, y, z0, cell.birth, strength);
      push(x1, y, z1, cell.birth, strength);
      push(x1, y, z0, cell.birth, strength);

      // THE RISERS — the vertical face of every terrace step the flow crosses,
      // so the lava pours over a lip instead of flying off it.
      //
      // ONE RISER PER SHARED EDGE, EMITTED BY THE EDGE AND NOT BY EITHER CELL.
      // The first version only looked at the +x/+z neighbour and only when THIS
      // cell was the higher of the two — which silently skipped every step where
      // the flow runs UPHILL in +x or +z, and left the terrain's own bare riser
      // showing through the flow as a pale vertical strip (seen in
      // .volcano-shots/03-flow-close.png). Comparing the pair and drawing from
      // the higher down to the lower covers both directions and still visits
      // each edge exactly once, because only the +x and +z edges are walked.
      //
      // A RISER IS LIFTED SIDEWAYS, NOT UPWARDS. The cap's hover is a lift along
      // Y, which does nothing for a VERTICAL quad sitting in the terrain riser's
      // own plane; left coplanar the two z-fight, and on a flow crossing a step
      // every fourth cell that reads as a black stipple crawling over
      // everything. So the face is pushed out along the DOWNHILL normal by the
      // same distance the cap is pushed up.
      const edges: ReadonlyArray<
        readonly [number, number, number, number, number, number, number, number]
      > = [
        // [neighbour cell, edge point A, edge point B, outward normal]
        [cell.x + 1, cell.y, x1, z0, x1, z1, 1, 0],
        [cell.x, cell.y + 1, x1, z1, x0, z1, 0, 1],
      ];
      for (const [nx, ny, ax0, az0, bx0, bz0, normalX, normalZ] of edges) {
        const neighbourKey = lavaKey(nx, ny);
        const neighbour = covered.get(neighbourKey);
        if (neighbour === undefined) continue;
        const neighbourY = capY.get(neighbourKey);
        if (neighbourY === undefined || neighbourY === y) continue;

        const topY = Math.max(y, neighbourY);
        const bottomY = Math.min(y, neighbourY);
        // Downhill is +normal when this cell is the higher one, -normal when the
        // neighbour is; the face leans away from whichever body it belongs to.
        const sign = y > neighbourY ? 1 : -1;
        const offsetX = normalX * LAVA_HOVER_HEIGHT * sign;
        const offsetZ = normalZ * LAVA_HOVER_HEIGHT * sign;

        // The face carries the WEAKER of the two cells' strengths, so the flow's
        // edge fades down a step as evenly as it fades across a tread.
        const riserStrength = Math.min(strength, strengthOf(neighbour.distance));
        if (riserStrength <= 0) continue;
        // The birth of whichever cell is on top — the face is lava running over
        // the lip, and that lava is the upper cell's.
        const riserBirth = y > neighbourY ? cell.birth : neighbour.birth;

        const ax = ax0 + offsetX;
        const az = az0 + offsetZ;
        const bx = bx0 + offsetX;
        const bz = bz0 + offsetZ;
        push(ax, topY, az, riserBirth, riserStrength);
        push(bx, topY, bz, riserBirth, riserStrength);
        push(bx, bottomY, bz, riserBirth, riserStrength);
        push(ax, topY, az, riserBirth, riserStrength);
        push(bx, bottomY, bz, riserBirth, riserStrength);
        push(ax, bottomY, az, riserBirth, riserStrength);
      }
    }

    geometry.setDrawRange(0, vertex);
    positionAttribute.needsUpdate = true;
    birthAttribute.needsUpdate = true;
    strengthAttribute.needsUpdate = true;
  }

  /**
   * Takes the molten cells, ANSWERING WHETHER THE SET ACTUALLY CHANGED.
   *
   * The answer is what lets one message cost at most one rebuild: every path
   * out of the loop below is either a write (the geometry or a birth moved) or
   * a deliberate skip (a stale re-melt, or a new cell over the cap), and only
   * the writes are worth rebuilding for.
   */
  function remember(list: readonly LavaCellState[], elapsed: number): boolean {
    let changed = false;
    for (const cell of list) {
      const key = lavaKey(cell.x, cell.y);
      // BIRTH, NOT AGE: the server sends how old a cell is NOW, and the shader
      // wants the moment it started. Converting once on receipt is what lets
      // the cooling run with nothing written per frame.
      const birth = elapsed - cell.ageSeconds;
      const existing = cells.get(key);
      // A re-melted cell takes the NEWER birth; the ground really is molten
      // again, and taking the older one would show it already cold.
      if (existing !== undefined && existing.birth >= birth) continue;
      if (existing === undefined && cells.size >= LAVA_CELL_CAP) continue;
      cells.set(key, { x: cell.x, y: cell.y, birth });
      changed = true;
    }
    return changed;
  }

  /** Drops cells, answering whether any of them was actually held. */
  function drop(list: ReadonlyArray<{ x: number; y: number }>): boolean {
    let changed = false;
    for (const cell of list) changed = cells.delete(lavaKey(cell.x, cell.y)) || changed;
    return changed;
  }

  return {
    root,

    replaceAll(list, elapsed, groundAt): void {
      cells.clear();
      remember(list, elapsed);
      rebuild(groundAt);
    },

    apply(forgotten, molten, elapsed, groundAt): void {
      // FORGOTTEN FIRST, and the two results are collected before either is
      // acted on: a cell the server evicted and re-melted in the same message
      // has to survive, and it only does if the drop happens before the take.
      const dropped = drop(forgotten);
      const taken = remember(molten, elapsed);
      // A MESSAGE THAT MOVED NO CELL DRAWS THE SAME MESH IT ALREADY HOLDS.
      // `changes` also carries the complete vent list (protocol.ts), so the
      // server broadcasts one whenever a vent merely flips `erupting` — with
      // both cell lists empty. That message used to cost a full rebuild.
      if (!dropped && !taken) return;
      rebuild(groundAt);
    },

    get pendingGround(): boolean {
      return missingGround;
    },

    retryPending(groundAt): void {
      if (!missingGround) return;
      rebuild(groundAt);
    },

    update(elapsed): void {
      material.uniforms.uElapsed!.value = elapsed;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
      root.clear();
      cells.clear();
    },
  };
}

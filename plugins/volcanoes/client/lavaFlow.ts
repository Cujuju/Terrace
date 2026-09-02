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
// ONE MESH, ONE DRAW CALL, RE-STAMPED IN PLACE ON A SERVER DELTA AND NEVER PER
// FRAME.
//
// The geometry is in WORLD SPACE (no instancing, no per-instance matrices), so
// it is rewritten when the flow CHANGES — a few times a second during an
// eruption, never at all the rest of the time. Nothing is written per frame:
// the cooling is a function of one uniform (the clock) and one per-vertex
// attribute (when that cell went molten), so a flow that is quietly going out
// costs a uniform update and nothing else.
//
// AND A CHANGE COSTS THE CELLS IT MOVED, NOT THE WORLD'S HISTORY. Every covered
// cell owns a FIXED SLOT of LAVA_SLOT_VERTICES vertices — its cap and its two
// risers, degenerate where a piece is absent — so a delta rewrites the slots in
// the neighbourhood it touched and uploads those runs, and leaves every other
// cell's vertices exactly where they were. This used to rebuild the WHOLE mesh
// from `cells`, which is world-lifetime and capped at LAVA_CELL_CAP: the first
// new cell of an eruption in a world that had erupted before paid for all of
// it, ten times a second (issue #261).
//
// That is the same reasoning ./plume.ts's header sets out, and the same standing
// defect it is written against: the streaming unit keeps becoming the drawing
// unit. A quad per cell would have been one draw call too, but it would have
// been re-uploaded every frame to animate the heat.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FLOW IS OPAQUE GEOMETRY, AND ITS SOFT EDGE IS COVERAGE, NOT BLENDING.
//
// This used to be transparent geometry that wrote no depth, drawn at alpha
// 0.96 so the terrace lip underneath showed faintly through the rock. The
// owner settled that look against it (2026-09-01): cooled lava is new ground,
// and ground you can see the old ground through reads as a stain rather than
// as rock. So the material is `transparent: false`, `depthWrite: true`, and
// the edge falloff that used to arrive as blended alpha now arrives as
// ALPHA-TO-COVERAGE: the fragment still writes vStrength into gl_FragColor.a,
// and the GPU converts that alpha into a fraction of the pixel's MSAA samples
// (the renderer asks for `antialias: true`, so the samples exist). A rim at
// 40% strength lights 40% of the samples and resolves to a soft edge, without
// any of it depending on what was drawn before it.
//
// THE CONSEQUENCE THAT MATTERS BEYOND THE LOOK: EMISSION ORDER NO LONGER
// AFFECTS THE PICTURE. Every fragment now competes on depth alone, so which
// order the quads were written into the buffers in — and therefore which order
// the footprint was built in — cannot change a single pixel. Two caps at
// different terrace heights overlapping on screen resolve by which is nearer
// the camera, as they always should have. That is what let the incremental
// re-stamp above happen at all: a cell keeps ONE slot for as long as it is
// covered, so the buffer order is allocation order and has nothing to do with
// which cell is nearest the camera or which was stamped first. Under the old
// blended, depth-write-off material that would have repainted every overlap.

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
 * How much of the flow reaches a footprint cell that far, in cells, from the
 * nearest cell the lava actually ran through — 1 in the core, easing to 0 at
 * FLOW_RADIUS_CELLS.
 */
function edgeStrengthAt(distance: number): number {
  const inner = FLOW_RADIUS_CELLS * FLOW_CORE_FRACTION;
  if (distance <= inner) return 1;
  const t = (distance - inner) / (FLOW_RADIUS_CELLS - inner);
  // smoothstep, so the edge eases out instead of ending on a line.
  return 1 - t * t * (3 - 2 * t);
}

/** One cell of the disc a single flow cell stamps onto the footprint. */
interface FootprintOffset {
  readonly dx: number;
  readonly dy: number;
  readonly distance: number;
  /** edgeStrengthAt(distance) — a function of the OFFSET, so never recomputed. */
  readonly strength: number;
}

/**
 * The stencil one flow cell stamps: every offset within FLOW_RADIUS_CELLS, in
 * the exact order the nested dy/dx loop used to visit them.
 *
 * BUILT ONCE, because none of it depends on the cell being stamped. This was a
 * `Math.hypot` and a reject test per offset per flow cell per rebuild — 81 x
 * LAVA_CELL_CAP = 15 552 of each, several times a second — to re-derive a
 * fixed disc, and the edge falloff re-derived a smoothstep from a distance
 * that could only ever be one of the values in this table.
 *
 * IT IS ALSO READ THE OTHER WAY ROUND. `findNearestFlow` walks these same
 * offsets FROM a plan cell and asks `cells` whether each lands on lava, which
 * is only the same disc because a disc is symmetric under negation: the offset
 * that reaches a flow cell from here carries exactly the distance and edge
 * strength that flow cell's own stencil would have stamped here. That inverted
 * read is what makes a single cell's coverage computable without walking every
 * flow cell in the world, and so is what makes the incremental re-stamp
 * possible.
 *
 * THE ORDER IS PRESERVED, BUT NOTHING DEPENDS ON IT ANY MORE. It used to decide
 * the order the footprint Map was built in and therefore which flow cell won an
 * exact distance tie. `findNearestFlow` states that tie-break outright instead
 * (see its own comment), so the result is a function of the SET of flow cells
 * and of nothing else — which is what makes an incrementally re-stamped mesh
 * comparable, triangle for triangle, against one stamped from scratch.
 */
const FOOTPRINT_STENCIL: readonly FootprintOffset[] = (() => {
  const out: FootprintOffset[] = [];
  for (let dy = -FLOW_RADIUS_CELLS; dy <= FLOW_RADIUS_CELLS; dy++) {
    for (let dx = -FLOW_RADIUS_CELLS; dx <= FLOW_RADIUS_CELLS; dx++) {
      const distance = Math.hypot(dx, dy);
      if (distance > FLOW_RADIUS_CELLS) continue;
      out.push({ dx, dy, distance, strength: edgeStrengthAt(distance) });
    }
  }
  return out;
})();

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
 * a re-stamp writes into buffers it already owns instead of allocating new ones
 * several times a second. LAVA_SLOT_CAP divides this into the fixed per-cell
 * slots the re-stamp hands out.
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
 * Where the flow sits WITHIN THE OPAQUE PASS — after the terrain, which draws
 * at the default renderOrder 0.
 *
 * IT NO LONGER DECIDES ANYTHING A PLAYER SEES, and the reason it used to is
 * gone. The old justification was that the flow and ./plume.ts's column were
 * both depth-write-off transparent geometry sorted into one list, so this
 * number chose which was painted over which. Now the flow is opaque: three
 * files a mesh into `opaque`, `transmissive` or `transparent` purely by
 * `material.transparent`, and renders those three lists in that fixed order —
 * so the plume is painted after the flow because it is transparent and the
 * flow is not, whatever either renderOrder says.
 *
 * WHAT IT STILL DOES is order the flow against other OPAQUE meshes, which is a
 * depth-rejection question and not a correctness one: drawing after the
 * terrain means terrain depth is already in the buffer, so flow fragments that
 * lost to it are rejected before the (noisy, several-octave) fragment shader
 * runs. Kept at 1 for that, and because a plugin that draws ground-level
 * decoration after the ground is the least surprising thing to read.
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

    // OPAQUE MATTER, AND THE ALPHA IS COVERAGE. This is new ground: nothing it
    // buried should read through it, so the alpha here is never a see-through
    // factor. The material is opaque with alphaToCoverage on, so this value is
    // consumed as the FRACTION OF THE PIXEL'S MSAA SAMPLES the flow occupies —
    // 1 across the body of the flow, easing to 0 at the rim, which resolves to
    // a soft edge made of geometry coverage rather than of blending. Full
    // strength therefore writes a fully opaque pixel (the 0.96 that used to sit
    // here existed only to let the terrace lip read through, which the owner
    // settled against on 2026-09-01).
    gl_FragColor = vec4(color, vStrength);
  }
`;
/**
 * One cell of the flow's FOOTPRINT — a cell the mesh covers, which is a flow
 * cell or one within FLOW_RADIUS_CELLS of one.
 *
 * Mutable and POOLED BY SLOT: the object lives in `slotCell` at the index of
 * the vertex slot the cell owns, and is overwritten in place when that slot is
 * handed to another cell. Nothing here is reallocated across a re-stamp.
 */
interface CoveredCell {
  x: number;
  y: number;
  /** Cells to the nearest flow cell, which is what sets `strength`. */
  distance: number;
  /** edgeStrengthAt(distance), carried rather than recomputed. */
  strength: number;
  /** The birth of that nearest flow cell, so the coverage cools with it. */
  birth: number;
  /**
   * The Y this cell's cap is drawn at (the drawn ground plus
   * LAVA_HOVER_HEIGHT), meaningful only while `hasCap` is true.
   */
  capY: number;
  /**
   * False while this client has no terrain for the cell — the cell keeps its
   * slot and its footprint entry, but the slot is written degenerate. Split out
   * from `capY` rather than encoded as a sentinel height, because every
   * sentinel Y is also a legal Y for a cap.
   */
  hasCap: boolean;
}

/** One cell the server says is lava, as this renderer remembers it. */
interface FlowCell {
  readonly x: number;
  readonly y: number;
  /** The value of the client clock at which this cell went molten. */
  readonly birth: number;
}

/**
 * THE FIXED VERTEX SLOT ONE COVERED CELL OWNS.
 *
 * A covered cell contributes at most three quads — its cap, the riser on its
 * +x edge and the riser on its +z edge — and it always occupies all three
 * places whether or not it fills them, because THAT is what lets a cell be
 * re-stamped without moving any other cell's vertices. A riser that does not
 * exist is written as a degenerate triangle pair (six vertices at one point,
 * strength 0), which the fragment shader discards on `vStrength <= 0.0` and the
 * rasteriser never reaches anyway: a zero-area triangle covers no sample.
 *
 * The alternative — packing the live quads and compacting on every change — is
 * what the whole-mesh rebuild did, and it is exactly the thing that made a
 * delta cost the world's history instead of the cells it moved.
 */
const LAVA_CAP_VERTICES = 6;
const LAVA_RISER_VERTICES = 6;
/** The +x and +z edges. One riser per SHARED edge, so each cell walks two. */
const LAVA_RISERS_PER_CELL = 2;
const LAVA_SLOT_VERTICES = LAVA_CAP_VERTICES + LAVA_RISERS_PER_CELL * LAVA_RISER_VERTICES;

/** Where each piece starts inside a slot, in vertices from the slot's base. */
const LAVA_CAP_OFFSET = 0;
const LAVA_RISER_X_OFFSET = LAVA_CAP_VERTICES;
const LAVA_RISER_Z_OFFSET = LAVA_CAP_VERTICES + LAVA_RISER_VERTICES;

/**
 * How many covered cells the preallocated buffers can hold at once — DERIVED
 * from the vertex budget and the slot size, never typed as a number of its own,
 * so the two cannot drift.
 *
 * At LAVA_VERTEX_CAP = 54 000 this is 3 000 slots against the ~1 500 cells a
 * flow at the server's cell cap honestly covers (see LAVA_VERTEX_CAP), i.e. the
 * same 2x headroom that budget was chosen with. A footprint that somehow
 * exceeded it would leave the overflowing cells out of the mesh — the same
 * silent truncation the old `push` bounds check did, in the same place in the
 * budget.
 */
const LAVA_SLOT_CAP = Math.floor(LAVA_VERTEX_CAP / LAVA_SLOT_VERTICES);

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
   * ONE MESSAGE, AT MOST ONE RE-STAMP, which is why this is a single call and
   * not the `add()` + `forget()` pair it replaces. Each of those rebuilt the
   * mesh for itself, so every delta that evicted — which is every delta once a
   * flow stands at LAVA_CELL_CAP — rebuilt the whole mesh twice to draw one
   * frame; and `add()` rebuilt unconditionally, so a message that carried
   * nothing but a vent's `erupting` flag rebuilt it for no visible change at
   * all. Here a message whose cells did not change re-stamps nothing.
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
  /**
   * Re-stamps the cells that were waiting on terrain, against terrain that may
   * have arrived. Call on a slow retry clock.
   */
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
  /** Held as one array so an upload does not allocate a list to walk. */
  const attributes = [positionAttribute, birthAttribute, strengthAttribute];

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('aBirth', birthAttribute);
  geometry.setAttribute('aStrength', strengthAttribute);
  geometry.setDrawRange(0, 0);

  const material = new ShaderMaterial({
    uniforms: { uElapsed: { value: 0 } },
    vertexShader: LAVA_VERTEX_SHADER,
    fragmentShader: LAVA_FRAGMENT_SHADER,
    // OPAQUE, WITH THE EDGE DONE BY COVERAGE. Cooled lava is new ground and
    // reads as rock only if it hides what it buried, so the flow is not
    // blended: it takes part in the opaque pass and writes depth like any other
    // solid surface, which is also what lets a flame or a tree standing in it
    // be occluded by the rock in front of them instead of showing through it.
    //
    // The soft rim survives because `alphaToCoverage` reinterprets the
    // fragment's alpha as MSAA sample coverage rather than as a blend weight —
    // the shader's vStrength falloff now lights a fraction of the samples in a
    // rim pixel and none beyond the footprint. This is only a soft edge because
    // the renderer is built with `antialias: true` (client/src/render/scene.ts
    // and client/src/previewVolcano.ts); on a single-sample target the same
    // material would give a hard, aliased boundary rather than a wrong picture.
    transparent: false,
    depthWrite: true,
    alphaToCoverage: true,
    // Risers are vertical quads and a player can orbit to either side of one.
    // (Cheaper than it was, too: three draws a DoubleSide material in two
    // passes — back faces then front — only while it is also transparent, and
    // this one no longer is.)
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

  /** Covered plan cell key → the index of the vertex slot that cell owns. */
  const covered = new Map<number, number>();
  /** Slot index → the covered cell occupying it. Reused, never reallocated. */
  const slotCell: CoveredCell[] = [];
  /** Slots whose cell left the footprint, ready to be handed to another. */
  const freeSlots: number[] = [];
  /**
   * ONE PAST THE HIGHEST SLOT EVER HANDED OUT — the draw range, in slots.
   *
   * It does not shrink when a slot in the middle is freed: that slot has
   * already been written degenerate, so drawing it costs a handful of zero-area
   * triangles and the alternative (compacting the tail) is the whole-mesh
   * rewrite this change exists to remove. It does reset to 0 when the footprint
   * empties, which is the only moment every slot is provably free.
   */
  let slotWatermark = 0;
  /**
   * Covered cells whose terrain had not streamed in when they were last
   * stamped, by plan cell key. This IS `pendingGround`, and it is what
   * `retryPending` re-stamps — the pending cells only, never the whole mesh.
   */
  const pendingCells = new Set<number>();

  // ── Scratch, reused across re-stamps so a delta allocates nothing ──────────
  /** The plan cells this re-stamp must recompute, deduplicated by key. */
  const dirtyKeys = new Set<number>();
  const dirtyX: number[] = [];
  const dirtyY: number[] = [];
  /** The slots this re-stamp must re-emit and upload. */
  const dirtySlots = new Set<number>();
  /** The flow cells this message added, dropped or re-melted. */
  const changedFlowX: number[] = [];
  const changedFlowY: number[] = [];
  /** dirtySlots, sorted, for coalescing the upload ranges. */
  const sortedSlots: number[] = [];

  /**
   * The result of the last `findNearestFlow`, returned through these rather
   * than through an object — the scan runs once per dirty cell per delta and an
   * allocation per call would put the garbage back that pooling took out.
   */
  let nearestFound = false;
  let nearestDistance = 0;
  let nearestStrength = 0;
  let nearestBirth = 0;

  /**
   * THE NEAREST FLOW CELL TO ONE PLAN CELL, scanned the way round that makes an
   * incremental re-stamp possible.
   *
   * The whole-mesh rebuild pushed: for each flow cell, stamp its disc. That
   * derives a cell's coverage only as a side effect of walking every flow cell
   * the world has ever held. This pulls: for one plan cell, look at the
   * FOOTPRINT_STENCIL offsets around IT and ask `cells` whether each is lava.
   * The stencil is a disc and a disc is symmetric under negation, so the offset
   * that reaches a flow cell from here carries exactly the distance and edge
   * strength that flow cell's own stencil would have stamped here.
   *
   * THE TIE-BREAK IS EXPLICIT, and that is a deliberate change of contract.
   * The push version resolved an exact distance tie with `existing.distance <=
   * offset.distance` — keep what is already there — so the winner was whichever
   * flow cell `cells` happened to iterate first: Map insertion order, which is
   * melt order EXCEPT for a re-melted cell, which keeps its old position under
   * a newer birth. That rule is unstateable without naming the iteration order,
   * and a pull scan has no iteration over `cells` at all.
   *
   * So it is written down instead: nearest wins; on an exact tie the OLDER
   * birth wins. Ties are the common case, not the corner: every cell beside
   * the path is equidistant to two consecutive path cells, so the tie decides
   * which way the heat gradient leans along the whole flow. Older-wins keeps
   * the shipped picture — measured against the push version over a 700-delta
   * scripted eruption, the only triangles that differ are around re-melts
   * (worst step 2.4% of them, birth only, never a position), and with re-melts
   * suppressed one step in 700. Newer-wins was tried and rejected (owner,
   * 2026-09-01): it differed on 697 of 700 steps, up to a third of the
   * triangles, by leaning every gradient downstream. On equal birth too —
   * which a single server tick makes common, since every cell in one message
   * shares an `ageSeconds` — the lower packed key wins, purely so the answer is
   * a function of the SET of flow cells and not of any order at all. That
   * total order is what makes an incrementally re-stamped mesh comparable,
   * triangle for triangle, against one stamped from scratch.
   */
  function findNearestFlow(px: number, py: number): void {
    nearestFound = false;
    let bestKey = 0;
    for (const offset of FOOTPRINT_STENCIL) {
      const fx = px + offset.dx;
      const fy = py + offset.dy;
      if (fx < 0 || fy < 0) continue;
      const key = lavaKey(fx, fy);
      const flow = cells.get(key);
      if (flow === undefined) continue;
      if (nearestFound) {
        if (offset.distance > nearestDistance) continue;
        if (offset.distance === nearestDistance) {
          if (flow.birth > nearestBirth) continue;
          if (flow.birth === nearestBirth && key >= bestKey) continue;
        }
      }
      nearestFound = true;
      nearestDistance = offset.distance;
      nearestStrength = offset.strength;
      nearestBirth = flow.birth;
      bestKey = key;
    }
  }

  /** Queues one plan cell for recomputation. Deduplicated; negatives dropped. */
  function markPlanCell(x: number, y: number): void {
    // The push version never created a footprint cell off the negative edge of
    // the world, and this must not either — a negative x would also collide in
    // `lavaKey`, which packs the pair assuming both fit in 16 bits.
    if (x < 0 || y < 0) return;
    const key = lavaKey(x, y);
    if (dirtyKeys.has(key)) return;
    dirtyKeys.add(key);
    dirtyX.push(x);
    dirtyY.push(y);
  }

  /**
   * Queues every plan cell whose footprint entry ONE changed flow cell can
   * affect: the disc of FOOTPRINT_STENCIL around it, and nothing else.
   *
   * That is the whole argument for the incremental re-stamp being exact. A plan
   * cell's entry is a function of the flow cells within FLOW_RADIUS_CELLS of
   * it, so it can only change if one of THOSE changed — appeared, vanished, or
   * was re-melted to a new birth. `p` is within range of `f` exactly when `p`
   * lies in `f`'s disc, so the union of the discs of the changed flow cells is
   * the complete set of plan cells that can move.
   */
  function markFlowDisc(fx: number, fy: number): void {
    for (const offset of FOOTPRINT_STENCIL) markPlanCell(fx + offset.dx, fy + offset.dy);
  }

  function takeSlot(): number {
    const reused = freeSlots.pop();
    if (reused !== undefined) return reused;
    if (slotWatermark >= LAVA_SLOT_CAP) return -1;
    const slot = slotWatermark++;
    if (slotCell[slot] === undefined) {
      slotCell[slot] = { x: 0, y: 0, distance: 0, strength: 0, birth: 0, capY: 0, hasCap: false };
    }
    return slot;
  }

  function writeVertex(
    index: number,
    x: number,
    y: number,
    z: number,
    birth: number,
    strength: number,
  ): void {
    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = z;
    births[index] = birth;
    strengths[index] = strength;
  }

  /**
   * Fills one quad's worth of a slot with a degenerate triangle pair — every
   * vertex on one point, strength 0.
   *
   * Placed on the cell's OWN first cap corner rather than at the origin, so a
   * slot's vertices never wander away from the cell they belong to. Nothing
   * reads them (a zero-area triangle covers no sample, and the fragment shader
   * discards on strength anyway), but a buffer whose unused entries sit under
   * the flow rather than at world zero is one whose bounding box still means
   * something to anyone who inspects it.
   */
  function writeDegenerate(base: number, count: number, x: number, y: number, z: number): void {
    for (let i = 0; i < count; i++) writeVertex(base + i, x, y, z, 0, 0);
  }

  /**
   * The riser on ONE shared edge of a covered cell, if that edge is a step;
   * degenerate if it is not.
   *
   * `edgeA`/`edgeB` are the edge's two ends in world plan coordinates and
   * `normalX`/`normalZ` its outward normal. The geometry is unchanged from the
   * whole-mesh version: the same lean along the downhill normal, the same
   * weaker-of-the-two strength, the same upper cell's birth.
   */
  function writeRiser(
    base: number,
    cell: CoveredCell,
    neighbourX: number,
    neighbourY: number,
    edgeAX: number,
    edgeAZ: number,
    edgeBX: number,
    edgeBZ: number,
    normalX: number,
    normalZ: number,
    fallbackX: number,
    fallbackZ: number,
  ): void {
    const y = cell.capY;
    const neighbourSlot = covered.get(lavaKey(neighbourX, neighbourY));
    const neighbour = neighbourSlot === undefined ? undefined : slotCell[neighbourSlot];
    if (neighbour === undefined || !neighbour.hasCap || neighbour.capY === y) {
      writeDegenerate(base, LAVA_RISER_VERTICES, fallbackX, y, fallbackZ);
      return;
    }

    const neighbourCapY = neighbour.capY;
    const topY = Math.max(y, neighbourCapY);
    const bottomY = Math.min(y, neighbourCapY);
    // Downhill is +normal when this cell is the higher one, -normal when the
    // neighbour is; the face leans away from whichever body it belongs to.
    const sign = y > neighbourCapY ? 1 : -1;
    const offsetX = normalX * LAVA_HOVER_HEIGHT * sign;
    const offsetZ = normalZ * LAVA_HOVER_HEIGHT * sign;

    // The face carries the WEAKER of the two cells' strengths, so the flow's
    // edge fades down a step as evenly as it fades across a tread.
    const riserStrength = Math.min(cell.strength, neighbour.strength);
    if (riserStrength <= 0) {
      writeDegenerate(base, LAVA_RISER_VERTICES, fallbackX, y, fallbackZ);
      return;
    }
    // The birth of whichever cell is on top — the face is lava running over
    // the lip, and that lava is the upper cell's.
    const riserBirth = y > neighbourCapY ? cell.birth : neighbour.birth;

    const ax = edgeAX + offsetX;
    const az = edgeAZ + offsetZ;
    const bx = edgeBX + offsetX;
    const bz = edgeBZ + offsetZ;
    writeVertex(base, ax, topY, az, riserBirth, riserStrength);
    writeVertex(base + 1, bx, topY, bz, riserBirth, riserStrength);
    writeVertex(base + 2, bx, bottomY, bz, riserBirth, riserStrength);
    writeVertex(base + 3, ax, topY, az, riserBirth, riserStrength);
    writeVertex(base + 4, bx, bottomY, bz, riserBirth, riserStrength);
    writeVertex(base + 5, ax, bottomY, az, riserBirth, riserStrength);
  }

  /**
   * Rewrites ONE slot from its covered cell and that cell's two neighbours.
   *
   * Every path writes all LAVA_SLOT_VERTICES vertices. A slot that is only
   * partly rewritten would keep whatever the cell before it left there, and
   * because a slot is never compacted there is no later pass to clean that up.
   */
  function writeSlot(slot: number): void {
    const cell = slotCell[slot];
    if (cell === undefined) return;
    const base = slot * LAVA_SLOT_VERTICES;

    const half = CELL_WORLD_SIZE / 2;
    const x0 = cell.x * CELL_WORLD_SIZE - half;
    const x1 = x0 + CELL_WORLD_SIZE;
    const z0 = cell.y * CELL_WORLD_SIZE - half;
    const z1 = z0 + CELL_WORLD_SIZE;

    // No terrain under it yet, or the edge falloff has run all the way out.
    // The whole-mesh version skipped such a cell entirely — cap AND both risers
    // — and so does this: three degenerate pairs emit nothing.
    if (!cell.hasCap || cell.strength <= 0) {
      writeDegenerate(base + LAVA_CAP_OFFSET, LAVA_CAP_VERTICES, x0, cell.capY, z0);
      writeDegenerate(base + LAVA_RISER_X_OFFSET, LAVA_RISER_VERTICES, x0, cell.capY, z0);
      writeDegenerate(base + LAVA_RISER_Z_OFFSET, LAVA_RISER_VERTICES, x0, cell.capY, z0);
      return;
    }

    const y = cell.capY;
    const strength = cell.strength;
    const birth = cell.birth;

    // The cap — this cell's own tread, at its own height. Never wider than
    // the cell, which is what makes an overhang impossible rather than
    // unlikely: a quad that cannot cross a cell boundary cannot cross a
    // terrace lip.
    const cap = base + LAVA_CAP_OFFSET;
    writeVertex(cap, x0, y, z0, birth, strength);
    writeVertex(cap + 1, x0, y, z1, birth, strength);
    writeVertex(cap + 2, x1, y, z1, birth, strength);
    writeVertex(cap + 3, x0, y, z0, birth, strength);
    writeVertex(cap + 4, x1, y, z1, birth, strength);
    writeVertex(cap + 5, x1, y, z0, birth, strength);

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
    //
    // AN EDGE IS OWNED BY THE CELL ON ITS LOW-COORDINATE SIDE, which is the
    // rule that makes the dirty set in `restamp` bigger than the footprint
    // change: this slot reads the +x and +z neighbours' heights and strengths,
    // so a cell that moves invalidates the slots of its -x and -z neighbours as
    // well as its own.
    writeRiser(base + LAVA_RISER_X_OFFSET, cell, cell.x + 1, cell.y, x1, z0, x1, z1, 1, 0, x0, z0);
    writeRiser(base + LAVA_RISER_Z_OFFSET, cell, cell.x, cell.y + 1, x1, z1, x0, z1, 0, 1, x0, z0);
  }

  /**
   * Uploads exactly the slots this re-stamp rewrote, as coalesced runs.
   *
   * ONLY WHAT CHANGED IS UPLOADED, which is the same argument the whole-mesh
   * version made for naming its live prefix, taken one step further: three's
   * WebGLAttributes.updateBuffer falls back to `bufferSubData(target, 0,
   * array)` — the WHOLE 1.08 MB array — when an attribute carries no update
   * ranges, and a named prefix of the live flow was still ~200 KB per delta.
   * Contiguous runs of dirty slots become one range each, so a delta that moved
   * a few hundred cells moves a few tens of KB.
   *
   * CLEARED FIRST, and not because three forgets to: updateBuffer calls
   * clearUpdateRanges() itself once it has uploaded. It only gets there when
   * the mesh RENDERS, though, and a re-stamp is driven by a server message —
   * two messages inside one frame would otherwise leave both messages' ranges
   * on the attribute, and every re-stamp after a frame the flow was not drawn
   * in would add more. Clearing here keeps the ranges to this re-stamp's,
   * whether or not a frame happened in between.
   */
  function uploadDirtySlots(): void {
    sortedSlots.length = 0;
    for (const slot of dirtySlots) sortedSlots.push(slot);
    sortedSlots.sort((a, b) => a - b);

    for (const attribute of attributes) attribute.clearUpdateRanges();

    let i = 0;
    while (i < sortedSlots.length) {
      const start = sortedSlots[i]!;
      let end = start;
      while (i + 1 < sortedSlots.length && sortedSlots[i + 1] === end + 1) {
        i++;
        end++;
      }
      i++;
      const firstVertex = start * LAVA_SLOT_VERTICES;
      const vertexCount = (end - start + 1) * LAVA_SLOT_VERTICES;
      for (const attribute of attributes) {
        // In ARRAY ELEMENTS, not vertices and not bytes — three multiplies the
        // start by the array's BYTES_PER_ELEMENT itself, so both numbers have
        // to be the vertex figure times the attribute's own itemSize.
        attribute.addUpdateRange(firstVertex * attribute.itemSize, vertexCount * attribute.itemSize);
      }
    }

    for (const attribute of attributes) attribute.needsUpdate = true;
  }

  function clearScratch(): void {
    dirtyKeys.clear();
    dirtyX.length = 0;
    dirtyY.length = 0;
    dirtySlots.clear();
  }

  /**
   * Re-stamps the queued dirty plan cells, and only them.
   *
   * A DELTA COSTS THE CELLS IT MOVED, NOT THE WORLD'S HISTORY. The whole-mesh
   * rebuild this replaces walked every one of `cells` — which is world-lifetime
   * and capped at LAVA_CELL_CAP — stamping a 49-offset disc from each, then
   * re-derived every covered cell's height and re-emitted every quad, so the
   * first new cell of an eruption in a world that had ever erupted before paid
   * a full-cap rebuild. Here the caller queues the plan cells a change can
   * reach (see `markFlowDisc` for why that set is complete) and this recomputes
   * those.
   *
   * IT RUNS IN THREE PASSES, AND THEY CANNOT BE MERGED. The footprint pass
   * settles every dirty cell's coverage and height; the riser pass widens the
   * set of SLOTS to re-emit to include each dirty cell's -x and -z neighbours,
   * because a riser is owned by the low side of the edge and reads the high
   * side's height; only then can a slot be written, because writing one reads
   * its neighbours' settled entries.
   *
   * RESIDUAL, stated rather than hidden: `groundAt` is re-read only for DIRTY
   * cells, where the whole-mesh rebuild re-read it for the entire footprint on
   * every delta. A covered cell whose drawn terrain height changes without any
   * flow cell near it changing therefore keeps its old cap height until a
   * delta, a `volcanoes:all` or a `retryPending` reaches it. The whole-mesh
   * version had the same hole whenever a message moved no cell at all (it
   * returned before rebuilding) — this widens it from "no cells moved" to "no
   * cells moved NEAR THIS ONE". Nothing in ./index.ts re-stamps on a terrain
   * change today, so neither version tracks a sculpt under a cooled flow.
   */
  function restamp(groundAt: DrawnGroundAtCell): void {
    // ── 1. The footprint, and the heights, over the dirty cells only ────────
    // Every dirty cell's distance to the NEAREST flow cell (which sets its edge
    // falloff) and that cell's birth (so the coverage cools with the lava that
    // made it), plus the height its cap is drawn at.
    for (let i = 0; i < dirtyX.length; i++) {
      const x = dirtyX[i]!;
      const y = dirtyY[i]!;
      const key = lavaKey(x, y);
      findNearestFlow(x, y);

      let slot = covered.get(key);

      if (!nearestFound) {
        // No lava within range any more: the cell leaves the footprint and
        // gives its slot back. The slot is left degenerate rather than
        // compacted away — see `slotWatermark`.
        if (slot === undefined) continue;
        const leaving = slotCell[slot]!;
        leaving.hasCap = false;
        leaving.strength = 0;
        covered.delete(key);
        pendingCells.delete(key);
        freeSlots.push(slot);
        dirtySlots.add(slot);
        continue;
      }

      if (slot === undefined) {
        slot = takeSlot();
        // Over LAVA_SLOT_CAP: the cell stays out of the mesh rather than
        // displacing one that is in it. Same truncation the old vertex-cap
        // bounds check did, and the budget makes it unreachable in practice.
        if (slot < 0) continue;
        covered.set(key, slot);
      }

      const entry = slotCell[slot]!;
      entry.x = x;
      entry.y = y;
      entry.distance = nearestDistance;
      entry.strength = nearestStrength;
      entry.birth = nearestBirth;

      const ground = groundAt(x, y);
      if (ground === null) {
        // No terrain here yet (a join snapshot's flow arrives before any chunk
        // does). Noted rather than guessed: a cap placed at an invented height
        // would be lava hanging in the air. The cell keeps its slot and its
        // place in the footprint, so its neighbours' risers still see it leave
        // — and `retryPending` comes back for exactly these.
        entry.hasCap = false;
        entry.capY = 0;
        pendingCells.add(key);
      } else {
        entry.hasCap = true;
        entry.capY = ground + LAVA_HOVER_HEIGHT;
        pendingCells.delete(key);
      }

      dirtySlots.add(slot);
    }

    // ── 2. The edges the dirty cells are the HIGH side of ───────────────────
    // A slot carries the risers on its cell's +x and +z edges, and each of
    // those reads the neighbour's cap height and strength. So a cell that
    // changed invalidates its -x and -z neighbours' slots as well as its own.
    for (let i = 0; i < dirtyX.length; i++) {
      const x = dirtyX[i]!;
      const y = dirtyY[i]!;
      if (x > 0) {
        const slot = covered.get(lavaKey(x - 1, y));
        if (slot !== undefined) dirtySlots.add(slot);
      }
      if (y > 0) {
        const slot = covered.get(lavaKey(x, y - 1));
        if (slot !== undefined) dirtySlots.add(slot);
      }
    }

    // The flow is gone. This is the one moment every slot is provably free, so
    // it is the one moment the watermark can be wound back — which keeps a
    // world that has finished erupting from drawing three thousand degenerate
    // slots for the rest of its life.
    if (covered.size === 0) {
      slotWatermark = 0;
      freeSlots.length = 0;
      geometry.setDrawRange(0, 0);
      clearScratch();
      return;
    }

    // ── 3. The vertices ─────────────────────────────────────────────────────
    for (const slot of dirtySlots) writeSlot(slot);

    geometry.setDrawRange(0, slotWatermark * LAVA_SLOT_VERTICES);
    uploadDirtySlots();
    clearScratch();
  }

  /**
   * Takes the molten cells, ANSWERING WHETHER THE SET ACTUALLY CHANGED and
   * recording WHICH cells did, in `changedFlow*`.
   *
   * The answer is what lets one message cost at most one re-stamp: every path
   * out of the loop below is either a write (the geometry or a birth moved) or
   * a deliberate skip (a stale re-melt, or a new cell over the cap), and only
   * the writes are worth re-stamping for. The list of them is what bounds the
   * re-stamp to a neighbourhood — a re-melt counts, because a new birth can
   * change which flow cell a tied footprint cell belongs to.
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
      changedFlowX.push(cell.x);
      changedFlowY.push(cell.y);
      changed = true;
    }
    return changed;
  }

  /** Drops cells, answering whether any of them was actually held. */
  function drop(list: ReadonlyArray<{ x: number; y: number }>): boolean {
    let changed = false;
    for (const cell of list) {
      if (!cells.delete(lavaKey(cell.x, cell.y))) continue;
      changedFlowX.push(cell.x);
      changedFlowY.push(cell.y);
      changed = true;
    }
    return changed;
  }

  /** Queues the disc of every flow cell this message moved. */
  function markChangedFlow(): void {
    for (let i = 0; i < changedFlowX.length; i++) markFlowDisc(changedFlowX[i]!, changedFlowY[i]!);
  }

  return {
    root,

    replaceAll(list, elapsed, groundAt): void {
      // THE JOIN SNAPSHOT GOES THROUGH THE SAME ROUTINE A DELTA DOES — it just
      // marks everything dirty. There is one emission path, so a snapshot and a
      // delta cannot drift apart, which is the property the whole change rests
      // on: the incrementally re-stamped mesh has to be the mesh a snapshot of
      // the same cells would have produced.
      //
      // "Everything" is every cell currently covered (the old flow's whole
      // footprint, which is where the old triangles are) plus the disc of every
      // cell of the new flow (which is where the new ones go).
      for (const slot of covered.values()) {
        const entry = slotCell[slot]!;
        markPlanCell(entry.x, entry.y);
      }
      cells.clear();
      changedFlowX.length = 0;
      changedFlowY.length = 0;
      remember(list, elapsed);
      markChangedFlow();
      restamp(groundAt);
    },

    apply(forgotten, molten, elapsed, groundAt): void {
      changedFlowX.length = 0;
      changedFlowY.length = 0;
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
      markChangedFlow();
      restamp(groundAt);
    },

    get pendingGround(): boolean {
      return pendingCells.size > 0;
    },

    retryPending(groundAt): void {
      if (pendingCells.size === 0) return;
      // ONLY THE CELLS THAT WERE WAITING. Their footprint entries cannot have
      // moved — no flow cell changed — so this re-runs the height lookup for
      // them and re-emits their slots and their neighbours' risers, which is
      // what a chunk arriving under them actually changes.
      for (const key of pendingCells) {
        const slot = covered.get(key);
        if (slot === undefined) continue;
        const entry = slotCell[slot]!;
        markPlanCell(entry.x, entry.y);
      }
      restamp(groundAt);
    },

    update(elapsed): void {
      material.uniforms.uElapsed!.value = elapsed;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
      root.clear();
      cells.clear();
      covered.clear();
      pendingCells.clear();
    },
  };
}

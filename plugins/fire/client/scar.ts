// THE BURN SCAR — the CLOSE-RANGE half of the signature ./smoke.ts carries at
// distance (issue #203, DESIGN.md 2026-08-26).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT IS FOR, AND WHY IT EXISTS ONLY BECAUSE SMOKE GOES SILENT.
//
// ./smoke.ts's close-range falloff goes to ZERO inside SMOKE_SILENT_DISTANCE.
// That is what fixed the grey-slab-in-the-face defect, and it left a new one: at
// the closest zoom the player can reach, a wood that has finished burning shows
// NOTHING — no flame, because the fire is out, and now no smoke either. This
// file is what the player sees there instead.
//
// ONE SIGNATURE, TWO HALVES, ONE CROSSOVER. The scar is at FULL strength
// exactly where the column is at nothing, and fades out as the column comes up,
// so at every camera distance exactly one of the two is saying "a fire happened
// here" and neither is shouting over the other. SMOKE_SILENT_DISTANCE and
// SMOKE_FULL_STRENGTH_DISTANCE are therefore IMPORTED from ./smoke.ts and never
// restated: two numbers that must agree are one number, and this file derives
// nothing of its own from their values.
//
// ─────────────────────────────────────────────────────────────────────────────
// ITS LIFETIME IS SMOKE'S, NOT THE WORLD'S.
//
// The scar appears when the fire does and retires on ./smoke.ts's clock — the
// same SMOKE_RISE_SECONDS up, the same SMOKE_AFTERLIFE_SECONDS down, keyed by
// ./flames/types.ts's stable `key` exactly as a column is. Nothing here is
// server state, nothing here is on the wire and nothing here is persisted, so
// SMOKE'S ACCEPTED RESIDUAL IS KEPT UNCHANGED: a client that joins after a fire
// died sees neither half of the signature. A scar that SURVIVES a rejoin is a
// question about world history and a different feature; the owner ruled it out
// of #203 deliberately.
//
// Reusing the rise as well as the afterlife is not laziness — it is the same
// arithmetic ./smoke.ts already recorded. A tree burns 22 s and reaches full
// strength; a crop burns 4 s and grass 3 s, so neither ever gets there. A tuft
// leaving the same black patch as a burned wood is the version of this feature
// that cries wolf, and the shared clock rules it out for free.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT KEEPS ITS OWN MAP RATHER THAN SHARING SMOKE'S.
//
// The two records look alike and are not the same record, in two ways that both
// matter:
//
//   * A COLUMN FOLLOWS A WALKING FIRE; A SCAR DOES NOT. ./smoke.ts refreshes a
//     column's x/z every frame, because a burning animal carries its smoke with
//     it. Scorched ground cannot walk. So the position here is frozen at the
//     moment the scar is created and never touched again — and a burning animal
//     still leaves a TRAIL of scars, because it lights the cell it stands on
//     (DESIGN.md, "fire is a vector") and each of those cell fires is a fire of
//     its own with a scar of its own.
//   * THE HEIGHT COMES FROM A DIFFERENT ORACLE — see the next section.
//
// ─────────────────────────────────────────────────────────────────────────────
// DRAWN ON THE TERRAIN'S OWN DRAWN SURFACE, NEVER MODELLED BESIDE IT.
//
// A flame STANDS on the ground and is seen against the sky; a scar LIES ON the
// ground and is seen against the very surface it is supposed to be part of. The
// two can therefore not use the same height. ./index.ts places a flame with
// ClientPluginCtx.terrainHeightAt, which answers "which band does the CELL
// LATTICE put this cell in" — but the terrain does not draw cell lattices: a
// band's cap is drawn over the region enclosed by the SMOOTHED MARCHED CONTOUR
// at that band's threshold, and the two disagree by a FULL BAND (one whole
// world unit of relief) wherever a cell falls on the wrong side of its own
// contour. So this file is placed by ClientPluginCtx.drawnGroundYAt, which is
// client/src/terrain/drawnGround.ts's answer: the Y that was actually written
// into the terrain's vertex buffer here.
//
// That is a rule the water work paid for four rewrites to learn, and it is why
// the scar is a DECAL the fire plugin draws rather than a tint on a terrain
// vertex. Tinting terrain vertices would put a gameplay concern inside core,
// which DESIGN.md's "nothing gamey in core" forbids, and would also make every
// burn a terrain edit.
//
// THE RESIDUAL THIS LEAVES, stated rather than hidden: the decal is ONE FLAT
// QUAD, and terraced ground is flat caps separated by one-unit risers. A scar
// whose disc overhangs the lip of a step has that overhanging sliver floating a
// band above the cap below it. It is bounded and it is small — the disc's alpha
// falls to nothing at its rim (SCAR_RIM_ROUGHNESS below), so what overhangs is
// the faintest part of the mark — and the alternative, one draw call per burned
// cell conformed to the ground under it, is disqualified by the budget rules.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BUDGET RULES (./flames/types.ts) BIND THE SCAR UNCHANGED.
//
//   * ONE InstancedMesh, ONE draw call for every scar in the world, capped
//     alongside the columns. A quad per burned cell done naively breaks the
//     draw-call rule however good it looks — the same bar smoke was held to.
//   * No external assets: the mark is a noise-eroded disc coloured in the
//     fragment shader, with no texture and no ramp table.
//   * No lights of its own.
//   * Allocation-free steady state: the scratch below is built once, and a Map
//     entry is allocated only when a NEW fire is first seen, which is a server
//     delta and not a frame event.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND IT MUST NOT DOUBLE UP ON STUMPS. plugins/flora already draws a STUMP as
// the residue a burned tree leaves (commit 372e9cc), so a burned wood is not
// what this feature is short of; burned GRASS and CROPS are, because they leave
// nothing at all. So the scar is deliberately FLAT, DARK and WIDER THAN THE
// THING THAT BURNED: it reads as scorched ground under and around whatever
// residue is already standing there, never as a second copy of it. Nothing in
// this file has any silhouette above the ground plane.
// ─────────────────────────────────────────────────────────────────────────────

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
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { FIRE_FLAME_INSTANCE_CAP } from '../protocol.ts';
import { VALUE_NOISE_GLSL } from './valueNoiseGlsl.ts';
import {
  SMOKE_AFTERLIFE_SECONDS,
  SMOKE_CLOSEST_ZOOM_FRAME_HEIGHT_WORLD_UNITS,
  SMOKE_FULL_STRENGTH_DISTANCE,
  SMOKE_MINIMUM_VISIBLE_STRENGTH,
  SMOKE_RENDER_ORDER,
  SMOKE_RISE_SECONDS,
  SMOKE_SILENT_DISTANCE,
} from './smoke.ts';
import type { FireInstance } from './flames/types.ts';

// ── Lifetime ──────────────────────────────────────────────────────────────
/**
 * How many scars may exist at once — burning and retiring together.
 *
 * ./smoke.ts's cap, and for its arithmetic: at most FIRE_FLAME_INSTANCE_CAP
 * things can be alight at one moment, each of them marks at most one patch of
 * ground, and a scar outliving its fire means the count can momentarily want to
 * exceed that. When it does the FAINTEST scar is evicted — the least visible
 * thing on screen is the correct thing to lose.
 */
const SCAR_CAP = FIRE_FLAME_INSTANCE_CAP;

// ── Size, in world units ──────────────────────────────────────────────────
/**
 * The radius every scar has whatever burned, in world units.
 *
 * ONE CELL. A fire burns exactly one cell (../protocol.ts keys a fire by a
 * packed cell), and a cell is CELL_WORLD_SIZE across whatever was growing on
 * it — so its half-diagonal is 0.18 world units and a disc of radius
 * CELL_WORLD_SIZE covers the burned cell with a margin of scorch around it.
 *
 * IT IS A FLOOR RATHER THAN A SCALE FACTOR because of who this feature is for.
 * Grass and crops are the fuels that leave nothing behind (a burned tree
 * already leaves flora's stump), and their fuel heights are 0.15 and 0.35 — a
 * mark scaled purely by fuel height would draw a burned tuft SMALLER than the
 * cell that burned, which is a mark nobody can see.
 */
const SCAR_MINIMUM_RADIUS = CELL_WORLD_SIZE;
/**
 * Extra radius per world unit of fuel height, on top of the floor above.
 *
 * 0.3, sized off the canopy that dropped the embers: a full-grown tree is 1.5
 * units tall and ~0.9 across (./torchMarker.ts's ring is sized to that same
 * foot), so 0.25 + 0.3 × 1.5 = 0.70 gives a tree a scar 1.4 units across —
 * just past its own crown, which is how far a burning tree scorches. A crop
 * lands at 0.36 and grass at 0.30, both barely above the floor. That keeps the
 * ordering grass < crop < tree that everything else about fuel keeps, while
 * making the DIFFERENCE between them small: the ground a fire touched is
 * mostly a fact about the fire, not about what was standing in it.
 */
const SCAR_RADIUS_PER_FUEL = 0.3;
/**
 * The viewport height a lift is judged invisible against, in pixels, and how
 * many of those pixels the scar is lifted by.
 *
 * 1080 because it is the commonest desktop viewport height; it decides only how
 * CONSERVATIVE the lift is, since the lift is a fixed world distance and a
 * taller viewport makes it smaller on screen, never larger. TWO pixels because
 * one still lets the depth buffer's quantisation win at a grazing camera angle,
 * which shows up on terraced ground as a flickering band, and two is the
 * smallest lift that reliably clears it.
 */
const SCAR_REFERENCE_VIEWPORT_LINES = 1080;
const SCAR_HOVER_SCREEN_PIXELS = 2;
/**
 * How far above the drawn cap the disc floats, in world units — 0.019.
 *
 * Coplanar geometry z-fights, so the decal cannot sit exactly on the surface it
 * marks; the question is how small a lift can be and still win that fight. It
 * is judged at the CLOSEST ZOOM THE PLAYER CAN REACH, which is the worst case
 * by construction: the frame is only SMOKE_CLOSEST_ZOOM_FRAME_HEIGHT_WORLD_UNITS
 * tall there, so a world distance covers more pixels than at any other range.
 * Two pixels of a 1080-line frame at that zoom is what the arithmetic below
 * gives, and being two pixels there it is under one pixel everywhere else.
 */
const SCAR_HOVER_HEIGHT =
  (SMOKE_CLOSEST_ZOOM_FRAME_HEIGHT_WORLD_UNITS / SCAR_REFERENCE_VIEWPORT_LINES) *
  SCAR_HOVER_SCREEN_PIXELS;

// ── The mark ──────────────────────────────────────────────────────────────
/**
 * How far out the disc stays at full density before it begins to fall off, as a
 * fraction of its radius.
 *
 * 0.45, so rather more than half the disc's WIDTH is falloff. A burn does not
 * end at a line — it thins from black through scorched to untouched — and a
 * hard-edged dark disc on grass reads as a decal someone stuck on the ground,
 * which is precisely the failure ./smoke.ts's SMOKE_EDGE_SOFTNESS exists to
 * avoid on the other half of this signature. A wide margin is also what lets
 * the overhanging-a-terrace-lip residual in the header stay cheap: what hangs
 * over an edge is the part that was nearly transparent anyway.
 */
const SCAR_CORE_FRACTION = 0.45;
/**
 * How far the noise may push the disc's boundary in and out, as a fraction of
 * its radius.
 *
 * 0.35 — deep enough that no part of the outline is a recognisable arc, which
 * is the whole job: a circle is the one shape a fire never burns, and the eye
 * finds a smooth curve however gently it fades. Bounded well under
 * SCAR_CORE_FRACTION so the erosion can only ever bite into the MARGIN; a
 * value that reached the core would be punching holes in the middle of the
 * burn, which is a different (and wrong) picture.
 */
const SCAR_RIM_ROUGHNESS = 0.35;
/**
 * The quad's half-width, in scar radii — 1 + SCAR_RIM_ROUGHNESS.
 *
 * DERIVED, NOT CHOSEN, and it is the difference between a ragged burn and a
 * burn with one straight side. The instance's scale is the scar's NOMINAL
 * radius, so a quad of half-width 1 would end exactly where the outline sits
 * before the noise touches it — and the noise pushes that outline OUTWARD by up
 * to SCAR_RIM_ROUGHNESS, so every lobe that bulged past 1 would be sliced off
 * flat against the quad's own edge. Giving the quad exactly the erosion's reach
 * as margin makes the widest possible lobe land on the quad's edge midpoint and
 * no further. It costs nothing: the extra area is fragments that discard.
 */
const SCAR_QUAD_HALF_WIDTH = 1 + SCAR_RIM_ROUGHNESS;
/**
 * Noise cycles across the disc's full width, and across a scar's mottling.
 *
 * The outline gets 1.5 cycles — a handful of lobes, which is what a burn front
 * stopping against damp ground looks like; more and the edge reads as fur. The
 * mottling gets 5.2, decorrelated from the outline both by frequency and by the
 * seed offset below, so the ash patches inside the burn are not just a scaled
 * copy of its own silhouette.
 */
const SCAR_OUTLINE_FREQUENCY = 1.5;
const SCAR_MOTTLE_FREQUENCY = 5.2;
/**
 * The two ends of the mark's colour. Char where the fire sat longest, ash where
 * it only passed.
 *
 * Both are warm rather than neutral, for ./smoke.ts's reason and the same one:
 * pure grey over this game's bright green grass reads as a rendering artefact,
 * and burned ground is brown-black in life. The char is not pure black either —
 * an absolutely black patch on a lit world reads as a HOLE in the terrain, and
 * a hole is the one thing a player would be certain was a bug.
 */
const SCAR_CHAR_COLOR: readonly [number, number, number] = [0.07, 0.055, 0.048];
const SCAR_ASH_COLOR: readonly [number, number, number] = [0.3, 0.28, 0.26];
/**
 * Alpha at the centre of a scar at full strength.
 *
 * HIGH, and that is the opposite of ./smoke.ts's SMOKE_ALPHA_PEAK for the
 * opposite reason: smoke is a thin volume seen THROUGH, so a dense column is a
 * grey slab, while scorched ground is opaque MATTER and a translucent one is a
 * stain. It stops short of 1 only so the band the scar sits on still reads
 * through it — the terrace step, the shoreline, the ground's own colour. At 1
 * the mark stops being on the terrain and becomes a hole in it.
 */
const SCAR_ALPHA_PEAK = 0.82;

/**
 * Where the scar sits in the transparent pass: one below ./smoke.ts's.
 *
 * Both are depth-write-off transparent geometry, so submission order IS
 * composite order and depth does not decide it. A column of smoke rises OUT OF
 * the ground it scorched, so the scar must be painted first and the column over
 * it; the reverse would put the ground mark on top of the gas leaving it.
 */
const SCAR_RENDER_ORDER = SMOKE_RENDER_ORDER - 1;

/** Stable 0…1 from an integer — ./smoke.ts's, which is ./flames/shaderPlume.ts's. */
function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

const SCAR_VERTEX_SHADER = /* glsl */ `
  attribute float aSeed;
  attribute float aStrength;

  varying vec2 vPlan;
  varying float vSeed;
  varying float vStrength;
  varying float vDistanceFade;

  void main() {
    // The quad is authored two units across and lying in XZ, so position.xz IS
    // the offset from the scar's centre in radii — no division, no uniform.
    vPlan = position.xz;
    vSeed = aSeed;
    vStrength = aStrength;

    // DISTANCE MEASURED TO THE SCAR'S CENTRE, not per-vertex: ./smoke.ts's rule
    // and its reason — the whole mark must fade as one body, and a per-vertex
    // distance would fade a scar's near edge differently from its far one.
    vec4 centre = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float cameraDistance = distance(cameraPosition, centre.xyz);
    // THE EXACT COMPLEMENT OF ./smoke.ts's vDistanceFade, over the same two
    // distances: full inside the closest zoom, where a column is drawn at
    // nothing, and gone by the default orbit, where a column is at full. One
    // signature, two halves, and the sum of the two is what the player sees.
    vDistanceFade = 1.0 - smoothstep(
      ${SMOKE_SILENT_DISTANCE.toFixed(2)},
      ${SMOKE_FULL_STRENGTH_DISTANCE.toFixed(2)},
      cameraDistance);

    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const SCAR_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vPlan;
  varying float vSeed;
  varying float vStrength;
  varying float vDistanceFade;

  ${VALUE_NOISE_GLSL}

  void main() {
    // Distance from the scar's centre in NOMINAL RADII: the outline sits at 1,
    // the quad reaches SCAR_QUAD_HALF_WIDTH along its axes so the eroded rim can
    // bulge past 1 without being sliced flat, and everything past the outline —
    // including all four corners — discards below.
    float radius = length(vPlan);

    // No hard outline, and no outline the eye can trace either. The noise moves
    // the boundary in and out, so what falls off is a ragged front rather than
    // an arc — a circle is the one shape a fire never burns.
    float outline = fnoise(vPlan * ${SCAR_OUTLINE_FREQUENCY.toFixed(2)} + vSeed);
    float body = 1.0 - smoothstep(
      ${SCAR_CORE_FRACTION.toFixed(2)},
      1.0,
      radius + outline * ${SCAR_RIM_ROUGHNESS.toFixed(2)});
    if (body <= 0.0) discard;

    // Char and ash, mottled. Decorrelated from the outline by frequency AND by
    // seed offset: sampled at the same phase, the pale patches would sit in the
    // same places as the outline's lobes and the whole mark would read as one
    // stencil scaled twice.
    float mottle = fnoise(vPlan * ${SCAR_MOTTLE_FREQUENCY.toFixed(2)} + vSeed + 37.4);
    vec3 color = mix(
      vec3(${SCAR_CHAR_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      vec3(${SCAR_ASH_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      0.5 + 0.5 * mottle);

    float alpha = body * vStrength * vDistanceFade * ${SCAR_ALPHA_PEAK.toFixed(2)};
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One fire's mark on the ground, remembered between frames.
 *
 * Everything here is copied BY VALUE out of a FireInstance and then FROZEN —
 * unlike ./smoke.ts's column, which refreshes its position every frame. The
 * instance object itself is never retained (./flames/types.ts's `key`).
 */
interface BurnScar {
  x: number;
  z: number;
  /** The drawn cap under the fire — ClientPluginCtx.drawnGroundYAt, not terrainHeightAt. */
  drawnY: number;
  radius: number;
  seed: number;
  /** 0…1. Rises while the fire is alight, decays for good once it is not. */
  strength: number;
  /** Whether the fire that made this scar was in the last applied list. */
  alive: boolean;
}

/**
 * Resolves the Y the terrain DRAWS at a world position, or null while this
 * client has no terrain for it yet.
 *
 * A function rather than a value because nothing under plugins/ imports
 * client/src at runtime: ./index.ts closes over its ClientPluginCtx and hands
 * the answer down.
 */
export type DrawnGroundAt = (worldX: number, worldZ: number) => number | null;

/**
 * The scar renderer's contract.
 *
 * Shaped like ./smoke.ts's FireSmoke and deliberately not FlameRenderer, for
 * FireSmoke's reason: the list `apply` is handed says WHICH FIRES ARE ALIVE,
 * not which marks to draw, and this renderer draws many marks that are not in
 * it.
 */
export interface FireScar {
  /** Everything this renderer draws. The plugin adds it to its layer. */
  readonly root: Group;
  /**
   * Tells the renderer which fires are ALIGHT right now. A scar is created for
   * a key it has not seen, refreshed for a key it has, and left to decay for a
   * key that has stopped appearing. Safe to call with an empty list on every
   * frame of a world that has stopped burning — that is exactly the case the
   * afterlife exists for.
   *
   * `groundAt` is only ever consulted for a key this renderer has NOT seen
   * before, so a chunk's contour plan is paid for once per burning chunk and
   * never per frame.
   */
  apply(fires: readonly FireInstance[], groundAt: DrawnGroundAt): void;
  /** How many scars are currently being drawn — live fires and retiring marks. */
  readonly drawnCount: number;
  /**
   * Advances every scar's lifetime. `dt` is seconds since the last frame.
   *
   * NO `elapsed`, unlike every other renderer in this plugin: scorched ground
   * does not move, so there is no phase to drive and no per-frame uniform.
   *
   * MUST be called on every frame in which anything is still marked, INCLUDING
   * frames on which nothing is burning — otherwise a scar's retirement stalls
   * and the last fire in the world leaves a permanent stain.
   */
  update(dt: number): void;
  /** Frees every geometry and material. Called once, at dispose. */
  dispose(): void;
}

export const createFireScar = (): FireScar => {
  const root = new Group();
  root.name = 'fire:scar';

  // Sized so the instance's scale is the scar's nominal RADIUS, with margin for
  // the rim erosion to bulge into (SCAR_QUAD_HALF_WIDTH). One quad, no
  // tessellation: the mark is flat by definition and every bit of its shape is
  // in the fragment shader, so extra vertices would buy nothing at all.
  const geometry = new PlaneGeometry(
    2 * SCAR_QUAD_HALF_WIDTH,
    2 * SCAR_QUAD_HALF_WIDTH,
    1,
    1,
  );
  // PlaneGeometry is authored in the XY plane; the ground is XZ.
  geometry.rotateX(-Math.PI / 2);

  const material = new ShaderMaterial({
    uniforms: {},
    vertexShader: SCAR_VERTEX_SHADER,
    fragmentShader: SCAR_FRAGMENT_SHADER,
    transparent: true,
    // A mark ON the ground, not a surface of its own: writing depth would let a
    // scar occlude the flame, the stump and the smoke standing in it.
    depthWrite: false,
    // Normal blending, never additive. This is the one thing in the fire
    // plugin whose entire job is to DARKEN what is behind it, and additive
    // blending can only ever lighten.
  });

  const mesh = new InstancedMesh(geometry, material, SCAR_CAP);
  mesh.name = 'fire:scar:marks';
  mesh.count = 0;
  mesh.renderOrder = SCAR_RENDER_ORDER;
  // The quad's own bounds are honest (nothing displaces a vertex here), but the
  // instance matrices are written every frame and three caches the bounding
  // sphere from the first upload; culling against a stale sphere would drop a
  // scar that is plainly on screen.
  mesh.frustumCulled = false;
  root.add(mesh);

  const seeds = new InstancedBufferAttribute(new Float32Array(SCAR_CAP), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(SCAR_CAP), 1);
  seeds.setUsage(DynamicDrawUsage);
  strengths.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aStrength', strengths);

  /** Every scar, by ./flames/types.ts's `key` — ./smoke.ts's rule, exactly. */
  const scars = new Map<number, BurnScar>();

  // Scratch — built once and written in place forever.
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  /**
   * Frees a slot when the cap binds, by dropping the FAINTEST scar — ./smoke.ts's
   * eviction and its reason: the least visible thing on screen is the cheapest
   * thing to lose, and unlike "drop the oldest" it never sacrifices a mark that
   * is still darkening in order to keep one that is about to fade out anyway.
   */
  function evictFaintest(): void {
    let faintestKey: number | null = null;
    let faintestStrength = Infinity;
    for (const [key, scar] of scars) {
      if (scar.strength < faintestStrength) {
        faintestStrength = scar.strength;
        faintestKey = key;
      }
    }
    if (faintestKey !== null) scars.delete(faintestKey);
  }

  return {
    root,

    get drawnCount(): number {
      return mesh.count;
    },

    apply(fires: readonly FireInstance[], groundAt: DrawnGroundAt): void {
      // Everything is presumed dead until this frame's list says otherwise —
      // ./smoke.ts's rule, and what turns "the fire is gone from the synced
      // set", which arrives as an ABSENCE and never as a message, into the
      // start of a scar's afterlife.
      for (const scar of scars.values()) scar.alive = false;

      for (const fire of fires) {
        const existing = scars.get(fire.key);
        if (existing !== undefined) {
          // POSITION IS NOT REFRESHED, and that is the difference from a smoke
          // column: a walking fire carries its smoke and leaves its scars.
          existing.alive = true;
          continue;
        }
        const drawnY = groundAt(fire.x, fire.z);
        // No terrain here yet (the join snapshot's fires arrive before any
        // chunk does). Skipped rather than queued: `apply` runs every frame the
        // fire is alight, so the next frame retries it for free, and a mark
        // placed at a guessed height would be a scar burned into the sea.
        if (drawnY === null) continue;
        if (scars.size >= SCAR_CAP) evictFaintest();
        // The only allocation this renderer makes after construction, and it
        // happens on a server delta — a new fire — not on a frame.
        scars.set(fire.key, {
          x: fire.x,
          z: fire.z,
          drawnY,
          radius: SCAR_MINIMUM_RADIUS + fire.fuelHeight * SCAR_RADIUS_PER_FUEL,
          seed: fire.seed,
          strength: 0,
          alive: true,
        });
      }
    },

    update(dt: number): void {
      if (scars.size === 0) {
        // Nothing has ever burned, or everything has faded. Leave the drawn
        // count at zero rather than re-uploading an empty buffer every frame.
        mesh.count = 0;
        return;
      }

      const seedArray = seeds.array as Float32Array;
      const strengthArray = strengths.array as Float32Array;
      let drawn = 0;

      for (const [key, scar] of scars) {
        if (scar.alive) {
          scar.strength = Math.min(1, scar.strength + dt / SMOKE_RISE_SECONDS);
        } else {
          scar.strength -= dt / SMOKE_AFTERLIFE_SECONDS;
          if (scar.strength < SMOKE_MINIMUM_VISIBLE_STRENGTH) {
            // Faded. Deleting DURING the iteration is safe on a Map, and is how
            // ./smoke.ts retires a column as it passes it.
            scars.delete(key);
            continue;
          }
        }

        position.set(scar.x, scar.drawnY + SCAR_HOVER_HEIGHT, scar.z);
        scale.set(scar.radius, 1, scar.radius);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(drawn, matrix);

        // The seed is a phase, not an index: scaled into a range wide enough
        // that two neighbouring cells land in different noise cells entirely.
        seedArray[drawn] = unitFromSeed(scar.seed, 9) * 64;
        strengthArray[drawn] = scar.strength;
        drawn++;
      }

      mesh.count = drawn;
      mesh.instanceMatrix.needsUpdate = true;
      seeds.needsUpdate = true;
      strengths.needsUpdate = true;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
      scars.clear();
    },
  };
};

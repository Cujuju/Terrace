// THE FUNNEL — a tornado, and the only part of this plugin that has to read as
// something with a SHAPE rather than as weather.
//
// ─────────────────────────────────────────────────────────────────────────────
// A SHEET, NOT A SWARM. The lesson this file was rewritten for.
//
// The first version was a column of billboarded puffs, copying the volcano
// plume. It never worked, at any count: a plume is a cloud, so a cloud of
// sprites IS a plume, but a funnel is a SURFACE — a continuous, tapered,
// rotating wall of condensation — and a stack of round sprites reads as a stack
// of round sprites however many you use and however you jitter them. Chasing it
// with density made it a grey sausage; chasing it with jitter made it a wisp.
//
// So the vortex is now one open-ended CONE MESH, tapered and twisted in the
// vertex shader, with the churn painted on as scrolling streaks in the fragment
// shader. A surface is drawn as a surface. The only sprites left are the DEBRIS
// SKIRT at the ground, which is genuinely a swarm — dirt and chaff thrown out
// around the touchdown — and is what gives the funnel a ragged foot instead of
// a clean geometric edge where it meets the terrain.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO DRAW CALLS FOR EVERY TORNADO IN THE WORLD, AND THE CPU ANIMATES NEITHER.
//
// The cone is an InstancedMesh whose instance matrix holds only where the
// tornado stands; the taper, the twist, the spin, the sway and the streaks are
// functions of one time uniform and three per-instance attributes. The skirt is
// a second InstancedMesh on the same principle. So a funnel costs a handful of
// matrix writes per server push and nothing per frame in between — which is
// this project's standing render defect (the streaming unit becoming the
// drawing unit; low triangles-per-call over a shared material) avoided by
// construction, against a 7 ms frame budget.

import {
  CylinderGeometry,
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
  REVEAL_CLIP_FRAGMENT_GLSL,
  REVEAL_CLIP_UNIFORMS_GLSL,
  REVEAL_CLIP_VERTEX_GLSL,
  type RevealClipUniforms,
} from '../../../client/src/plugins/kit/revealClip.ts';
import {
  TORNADO_HEIGHT_WORLD_UNITS,
  TORNADO_RADIUS_CELLS,
  WORLD_UNITS_PER_BAND,
} from '../protocol.ts';

/**
 * How many funnels can be drawn at once — the server's tornado cap, plus one.
 *
 * The spare is deliberate: a tornado that has stopped being broadcast is still
 * dispersing here for FUNNEL_DISPERSE_SECONDS, so at the moment one dies and
 * another forms this renderer legitimately holds one more than the server does.
 */
export const MAX_FUNNELS = 3;

/**
 * How much of the server's DAMAGE radius the visible vortex fills.
 *
 * A HALF, and the gap is not sloppiness — it is what a tornado is. The wind
 * that takes a roof off reaches well beyond the condensation funnel you can
 * see, so the damage swathe is genuinely wider than the column. Derived from
 * the server's radius rather than typed, so widening the damage still widens
 * the funnel.
 */
export const VISIBLE_VORTEX_FRACTION = 0.5;

/**
 * The vortex's radius at the ground and at the cloud, in world units.
 *
 * THE FLARE IS 2.4×, MEASURED AGAINST THE HEIGHT rather than chosen for itself:
 * at 4× the top was twelve world units across against a six-unit column, which
 * renders as a mushroom. A funnel has to be taller than it is wide at every
 * height or it stops reading as one.
 */
export const FUNNEL_GROUND_RADIUS_WORLD_UNITS =
  TORNADO_RADIUS_CELLS * CELL_WORLD_SIZE * VISIBLE_VORTEX_FRACTION;
export const FUNNEL_CLOUD_RADIUS_WORLD_UNITS = FUNNEL_GROUND_RADIUS_WORLD_UNITS * 2.4;

/**
 * Segments around the cone and up it.
 *
 * 48 × 24 — 2 304 triangles for a whole tornado, which is nothing, and the
 * counts are set by two different requirements. AROUND: the silhouette is a
 * circle seen edge-on, and under 32 segments the edge of the funnel visibly
 * facets. UP: the twist rotates each ring by a different amount, so the ring
 * spacing is what the helical shear is sampled at — too few and the streaks
 * staircase instead of spiralling.
 */
export const FUNNEL_RADIAL_SEGMENTS = 48;
export const FUNNEL_HEIGHT_SEGMENTS = 24;

/**
 * Turns of twist between the ground and the cloud.
 *
 * TWO. The whole cone is sheared into a helix by this, which is what makes the
 * streaks painted on it climb rather than run straight up. More than about
 * three and adjacent streaks alias into a moiré at any distance.
 */
export const FUNNEL_TWIST_TURNS = 2;

/**
 * Turns per second the vortex rotates.
 *
 * 0.9 — just under one revolution a second. It is the difference between a
 * static twisted shape and something spinning; much faster and it strobes at
 * frame rates that are multiples of it.
 */
export const FUNNEL_SPIN_TURNS_PER_SECOND = 0.9;

/**
 * Streaks painted around the cone.
 *
 * NINE, which is prime to neither the radial segments nor the twist, and that
 * is the point: a count that divides into either lines the streaks up with the
 * mesh and the funnel starts to look like a wireframe of itself.
 */
export const FUNNEL_STREAK_COUNT = 9;

/**
 * Seconds a funnel takes to disperse after the server stops broadcasting it.
 *
 * THERE IS NO TOUCHDOWN TIME, for the reason ./spiral.ts's
 * SPIRAL_DISPERSE_SECONDS gives at length: the arrival is already faded in by
 * the server's own spin-up envelope, which reaches the client as `intensity`,
 * and a second envelope here multiplies the two into invisibility. The
 * dispersal is the only direction the wire cannot express, because a dead
 * tornado simply stops appearing in the list.
 *
 * Five seconds, and slow on purpose: a touchdown is sudden but the debris
 * hangs, so a symmetric fade would make the end look like somebody switched
 * the funnel off.
 */
export const FUNNEL_DISPERSE_SECONDS = 5;

/** Debris sprites thrown out around one touchdown. */
export const DEBRIS_PER_FUNNEL = 64;

/**
 * How high the skirt reaches and how far out it is thrown, as fractions of the
 * funnel's own height and ground radius.
 *
 * A SIXTH OF THE HEIGHT and up to THREE GROUND RADII out. The skirt's job is to
 * hide the geometric circle where the cone meets the terrain and to say that
 * this thing is picking the ground up; it stops well below the point where it
 * would start competing with the vortex for the silhouette.
 */
export const DEBRIS_HEIGHT_FRACTION = 1 / 6;
export const DEBRIS_SPREAD_RADII = 3;

/** Seconds one debris sprite takes to be thrown out and fall back. */
export const DEBRIS_LIFE_SECONDS = 1.4;

/**
 * Where the funnel sits in the transparent pass — above the cyclone deck
 * (./spiral.ts's SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE, which is the highest of
 * that deck's two camera-dependent orders), so a tornado seen against an
 * overcast is painted over it. Both are depth-write-off transparent geometry,
 * so submission order IS composite order. The skirt goes above the cone for the
 * same reason: debris is in front of the wall it was torn from.
 */
export const FUNNEL_RENDER_ORDER = 2;
export const DEBRIS_RENDER_ORDER = 3;

// ─────────────────────────────────────────────────────────────────────────────
// THE VORTEX SHEET.

const CONE_VERTEX_SHADER = /* glsl */ `
  ${REVEAL_CLIP_UNIFORMS_GLSL}

  uniform float uElapsed;

  attribute float aSeed;
  attribute float aStrength;

  varying float vLife;
  varying float vStrength;
  varying float vSeed;
  varying vec2 vSurface;

  void main() {
    // The geometry is a UNIT open cylinder: uv.y runs 0 at the bottom rim to 1
    // at the top, and uv.x runs once around. Everything about the funnel's real
    // shape happens here, so the same geometry serves every tornado.
    float life = uv.y;
    vLife = life;
    vStrength = aStrength;
    vSeed = aSeed;
    vSurface = uv;

    // The instance matrix carries ONLY where the tornado is standing.
    vec3 base = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

    // THE TAPER. Quadratic rather than linear so the funnel is PINCHED near the
    // ground and flares late — the shape a tornado actually has. A linear cone
    // is a megaphone.
    float taper = life * life;
    float radius = mix(
      ${FUNNEL_GROUND_RADIUS_WORLD_UNITS.toFixed(4)},
      ${FUNNEL_CLOUD_RADIUS_WORLD_UNITS.toFixed(4)},
      taper);

    // THE TWIST AND THE SPIN. Each ring is rotated by a different amount, which
    // shears the whole cone into a helix — the mesh stays intact because every
    // vertex in a ring shares its own life value and therefore its rotation.
    //
    // uv.x IS THE ANGLE, not atan(position.z, position.x): the seam vertices
    // are duplicated with uv.x = 0 and 1, which is exactly what makes the two
    // sides of the seam land on the same point. Deriving the angle from the
    // position would work too, but it would recompute what the geometry
    // already knows and it would put a discontinuity at the seam.
    float angle = 6.28318 * (
      uv.x +
      life * ${FUNNEL_TWIST_TURNS.toFixed(2)} +
      uElapsed * ${FUNNEL_SPIN_TURNS_PER_SECOND.toFixed(2)} +
      aSeed);

    // A WOBBLE OF THE WHOLE AXIS, so the funnel snakes instead of standing
    // plumb. Two sines at incommensurate rates, which never visibly repeat, and
    // scaled by the taper so the foot stays planted while the top wanders.
    float sway = ${(FUNNEL_GROUND_RADIUS_WORLD_UNITS * 0.55).toFixed(4)} * taper;
    vec2 axis = vec2(
      sin(uElapsed * 0.7 + aSeed * 6.28318) * sway,
      cos(uElapsed * 0.53 + aSeed * 3.14159) * sway);

    vec3 world = base + vec3(
      cos(angle) * radius + axis.x,
      life * ${TORNADO_HEIGHT_WORLD_UNITS.toFixed(2)},
      sin(angle) * radius + axis.y);

    // NOTHING IS DRAWN OFF THE RECEIVED MAP (#284). The funnel is one of the
    // two kinds the server already filters on its CENTRE (broadcastVisible),
    // and this is the other half of that: a funnel standing near the frontier
    // is a 28-unit column, so its top can lean over ground this client has
    // never been sent even when its foot is on ground it has.
    ${REVEAL_CLIP_VERTEX_GLSL}

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const CONE_FRAGMENT_SHADER = /* glsl */ `
  ${REVEAL_CLIP_UNIFORMS_GLSL}

  // See ./spiral.ts's uDaylight note: this material is unlit, so the scene's
  // own light has to reach it as a number, or a funnel under a cyclone stays
  // sunlit while the ground around it does not.
  uniform float uDaylight;
  uniform float uElapsed;

  varying float vLife;
  varying float vStrength;
  varying float vSeed;
  varying vec2 vSurface;

  void main() {
    // The clip FIRST, so a discarded fragment does no other work.
    ${REVEAL_CLIP_FRAGMENT_GLSL}

    // THE CHURN, painted rather than modelled. Two bands of streaks at
    // incommensurate frequencies scrolling in opposite directions: one is the
    // condensation spiralling up the wall, the other tears holes in it. Their
    // beat is what makes a smooth cone look turbulent without a single extra
    // triangle or a texture fetch.
    float climb = sin(6.28318 * (
      vSurface.x * ${FUNNEL_STREAK_COUNT.toFixed(1)} +
      vLife * 2.0 +
      uElapsed * 1.7 +
      vSeed));
    float tear = sin(6.28318 * (
      vSurface.x * 5.0 -
      vLife * 3.3 +
      uElapsed * 0.9 +
      vSeed * 2.0));
    // THE FLOORS ARE HIGH, and that is what makes this a sheet with texture
    // rather than a lattice of gaps. Two sines multiplied average about a third
    // of their peak, so the first values here (0.58 and 0.62) put the whole
    // funnel at a third of its nominal alpha — in world, against a bright sea,
    // it read as a smear of glass. Raising the floors keeps the streaks and
    // gives the surface a body.
    float churn = (0.74 + 0.26 * climb) * (0.78 + 0.22 * tear);

    // DIRT AT THE BOTTOM, CLOUD AT THE TOP. What a funnel picks up is the
    // colour of the ground it is standing on; the top of it is the storm base
    // it hangs from. One smoothstep between the two is what makes a grey cone
    // read as a tornado rather than as a chimney.
    vec3 debris = vec3(0.40, 0.32, 0.23);
    vec3 cloud = vec3(0.62, 0.63, 0.68);
    vec3 color = mix(debris, cloud, smoothstep(0.04, 0.62, vLife)) * uDaylight;

    // DENSER AT THE FOOT, DISSOLVING INTO THE CLOUD AT THE TOP. Without the top
    // fade the cone ends on a hard rim, which reads as a cut-off pipe rather
    // than as a funnel going up into a storm.
    float body = (1.0 - 0.35 * vLife) * (1.0 - smoothstep(0.72, 1.0, vLife));

    float alpha = churn * body * vStrength * 0.85;
    if (alpha <= 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// THE DEBRIS SKIRT.

const DEBRIS_VERTEX_SHADER = /* glsl */ `
  ${REVEAL_CLIP_UNIFORMS_GLSL}

  uniform float uElapsed;

  attribute float aPhase;
  attribute float aSeed;
  attribute float aStrength;

  varying float vLife;
  varying float vStrength;
  varying vec2 vQuad;

  void main() {
    float life = fract(uElapsed / ${DEBRIS_LIFE_SECONDS.toFixed(2)} + aPhase);
    vLife = life;
    vStrength = aStrength;
    vQuad = position.xy;

    vec3 base = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

    // Thrown OUTWARD and up, then falling back — a parabola in height against a
    // radius that only ever grows. That asymmetry is what reads as debris being
    // flung out rather than as a ring pulsing.
    float radius = ${FUNNEL_GROUND_RADIUS_WORLD_UNITS.toFixed(4)} *
      (0.5 + ${DEBRIS_SPREAD_RADII.toFixed(1)} * life * fract(aSeed * 3.7 + 0.2));
    float angle = 6.28318 * (fract(aSeed * 61.7) + life * 0.35 +
      uElapsed * ${(FUNNEL_SPIN_TURNS_PER_SECOND * 0.6).toFixed(2)});
    float height = ${(TORNADO_HEIGHT_WORLD_UNITS * DEBRIS_HEIGHT_FRACTION).toFixed(3)} *
      4.0 * life * (1.0 - life) * fract(aSeed * 13.1 + 0.5);

    vec3 world = base + vec3(cos(angle) * radius, height, sin(angle) * radius);

    // Clipped like the cone above: debris thrown across the frontier is
    // geometry over floor this client was never sent.
    ${REVEAL_CLIP_VERTEX_GLSL}

    // BILLBOARD IN VIEW SPACE — faces the camera exactly, for free, with no
    // rotation written from the CPU and no chance of lagging it by a frame.
    float size = ${(WORLD_UNITS_PER_BAND * 0.55).toFixed(4)} * (0.5 + fract(aSeed * 29.3));
    vec4 viewPosition = viewMatrix * vec4(world, 1.0);
    viewPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const DEBRIS_FRAGMENT_SHADER = /* glsl */ `
  ${REVEAL_CLIP_UNIFORMS_GLSL}

  uniform float uDaylight;

  varying float vLife;
  varying float vStrength;
  varying vec2 vQuad;

  void main() {
    ${REVEAL_CLIP_FRAGMENT_GLSL}

    // The quad is authored two units across, so vQuad is the offset from its
    // centre in half-widths. Harder-edged than the cloud puffs elsewhere in
    // this plugin: this is dirt and chaff, not vapour.
    float radius = length(vQuad);
    float chip = 1.0 - smoothstep(0.35, 1.0, radius);
    if (chip <= 0.0) discard;

    vec3 color = vec3(0.34, 0.27, 0.19) * uDaylight;
    // In fast, out slow, and gone before it lands: a sprite that reached the
    // ground at full opacity would pile into a solid ring.
    float fade = smoothstep(0.0, 0.12, vLife) * (1.0 - smoothstep(0.45, 1.0, vLife));
    float alpha = chip * fade * vStrength * 0.8;
    if (alpha <= 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** One tornado, as this renderer remembers it. */
interface Funnel {
  x: number;
  /** World-space Y of the ground the funnel is standing on. */
  groundY: number;
  z: number;
  /** Stable 0…1 from the storm id — offsets the twist so two do not match. */
  readonly seed: number;
  /** True while the server is still broadcasting this tornado. */
  alive: boolean;
  /** 1 while the server is broadcasting it; falls over FUNNEL_DISPERSE_SECONDS. */
  presence: number;
  /** The storm's own intensity, as last broadcast. */
  intensity: number;
  /**
   * Cone slot and first debris slot this funnel occupies, set by the last full
   * rewrite — so a frame that only needs to change one funnel's strength knows
   * where to write it without walking the others.
   */
  coneSlot: number;
  debrisBase: number;
  /** The strength value currently sitting in the buffers for those slots. */
  writtenStrength: number;
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
  /**
   * Advances every funnel's presence and the shared clock. `dt` in seconds;
   * `daylight` is how much of the scene's light is reaching it, in [0, 1].
   */
  update(dt: number, elapsed: number, daylight: number): void;
  dispose(): void;
}

/** Stable 0…1 from a storm id. */
function unitFromId(id: number): number {
  let h = id >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/**
 * `revealClip` is `ClientPluginCtx.revealClipUniforms()`, SPREAD into both
 * materials' own uniform objects — the same `{ value }` boxes in all three
 * places, so one mask upload reaches every material at once. See
 * client/src/plugins/kit/revealClip.ts for the whole pattern.
 */
export function createFunnel(revealClip: RevealClipUniforms): FunnelRenderer {
  const root = new Group();
  root.name = 'tornado:funnel';

  // ── The vortex sheet ──────────────────────────────────────────────────────
  // A UNIT open cylinder, reshaped entirely in the vertex shader: the taper is
  // per-height, so authoring a cone here would only fix the wrong taper into
  // the geometry.
  const coneGeometry = new CylinderGeometry(
    1,
    1,
    1,
    FUNNEL_RADIAL_SEGMENTS,
    FUNNEL_HEIGHT_SEGMENTS,
    true,
  );
  const coneMaterial = new ShaderMaterial({
    uniforms: { ...revealClip, uElapsed: { value: 0 }, uDaylight: { value: 1 } },
    vertexShader: CONE_VERTEX_SHADER,
    fragmentShader: CONE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // SEEN FROM INSIDE AS WELL AS OUT — the near wall is transparent, so the
    // far wall is what gives the funnel its volume. Culling it would leave a
    // hollow shell that reads as a decal.
    side: DoubleSide,
    // NORMAL BLENDING, NEVER ADDITIVE — plugins/fire/client/smoke.ts's rule. A
    // funnel must be able to DARKEN what is behind it: against daylight it is a
    // silhouette, and additive blending can only ever lighten.
  });
  const cone = new InstancedMesh(coneGeometry, coneMaterial, MAX_FUNNELS);
  cone.name = 'tornado:funnel:vortex';
  cone.count = 0;
  cone.renderOrder = FUNNEL_RENDER_ORDER;
  // Every vertex is displaced in the shader, so three's bounding sphere — which
  // it computes from the undisplaced cylinder — describes nothing this draws.
  cone.frustumCulled = false;
  root.add(cone);

  const coneSeeds = new InstancedBufferAttribute(new Float32Array(MAX_FUNNELS), 1);
  const coneStrengths = new InstancedBufferAttribute(new Float32Array(MAX_FUNNELS), 1);
  coneSeeds.setUsage(DynamicDrawUsage);
  coneStrengths.setUsage(DynamicDrawUsage);
  coneGeometry.setAttribute('aSeed', coneSeeds);
  coneGeometry.setAttribute('aStrength', coneStrengths);

  // ── The debris skirt ──────────────────────────────────────────────────────
  const debrisCapacity = MAX_FUNNELS * DEBRIS_PER_FUNNEL;
  const debrisGeometry = new PlaneGeometry(2, 2, 1, 1);
  const debrisMaterial = new ShaderMaterial({
    uniforms: { ...revealClip, uElapsed: { value: 0 }, uDaylight: { value: 1 } },
    vertexShader: DEBRIS_VERTEX_SHADER,
    fragmentShader: DEBRIS_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  const debris = new InstancedMesh(debrisGeometry, debrisMaterial, debrisCapacity);
  debris.name = 'tornado:funnel:debris';
  debris.count = 0;
  debris.renderOrder = DEBRIS_RENDER_ORDER;
  debris.frustumCulled = false;
  root.add(debris);

  const debrisPhases = new InstancedBufferAttribute(new Float32Array(debrisCapacity), 1);
  const debrisSeeds = new InstancedBufferAttribute(new Float32Array(debrisCapacity), 1);
  const debrisStrengths = new InstancedBufferAttribute(new Float32Array(debrisCapacity), 1);
  for (const attribute of [debrisPhases, debrisSeeds, debrisStrengths]) {
    attribute.setUsage(DynamicDrawUsage);
  }
  debrisGeometry.setAttribute('aPhase', debrisPhases);
  debrisGeometry.setAttribute('aSeed', debrisSeeds);
  debrisGeometry.setAttribute('aStrength', debrisStrengths);

  const funnels = new Map<number, Funnel>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);

  /**
   * Set whenever the instance LAYOUT stops matching the buffers — a funnel
   * added, dropped, or moved by a server push.
   *
   * Everything the five buffers hold is a function of the push (position,
   * seed, debris phase); only `strength` moves between pushes, and only while
   * a funnel is dispersing. See ./spiral.ts, which had the same defect at a
   * larger scale and is fixed the same way.
   */
  let layoutDirty = false;
  let drawnCones = 0;
  let drawnDebris = 0;

  /** Queues `instances` worth of `attribute` for upload, and nothing beyond. */
  function markUploaded(attribute: InstancedBufferAttribute, instances: number): void {
    attribute.clearUpdateRanges();
    // In ARRAY ELEMENTS, not instances: three multiplies the start by the
    // array's BYTES_PER_ELEMENT itself, so the count carries the itemSize.
    attribute.addUpdateRange(0, instances * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  /** Writes every buffer for every live funnel, and records where each landed. */
  function writeLayout(): void {
    const coneSeedArray = coneSeeds.array as Float32Array;
    const coneStrengthArray = coneStrengths.array as Float32Array;
    const phaseArray = debrisPhases.array as Float32Array;
    const seedArray = debrisSeeds.array as Float32Array;
    const strengthArray = debrisStrengths.array as Float32Array;
    drawnCones = 0;
    drawnDebris = 0;

    for (const funnel of funnels.values()) {
      position.set(funnel.x, funnel.groundY, funnel.z);
      matrix.compose(position, rotation, scale);
      // The storm's own intensity times how far into its touchdown it is: a
      // weak tornado is a thin funnel, and a dispersing one thins out.
      const strength = funnel.presence * funnel.intensity;
      funnel.coneSlot = drawnCones;
      funnel.debrisBase = drawnDebris;
      funnel.writtenStrength = strength;

      cone.setMatrixAt(drawnCones, matrix);
      coneSeedArray[drawnCones] = funnel.seed;
      coneStrengthArray[drawnCones] = strength;
      drawnCones++;

      for (let i = 0; i < DEBRIS_PER_FUNNEL; i++) {
        debris.setMatrixAt(drawnDebris, matrix);
        // Evenly spaced around the life cycle, so the skirt is continuous
        // rather than pulsing.
        phaseArray[drawnDebris] = i / DEBRIS_PER_FUNNEL;
        // Offset by the golden ratio per sprite, so two tornadoes with
        // adjacent ids do not throw their debris into the same places.
        seedArray[drawnDebris] = (funnel.seed + i * 0.6180339887) % 1;
        strengthArray[drawnDebris] = strength;
        drawnDebris++;
      }
    }

    cone.count = drawnCones;
    markUploaded(cone.instanceMatrix, drawnCones);
    markUploaded(coneSeeds, drawnCones);
    markUploaded(coneStrengths, drawnCones);

    debris.count = drawnDebris;
    markUploaded(debris.instanceMatrix, drawnDebris);
    markUploaded(debrisPhases, drawnDebris);
    markUploaded(debrisSeeds, drawnDebris);
    markUploaded(debrisStrengths, drawnDebris);
  }

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
          // A MOVE IS A LAYOUT CHANGE; a change of intensity is not — intensity
          // only reaches the buffers through `strength`, which has its own
          // two-buffer path in update().
          if (existing.x !== storm.x || existing.groundY !== storm.groundY || existing.z !== storm.z) {
            layoutDirty = true;
          }
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
          // BORN AT FULL PRESENCE — see FUNNEL_DISPERSE_SECONDS.
          presence: 1,
          intensity: storm.intensity,
          coneSlot: 0,
          debrisBase: 0,
          writtenStrength: Number.NaN,
        });
        layoutDirty = true;
      }
    },

    update(dt, elapsed, daylight): void {
      coneMaterial.uniforms.uElapsed!.value = elapsed;
      coneMaterial.uniforms.uDaylight!.value = daylight;
      debrisMaterial.uniforms.uElapsed!.value = elapsed;
      debrisMaterial.uniforms.uDaylight!.value = daylight;

      if (funnels.size === 0) {
        cone.count = 0;
        debris.count = 0;
        drawnCones = 0;
        drawnDebris = 0;
        return;
      }

      // ── The life cycle, which is the only thing a frame actually advances ──
      for (const [id, funnel] of funnels) {
        if (funnel.alive) {
          // A funnel that was dispersing and came back (a dropped message, a
          // reconnect) recovers rather than restarting its life.
          funnel.presence = 1;
        } else {
          funnel.presence -= dt / FUNNEL_DISPERSE_SECONDS;
          if (funnel.presence <= 0) {
            // Dispersed. Deleting DURING the iteration is safe on a Map.
            funnels.delete(id);
            layoutDirty = true;
          }
        }
      }

      if (funnels.size === 0) {
        cone.count = 0;
        debris.count = 0;
        drawnCones = 0;
        drawnDebris = 0;
        layoutDirty = false;
        return;
      }

      if (layoutDirty) {
        writeLayout();
        layoutDirty = false;
        return;
      }

      // ── The steady state: one float per instance, and usually none ────────
      const coneStrengthArray = coneStrengths.array as Float32Array;
      const strengthArray = debrisStrengths.array as Float32Array;
      let touched = false;
      for (const funnel of funnels.values()) {
        const strength = funnel.presence * funnel.intensity;
        if (strength === funnel.writtenStrength) continue;
        coneStrengthArray[funnel.coneSlot] = strength;
        strengthArray.fill(strength, funnel.debrisBase, funnel.debrisBase + DEBRIS_PER_FUNNEL);
        funnel.writtenStrength = strength;
        touched = true;
      }
      if (touched) {
        markUploaded(coneStrengths, drawnCones);
        markUploaded(debrisStrengths, drawnDebris);
      }
    },

    dispose(): void {
      cone.dispose();
      coneGeometry.dispose();
      coneMaterial.dispose();
      debris.dispose();
      debrisGeometry.dispose();
      debrisMaterial.dispose();
      root.clear();
      funnels.clear();
    },
  };
}

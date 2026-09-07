// THE TWO THINGS IN THIS PLUGIN THAT ARE NOT A SAUCER: the laser bolts, and the
// fireballs at the crash sites.
//
// Both are PURE PRESENTATION invented here out of what the server sent plus the
// frame clock. Nothing about either is on the wire beyond "a bolt was fired from
// A at B, this many seconds ago" and "this wreck went in here, this many
// seconds ago"; nothing in the world can observe them; and the FIRE and the
// CRATER are not drawn here at all — the fire plugin draws the flames and the
// terrain shows the hole, which is the whole reason the burst is allowed to be
// as short as it is.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERYTHING IS POOLED AND NOTHING IS ALLOCATED PER FRAME.
//
// The frame budget is 7.1 ms (140 fps, the project benchmark) and this rig runs
// inside it every frame an encounter is alive. So: every pool below is built
// once at attach — one InstancedMesh per visual part, cut to zero (`count = 0`)
// rather than removed when nothing is showing, plus a handful of individual
// shard clouds hidden the same way meshes always were — the shard cloud is one
// Points object whose positions are rewritten in place, and the scratch
// vectors below are module-scope singletons rather than locals. A hidden
// subtree, or an InstancedMesh at `count = 0`, costs no draw call at all
// (client/src/plugins/host.ts, countDrawObjects), so the pool is free when the
// sky is empty.

import {
  AdditiveBlending,
  NormalBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type ColorRepresentation,
} from 'three';
import {
  CELL_WORLD_SIZE,
  LASER_BOLT_LENGTH_CELLS,
  LASER_BOLT_LIFETIME_SECONDS,
  LASER_BOLT_SPEED_CELLS_PER_SECOND,
  MAX_LASER_BOLTS,
  MAX_SAUCERS_PER_ENCOUNTER,
} from '../protocol.ts';
import { spliceShader } from '../../../client/src/render/shaderSplice.ts';

/**
 * A LENGTH OF GROUND, IN THE UNITS THE SCENE IS DRAWN IN.
 *
 * Every dimension in this file is stated in CELLS — that is how the rest of the
 * plugin talks — and every one of them is then multiplied by this, because a
 * three.js length here is a SCENE unit and a scene unit is four cells since the
 * 2026-08-21 re-sample (CELL_WORLD_SIZE = 1/4; plugins/boats/client/index.ts
 * places a hull at `x * CELL_WORLD_SIZE` and scales nothing, which is the
 * primary evidence). Omitting it would draw everything here four times too big.
 */
function worldUnitsAcross(cells: number): number {
  return cells * CELL_WORLD_SIZE;
}

/**
 * Scratch vectors, reused by every call. Module-scope singletons because this
 * whole file runs per frame and a `new Vector3` in here is an allocation the
 * garbage collector pays for inside the frame budget.
 *
 * SAFE BECAUSE NOTHING HERE IS RE-ENTRANT: the client host calls each frame
 * handler in turn, on one thread, and no function below yields. Shared across
 * all three pools below for the same reason — a bolt, a burst and a splash are
 * never being placed at the same instant.
 */
const scratchDirection = new Vector3();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const scratchQuaternion = new Quaternion();
const scratchMatrix = new Matrix4();
const scratchColor = new Color();

/** A cylinder is authored along +Y; every orientation below is measured from it. */
const CYLINDER_AXIS = new Vector3(0, 1, 0);

/** A bolt's own geometry is already sized and never scaled per instance. */
const UNIT_SCALE = new Vector3(1, 1, 1);

// ─────────────────────────────────────────────────────────────────────────────
// PER-INSTANCE ALPHA.
//
// InstancedMesh gives per-instance COLOUR for free: `setColorAt` writes into
// `instanceColor`, and three's stock program multiplies it into `diffuseColor`
// on its own. It gives NO per-instance alpha — there is nothing in the stock
// program that reads a second instanced value into `diffuseColor.a`. Every
// pool in this file fades its members on their own clock, so that gap has to
// be closed one of two ways:
//
//   - fold the fade into the instance COLOUR and hold material opacity at a
//     constant 1. Correct ONLY under AdditiveBlending, where the blend
//     equation is `colour · srcAlpha + dst` and a constant srcAlpha of 1
//     makes that `colour + dst` — so a colour already scaled by the fade
//     reproduces the old per-material opacity fade exactly. `createCrashBursts`
//     uses this: the ball and the core were additive already (BURST_COLOUR's
//     comment).
//   - splice a REAL per-instance alpha into the compiled program, via a second
//     InstancedBufferAttribute. Required under NormalBlending, where the
//     result is a mix with the background (`colour · a + dst · (1 − a)`) and
//     folding the fade into colour instead would fade the pool toward BLACK,
//     not toward the background — which over daylit ground or sky is exactly
//     the "extremely difficult to see" additive bolt BOLT_INTENSITY's comment
//     already rejected once. `createLaserPool` and `createCrashSplashes` (both
//     NormalBlending, by design — see BOLT_INTENSITY and SPLASH_COLOUR) use
//     `addInstancedAlpha` below for this.
//
// The splice itself is the same primitive plugins/cyclone/client/spiral.ts
// uses for its own per-puff fade, adapted to MeshBasicMaterial's stock program
// instead of a hand-authored ShaderMaterial.

/** The header, in both stages — same anchor spiral.ts patches at. */
const SHADER_COMMON_ANCHOR = '#include <common>';
/** Declares `vec3 transformed`; a convenient, side-effect-free place to read the attribute. */
const BEGIN_VERTEX_ANCHOR = '#include <begin_vertex>';
/** The last chunk in MeshBasicMaterial's fragment program to touch `diffuseColor.a` before it. */
const ALPHATEST_FRAGMENT_ANCHOR = '#include <alphatest_fragment>';

const INSTANCED_ALPHA_VERTEX_DECLARATIONS = /* glsl */ `varying float vInstancedAlpha;
attribute float instancedAlpha;`;
const INSTANCED_ALPHA_FRAGMENT_DECLARATIONS = /* glsl */ `varying float vInstancedAlpha;`;
const INSTANCED_ALPHA_ASSIGN = /* glsl */ `vInstancedAlpha = instancedAlpha;`;
const INSTANCED_ALPHA_APPLY = /* glsl */ `diffuseColor.a *= vInstancedAlpha;`;

/**
 * Attaches a per-instance alpha to `material` — a `MeshBasicMaterial` drawn by
 * an `InstancedMesh` of `capacity` instances — and returns the attribute so
 * the caller can write a fade into it per instance, per frame.
 *
 * `label` names the material in `spliceShader`'s own thrown error, should a
 * future three.js upgrade move one of the two anchors.
 */
function addInstancedAlpha(
  geometry: BufferGeometry,
  material: MeshBasicMaterial,
  capacity: number,
  label: string,
): InstancedBufferAttribute {
  const alpha = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
  alpha.setUsage(DynamicDrawUsage);
  geometry.setAttribute('instancedAlpha', alpha);

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        SHADER_COMMON_ANCHOR,
        `${SHADER_COMMON_ANCHOR}\n${INSTANCED_ALPHA_VERTEX_DECLARATIONS}`,
        label,
      ),
      BEGIN_VERTEX_ANCHOR,
      `${BEGIN_VERTEX_ANCHOR}\n    ${INSTANCED_ALPHA_ASSIGN}`,
      label,
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        SHADER_COMMON_ANCHOR,
        `${SHADER_COMMON_ANCHOR}\n${INSTANCED_ALPHA_FRAGMENT_DECLARATIONS}`,
        label,
      ),
      ALPHATEST_FRAGMENT_ANCHOR,
      `${ALPHATEST_FRAGMENT_ANCHOR}\n    ${INSTANCED_ALPHA_APPLY}`,
      label,
    );
  };
  // three keys a compiled program by material type, parameters and this
  // method — never by `onBeforeCompile` — so without a key of its own this
  // pool could share a program with another patched MeshBasicMaterial of the
  // same parameters. Same defensive step spiral.ts's own patch takes.
  const stockCacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${stockCacheKey()}|instancedAlpha:${label}`;

  return alpha;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BOLTS.

/**
 * A bolt's radius, in cells.
 *
 * 0.2 — a twentieth of a hull (SAUCER_DIAMETER_CELLS is four cells). It was
 * 0.12, the hangar's proportion, which from the orbit camera the owner watches
 * from is under a pixel wide: "extremely difficult to see" (2026-09-04); then
 * 0.35, which was "too thick" (2026-09-05) once the bolt was opaque. It is a
 * length of the WORLD, not of the model, so it does not change if the hull
 * is re-authored at another size.
 */
const BOLT_RADIUS_CELLS = 0.2;

/**
 * The fraction of a bolt's lifetime it stays at full brightness before it
 * fades. 0.7: a bolt that fades from the muzzle (the first cut) was half
 * gone by the middle of its flight, where it is furthest from either hull and
 * most needs to be seen.
 */
const BOLT_FADE_START_FRACTION = 0.7;

/**
 * How far above 1.0 a bolt's colour is driven, so it reads as LIGHT under the
 * scene's ACES tone mapping rather than as a tinted streak.
 *
 * TWO (owner, 2026-09-04: "make the laser bursts brighter like they are in
 * the artifact"). The hangar draws its bolt against a black floor, where
 * anything bright reads; in the world the bolt is drawn over daylit ground
 * and sky. Twice the faction colour pushes the streak's centre through ACES
 * toward white while the hue survives — a hot bolt of THAT colour.
 *
 * DRAWN OPAQUE (NormalBlending), NOT ADDITIVE, since the same day: additive
 * light cannot darken anything, so over a bright sky or pale ground an
 * additive bolt is invisible by construction. An opaque streak occludes what
 * is behind it and is seen against everything. Three times, additive, was the
 * first cut and was still "extremely difficult to see". This is also why the
 * instancing below gives the pool a REAL per-instance alpha (addInstancedAlpha)
 * instead of folding the fade into instance colour: NormalBlending fades
 * toward the background, additive-style folding would fade toward black.
 */
const BOLT_INTENSITY = 2;

/** Sides on the bolt cylinder. SIX: it is a lit streak seen edge-on at speed. */
const BOLT_RADIAL_SEGMENTS = 6;

/**
 * How far past its aim point a bolt is drawn before it is hidden, in cells:
 * its own length, so a bolt that has arrived reads as having struck through
 * the hull (or, aimed to one side for a miss, past it) rather than stopping
 * short in the air.
 */
const BOLT_OVERSHOOT_CELLS = LASER_BOLT_LENGTH_CELLS;

export interface LaserPool {
  readonly root: Group;
  /** Hides every bolt. Called at the top of each frame's apply pass. */
  begin(): void;
  /**
   * Draws one bolt in flight from `from` toward `aim` (world space): a streak
   * LASER_BOLT_LENGTH long whose head is where a projectile of
   * LASER_BOLT_SPEED would be `age` seconds after leaving the muzzle, in the
   * shooter's faction colour, faded by its age. Silently does nothing once the
   * pool is exhausted — MAX_LASER_BOLTS is the server's own ceiling, so that is
   * unreachable rather than a policy.
   */
  draw(from: Vector3, aim: Vector3, age: number, colour: ColorRepresentation): void;
  dispose(): void;
}

export function createLaserPool(): LaserPool {
  // A BOLT-LENGTH cylinder, translated so its base sits at the origin: the draw
  // below puts the base at the streak's tail and points it down the flight
  // line, which is one position and one quaternion rather than a midpoint
  // calculation.
  const boltRadius = worldUnitsAcross(BOLT_RADIUS_CELLS);
  const boltLength = worldUnitsAcross(LASER_BOLT_LENGTH_CELLS);
  const geometry = new CylinderGeometry(
    boltRadius,
    boltRadius,
    boltLength,
    BOLT_RADIAL_SEGMENTS,
    1,
    true,
  );
  geometry.translate(0, boltLength / 2, 0);

  const root = new Group();
  root.name = 'saucers:bolts';

  // ONE MATERIAL FOR THE WHOLE POOL, not one per bolt: the faction colour is
  // now per-instance data via `setColorAt` (free RGB), and the fade is the
  // `instancedAlpha` attribute `addInstancedAlpha` attaches below — between the
  // two, one InstancedMesh draws every bolt of every age and faction on screen
  // together, in place of MAX_LASER_BOLTS separate meshes and materials.
  const material = new MeshBasicMaterial({
    transparent: true,
    opacity: 1,
    blending: NormalBlending,
    depthWrite: false,
  });
  const instancedAlpha = addInstancedAlpha(geometry, material, MAX_LASER_BOLTS, 'saucers:bolts');

  const mesh = new InstancedMesh(geometry, material, MAX_LASER_BOLTS);
  mesh.name = 'saucers:bolts:pool';
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // No per-frame bounding-volume recompute for a pool this small and this
  // mobile — plugins/cyclone/client/spiral.ts's deck makes the same call for
  // the same reason.
  mesh.frustumCulled = false;
  root.add(mesh);

  /** Instances actually written this frame so far — also the next write index. */
  let next = 0;

  return {
    root,
    begin(): void {
      mesh.count = 0;
      next = 0;
    },
    draw(from: Vector3, aim: Vector3, age: number, colour: ColorRepresentation): void {
      if (next >= MAX_LASER_BOLTS) return;

      scratchDirection.subVectors(aim, from);
      const distance = scratchDirection.length();
      // A zero-length flight line would produce a NaN direction. It cannot
      // happen while two saucers are apart, which is exactly why it is worth one
      // comparison rather than a debugging session the day something moves them
      // together.
      if (distance <= 0) return;
      scratchDirection.divideScalar(distance);

      // The head travels at the wire's speed; once it is a bolt-length past the
      // aim point the bolt has struck (or missed) and is hidden, so nothing
      // flies on out of the fight.
      const head = worldUnitsAcross(LASER_BOLT_SPEED_CELLS_PER_SECOND) * age;
      if (head > distance + worldUnitsAcross(BOLT_OVERSHOOT_CELLS)) return;
      const tail = Math.max(0, head - worldUnitsAcross(LASER_BOLT_LENGTH_CELLS));

      const index = next;
      next++;

      scratchPosition.copy(from).addScaledVector(scratchDirection, tail);
      scratchQuaternion.setFromUnitVectors(CYLINDER_AXIS, scratchDirection);
      scratchMatrix.compose(scratchPosition, scratchQuaternion, UNIT_SCALE);
      mesh.setMatrixAt(index, scratchMatrix);

      scratchColor.set(colour).multiplyScalar(BOLT_INTENSITY);
      mesh.setColorAt(index, scratchColor);

      // Full brightness for most of the flight, then a linear fade that ends
      // exactly when the server stops sending it.
      const life = Math.min(1, Math.max(0, age / LASER_BOLT_LIFETIME_SECONDS));
      const opacity =
        life < BOLT_FADE_START_FRACTION ? 1 : (1 - life) / (1 - BOLT_FADE_START_FRACTION);
      instancedAlpha.setX(index, opacity);

      mesh.count = next;
      mesh.instanceMatrix.needsUpdate = true;
      // `setColorAt` allocates `instanceColor` the first time it is ever
      // called, and never sets it back to null — safe to assert non-null on
      // every call after this one.
      mesh.instanceColor!.needsUpdate = true;
      instancedAlpha.needsUpdate = true;
    },
    dispose(): void {
      material.dispose();
      geometry.dispose();
      mesh.dispose();
      root.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FIREBALLS.

/**
 * How long a burst lasts, in seconds.
 *
 * 2 s (owner, 2026-09-04, twice: "the explosion could be larger", then "a
 * larger brighter fireball"), and it is deliberately SHORTER than
 * CRASH_WIRE_SECONDS: the burst has to be over before the entry that carries
 * it stops arriving, or the last frames of the fireball would be cut off by
 * the wire rather than by the effect finishing.
 */
export const BURST_SECONDS = 2;

/**
 * The fireball at full expansion, in cells. EIGHT — the arena's radius, over
 * three times the crater's, so the ball swallows the fire ring and stands two
 * hulls tall over the wreck. Five (the first revision) still read as a puff
 * from the orbit camera the owner watches from.
 */
const BURST_MAX_RADIUS_CELLS = 8;

/**
 * A WHITE-HOT CORE inside the ball: smaller, brighter, gone in the first part
 * of the burst. It is what makes the ball read as a detonation rather than as
 * an orange balloon — the flash, then the fire. Pure white, half the ball.
 */
const CORE_MAX_RADIUS_CELLS = 4;
const CORE_SECONDS_FRACTION = 0.35;
const CORE_COLOUR = 0xffffff;

/**
 * How the ball's brightness falls over the burst. Opacity is (1 − t) raised to
 * this: under one HOLDS the light near full for most of the burst and drops it
 * at the end, where a straight (1 − t) had it half-faded before it was
 * half-grown — the "brighter" in the owner's ask.
 */
const BURST_FADE_EXPONENT = 0.5;

/** Sphere tessellation. Low: it is on screen for under two seconds, glowing, expanding. */
const BURST_RADIAL_SEGMENTS = 16;
const BURST_HEIGHT_SEGMENTS = 12;

/** Hot orange, additively blended so it reads as light rather than as a ball. */
const BURST_COLOUR = 0xffa03c;

/**
 * Shards thrown out of the impact.
 *
 * TWENTY-FOUR — enough to read as debris from a whole hull, few enough that
 * the cloud is ONE draw call and its positions can be rewritten in place every
 * frame without showing up in a profile.
 */
const BURST_SHARD_COUNT = 24;

/** How far a shard travels over the burst, in cells, and how high it arcs — scaled with the ball. */
const SHARD_REACH_CELLS = 12;
const SHARD_RISE_CELLS = 6;

/** Shard size in pixels, and their colour — the same fire as the ball. */
const SHARD_SIZE_PIXELS = 5;

/**
 * The shards' launch directions, FIXED rather than random.
 *
 * A crash looks the same on every client because it IS the same crash: two
 * players standing beside each other must not see debris fly two different ways.
 * Evenly spaced bearings with three heights of arc gives a spray that is
 * plainly a spray and is a function of nothing.
 */
const SHARD_BEARINGS: readonly { readonly x: number; readonly z: number; readonly lift: number }[] =
  Array.from({ length: BURST_SHARD_COUNT }, (_unused, index) => {
    const angle = (index * 2 * Math.PI) / BURST_SHARD_COUNT;
    return {
      x: Math.cos(angle),
      z: Math.sin(angle),
      // Three heights of arc, so the spray has a shape instead of being a flat
      // ring.
      lift: index % 3 === 0 ? 1 : index % 3 === 1 ? 0.7 : 0.45,
    };
  });

/** One pooled burst's shard cloud — the one part of a burst left unmerged. */
interface BurstShards {
  readonly points: Points;
  readonly geometry: BufferGeometry;
  readonly material: PointsMaterial;
}

export interface CrashBursts {
  readonly root: Group;
  /** Hides every burst. Called at the top of each frame's apply pass. */
  begin(): void;
  /**
   * Places and advances one burst. `age` is seconds since impact, from the
   * server. A burst past BURST_SECONDS draws nothing, which is what makes a
   * client that joined mid-burst show the right part of it rather than
   * restarting it. Silently does nothing once the pool is exhausted — the pool
   * holds one per saucer the roster can carry, so that is unreachable.
   */
  show(x: number, groundY: number, z: number, age: number): void;
  dispose(): void;
}

/** One burst per saucer the roster can hold: on the clock they can all go down together. */
const BURST_POOL_SIZE = MAX_SAUCERS_PER_ENCOUNTER;

export function createCrashBursts(): CrashBursts {
  const root = new Group();
  root.name = 'saucers:bursts';

  const sphere = new SphereGeometry(1, BURST_RADIAL_SEGMENTS, BURST_HEIGHT_SEGMENTS);

  // THE BALL AND THE CORE WERE ADDITIVE ALREADY (BURST_COLOUR's comment), so
  // the fold-into-colour option from the header above applies directly: hold
  // material opacity at a constant 1 and write each instance's OWN fade into
  // its instance colour instead (`BURST_COLOUR * fade`, `CORE_COLOUR * fade`).
  // Under AdditiveBlending that reproduces the old per-material opacity fade
  // exactly, with no shader patch needed — unlike the bolts and the splashes.
  const ballMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 1,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const ball = new InstancedMesh(sphere, ballMaterial, BURST_POOL_SIZE);
  ball.name = 'saucers:bursts:ball';
  ball.count = 0;
  ball.instanceMatrix.setUsage(DynamicDrawUsage);
  ball.frustumCulled = false;
  root.add(ball);

  const coreMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 1,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const core = new InstancedMesh(sphere, coreMaterial, BURST_POOL_SIZE);
  core.name = 'saucers:bursts:core';
  core.count = 0;
  core.instanceMatrix.setUsage(DynamicDrawUsage);
  core.frustumCulled = false;
  root.add(core);

  // THE SHARD CLOUDS ARE LEFT UNMERGED (see the file header on this pool):
  // each burst's own fade is a uniform PointsMaterial.opacity, one per burst,
  // and merging the nine clouds into one Points object would need a
  // per-vertex alpha to keep that — the same shader-patch machinery the bolts
  // need, for twenty-four points per burst rather than one bolt. Not "trivially
  // mergeable" by the job's own bar, so nine draws they stay.
  const shards: BurstShards[] = [];
  for (let index = 0; index < BURST_POOL_SIZE; index++) {
    const shardGeometry = new BufferGeometry();
    shardGeometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(BURST_SHARD_COUNT * 3), 3),
    );
    const shardMaterial = new PointsMaterial({
      color: BURST_COLOUR,
      size: SHARD_SIZE_PIXELS,
      sizeAttenuation: false,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const points = new Points(shardGeometry, shardMaterial);
    points.name = `saucers:burst:shards:${index}`;
    points.visible = false;
    root.add(points);
    shards.push({ points, geometry: shardGeometry, material: shardMaterial });
  }

  /** Instances actually written this frame so far — also the next write index. */
  let next = 0;

  return {
    root,
    begin(): void {
      ball.count = 0;
      core.count = 0;
      for (const shard of shards) shard.points.visible = false;
      next = 0;
    },
    show(x: number, groundY: number, z: number, age: number): void {
      const t = age / BURST_SECONDS;
      if (t < 0 || t >= 1) return;
      if (next >= BURST_POOL_SIZE) return;
      const index = next;
      next++;
      const shard = shards[index]!;

      // The ball expands fast and fades linearly: `sqrt` front-loads the growth,
      // which is what an explosion does and a balloon does not.
      const grow = Math.sqrt(t);
      scratchScale.setScalar(worldUnitsAcross(BURST_MAX_RADIUS_CELLS) * grow);
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(x, groundY, z);
      ball.setMatrixAt(index, scratchMatrix);
      scratchColor.set(BURST_COLOUR).multiplyScalar(Math.pow(1 - t, BURST_FADE_EXPONENT));
      ball.setColorAt(index, scratchColor);
      ball.count = next;

      // The core is over in the first third: full size at once, fading out.
      // Its colour reaches exactly zero at coreT = 1, which under additive
      // blending contributes nothing — the same as the old `core.visible =
      // coreT < 1`, with no separate visibility flag to manage per instance.
      const coreT = Math.min(1, t / CORE_SECONDS_FRACTION);
      scratchScale.setScalar(worldUnitsAcross(CORE_MAX_RADIUS_CELLS) * Math.sqrt(coreT));
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(x, groundY, z);
      core.setMatrixAt(index, scratchMatrix);
      scratchColor.set(CORE_COLOUR).multiplyScalar(1 - coreT);
      core.setColorAt(index, scratchColor);
      core.count = next;

      // Shards fly out on their fixed bearings and fall back under a simple
      // parabola. Not physics — there is no gravity constant here and there does
      // not need to be one; it is the arc a thrown thing makes.
      shard.points.visible = true;
      shard.points.position.set(x, groundY, z);
      const positions = shard.geometry.getAttribute('position') as BufferAttribute;
      for (let i = 0; i < SHARD_BEARINGS.length; i++) {
        const bearing = SHARD_BEARINGS[i]!;
        const reach = worldUnitsAcross(SHARD_REACH_CELLS) * t;
        const rise = worldUnitsAcross(SHARD_RISE_CELLS) * bearing.lift * (t * (2 - 2 * t));
        positions.setXYZ(i, bearing.x * reach, rise, bearing.z * reach);
      }
      positions.needsUpdate = true;
      shard.material.opacity = 1 - t;

      ball.instanceMatrix.needsUpdate = true;
      ball.instanceColor!.needsUpdate = true;
      core.instanceMatrix.needsUpdate = true;
      // Same non-null reasoning as the laser pool's `draw`: `setColorAt`
      // allocates `instanceColor` on first use and it stays allocated.
      core.instanceColor!.needsUpdate = true;
    },
    dispose(): void {
      ballMaterial.dispose();
      coreMaterial.dispose();
      ball.dispose();
      core.dispose();
      for (const shard of shards) {
        shard.material.dispose();
        shard.geometry.dispose();
      }
      sphere.dispose();
      root.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SPLASHES.

/**
 * A wreck into the sea (owner, 2026-09-05: "a large splash animation").
 * Drawn WITH the fireball — the hull still detonates — and instead of the
 * fire ring, which the server does not light on water.
 *
 * 1.5 s: shorter than the fireball, which is a fire, and it must be over
 * before CRASH_WIRE_SECONDS for BURST_SECONDS' reason.
 */
export const SPLASH_SECONDS = 1.5;

/**
 * The plume — a column of white water thrown up by the impact — at its
 * tallest and widest, in cells. TWELVE tall, three hulls, so it stands over
 * the fireball; FOUR wide at the base, a hull. It rises and falls under the
 * same arc the shards fly (`t·(2 − 2t)`), which peaks at the burst's middle.
 */
const PLUME_HEIGHT_CELLS = 12;
const PLUME_RADIUS_CELLS = 4;

/**
 * The ring — the wave the impact pushes out across the surface — at full
 * spread, in cells: the fireball's radius, so the two read as one event.
 * Grows like the fireball (`sqrt`, front-loaded) and thins as it spreads.
 */
const RING_MAX_RADIUS_CELLS = BURST_MAX_RADIUS_CELLS;
const RING_TUBE_CELLS = 0.6;
const RING_RADIAL_SEGMENTS = 6;
const RING_TUBULAR_SEGMENTS = 32;

/**
 * Sea-foam white, drawn OPAQUE-ish (NormalBlending) and not additive: water
 * is not light, and an additive plume over a bright sea vanishes exactly as
 * the additive bolts did (BOLT_INTENSITY). The ring is the same white. For the
 * same reason, this pool keeps a REAL per-instance alpha (addInstancedAlpha)
 * rather than folding the fade into instance colour.
 */
const SPLASH_COLOUR = 0xe8f4ff;

export interface CrashSplashes {
  readonly root: Group;
  /** Hides every splash. Called at the top of each frame's apply pass. */
  begin(): void;
  /** Places and advances one splash at the sea surface. `age` as `CrashBursts.show`. */
  show(x: number, surfaceY: number, z: number, age: number): void;
  dispose(): void;
}

/** One per saucer the roster can hold, as the bursts: they can all go into the sea together. */
const SPLASH_POOL_SIZE = MAX_SAUCERS_PER_ENCOUNTER;

export function createCrashSplashes(): CrashSplashes {
  const root = new Group();
  root.name = 'saucers:splashes';

  // The plume is a unit sphere scaled tall and translated so its base sits at
  // the origin — the surface — and it grows UP from there.
  const sphere = new SphereGeometry(1, BURST_RADIAL_SEGMENTS, BURST_HEIGHT_SEGMENTS);
  sphere.translate(0, 1, 0);
  const ringGeometry = new TorusGeometry(1, worldUnitsAcross(RING_TUBE_CELLS), RING_RADIAL_SEGMENTS, RING_TUBULAR_SEGMENTS);
  ringGeometry.rotateX(Math.PI / 2);

  const plumeMaterial = new MeshBasicMaterial({
    color: SPLASH_COLOUR,
    transparent: true,
    opacity: 1,
    blending: NormalBlending,
    depthWrite: false,
  });
  const plumeAlpha = addInstancedAlpha(sphere, plumeMaterial, SPLASH_POOL_SIZE, 'saucers:splashes:plume');
  const plume = new InstancedMesh(sphere, plumeMaterial, SPLASH_POOL_SIZE);
  plume.name = 'saucers:splashes:plume';
  plume.count = 0;
  plume.instanceMatrix.setUsage(DynamicDrawUsage);
  plume.frustumCulled = false;
  root.add(plume);

  const ringMaterial = new MeshBasicMaterial({
    color: SPLASH_COLOUR,
    transparent: true,
    opacity: 1,
    blending: NormalBlending,
    depthWrite: false,
  });
  const ringAlpha = addInstancedAlpha(ringGeometry, ringMaterial, SPLASH_POOL_SIZE, 'saucers:splashes:ring');
  const ring = new InstancedMesh(ringGeometry, ringMaterial, SPLASH_POOL_SIZE);
  ring.name = 'saucers:splashes:ring';
  ring.count = 0;
  ring.instanceMatrix.setUsage(DynamicDrawUsage);
  ring.frustumCulled = false;
  root.add(ring);

  /** Instances actually written this frame so far — also the next write index. */
  let next = 0;

  return {
    root,
    begin(): void {
      plume.count = 0;
      ring.count = 0;
      next = 0;
    },
    show(x: number, surfaceY: number, z: number, age: number): void {
      const t = age / SPLASH_SECONDS;
      if (t < 0 || t >= 1) return;
      if (next >= SPLASH_POOL_SIZE) return;
      const index = next;
      next++;

      // Up and back down: the shards' arc, peaking mid-splash. The base
      // widens as the column collapses.
      const arc = t * (2 - 2 * t);
      scratchScale.set(
        worldUnitsAcross(PLUME_RADIUS_CELLS) * (0.5 + 0.5 * t),
        worldUnitsAcross(PLUME_HEIGHT_CELLS) * arc,
        worldUnitsAcross(PLUME_RADIUS_CELLS) * (0.5 + 0.5 * t),
      );
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(x, surfaceY, z);
      plume.setMatrixAt(index, scratchMatrix);
      plumeAlpha.setX(index, 1 - t * t);
      plume.count = next;

      const spread = Math.sqrt(t);
      scratchScale.set(
        worldUnitsAcross(RING_MAX_RADIUS_CELLS) * spread,
        1,
        worldUnitsAcross(RING_MAX_RADIUS_CELLS) * spread,
      );
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(x, surfaceY, z);
      ring.setMatrixAt(index, scratchMatrix);
      ringAlpha.setX(index, 1 - t);
      ring.count = next;

      plume.instanceMatrix.needsUpdate = true;
      plumeAlpha.needsUpdate = true;
      ring.instanceMatrix.needsUpdate = true;
      ringAlpha.needsUpdate = true;
    },
    dispose(): void {
      plumeMaterial.dispose();
      ringMaterial.dispose();
      plume.dispose();
      ring.dispose();
      sphere.dispose();
      ringGeometry.dispose();
      root.clear();
    },
  };
}

/**
 * Exposed so the plugin's draw budget is written from the rigs' own counts.
 * ONE now, whatever MAX_LASER_BOLTS is: the whole pool is one InstancedMesh
 * (countDrawObjects counts an InstancedMesh once, however many instances it
 * carries), where it used to be one Mesh — and one draw call — per bolt.
 */
export const LASER_POOL_DRAW_OBJECTS = 1;
/** The ball and the core: each is now one InstancedMesh across the whole pool. */
const BURST_INSTANCED_DRAW_OBJECTS = 2;
/** Plus one shard-Points object per pool slot — left unmerged, see createCrashBursts. */
export const BURST_DRAW_OBJECTS = BURST_INSTANCED_DRAW_OBJECTS + BURST_POOL_SIZE;
/**
 * The plume and the ring: each is now one InstancedMesh across the whole pool,
 * no longer multiplied by SPLASH_POOL_SIZE — the pool no longer costs one
 * draw per member.
 */
export const SPLASH_DRAW_OBJECTS = 2;

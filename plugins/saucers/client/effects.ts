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
// inside it every frame an encounter is alive. So: the bolt meshes are built
// once at attach and hidden rather than removed, the shard cloud is one Points
// object whose positions are rewritten in place, and the scratch vectors below
// are module-scope singletons rather than locals. A hidden subtree costs no draw
// call at all (client/src/plugins/host.ts, countDrawObjects), so the pool is
// free when the sky is empty.

import {
  AdditiveBlending,
  NormalBlending,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
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
 * handler in turn, on one thread, and no function below yields.
 */
const scratchDirection = new Vector3();
const scratchQuaternion = new Quaternion();

/** A cylinder is authored along +Y; every orientation below is measured from it. */
const CYLINDER_AXIS = new Vector3(0, 1, 0);

// ─────────────────────────────────────────────────────────────────────────────
// THE BOLTS.

/**
 * A bolt's radius, in cells.
 *
 * 0.35 — a twelfth of a hull (SAUCER_DIAMETER_CELLS is four cells). It was
 * 0.12, the hangar's proportion, which from the orbit camera the owner watches
 * from is under a pixel wide: "extremely difficult to see" (2026-09-04). It is
 * a length of the WORLD, not of the model, so it does not change if the hull
 * is re-authored at another size.
 */
const BOLT_RADIUS_CELLS = 0.35;

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
 * first cut and was still "extremely difficult to see".
 */
const BOLT_INTENSITY = 2;

/** Sides on the bolt cylinder. SIX: it is a lit streak seen edge-on at speed. */
const BOLT_RADIAL_SEGMENTS = 6;

/**
 * How far past its target a bolt is drawn before it is hidden, in cells: its
 * own length, so a bolt that has arrived reads as having struck through the
 * hull rather than stopping short of it. A bolt that lands and one that misses
 * look the same — the server does not say which — and that is the one thing
 * about the fight a watching player cannot read off the screen.
 */
const BOLT_OVERSHOOT_CELLS = LASER_BOLT_LENGTH_CELLS;

/**
 * One pooled bolt. `mesh.visible` is the only thing that changes when a bolt is
 * not in use — never `add`/`remove`, which would touch the scene graph every
 * time anybody fired.
 */
interface Bolt {
  readonly mesh: Mesh;
}

export interface LaserPool {
  readonly root: Group;
  /** Hides every bolt. Called at the top of each frame's apply pass. */
  begin(): void;
  /**
   * Draws one bolt in flight from `from` toward `to`: a streak
   * LASER_BOLT_LENGTH long whose head is where a projectile of
   * LASER_BOLT_SPEED would be `age` seconds after leaving the muzzle, in the
   * shooter's faction colour, faded by its age. Silently does nothing once the
   * pool is exhausted — MAX_LASER_BOLTS is the server's own ceiling, so that is
   * unreachable rather than a policy.
   */
  draw(from: Vector3, to: Vector3, age: number, colour: ColorRepresentation): void;
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
  const bolts: Bolt[] = [];
  for (let index = 0; index < MAX_LASER_BOLTS; index++) {
    // ONE MATERIAL PER BOLT, not one shared: the fade and the faction colour
    // are written into the material, and bolts of different ages and factions
    // are on screen together.
    const material = new MeshBasicMaterial({
      transparent: true,
      opacity: 1,
      blending: NormalBlending,
      depthWrite: false,
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = `saucers:bolt:${index}`;
    mesh.visible = false;
    root.add(mesh);
    bolts.push({ mesh });
  }

  let next = 0;

  return {
    root,
    begin(): void {
      for (const bolt of bolts) bolt.mesh.visible = false;
      next = 0;
    },
    draw(from: Vector3, to: Vector3, age: number, colour: ColorRepresentation): void {
      const bolt = bolts[next];
      if (bolt === undefined) return;
      next++;

      scratchDirection.subVectors(to, from);
      const distance = scratchDirection.length();
      // A zero-length flight line would produce a NaN direction. It cannot
      // happen while two saucers are apart, which is exactly why it is worth one
      // comparison rather than a debugging session the day something moves them
      // together.
      if (distance <= 0) return;
      scratchDirection.divideScalar(distance);

      // The head travels at the wire's speed; once it is a bolt-length past the
      // target the bolt has struck (or missed) and is hidden, so nothing flies on
      // out of the fight.
      const head = worldUnitsAcross(LASER_BOLT_SPEED_CELLS_PER_SECOND) * age;
      if (head > distance + worldUnitsAcross(BOLT_OVERSHOOT_CELLS)) return;
      const tail = Math.max(0, head - worldUnitsAcross(LASER_BOLT_LENGTH_CELLS));

      bolt.mesh.position.copy(from).addScaledVector(scratchDirection, tail);
      bolt.mesh.quaternion.copy(
        scratchQuaternion.setFromUnitVectors(CYLINDER_AXIS, scratchDirection),
      );
      const material = bolt.mesh.material as MeshBasicMaterial;
      material.color.set(colour).multiplyScalar(BOLT_INTENSITY);
      // Full brightness for most of the flight, then a linear fade that ends
      // exactly when the server stops sending it.
      const life = Math.min(1, Math.max(0, age / LASER_BOLT_LIFETIME_SECONDS));
      material.opacity =
        life < BOLT_FADE_START_FRACTION ? 1 : (1 - life) / (1 - BOLT_FADE_START_FRACTION);
      bolt.mesh.visible = true;
    },
    dispose(): void {
      for (const bolt of bolts) (bolt.mesh.material as MeshBasicMaterial).dispose();
      geometry.dispose();
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

/** One pooled fireball. */
interface Burst {
  readonly root: Group;
  readonly ball: Mesh;
  readonly ballMaterial: MeshBasicMaterial;
  readonly core: Mesh;
  readonly coreMaterial: MeshBasicMaterial;
  readonly shardGeometry: BufferGeometry;
  readonly shardMaterial: PointsMaterial;
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

/** The ball, the core and the shard cloud. */
const OBJECTS_PER_BURST = 3;

export function createCrashBursts(): CrashBursts {
  const root = new Group();
  root.name = 'saucers:bursts';

  const sphere = new SphereGeometry(1, BURST_RADIAL_SEGMENTS, BURST_HEIGHT_SEGMENTS);
  const bursts: Burst[] = [];
  for (let index = 0; index < BURST_POOL_SIZE; index++) {
    const burstRoot = new Group();
    burstRoot.name = `saucers:burst:${index}`;
    burstRoot.visible = false;

    const ballMaterial = new MeshBasicMaterial({
      color: BURST_COLOUR,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const ball = new Mesh(sphere, ballMaterial);
    burstRoot.add(ball);

    const coreMaterial = new MeshBasicMaterial({
      color: CORE_COLOUR,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const core = new Mesh(sphere, coreMaterial);
    burstRoot.add(core);

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
    burstRoot.add(new Points(shardGeometry, shardMaterial));

    root.add(burstRoot);
    bursts.push({ root: burstRoot, ball, ballMaterial, core, coreMaterial, shardGeometry, shardMaterial });
  }

  let next = 0;

  return {
    root,
    begin(): void {
      for (const burst of bursts) burst.root.visible = false;
      next = 0;
    },
    show(x: number, groundY: number, z: number, age: number): void {
      const t = age / BURST_SECONDS;
      if (t < 0 || t >= 1) return;
      const burst = bursts[next];
      if (burst === undefined) return;
      next++;

      burst.root.visible = true;
      burst.root.position.set(x, groundY, z);

      // The ball expands fast and fades linearly: `sqrt` front-loads the growth,
      // which is what an explosion does and a balloon does not.
      const grow = Math.sqrt(t);
      burst.ball.scale.setScalar(worldUnitsAcross(BURST_MAX_RADIUS_CELLS) * grow);
      burst.ballMaterial.opacity = Math.pow(1 - t, BURST_FADE_EXPONENT);

      // The core is over in the first third: full size at once, fading out.
      const coreT = Math.min(1, t / CORE_SECONDS_FRACTION);
      burst.core.visible = coreT < 1;
      burst.core.scale.setScalar(worldUnitsAcross(CORE_MAX_RADIUS_CELLS) * Math.sqrt(coreT));
      burst.coreMaterial.opacity = 1 - coreT;

      // Shards fly out on their fixed bearings and fall back under a simple
      // parabola. Not physics — there is no gravity constant here and there does
      // not need to be one; it is the arc a thrown thing makes.
      const positions = burst.shardGeometry.getAttribute('position') as BufferAttribute;
      for (let index = 0; index < SHARD_BEARINGS.length; index++) {
        const bearing = SHARD_BEARINGS[index]!;
        const reach = worldUnitsAcross(SHARD_REACH_CELLS) * t;
        const rise = worldUnitsAcross(SHARD_RISE_CELLS) * bearing.lift * (t * (2 - 2 * t));
        positions.setXYZ(index, bearing.x * reach, rise, bearing.z * reach);
      }
      positions.needsUpdate = true;
      burst.shardMaterial.opacity = 1 - t;
    },
    dispose(): void {
      for (const burst of bursts) {
        burst.ballMaterial.dispose();
        burst.coreMaterial.dispose();
        burst.shardGeometry.dispose();
        burst.shardMaterial.dispose();
      }
      sphere.dispose();
      root.clear();
    },
  };
}

/** Exposed so the plugin's draw budget is written from the rigs' own counts. */
export const LASER_POOL_DRAW_OBJECTS = MAX_LASER_BOLTS;
/** Every burst in the pool, fully drawn. */
export const BURST_DRAW_OBJECTS = BURST_POOL_SIZE * OBJECTS_PER_BURST;

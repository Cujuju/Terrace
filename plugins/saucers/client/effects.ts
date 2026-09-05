// THE TWO THINGS IN THIS PLUGIN THAT ARE NOT A SAUCER: the laser bolts, and the
// fireball at the crash site.
//
// Both are PURE PRESENTATION invented here out of what the server sent plus the
// frame clock. Nothing about either is on the wire beyond "a bolt was fired from
// A at B, this many seconds ago" and "the wreck went in here, this many seconds
// ago"; nothing in the world can observe them; and the FIRE and the CRATER are
// not drawn here at all — the fire plugin draws the flames and the terrain shows
// the hole, which is the whole reason the burst is allowed to be as short as it
// is.
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
} from 'three';
import { CELL_WORLD_SIZE, LASER_BOLT_LIFETIME_SECONDS, MAX_LASER_BOLTS } from '../protocol.ts';

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
 * 0.12 — three hundredths of a world unit, against a hull that is one world unit
 * across (SAUCER_DIAMETER_CELLS is four cells). Thin enough to read as a beam
 * rather than as a pipe, thick enough to survive being seen end-on at
 * dogfight speed. It is a length of the WORLD, not of the model, so it does not
 * change if the hull is re-authored at another size.
 */
const BOLT_RADIUS_CELLS = 0.12;

/** Sides on the bolt cylinder. SIX: it is a lit streak seen edge-on at speed. */
const BOLT_RADIAL_SEGMENTS = 6;

/** The bolt's colour. A hot cyan-white, unlit and additively blended. */
const BOLT_COLOUR = 0x9ff0ff;

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
   * Draws one bolt between two world-space points, faded by its age. Silently
   * does nothing once the pool is exhausted — MAX_LASER_BOLTS is the server's
   * own ceiling, so that is unreachable rather than a policy.
   */
  draw(from: Vector3, to: Vector3, age: number): void;
  dispose(): void;
}

export function createLaserPool(): LaserPool {
  // A UNIT-LENGTH cylinder, translated so its base sits at the origin: the draw
  // below then scales Y by the distance and puts the base at the muzzle, which
  // is one scale and one quaternion rather than a midpoint calculation.
  const boltRadius = worldUnitsAcross(BOLT_RADIUS_CELLS);
  const geometry = new CylinderGeometry(
    boltRadius,
    boltRadius,
    1,
    BOLT_RADIAL_SEGMENTS,
    1,
    true,
  );
  geometry.translate(0, 0.5, 0);

  const root = new Group();
  root.name = 'saucers:bolts';
  const bolts: Bolt[] = [];
  for (let index = 0; index < MAX_LASER_BOLTS; index++) {
    // ONE MATERIAL PER BOLT, not one shared: the fade is written into the
    // material's opacity, and bolts of different ages are on screen together.
    const material = new MeshBasicMaterial({
      color: BOLT_COLOUR,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
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
    draw(from: Vector3, to: Vector3, age: number): void {
      const bolt = bolts[next];
      if (bolt === undefined) return;
      next++;

      scratchDirection.subVectors(to, from);
      const length = scratchDirection.length();
      // A zero-length bolt would produce a NaN direction. It cannot happen while
      // two saucers are half an arena apart, which is exactly why it is worth
      // one comparison rather than a debugging session the day something moves
      // them together.
      if (length <= 0) return;
      scratchDirection.divideScalar(length);

      bolt.mesh.position.copy(from);
      bolt.mesh.quaternion.copy(
        scratchQuaternion.setFromUnitVectors(CYLINDER_AXIS, scratchDirection),
      );
      bolt.mesh.scale.set(1, length, 1);
      // Linear fade over the bolt's whole life, so a bolt is brightest at the
      // muzzle-flash instant and gone exactly when the server stops sending it.
      const life = 1 - Math.min(1, Math.max(0, age / LASER_BOLT_LIFETIME_SECONDS));
      (bolt.mesh.material as MeshBasicMaterial).opacity = life;
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
// THE FIREBALL.

/**
 * How long the burst lasts, in seconds.
 *
 * ONE SECOND, and it is deliberately SHORTER than the server's aftermath phase
 * (AFTERMATH_SECONDS is 1.5): the burst has to be over before the payload that
 * carries it stops arriving, or the last frames of the fireball would be cut off
 * by the encounter ending rather than by the effect finishing.
 */
export const BURST_SECONDS = 1;

/** The fireball's radius at full expansion, in cells. Three — a crater and a bit. */
const BURST_MAX_RADIUS_CELLS = 3;

/** Sphere tessellation. Low: it is on screen for a second, glowing, expanding. */
const BURST_RADIAL_SEGMENTS = 16;
const BURST_HEIGHT_SEGMENTS = 12;

/** Hot orange, additively blended so it reads as light rather than as a ball. */
const BURST_COLOUR = 0xffa03c;

/**
 * Shards thrown out of the impact.
 *
 * TWELVE — enough to read as debris, few enough that the whole cloud is ONE
 * draw call and its positions can be rewritten in place every frame without
 * showing up in a profile.
 */
const BURST_SHARD_COUNT = 12;

/** How far a shard travels over the burst, in cells, and how high it arcs. */
const SHARD_REACH_CELLS = 5;
const SHARD_RISE_CELLS = 2.5;

/** Shard size in pixels, and their colour — the same fire as the ball. */
const SHARD_SIZE_PIXELS = 4;

/**
 * The shards' launch directions, FIXED rather than random.
 *
 * A crash looks the same on every client because it IS the same crash: two
 * players standing beside each other must not see debris fly two different ways.
 * Twelve evenly spaced bearings with alternating rise gives a spray that is
 * plainly a spray and is a function of nothing.
 */
const SHARD_BEARINGS: readonly { readonly x: number; readonly z: number; readonly lift: number }[] =
  Array.from({ length: BURST_SHARD_COUNT }, (_unused, index) => {
    const angle = (index * 2 * Math.PI) / BURST_SHARD_COUNT;
    return {
      x: Math.cos(angle),
      z: Math.sin(angle),
      // Alternating high and low arcs, so the spray has a shape instead of being
      // a flat ring.
      lift: index % 2 === 0 ? 1 : 0.55,
    };
  });

export interface CrashBurst {
  readonly root: Group;
  /**
   * Places and advances the burst. `age` is seconds since impact, from the
   * server. Hides itself once the burst is over, which is what makes a client
   * that joined mid-aftermath show the right part of it rather than restarting
   * it.
   */
  show(x: number, groundY: number, z: number, age: number): void;
  /** Hides everything — the sky is empty. */
  hide(): void;
  dispose(): void;
}

export function createCrashBurst(): CrashBurst {
  const root = new Group();
  root.name = 'saucers:burst';
  root.visible = false;

  const ballGeometry = new SphereGeometry(1, BURST_RADIAL_SEGMENTS, BURST_HEIGHT_SEGMENTS);
  const ballMaterial = new MeshBasicMaterial({
    color: BURST_COLOUR,
    transparent: true,
    opacity: 1,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const ball = new Mesh(ballGeometry, ballMaterial);
  ball.name = 'saucers:burst:ball';
  root.add(ball);

  const shardPositions = new Float32Array(BURST_SHARD_COUNT * 3);
  const shardGeometry = new BufferGeometry();
  shardGeometry.setAttribute('position', new BufferAttribute(shardPositions, 3));
  const shardMaterial = new PointsMaterial({
    color: BURST_COLOUR,
    size: SHARD_SIZE_PIXELS,
    sizeAttenuation: false,
    transparent: true,
    opacity: 1,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const shards = new Points(shardGeometry, shardMaterial);
  shards.name = 'saucers:burst:shards';
  root.add(shards);

  return {
    root,
    show(x: number, groundY: number, z: number, age: number): void {
      const t = age / BURST_SECONDS;
      if (t < 0 || t >= 1) {
        root.visible = false;
        return;
      }
      root.visible = true;
      root.position.set(x, groundY, z);

      // The ball expands fast and fades linearly: `sqrt` front-loads the growth,
      // which is what an explosion does and a balloon does not.
      const grow = Math.sqrt(t);
      ball.scale.setScalar(worldUnitsAcross(BURST_MAX_RADIUS_CELLS) * grow);
      ballMaterial.opacity = 1 - t;

      // Shards fly out on their fixed bearings and fall back under a simple
      // parabola. Not physics — there is no gravity constant here and there does
      // not need to be one; it is the arc a thrown thing makes, and it is over
      // in a second.
      const positions = shardGeometry.getAttribute('position') as BufferAttribute;
      for (let index = 0; index < SHARD_BEARINGS.length; index++) {
        const bearing = SHARD_BEARINGS[index]!;
        const reach = worldUnitsAcross(SHARD_REACH_CELLS) * t;
        const rise = worldUnitsAcross(SHARD_RISE_CELLS) * bearing.lift * (t * (2 - 2 * t));
        positions.setXYZ(index, bearing.x * reach, rise, bearing.z * reach);
      }
      positions.needsUpdate = true;
      shardMaterial.opacity = 1 - t;
    },
    hide(): void {
      root.visible = false;
    },
    dispose(): void {
      ballGeometry.dispose();
      ballMaterial.dispose();
      shardGeometry.dispose();
      shardMaterial.dispose();
      root.clear();
    },
  };
}

/** Exposed so the plugin's draw budget is written from the rigs' own counts. */
export const LASER_POOL_DRAW_OBJECTS = MAX_LASER_BOLTS;
/** The ball and the shard cloud. */
export const BURST_DRAW_OBJECTS = 2;

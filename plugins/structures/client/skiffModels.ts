// skiffModels.ts — the Three.js rendering half of card 33's skiffs; see
// skiffs.ts for the placement/animation-parameter math this file consumes,
// and its own banner for why skiffs exist purely client-side.
//
// EVERY BOAT IS A SIMPLE LOW-POLY PROP, deliberately much simpler than the
// standing buildings in models.ts: a skiff is ambient background dressing
// glimpsed bobbing on the water at the game's orbit-camera distance, not a
// hero asset a player walks up to — see models.ts's own file banner for the
// "this game's camera looks down from an 80+ cell orbit" reasoning that
// birds and fish already rely on for the same simplification.
//
// PER-FRAME MATRIX REWRITE, not a static apply()-only instance buffer like
// every building mesh in this plugin: a skiff's position changes every
// frame (it orbits its anchor and bobs), so animate() recomputes every
// instance's transform every frame it has any skiffs to draw — not just
// once per founding/upgrade/demolition the way models.ts's apply() does.
// The instance COUNT still only changes on apply() (a new or lost coastal
// settlement), so animate() is a no-op the instant there are zero skiffs —
// no idle per-frame cost on an all-inland world.

import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { SEA_LEVEL } from '@terrace/shared';
import { STRUCTURES_CAP } from '../protocol.ts';
import { SKIFF_MAX_PER_SETTLEMENT, SKIFF_ORBIT_PERIOD_SECONDS, type SkiffPlacement } from './skiffs.ts';

const Y_AXIS = new Vector3(0, 1, 0);
const FULL_TURN_RADIANS = Math.PI * 2;

/**
 * World-space Y a skiff floats at, before its own small bob
 * (SKIFF_BOB_AMPLITUDE_WORLD_UNITS below).
 *
 * Own copy of the reasoning plugins/wildlife/client/placement.ts's
 * SEA_SURFACE_WORLD_Y states in full (own copy per plugin — see this
 * plugin's protocol.ts header on why every plugin keeps its own): SEA_LEVEL
 * is 0 by definition, and the renderer draws the sea surface at
 * `SEA_LEVEL * scale + a lift far smaller than any clearance here`
 * (client/src/render/water.ts), so world Y = 0 is where the surface actually
 * sits. The `: 0` annotation stops this compiling the day SEA_LEVEL becomes
 * anything else, which is exactly when this reasoning stops holding.
 */
const SKIFF_FLOAT_WORLD_Y: 0 = SEA_LEVEL;

/** How far a skiff bobs above/below its resting float line, in world units. Small: a ripple, not a swell. */
const SKIFF_BOB_AMPLITUDE_WORLD_UNITS = 0.02;
/** Seconds for one full bob cycle (down-up-down). Distinct from every skiff's own orbit period, so bobbing never lines up with orbiting into a repeating combined cycle a player could clock. */
const SKIFF_BOB_PERIOD_SECONDS = 2.6;

const SKIFF_HULL_COLOR = 0x6b4a30;
const SKIFF_THWART_COLOR = 0x4a3220;

/**
 * Instance capacity: every live structure could in principle be a maxed-out
 * coastal settlement (STRUCTURES_CAP, protocol.ts) floating the maximum
 * skiff count (SKIFF_MAX_PER_SETTLEMENT, skiffs.ts) — the same "assume the
 * worst case, allocate once" trade every InstancedMesh in this plugin makes
 * (see models.ts's identical comment on its own tier meshes). 512 x 3 = 1536
 * instances of a two-part, few-hundred-vertex prop is trivial GPU cost next
 * to the building meshes already allocated at this same worst case.
 */
const SKIFF_INSTANCE_CAPACITY = STRUCTURES_CAP * SKIFF_MAX_PER_SETTLEMENT;

interface SkiffPart {
  readonly geometry: BoxGeometry;
  readonly material: MeshLambertMaterial;
  readonly localMatrices: Matrix4[];
}

/**
 * Two parts: a hull and a single thwart (bench) crossbar — enough to read as
 * "a small rowboat" at gameplay distance without the tapered bow/stern
 * carpentry the standing buildings invest in (see the file banner). The
 * hull's length runs along local +Z, matching every other "front" convention
 * in this plugin (models.ts's doors/windows), so a skiff's yaw can reuse the
 * exact same axis-angle-about-Y convention circleRingMatrices already uses.
 */
function buildSkiffParts(): SkiffPart[] {
  const hullLength = 0.36;
  const hullWidth = 0.14;
  const hullHeight = 0.06;
  const hull: SkiffPart = {
    geometry: new BoxGeometry(hullWidth, hullHeight, hullLength),
    material: new MeshLambertMaterial({ color: SKIFF_HULL_COLOR, flatShading: true }),
    localMatrices: [new Matrix4().makeTranslation(0, hullHeight / 2, 0)],
  };
  const thwart: SkiffPart = {
    geometry: new BoxGeometry(hullWidth * 0.75, 0.025, 0.02),
    material: new MeshLambertMaterial({ color: SKIFF_THWART_COLOR, flatShading: true }),
    localMatrices: [new Matrix4().makeTranslation(0, hullHeight + 0.012, 0)],
  };
  return [hull, thwart];
}

export interface SkiffModels {
  readonly root: Group;
  apply(placements: readonly SkiffPlacement[]): void;
  /** Advances every skiff's orbit/bob by `dt` seconds. A no-op while there are no skiffs to draw. */
  animate(dt: number): void;
  dispose(): void;
}

export function createSkiffModels(): SkiffModels {
  const parts = buildSkiffParts();
  const geometries = parts.map((part) => part.geometry);
  const materials = parts.map((part) => part.material);

  const root = new Group();
  root.name = 'structures:skiffs';
  const meshes = parts.map((part) => {
    const mesh = new InstancedMesh(part.geometry, part.material, SKIFF_INSTANCE_CAPACITY);
    mesh.count = 0;
    root.add(mesh);
    return mesh;
  });

  let current: readonly SkiffPlacement[] = [];
  let elapsedSeconds = 0;

  // Scratch objects reused across every instance of every frame — the same
  // discipline models.ts's apply() keeps, for the identical reason: this
  // runs every frame, not just on a rebuild.
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const boatMatrix = new Matrix4();
  const instanceMatrix = new Matrix4();

  function writeFrame(): void {
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const mesh = meshes[partIndex];
      let count = 0;
      for (const skiff of current) {
        const t = elapsedSeconds + skiff.phaseSeconds;
        const dirSign = skiff.orbitClockwise ? 1 : -1;
        const angle = (t / SKIFF_ORBIT_PERIOD_SECONDS) * FULL_TURN_RADIANS * dirSign;
        const worldX = skiff.x + Math.sin(angle) * skiff.orbitRadius;
        const worldZ = skiff.z + Math.cos(angle) * skiff.orbitRadius;
        const bob = Math.sin((t / SKIFF_BOB_PERIOD_SECONDS) * FULL_TURN_RADIANS) * SKIFF_BOB_AMPLITUDE_WORLD_UNITS;
        position.set(worldX, SKIFF_FLOAT_WORLD_Y + bob, worldZ);

        // Heading = the instantaneous direction of travel around the orbit
        // (the derivative of the position formula above w.r.t. angle,
        // signed by orbitClockwise), so the hull always noses the way it is
        // actually moving rather than facing a fixed or unrelated direction.
        const tangentX = dirSign * Math.cos(angle);
        const tangentZ = -dirSign * Math.sin(angle);
        rotation.setFromAxisAngle(Y_AXIS, Math.atan2(tangentX, tangentZ));

        boatMatrix.compose(position, rotation, scale);
        for (const local of part.localMatrices) {
          instanceMatrix.multiplyMatrices(boatMatrix, local);
          mesh.setMatrixAt(count++, instanceMatrix);
        }
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  return {
    root,

    apply(placements: readonly SkiffPlacement[]): void {
      // SKIFF_INSTANCE_CAPACITY already covers the worst case placementsFor
      // can hand in (see its own comment); this is not a second cap, just
      // the caller's list.
      current = placements;
      writeFrame();
    },

    animate(dt: number): void {
      elapsedSeconds += dt;
      if (current.length > 0) writeFrame();
    },

    dispose(): void {
      for (const mesh of meshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}

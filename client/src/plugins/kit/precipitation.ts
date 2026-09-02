// FALLING COLUMNS: the vertical layout of the sky, and one pooled column of
// particles falling through it.
//
// WHAT IS HERE AND WHY IT IS SHARED. Three plugins draw a column of particles
// falling out of a drifting mass; they differ only in a PROFILE — how many
// particles, how fast they fall, what shape they are, whether they sway. The
// column itself is one mechanism: a struct-of-arrays of per-particle constants
// drawn once, a buffer rewritten in place every frame, and one draw call.
//
// The pure maths (`fallFraction`, `driftSeconds`) and every constant live beside
// it rather than inside the mesh code, so a node test can check how the fall
// BEHAVES without a GL context — this project ships no headless GL rig
// (docs/DESIGN.md).
//
// NO PER-FRAME ALLOCATIONS. Every geometry, material and buffer is built once
// when a column is created and mutated in place each frame; the frame path
// writes numbers into arrays that already exist.
//
// UNITS: world units and seconds, except where a name says cells.

import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
  type Material,
  type Object3D,
} from 'three';
import { BAND_HEIGHT, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, WORLD_UNITS_PER_BAND } from '@terrace/shared';

const TWO_PI = Math.PI * 2;

// ── The vertical layout of the sky ───────────────────────────────────────────

/** Height units per world unit — the client's WORLD_UNIT_HEIGHT_UNITS. */
const WORLD_UNIT_HEIGHT_UNITS = MAX_HEIGHT / MAX_RELIEF_WORLD_UNITS;

/**
 * World-space Y of the highest ground this game can contain.
 *
 * MAX_HEIGHT (@terrace/shared) is the sculpt ceiling in HEIGHT UNITS and
 * BAND_HEIGHT is height units per band, so the quotient is the ceiling in BANDS
 * — which is world units only while a band draws one world unit. It does not
 * (WORLD_UNITS_PER_BAND, moved into shared on 2026-08-20), so the relief is
 * applied directly: it is the one number the client's vertical scale is built
 * from.
 */
export const MAX_GROUND_WORLD_Y = (MAX_HEIGHT / BAND_HEIGHT) * WORLD_UNITS_PER_BAND;

/**
 * Clearance between the highest possible mountain and the cloud base, in world
 * units.
 *
 * Half of MAX_GROUND_WORLD_Y, for the same reason the wildlife plugin's birds
 * keep the same gap: the requirement is that a mass reads as being OVER the
 * world, and that has to hold at the worst case (a player who has built a
 * maximum-height peak and then watches a front cross it) rather than at the
 * typical one. It puts the cloud base at exactly the altitude birds fly at,
 * which is the correct picture and not a collision: a flock crossing under the
 * rim of a falling column is what a sky looks like.
 */
export const CLOUD_HEADROOM_WORLD_UNITS = MAX_GROUND_WORLD_Y / 2;

/** World-space Y a particle is born at. 24 today. */
export const CLOUD_BASE_WORLD_Y = MAX_GROUND_WORLD_Y + CLOUD_HEADROOM_WORLD_UNITS;

/**
 * How far below sea level a column keeps falling before it is recycled, in
 * bands.
 *
 * A QUARTER OF A CELL below a fresh world's open-sea floor. Particles are
 * depth-TESTED, so the ground and the sea surface hide everything under them;
 * the column has to reach past the deepest ordinary floor so that it visibly
 * meets the ground everywhere instead of stopping in mid-air over a trench. It
 * does not reach MIN_HEIGHT: a player-dug abyss that deep would show the column
 * ending above its floor, which is a cheaper failure than making every column
 * that tall.
 *
 * STATED IN HEIGHT UNITS, band count derived, so the clearance keeps holding at
 * any terracing. Restated rather than imported because a client plugin cannot
 * pull in the server's world module.
 */
const FRESH_SEABED_DEPTH_BELOW_SEA = 192;
/** Clearance under that floor: a quarter cell, enough to read as "past it". */
const PRECIPITATION_FLOOR_CLEARANCE = WORLD_UNIT_HEIGHT_UNITS / 4;
export const PRECIPITATION_FLOOR_BANDS_BELOW_SEA =
  (FRESH_SEABED_DEPTH_BELOW_SEA + PRECIPITATION_FLOOR_CLEARANCE) / BAND_HEIGHT;

/** World-space Y at which a particle is recycled to the cloud base. −4 today. */
export const PRECIPITATION_FLOOR_WORLD_Y =
  -PRECIPITATION_FLOOR_BANDS_BELOW_SEA * WORLD_UNITS_PER_BAND;

/** Height of the falling column, in world units. 28 today. */
export const PRECIPITATION_COLUMN_WORLD_UNITS =
  CLOUD_BASE_WORLD_Y - PRECIPITATION_FLOOR_WORLD_Y;

// ── The profile ──────────────────────────────────────────────────────────────

/** Everything that decides how one plugin's precipitation falls and looks. */
export interface PrecipitationProfile {
  /** Line segments or round sprites. Chooses the mesh built below. */
  readonly form: 'streak' | 'flake';
  /** Particles in one column. */
  readonly count: number;
  /** World units per second, downward. */
  readonly fallSpeed: number;
  /** Length of a streak, in world units. Ignored by 'flake'. */
  readonly streakLength: number;
  /** Sprite diameter in world units. Ignored by 'streak'. */
  readonly spriteSize: number;
  /** Peak alpha, reached at intensity 1. */
  readonly opacity: number;
  readonly color: number;
  /** Horizontal sway amplitude in cells, and its rate. Zero disables it. */
  readonly swayCells: number;
  readonly swayHz: number;
}

/**
 * Where in its fall a particle is, as a fraction in [0, 1): 0 at the cloud base,
 * approaching 1 at the floor.
 *
 * `birth` is the particle's own position in the cycle, drawn once when the
 * column is built, so a column's particles are spread through it instead of
 * falling as one sheet. The wrap is per-particle: one that reaches the floor
 * reappears at the cloud base, 28 units above and far from anything a player is
 * looking at.
 *
 * Total for any finite input, including a negative elapsed time — the JS `%`
 * keeps the sign of its left operand, so the `+ 1` is what stops a negative
 * fraction placing a particle above the cloud.
 */
export function fallFraction(
  elapsedSeconds: number,
  birth: number,
  fallSpeed: number,
): number {
  const cycles = birth + (elapsedSeconds * fallSpeed) / PRECIPITATION_COLUMN_WORLD_UNITS;
  return ((cycles % 1) + 1) % 1;
}

/**
 * Seconds a particle at fall fraction `f` has been in the air. Multiplied by the
 * mass's velocity, this is how far downwind it has been carried — which is what
 * shears the column, and what makes a slow-falling particle visibly blow
 * sideways while a fast one barely leans.
 */
export function driftSeconds(fraction: number, fallSpeed: number): number {
  return (fraction * PRECIPITATION_COLUMN_WORLD_UNITS) / fallSpeed;
}

// ── The column ───────────────────────────────────────────────────────────────

/** A pooled column of falling particles. Positions are rewritten every frame. */
export interface PrecipitationColumn {
  readonly object: Object3D;
  readonly material: Material;
  /**
   * Rewrites every particle's position for this frame. `vx`/`vy` are the mass's
   * velocity in WORLD UNITS per second and shear the column downwind.
   */
  advance(elapsed: number, radius: number, vx: number, vy: number): void;
  dispose(): void;
}

/**
 * Builds one falling column in the LOCAL space of its rig — a rig's root is
 * moved to the mass's centre, so nothing here ever holds a world coordinate and
 * the numbers stay small however far across a 512² world the front has drifted.
 *
 * `frustumCulled` is off. three computes a bounding sphere once, from the
 * positions the geometry was created with, and every frame after that these
 * positions move; a stale sphere would cull the column exactly when the camera
 * looked at it. With a handful of columns on screen, always submitting the draw
 * call is cheaper than any correct alternative.
 *
 * `renderOrder` is the caller's: it depends on what else that plugin draws and
 * on the transparent sea underneath (see the callers' RENDER_ORDER constants).
 */
export function createPrecipitationColumn(
  profile: PrecipitationProfile,
  renderOrder: number,
): PrecipitationColumn {
  const verticesPerParticle = profile.form === 'streak' ? 2 : 1;
  // Per-particle constants, drawn once. Kept in flat arrays rather than an array
  // of objects: the frame loop reads them `count` times, and a struct-of-arrays
  // walk is both allocation-free and cache-friendly.
  const discX = new Float32Array(profile.count);
  const discZ = new Float32Array(profile.count);
  const birth = new Float32Array(profile.count);
  const swayPhase = new Float32Array(profile.count);

  for (let i = 0; i < profile.count; i++) {
    // sqrt of a uniform gives a UNIFORM AREA density over the disc; using the
    // uniform directly would crowd every column into its own middle.
    const r = Math.sqrt(Math.random());
    const angle = Math.random() * TWO_PI;
    discX[i] = Math.cos(angle) * r;
    discZ[i] = Math.sin(angle) * r;
    birth[i] = Math.random();
    swayPhase[i] = Math.random() * TWO_PI;
  }

  const geometry = new BufferGeometry();
  const attribute = new Float32BufferAttribute(profile.count * verticesPerParticle * 3, 3);
  // Told once that this buffer changes every frame, so the driver can pick the
  // right storage for it instead of assuming static geometry.
  attribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', attribute);

  // THE BUFFER THE FRAME LOOP WRITES IS THE ATTRIBUTE'S OWN, TAKEN BACK OUT OF
  // IT — never a Float32Array handed in and kept alongside.
  //
  // Fixed 2026-08-28, and it is why no player had ever seen a raindrop.
  // `Float32BufferAttribute`'s constructor is `super(new Float32Array(array),
  // …)`, and `new Float32Array(aFloat32Array)` COPIES: the array passed in is
  // not the array drawn. The rig kept writing into its own copy and setting
  // `needsUpdate` on an attribute whose buffer stayed zero-filled, so every
  // particle was a degenerate zero-length line at the rig's centre. Nothing
  // failed and nothing warned.
  //
  // Constructing the attribute from a LENGTH and reading `.array` back is what
  // makes the two impossible to separate again: there is now only one buffer,
  // and it is the one the GPU uploads.
  const positions = attribute.array as Float32Array;

  const material =
    profile.form === 'streak'
      ? new LineBasicMaterial({
          color: profile.color,
          transparent: true,
          opacity: 0,
          // Depth TESTED so the ground and the sea occlude the part of the
          // column below them, not depth WRITTEN so particles never cut each
          // other or the sheets they fall through.
          depthWrite: false,
        })
      : new PointsMaterial({
          color: profile.color,
          size: profile.spriteSize,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });

  const object =
    profile.form === 'streak'
      ? new LineSegments(geometry, material as LineBasicMaterial)
      : new Points(geometry, material as PointsMaterial);
  object.frustumCulled = false;
  object.renderOrder = renderOrder;

  return {
    object,
    material,

    advance(elapsed: number, radius: number, vx: number, vy: number): void {
      // The streak points along the particle's actual velocity — down at
      // fallSpeed, sideways at the wind — so it leans into the wind instead of
      // hanging vertically in a gale. One normalisation per frame, not per
      // particle.
      const speed = Math.hypot(vx, profile.fallSpeed, vy);
      const streakX = (vx / speed) * profile.streakLength;
      const streakY = (-profile.fallSpeed / speed) * profile.streakLength;
      const streakZ = (vy / speed) * profile.streakLength;

      let write = 0;
      for (let i = 0; i < profile.count; i++) {
        const fraction = fallFraction(elapsed, birth[i]!, profile.fallSpeed);
        const aloft = driftSeconds(fraction, profile.fallSpeed);
        const sway =
          profile.swayCells === 0
            ? 0
            : profile.swayCells * Math.sin(elapsed * profile.swayHz * TWO_PI + swayPhase[i]!);

        const x = discX[i]! * radius + vx * aloft + sway;
        const y = CLOUD_BASE_WORLD_Y - fraction * PRECIPITATION_COLUMN_WORLD_UNITS;
        // The second sway axis is a quarter cycle out of phase with the first,
        // so a particle traces a slow ellipse rather than sliding along one line.
        const z =
          discZ[i]! * radius +
          vy * aloft +
          (profile.swayCells === 0
            ? 0
            : profile.swayCells * Math.cos(elapsed * profile.swayHz * TWO_PI + swayPhase[i]!));

        positions[write++] = x;
        positions[write++] = y;
        positions[write++] = z;
        if (verticesPerParticle === 2) {
          positions[write++] = x + streakX;
          positions[write++] = y + streakY;
          positions[write++] = z + streakZ;
        }
      }
      attribute.needsUpdate = true;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}

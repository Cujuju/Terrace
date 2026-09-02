// ONE DRIFTING MASS, IN THE SCENE — the rig four plugins draw, and the pool they
// keep it in.
//
// A rig is a Group put at the mass's centre on the X/Z plane and never rotated,
// holding a haze bank (./hazeBank.ts) and, for a mass that precipitates, one
// falling column (./precipitation.ts). Everything else a plugin needs — a bolt,
// a flash, a light — is added to `root` by that plugin and animated by it.
//
// RENDERING IS ANCHORED TO THE MASS, NOT TO THE CAMERA. The usual way to draw
// rain is a small box of particles that follows the viewer, because in most games
// weather covers the whole world and drawing all of it is impossible. Here it is
// the other way round: a mass IS a bounded object — a disc of 24 to 56 cells — so
// the entire thing fits in one pooled rig, and anchoring that rig to the mass is
// both simpler and more correct. A front is then a body that visibly crosses the
// landscape and passes over the player, which a camera-locked box cannot show.
// It is also the only option available: ClientPluginCtx exposes no camera.
//
// COST, NAMED: the particle COUNT per rig is fixed while the radius is not, so a
// 24-cell squall is about five times as dense as a 56-cell front. That reads as a
// compact shower being heavier than a broad drizzle — a defensible picture, and a
// consequence rather than a decision.
//
// WHY POOL AT ALL when only a handful exist: building one allocates a
// multi-thousand-float buffer and a fresh material, and weather turns over every
// few minutes forever, so without a pool a world left running all evening pays
// that repeatedly. With one it pays it once, and the shared geometry once ever.

import { Group } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type { BufferGeometry } from 'three';
import { createHazeBank, type HazeBank } from './hazeBank.ts';
import {
  createPrecipitationColumn,
  type PrecipitationColumn,
  type PrecipitationProfile,
} from './precipitation.ts';
import type { InterpolatedDisc } from './discInterpolator.ts';

/**
 * Draw order for a mass's transparent parts.
 *
 * The sea is transparent too (render/water.ts) and it is ONE plane the size of
 * the world, so three sorts it by the distance to its centre — the middle of the
 * map, not the water under the weather. Left to the sort, a sheet a unit above
 * the surface can therefore be drawn first and then painted over by the sea. A
 * positive render order puts every sheet after it, unconditionally. Same value
 * and same reasoning as the monsters plugin's DREAD_RENDER_ORDER.
 */
export const DISC_RENDER_ORDER = 1;

/** One mass's body: the haze, and the column falling through it. */
export interface DiscRig {
  /** Put at the mass's centre on the X/Z plane; never rotated. */
  readonly root: Group;
  /**
   * One frame. Returns whether the mass is LIT — intensity above zero — so a
   * caller can skip its own parts on exactly the frames this one does. Nothing
   * is drawn at zero: a transparent draw call that contributes nothing is still
   * a transparent draw call, and this is what makes a gathering mass cost
   * nothing until it is actually visible.
   *
   * `elapsed` is the plugin's animation clock, which STOPS ADVANCING under
   * prefers-reduced-motion — so every fall, sway, spin and bob in here becalms
   * from that one fact, with no reduced-motion branch of its own.
   */
  update(disc: InterpolatedDisc, elapsed: number): boolean;
  /** Frees everything this rig OWNS. Shared geometry belongs to its builder. */
  dispose(): void;
}

export interface DiscRigSpec {
  /** The shared haze geometry, built once per plugin and freed by it. */
  readonly hazeGeometry: BufferGeometry;
  /** Multiplier on every haze layer's peak opacity. */
  readonly hazeStrength: number;
  /** How this mass precipitates, or null for one that does not. */
  readonly profile: PrecipitationProfile | null;
  /** Node name, for legibility in the three.js inspector. */
  readonly name: string;
}

export function createDiscRig(spec: DiscRigSpec): DiscRig {
  const root = new Group();
  root.name = spec.name;

  const column: PrecipitationColumn | null =
    spec.profile === null ? null : createPrecipitationColumn(spec.profile, DISC_RENDER_ORDER);
  if (column !== null) root.add(column.object);

  const haze: HazeBank = createHazeBank(spec.hazeGeometry, spec.hazeStrength, DISC_RENDER_ORDER);
  for (const sheet of haze.sheets) root.add(sheet);

  return {
    root,

    update(disc: InterpolatedDisc, elapsed: number): boolean {
      // The wire carries a mass's position, radius and velocity in CELLS — the
      // server sims on the same grid as everything else — and everything below
      // draws in WORLD UNITS. One conversion at the top, so no line further down
      // has to remember which space it is in.
      const worldRadius = disc.radius * CELL_WORLD_SIZE;
      root.position.set(disc.x * CELL_WORLD_SIZE, 0, disc.y * CELL_WORLD_SIZE);

      const lit = disc.intensity > 0;
      root.visible = lit;
      if (!lit) return false;

      if (column !== null && spec.profile !== null) {
        column.material.opacity = spec.profile.opacity * disc.intensity;
        column.advance(
          elapsed,
          worldRadius,
          disc.vx * CELL_WORLD_SIZE,
          disc.vy * CELL_WORLD_SIZE,
        );
      }

      haze.update(worldRadius, disc.intensity, elapsed);
      return true;
    },

    dispose(): void {
      root.clear();
      column?.dispose();
      haze.dispose();
    },
  };
}

/** Rigs, reused as masses come and go. */
export interface RigPool<T> {
  /** A rig from the free list if one is waiting, otherwise a fresh one. */
  acquire(): T;
  /** Returns a rig to the free list. The caller has already unparented it. */
  release(rig: T): void;
  /** Frees every rig, free or not. */
  dispose(): void;
}

/**
 * A free list over `create`.
 *
 * `onRelease` runs before a rig re-enters the list — where a plugin puts out
 * anything that must not survive into the next mass to acquire this rig.
 */
export function createRigPool<T extends { dispose(): void }>(
  create: () => T,
  onRelease?: (rig: T) => void,
): RigPool<T> {
  const free: T[] = [];
  const all: T[] = [];

  return {
    acquire(): T {
      const reused = free.pop();
      if (reused !== undefined) return reused;
      const rig = create();
      all.push(rig);
      return rig;
    },
    release(rig: T): void {
      onRelease?.(rig);
      free.push(rig);
    },
    dispose(): void {
      for (const rig of all) rig.dispose();
      all.length = 0;
      free.length = 0;
    },
  };
}

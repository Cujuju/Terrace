// THE RAIN A CYCLONE DROPS — the kit's falling column, seeded over the band
// annulus so that nothing falls through the eye.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS (#299). A hurricane that only rotated a cloud deck did
// nothing a player standing under it could feel. Rain is the half of "the storm
// is here" that reaches the ground, and it is also what makes the eye MEAN
// something: the calm hole is now a hole in the weather and not only a hole in
// the picture.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MECHANISM IS THE KIT'S, AND ONLY THE PROFILE IS OURS — the same split the
// rain, snow and thunderstorm plugins make (kit/precipitation.ts). What this
// file adds over those three is that its seed disc has a HOLE in it, which is
// now a first-class part of the column's contract (`innerRadiusFraction`)
// rather than something a caller filters afterwards.
//
// WHY NOT kit/discRig.ts. That rig is built for a mass carried by
// kit/discSystemsView.ts: it holds a haze bank as well as a column, and it is
// driven from an `InterpolatedDisc`. A cyclone is on its own wire, extrapolated
// rather than interpolated (./index.ts), and it has no haze — its air is
// darkened by ./gloom.ts, globally, which is the thing haze sheets approximate
// for a mass too small to justify one. So this takes the kit's COLUMN, which is
// the part that is actually shared, and not the rig around it.

import { Group } from 'three';
import type { Material } from 'three';
import {
  createPrecipitationColumn,
  type PrecipitationColumn,
  type PrecipitationProfile,
} from '../../../client/src/plugins/kit/precipitation.ts';
import { DISC_RENDER_ORDER } from '../../../client/src/plugins/kit/discRig.ts';
import { CYCLONE_EYE_RADIUS_FRACTION, CYCLONE_PLUGIN_NAME } from '../protocol.ts';
import { CYCLONE_NOMINAL_RADIUS_WORLD_UNITS, MAX_SPIRALS } from './spiral.ts';

/**
 * Drops per square world unit of the storm's rain annulus, at full strength.
 *
 * ONE. A cyclone is sixty world units across against a camera that orbits at
 * eighty, so what registers is the TEXTURE of a whole column rather than any
 * one streak; this is the sparse end of the density the smaller sky plugins
 * use over their own much smaller discs, and it is deliberately the sparse end,
 * because the count below multiplies it by an area twenty times theirs.
 *
 * IT IS A DENSITY AND THE COUNT IS DERIVED, so that a change to the storm's
 * radius or to the size of its eye cannot quietly change how heavy its rain
 * looks — the same "one decision, not two" rule the deck's puff count follows.
 */
export const CYCLONE_RAIN_DROPS_PER_WORLD_AREA = 1;

/**
 * The annulus the rain falls through, in square world units at the nominal
 * radius: the storm's disc with the eye taken out of it.
 *
 * AT THE NOMINAL RADIUS, for the reason spiral.ts's
 * CYCLONE_NOMINAL_RADIUS_WORLD_UNITS states: the count is fixed when the column
 * is built and the radius is not known until the server says so, so the two can
 * only be reconciled at one stated size. The residual is the one
 * kit/discRig.ts already names in full — a fixed particle count over a variable
 * disc means a clamped-small storm rains harder than a full-sized one.
 */
export const CYCLONE_RAIN_ANNULUS_WORLD_AREA =
  Math.PI *
  CYCLONE_NOMINAL_RADIUS_WORLD_UNITS *
  CYCLONE_NOMINAL_RADIUS_WORLD_UNITS *
  (1 - CYCLONE_EYE_RADIUS_FRACTION * CYCLONE_EYE_RADIUS_FRACTION);

/** Drops in one cyclone's column — derived from the density, never chosen. */
export const CYCLONE_DROP_COUNT = Math.round(
  CYCLONE_RAIN_DROPS_PER_WORLD_AREA * CYCLONE_RAIN_ANNULUS_WORLD_AREA,
);

/**
 * How a cyclone's rain falls and looks — the kit's rain, driven harder.
 *
 * FASTER AND LONGER THAN ORDINARY RAIN. Wind is what makes a hurricane a
 * hurricane, and the column shows it twice: the streak leans into the storm's
 * own drift (kit/precipitation.ts's `advance`), and it is longer than a shower's
 * so the lean is legible at all. The fall speed is what fixes the streak's
 * overlap between frames — at this speed a drop steps rather less than a streak
 * length per frame at sixty, so the column reads as continuous water and not as
 * a dotted line.
 *
 * IT DOES NOT SWAY. A sway is what makes a snowflake read as light enough to be
 * pushed about by air; a streak that swayed would smear, and rain this heavy is
 * not being pushed about by anything.
 *
 * DARKER AND DENSER THAN THE RAIN PLUGIN'S, because it falls under a deck that
 * is itself darker: rain lit by a sky the gloom has taken 60 % of the light out
 * of (./gloom.ts) is not the pale grey-blue of a shower under an ordinary
 * overcast.
 */
export const CYCLONE_RAIN_PROFILE: PrecipitationProfile = {
  form: 'streak',
  count: CYCLONE_DROP_COUNT,
  fallSpeed: 34,
  streakLength: 1.3,
  spriteSize: 0,
  opacity: 0.5,
  color: 0x8ea3b8,
  swayCells: 0,
  swayHz: 0,
  // THE EYE IS SPARED, and it is the same hole the deck leaves and the server
  // spares from wind damage. Taken from the protocol rather than restated, for
  // the reason spiral.ts's header gives: two numbers would eventually disagree
  // and make a true thing false.
  innerRadiusFraction: CYCLONE_EYE_RADIUS_FRACTION,
};

/**
 * Draw objects one cyclone's rain costs: ONE — the column is a single
 * `LineSegments`. There is no haze bank (see the header), so this is the whole
 * of it.
 */
export const CYCLONE_RAIN_DRAW_OBJECTS = 1;

/** One storm, as this field is told about it. */
export interface CycloneRainSource {
  readonly id: number;
  /** World-space X/Z of the eye. */
  readonly x: number;
  readonly z: number;
  /** The storm's radius in WORLD UNITS, converted from the wire's cells. */
  readonly radiusWorldUnits: number;
  readonly intensity: number;
  /** The storm's drift, in WORLD UNITS per second — it tilts the streaks. */
  readonly vx: number;
  readonly vz: number;
}

/** Every live cyclone's rain, as one pooled set of columns. */
export interface CycloneRainField {
  /** Parent this into the plugin's layer. */
  readonly root: Group;
  /** Reconciles the columns against the live storms and advances them. */
  apply(live: readonly CycloneRainSource[], elapsed: number): void;
  dispose(): void;
}

/** One column, and the storm it is currently drawing. */
interface RainRig {
  readonly root: Group;
  readonly column: PrecipitationColumn;
}

/**
 * `applyRevealClip` is `ClientPluginCtx.applyRevealClip` — a column's material
 * is its OWN (the kit builds a fresh one per column), so the clip is applied
 * once per column at the moment it is built, which is the "once per material,
 * never per mesh" rule that call states.
 */
export function createCycloneRainField(
  applyRevealClip: (material: Material, label: string) => void,
): CycloneRainField {
  const root = new Group();
  root.name = `${CYCLONE_PLUGIN_NAME}:rain`;

  /** The column drawing each live storm, keyed by storm id. */
  const rigs = new Map<number, RainRig>();
  /**
   * Columns built and not currently drawing a storm.
   *
   * POOLED FOR THE REASON kit/discRig.ts POOLS ITS RIGS: building one allocates
   * a multi-thousand-float buffer and a fresh material that has to be compiled,
   * and storms turn over forever, so without a free list a world left running
   * all evening pays that repeatedly.
   */
  const free: RainRig[] = [];
  const built: RainRig[] = [];

  function acquire(): RainRig {
    const reused = free.pop();
    if (reused !== undefined) return reused;
    const rig: RainRig = {
      root: new Group(),
      column: createPrecipitationColumn(CYCLONE_RAIN_PROFILE, DISC_RENDER_ORDER),
    };
    rig.root.name = `${CYCLONE_PLUGIN_NAME}:rain:column`;
    rig.root.add(rig.column.object);
    applyRevealClip(rig.column.material, `${CYCLONE_PLUGIN_NAME} rain`);
    built.push(rig);
    return rig;
  }

  return {
    root,

    apply(live, elapsed): void {
      // RELEASES FIRST, THEN ACQUIRES — kit/discSystemsView.ts's rule, for its
      // reason: one push can retire a storm and introduce another, and the
      // other order makes the newcomer build a column while the one it could
      // have reused is still on its way to the free list.
      for (const [id, rig] of rigs) {
        if (live.some((storm) => storm.id === id)) continue;
        root.remove(rig.root);
        rigs.delete(id);
        free.push(rig);
      }

      for (const storm of live) {
        // NOTHING IS DRAWN FOR A STORM WITH NO STRENGTH LEFT. A transparent
        // draw call that contributes nothing is still a transparent draw call,
        // and this is what makes a storm that is spinning up or dispersing cost
        // nothing until it is actually visible (kit/discRig.ts's rule).
        const lit = storm.intensity > 0;
        let rig = rigs.get(storm.id);
        if (rig === undefined) {
          if (!lit) continue;
          if (rigs.size >= MAX_SPIRALS) continue;
          rig = acquire();
          rigs.set(storm.id, rig);
          root.add(rig.root);
        }
        rig.root.visible = lit;
        if (!lit) continue;

        rig.root.position.set(storm.x, 0, storm.z);
        rig.column.material.opacity = CYCLONE_RAIN_PROFILE.opacity * storm.intensity;
        // THE COLUMN IS DRAWN IN THE RIG'S LOCAL SPACE, which the eye carries
        // with it, so a drop's position in there is the straight-down fall it
        // makes in the cloud's own frame and the wind only tilts the streak
        // (#300, kit/precipitation.ts's `advance`).
        rig.column.advance(elapsed, storm.radiusWorldUnits, storm.vx, storm.vz);
      }
    },

    dispose(): void {
      for (const rig of built) rig.column.dispose();
      built.length = 0;
      free.length = 0;
      rigs.clear();
      root.clear();
    },
  };
}

// THE SHIPPED LOOK: one fire drawn by TWO renderers, crossfaded by intensity.
//
// The owner asked for a fire that starts as the shader plume and becomes the
// licking ribbons (2026-08-24). Built that way first, it did not survive its own
// renders, and the reason is geometric rather than aesthetic:
//
//   A PLUME IS A COLUMN AT THE TREE'S CENTRE, AND A CROWN IS OPAQUE.
//   Its height is 1.4 x the fuel's, scaled by intensity, so below roughly
//   intensity 0.6 the whole flame is shorter than the tree it stands in and is
//   depth-culled by the crown. A catching fire rendered as nothing at all.
//
// Widening it, brightening it and floor-raising its height were each tried and
// photographed: they produce a translucent orange smear over the crown, or a
// wisp poking out of the tip. A centre column simply cannot be the LOW-intensity
// look on a tree whose widest, most opaque part is between it and the camera.
//
// So the order is INVERTED, and both looks are used where each is legible:
//
//   catching     RIBBONS. They wrap the trunk and pool on the ground OUTSIDE
//                the crown's silhouette, so a small fire is visible from the
//                first frame — which is the moment a player most needs it.
//   roaring      PLUME. Once the fire is fierce its column clears the crown and
//                towers over the tree, which is what "this wood is lost" looks
//                like and what the ribbons alone never said.
//   guttering    back to ribbons, then out.
//
// SYMMETRIC, because `intensity` is symmetric (../../protocol.ts): it climbs
// through the ignition ramp and falls through the long decay tail, so a dying
// fire sinks back to tongues around the trunk rather than holding a column up
// while it goes out.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE COST, stated plainly: TWO draw calls instead of one, for any number of
// fires. ./types.ts's budget rule is a FIXED SMALL number of calls, not one;
// two is still fixed and still independent of how much of the world is alight,
// and either sub-renderer with nothing to draw sits at instance count 0, which
// the renderer skips entirely.
// ─────────────────────────────────────────────────────────────────────────────

import { Group } from 'three';
import { buildRibbonFlames } from './ribbons.ts';
import { buildShaderPlumeFlames } from './shaderPlume.ts';
import type { FireInstance, FlameRenderer, FlameRendererBuilder } from './types.ts';

/**
 * Where the plume takes over from the ribbons.
 *
 * THE START IS DERIVED FROM THE TREE, not dialled in. A plume is
 * FLAME_HEIGHT_PER_FUEL (1.4) x the fuel's height x its own intensity scale
 * (INTENSITY_SIZE_FLOOR + the rest x intensity, i.e. 0.34…1.0), so it first
 * exceeds the height of what it is burning at intensity ~0.56 — below that it
 * is inside the crown and invisible (see the header). 0.55 is that number: the
 * plume is introduced at exactly the intensity where it starts to be a flame
 * anyone can see, and never before.
 *
 * The END, 0.85, leaves the handover a third of the range wide: long enough
 * that the column rises out of the tongues rather than replacing them between
 * two frames, and finished before the plateau where most of a fire's life is
 * spent.
 */
export const PLUME_TAKEOVER_START_INTENSITY = 0.55;
export const PLUME_TAKEOVER_END_INTENSITY = 0.85;

/**
 * Below this presence a look is not handed to its renderer at all.
 *
 * Not an optimisation — a correctness guard. A shader flame at presence 0.004
 * is invisible but still occupies an instance slot, still writes into the
 * depth-sorted transparent pass, and (at FIRE_CELL_CAP) still costs the vertex
 * work of a full plume. Dropping it below the threshold at which it could
 * possibly be seen keeps a wood full of roaring fires from also drawing a wood
 * full of invisible ones.
 */
const MINIMUM_VISIBLE_PRESENCE = 0.01;

/** Smoothstep. Eases both ends of the handover, so neither look pops in. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much of the PLUME look this fire wants, 0…1; the ribbons get the rest.
 */
export function plumeShareOf(intensity: number): number {
  return smoothstep(PLUME_TAKEOVER_START_INTENSITY, PLUME_TAKEOVER_END_INTENSITY, intensity);
}

/**
 * Share → the presence that share is drawn at: an EQUAL-POWER crossfade.
 *
 * Not the share itself, and the renders are why (2026-08-24). Two looks at 0.5
 * opacity do not read as one fire half-way between them — they read as two
 * ghosts, because each is individually washed out and the pair together is
 * dimmer than either alone. It is the same reason an audio crossfade uses
 * √ rather than a straight line: what should hold constant through the handover
 * is the ENERGY, and energy goes as the square.
 *
 * √0.5 ≈ 0.71, so at the midpoint each look is drawn at nearly three quarters
 * strength and the fire stays a fire the whole way across.
 */
function presenceForShare(share: number): number {
  return Math.sqrt(share);
}

/**
 * A FireInstance this module may write into.
 *
 * The compositor hands each sub-renderer the same fires with a different
 * `presence`, and it does that EVERY FRAME for up to FIRE_CELL_CAP fires. Built
 * by spreading (`{...fire, presence}`) that would be 800 short-lived objects a
 * frame — precisely the churn ./types.ts's allocation-free rule exists to
 * forbid. So each side keeps a pool of mutable instances that is grown once and
 * then written in place forever.
 */
type MutableFireInstance = { -readonly [K in keyof FireInstance]: FireInstance[K] };

/** Grows `pool` to at least `size` entries. Allocates only when the fire grows. */
function ensurePool(pool: MutableFireInstance[], size: number): void {
  while (pool.length < size) {
    pool.push({ x: 0, z: 0, groundY: 0, fuelHeight: 0, intensity: 0, ageSeconds: 0, presence: 1, seed: 0 });
  }
}

/** Copies one fire into a pooled slot, with the presence this side is owed. */
function writeSlot(slot: MutableFireInstance, fire: FireInstance, presence: number): void {
  slot.x = fire.x;
  slot.z = fire.z;
  slot.groundY = fire.groundY;
  slot.fuelHeight = fire.fuelHeight;
  slot.intensity = fire.intensity;
  slot.ageSeconds = fire.ageSeconds;
  slot.seed = fire.seed;
  slot.presence = presence;
}

export const buildRibbonsToPlumeFlames: FlameRendererBuilder = () => {
  const plume = buildShaderPlumeFlames();
  const ribbons = buildRibbonFlames();

  const root = new Group();
  root.name = 'fire:flames';
  // RIBBONS FIRST, PLUME OVER THEM. Both are transparent passes, so this
  // decides which one wins where they overlap mid-handover; the plume is the
  // look being handed TO, and it is the one that has to be seen rising.
  root.add(ribbons.root);
  root.add(plume.root);

  const plumePool: MutableFireInstance[] = [];
  const ribbonPool: MutableFireInstance[] = [];
  /** The slices actually handed over — sub-arrays of the pools, reused. */
  const plumeList: FireInstance[] = [];
  const ribbonList: FireInstance[] = [];

  return {
    name: 'ribbons → plume',
    root,

    /**
     * ./types.ts's drawn-set contract. A fire can be in one sub-renderer, the
     * other, or both during the handover, so this is the SUM: it answers "is
     * anything of mine on screen", which is what the contract is for, and never
     * claims empty while either look still has instances.
     */
    get drawnCount(): number {
      return plume.drawnCount + ribbons.drawnCount;
    },

    apply(fires: readonly FireInstance[]): void {
      ensurePool(plumePool, fires.length);
      ensurePool(ribbonPool, fires.length);
      plumeList.length = 0;
      ribbonList.length = 0;

      for (const fire of fires) {
        const plumeShare = plumeShareOf(fire.intensity);
        const plumePresence = presenceForShare(plumeShare);
        const ribbonPresence = presenceForShare(1 - plumeShare);

        if (plumePresence >= MINIMUM_VISIBLE_PRESENCE) {
          const slot = plumePool[plumeList.length]!;
          writeSlot(slot, fire, plumePresence);
          plumeList.push(slot);
        }
        if (ribbonPresence >= MINIMUM_VISIBLE_PRESENCE) {
          const slot = ribbonPool[ribbonList.length]!;
          writeSlot(slot, fire, ribbonPresence);
          ribbonList.push(slot);
        }
      }

      plume.apply(plumeList);
      ribbons.apply(ribbonList);
    },

    update(dt: number, elapsed: number): void {
      // BOTH, unconditionally. A sub-renderer with nothing applied is a no-op by
      // its own contract, and skipping the update of a look that is currently
      // empty would freeze its animation clock — so the first fire to re-enter
      // that band would open mid-gesture, on a phase minutes stale.
      plume.update(dt, elapsed);
      ribbons.update(dt, elapsed);
    },

    dispose(): void {
      plume.dispose();
      ribbons.dispose();
      root.clear();
      plumePool.length = 0;
      ribbonPool.length = 0;
      plumeList.length = 0;
      ribbonList.length = 0;
    },
  };
};

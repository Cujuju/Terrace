// The rain, built: a falling column of streaks inside a bank of haze.
//
// CLIENT-SIDE PRESENTATION. Nothing here is on the wire and nothing here is
// authoritative — every drop is invented locally out of the four numbers a system
// carries (centre, radius, intensity, wind) plus the frame clock. Two players
// standing in the same front see the same front and different drops.
//
// The MECHANISM is core's client kit: the column, the haze bank, the pool and the
// rig that holds them (client/src/plugins/kit/discRig.ts). What is here is the
// one thing that is actually about rain — its profile.

import type { BufferGeometry } from 'three';
import {
  buildHazeGeometry,
  PRECIPITATION_HAZE_SCALE,
} from '../../../client/src/plugins/kit/hazeBank.ts';
import {
  createDiscRig,
  createRigPool,
  DISC_RENDER_ORDER,
  type DiscRig,
  type RigPool,
} from '../../../client/src/plugins/kit/discRig.ts';
import {
  createCumulusDeck,
  CUMULUS_DECK_DRAW_OBJECTS,
  puffsForCoverage,
  type CumulusDeck,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import type { PrecipitationProfile } from '../../../client/src/plugins/kit/precipitation.ts';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import { MAX_ACTIVE_SYSTEMS, RAIN_PLUGIN_NAME } from '../protocol.ts';

/**
 * Particles in one rain rig.
 *
 * 900 over a system's disc, which is 1 800 cells² at the minimum radius and
 * 9 800 at the maximum — so between one drop per two cells and one per eleven,
 * spread through a 28-unit column. That is not a physical density (real rain
 * would be millions); it is the density at which the eye reads "it is raining"
 * from the camera's 80-cell orbit, where a single drop is a sub-pixel streak and
 * what registers is the texture of the whole column.
 *
 * The cost is one draw call and, per frame, 900 iterations writing 5 400 floats
 * into a buffer that is allocated once.
 */
export const RAIN_DROP_COUNT = 900;

/**
 * How rain falls and looks.
 *
 * Pale grey-blue, and translucent: a drop is a highlight on falling water, not a
 * solid object. The fall speed puts a drop through the whole column in 1.1 s,
 * which at 60 fps is a 0.43-unit step per frame — half a streak length, so
 * consecutive frames overlap and the column reads as continuous rather than as a
 * dotted line. It does not sway: a streak that swayed would smear.
 */
export const RAIN_PROFILE: PrecipitationProfile = {
  form: 'streak',
  count: RAIN_DROP_COUNT,
  fallSpeed: 26,
  streakLength: 0.9,
  spriteSize: 0,
  opacity: 0.42,
  color: 0xa8c4d8,
  swayCells: 0,
  swayHz: 0,
};

/**
 * Draw objects one rain rig costs: FIVE — the column, plus the four haze sheets
 * (client/src/plugins/kit/hazeBank.ts, HAZE_LAYERS). The DECK is not among
 * them: it is one instanced draw for every mass at once, counted separately by
 * CUMULUS_DECK_DRAW_OBJECTS.
 */
export const RAIN_RIG_DRAW_OBJECTS = 5;

/**
 * A rain puff's half-width, as a fraction of the mass's radius.
 *
 * 0.12 — about an eighth of the front across. Rain cloud is a broad even
 * overcast rather than a few towering heads, so its puffs are small enough that
 * the deck's texture reads at the camera's 80-cell orbit and no single puff
 * spans the eye's whole disc. The COUNT follows from it and is not a second
 * decision (`puffsForCoverage`): 139 puffs today.
 */
export const RAIN_PUFF_SIZE_FRACTION = 0.12;

/** Puffs in one rain mass's deck — derived from the size, never chosen. */
export const RAIN_PUFFS_PER_MASS = puffsForCoverage(RAIN_PUFF_SIZE_FRACTION);

/**
 * The rain cloud's own colour, before any of the scene's light reaches it.
 *
 * A neutral mid grey, a shade cooler than white. It is a DIFFUSE colour and not
 * a finished pixel — the deck is Lambert-lit, so the sun, the gloom of a
 * cyclone overhead and a thunderstorm's flash all still act on it. Authoring it
 * near-white would leave nothing for the shading to take away.
 */
export const RAIN_DECK_COLOR = 0xb6bcc4;

/**
 * How much of the light a rain deck takes off the ground under it, at full
 * intensity — `ClientPluginCtx.publishGroundShade`.
 *
 * A quarter. Rain cloud is thick enough to be plainly a shadow and thin enough
 * that the terrain under it stays legible; the shade is multiplied by the
 * mass's own interpolated intensity, so a gathering front darkens the ground
 * as it arrives rather than switching it off.
 */
export const RAIN_SHADE_DARKNESS = 0.25;

/** The pool, its shared geometry, and the plugin's one cloud deck. */
export interface RainRigs extends RigPool<DiscRig> {
  /** One instanced draw for every mass's cloud; parented at attach. */
  readonly deck: CumulusDeck;
  dispose(): void;
}

export function createRainRigs(ctx: ClientPluginCtx): RainRigs {
  // ONE OWNER: the sheet geometry is built once here and freed once here;
  // freeing it inside a rig would tear the resource out from under every other.
  const hazeGeometry: BufferGeometry = buildHazeGeometry();

  const deck = createCumulusDeck({
    // The deck's capacity is an expression of this plugin's OWN cap, exactly
    // as its draw budget is — never a number picked to be big enough.
    maxMasses: MAX_ACTIVE_SYSTEMS,
    puffSizeFraction: RAIN_PUFF_SIZE_FRACTION,
    color: RAIN_DECK_COLOR,
    name: `${RAIN_PLUGIN_NAME}:deck`,
    renderOrder: DISC_RENDER_ORDER,
    applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
  });

  const pool = createRigPool<DiscRig>(
    () =>
      createDiscRig({
        hazeGeometry,
        // A third of a full bank: precipitation without any haze under it reads as
        // lines in a vacuum, and real rain greys the air it falls through.
        hazeStrength: PRECIPITATION_HAZE_SCALE,
        profile: RAIN_PROFILE,
        name: `${RAIN_PLUGIN_NAME}:system`,
        deck,
        applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
      }),
    // A RIG LEAVES THE SCENE WITHOUT A LAST FRAME. The deck is drawn from
    // uniforms rather than from the rig's root, so unparenting the root does
    // not take the cloud with it — parking the slot is what does.
    (rig) => rig.park(),
  );

  return {
    deck,
    acquire: pool.acquire,
    release: pool.release,
    dispose(): void {
      pool.dispose();
      deck.dispose();
      hazeGeometry.dispose();
    },
  };
}

/** Draw objects the whole plugin costs beyond its rigs: the deck. */
export const RAIN_DECK_DRAW_OBJECTS = CUMULUS_DECK_DRAW_OBJECTS;

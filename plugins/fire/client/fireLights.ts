// The light a fire casts on the ground around it.
//
// ─────────────────────────────────────────────────────────────────────────────
// A FIXED POOL, NEVER A LIGHT PER FIRE.
//
// Adding or removing a light invalidates every material's shader program — the
// light count is baked into the program key — so a light per fire would
// recompile the terrain, the water and every creature each time a tree caught.
// That is the same fact plugins/weather/client/rig.ts learned for its storm
// flash, and the reason its light is created with the rig and left in the graph
// at zero intensity between flashes.
//
// Here it is worse than it is for weather, because fires arrive in dozens. So
// the pool is built ONCE at attach, sized at FIRE_LIGHT_POOL_SIZE, and stays in
// the scene graph forever — the lights move between fires and drop to zero
// intensity when there is nothing to light.
//
// WHICH FIRES GET ONE. The fiercest, and that is deliberately not "the nearest":
// ClientPluginCtx exposes no camera (client/src/plugins/types.ts), and the
// fiercest fires are the ones whose glow is worth having anyway. A pool chosen
// by intensity is also STABLE — a fire does not gain and lose its light as the
// player orbits, which a distance-ranked pool would do at every tie.
// ─────────────────────────────────────────────────────────────────────────────

import { Group, PointLight } from 'three';
import type { FireInstance } from './flames/types.ts';

/**
 * How many fires may cast light at once.
 *
 * FOUR. The renderer's other claimant on the light budget is weather's storm
 * flash (one PointLight per live storm, up to MAX_ACTIVE_SYSTEMS = 3), and the
 * scene's own rig is three more; four here keeps the worst case to a single
 * digit, which is the range where WebGL's forward renderer stays cheap. It is
 * also enough that a fire FRONT reads as a band of light rather than as one
 * bright dot, which is the whole point of having more than one.
 */
export const FIRE_LIGHT_POOL_SIZE = 4;

/**
 * How far a fire's light reaches, in world units.
 *
 * A tree is ~1.5 units tall, so 6 lights the tree, its neighbours and the
 * ground between them without washing across a whole terrace. Past this
 * distance the flame still glows — it is unlit geometry — but the ground stops
 * knowing about it, which is the correct place for a cheap approximation to
 * end.
 */
export const FIRE_LIGHT_RANGE_WORLD_UNITS = 6;

/** Peak intensity of one fire light, at intensity 1. Matched to a fire's scale. */
export const FIRE_LIGHT_PEAK_INTENSITY = 2.5;

/** Height above the ground the light sits at — inside the flame, not under it. */
export const FIRE_LIGHT_HEIGHT_FRACTION_OF_FUEL = 0.5;

/** Warm ember orange. Never white: firelight that is not warm reads as a lamp. */
export const FIRE_LIGHT_COLOR = 0xff7a33;

/**
 * Seconds between re-choosing which fires hold the lights.
 *
 * NOT every frame. Re-ranking 400 fires 60 times a second is real work to
 * produce an answer that changes on the scale of a fire's whole life, and a
 * light that hops between two nearly-equal fires every frame flickers in a way
 * no fire does. A quarter second is below the threshold at which the handover
 * is noticeable and 15× cheaper than doing it per frame.
 */
export const FIRE_LIGHT_REASSIGN_SECONDS = 0.25;

export interface FireLights {
  /** Parent of the pool; add to the plugin's layer. */
  readonly root: Group;
  /**
   * Points the pool at the fiercest of these fires. Cheap to call every frame:
   * the RANKING only re-runs on FIRE_LIGHT_REASSIGN_SECONDS, while the
   * brightness of whatever is already held follows every frame.
   */
  update(fires: readonly FireInstance[], dt: number): void;
  /** Drops every light to dark. Called when nothing is burning. */
  darken(): void;
}

export function createFireLights(): FireLights {
  const root = new Group();
  root.name = 'fire:lights';

  const lights: PointLight[] = [];
  for (let index = 0; index < FIRE_LIGHT_POOL_SIZE; index++) {
    const light = new PointLight(FIRE_LIGHT_COLOR, 0, FIRE_LIGHT_RANGE_WORLD_UNITS);
    light.visible = true;
    lights.push(light);
    root.add(light);
  }

  /** The fires currently holding a light, by pool slot. Re-chosen on the cadence. */
  let held: (FireInstance | null)[] = new Array(FIRE_LIGHT_POOL_SIZE).fill(null);
  let sinceReassignSeconds = FIRE_LIGHT_REASSIGN_SECONDS;

  /** Scratch, reused: ranking must not allocate a new array every frame. */
  const ranked: FireInstance[] = [];

  function reassign(fires: readonly FireInstance[]): void {
    ranked.length = 0;
    for (const fire of fires) ranked.push(fire);
    ranked.sort((a, b) => b.intensity - a.intensity);
    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
      held[slot] = ranked[slot] ?? null;
    }
  }

  return {
    root,

    update(fires: readonly FireInstance[], dt: number): void {
      sinceReassignSeconds += dt;
      if (sinceReassignSeconds >= FIRE_LIGHT_REASSIGN_SECONDS) {
        sinceReassignSeconds = 0;
        reassign(fires);
      }

      for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
        const light = lights[slot]!;
        const fire = held[slot];
        if (fire === undefined || fire === null) {
          light.intensity = 0;
          continue;
        }
        light.position.set(
          fire.x,
          fire.groundY + fire.fuelHeight * FIRE_LIGHT_HEIGHT_FRACTION_OF_FUEL,
          fire.z,
        );
        light.intensity = fire.intensity * FIRE_LIGHT_PEAK_INTENSITY;
      }
    },

    darken(): void {
      held = new Array(FIRE_LIGHT_POOL_SIZE).fill(null);
      for (const light of lights) light.intensity = 0;
    },
  };
}

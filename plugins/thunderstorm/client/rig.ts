// The thunderstorm, built: heavier rain than rain, and the bolts that come out
// of it.
//
// CLIENT-SIDE PRESENTATION. Nothing here is on the wire and nothing here is
// authoritative — every drop and every bolt silhouette is invented locally out
// of the numbers a system carries plus the frame clock. WHERE a bolt lands is
// the server's (../server/lightning.ts) and arrives as an event.
//
// Rules this file keeps:
//
//   * NOT scene.fog, NOT the lighting rig, NOT the sky. The one exception is a
//     flash's PointLight, which is a light in the scene by necessity, is bounded
//     by FLASH_LIGHT_RANGE_CELLS — and which is PARKED, never added or removed:
//     the pool owns a fixed bank of them so the scene's light count never
//     changes. ADDING OR REMOVING A LIGHT INVALIDATES EVERY MATERIAL'S SHADER
//     PROGRAM (the count is baked into the program key), so three would
//     recompile the terrain, the water and every creature.
//   * PHOTOSENSITIVITY IS A HARD REQUIREMENT, not a setting. Under
//     prefers-reduced-motion there are no flashes at all and the whole sky holds
//     still; outside it, the client-wide LightningGovernor and the single-rise
//     envelope in ./lightning.ts bound the stimulus.
//   * NO PER-FRAME ALLOCATIONS.
//   * ONE OWNER. Everything a rig creates is reachable from it and freed by its
//     dispose(); everything SHARED between rigs is owned by the pool and freed
//     exactly once, by the pool.
//
// The body of a storm — the falling column and the haze bank — is core's client
// kit (client/src/plugins/kit/discRig.ts), the same one rain and snow use. What
// is here is the profile, and everything electrical.

import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  type Material,
} from 'three';
import {
  buildHazeGeometry,
  HAZE_LAYERS,
  PRECIPITATION_HAZE_SCALE,
} from '../../../client/src/plugins/kit/hazeBank.ts';
import {
  createDiscRig,
  createRigPool,
  DISC_RENDER_ORDER,
  type DiscRig,
} from '../../../client/src/plugins/kit/discRig.ts';
import {
  createCumulusDeck,
  CUMULUS_DECK_DRAW_OBJECTS,
  puffsForCoverage,
  type CumulusDeck,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import type { PrecipitationProfile } from '../../../client/src/plugins/kit/precipitation.ts';
import type { InterpolatedDisc } from '../../../client/src/plugins/kit/discInterpolator.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { MAX_ACTIVE_SYSTEMS, THUNDERSTORM_PLUGIN_NAME } from '../protocol.ts';
import {
  BOLT_BOTTOM_WORLD_Y,
  BOLT_JAG_WORLD_UNITS,
  BOLT_TIP_WIDTH_FRACTION,
  BOLT_TOP_WORLD_Y,
  BOLT_WIDTH_WORLD_UNITS,
  FLASH_COLOR,
  FLASH_GLOW_OPACITY,
  FLASH_LIGHT_PEAK_INTENSITY,
  FLASH_LIGHT_RANGE_CELLS,
  LightningSchedule,
  type LightningGovernor,
} from './lightning.ts';

/**
 * Particles in one thunderstorm rig — half again as many as ordinary rain's 900,
 * and darker: the rain of a storm, before any lightning has told you it is one.
 * The drop count is the one number a storm does not share with rain, which is
 * why this is a profile of its own rather than a `heavier: boolean`.
 */
export const THUNDERSTORM_DROP_COUNT = 1350;

/** How a thunderstorm's rain falls and looks. Rain, harder. */
export const THUNDERSTORM_PROFILE: PrecipitationProfile = {
  form: 'streak',
  count: THUNDERSTORM_DROP_COUNT,
  fallSpeed: 30,
  streakLength: 1.1,
  spriteSize: 0,
  opacity: 0.55,
  color: 0x8fa8bd,
  swayCells: 0,
  swayHz: 0,
  // A FULL DISC: the rain falls out of the whole cloud, which has no hole in it.
  innerRadiusFraction: 0,
};

/**
 * A thunderstorm puff's half-width, as a fraction of the mass's radius.
 *
 * 0.12 — the same as rain's, and deliberately so: what makes a thunderhead read
 * as one is that it is DARK and that it lights itself, not that its puffs are a
 * different size. The COUNT follows from it (`puffsForCoverage`): 139 puffs.
 */
export const THUNDERSTORM_PUFF_SIZE_FRACTION = 0.12;

/** Puffs in one storm's deck — derived from the size, never chosen. */
export const THUNDERSTORM_PUFFS_PER_MASS = puffsForCoverage(THUNDERSTORM_PUFF_SIZE_FRACTION);

/**
 * The thunderhead's own colour, before any of the scene's light reaches it.
 *
 * A DARK SLATE, and much darker than rain's grey: this is the one deck in the
 * set whose whole picture is a black cloud with light inside it. Because the
 * material is Lambert-lit, that flash reaches it for free — the storm's own
 * PointLight (STORM_FLASH_LIGHT_BANK_SIZE above) now lights the cloud it comes
 * out of, which is the reason the decks are lit rather than shaded by a
 * hand-fed daylight number.
 */
export const THUNDERSTORM_DECK_COLOR = 0x51565f;

/**
 * How much of the light a thunderhead takes off the ground under it, at full
 * intensity.
 *
 * 0.45 — nearly half, and by far the deepest of the three. A thunderstorm is
 * the kind a player is meant to see coming across the map, and the shadow is
 * the first thing that arrives. It stops well short of the cyclone's global
 * gloom, which darkens the whole world rather than a disc of it.
 */
export const THUNDERSTORM_SHADE_DARKNESS = 0.45;

/**
 * How many storm flash lights exist IN THE SCENE, for the plugin's whole life.
 *
 * WHY A FIXED BANK (2026-08-28). three bakes the point-light COUNT into every
 * material's program key, so adding or removing one light recompiles the
 * terrain, the water and every creature. Storm rigs used to carry their own
 * light in and out of the scene as storms came and went; that was a fresh light
 * count — and a compile burst — roughly every half minute, measured at 41 → 82
 * programs in 150 s. The bank is created once, at zero intensity, and never
 * changes size, so the count is constant from the first frame.
 *
 * ONE PER STORM THE CAP ALLOWS. The pre-split plugin sized this at 4 against a
 * ceiling of 14 systems of every kind, so a fifth concurrent storm drew its bolt
 * and glow without lighting the ground. With thunderstorms capped at
 * MAX_ACTIVE_SYSTEMS = 3 of their own, one light each is both fewer lights in
 * the scene than before and no storm left unlit.
 */
export const STORM_FLASH_LIGHT_BANK_SIZE = MAX_ACTIVE_SYSTEMS;

/**
 * Kinks in a bolt, and the phase each kink advances by.
 *
 * Nine kinks over a 22-unit fall is a jag every 2.4 units: fewer reads as a bent
 * stick, many more reads as a fuzzy line at any real camera distance. The phase
 * step is deliberately not a rational fraction of 2π, so the kinks do not fall
 * into a repeating zigzag.
 */
const BOLT_SEGMENTS = 9;
const BOLT_JAG_TURN_RADIANS = 2.4;

/**
 * The bolt: two ribbons crossed at a right angle, following the same jagged
 * descent from the cloud base down into the haze.
 *
 * CROSSED, because one flat ribbon disappears when the camera comes round to its
 * edge — and the camera here is a free orbit, so that is not an edge case, it is
 * a quarter of all views. Two of them at 90° means one is always presenting a
 * face. Cheaper and steadier than billboarding, which would have to re-orient
 * the strip every frame against a camera this plugin has no access to (the
 * ClientPluginCtx contract does not expose one, deliberately).
 *
 * Authored once in its own space and shared by every storm on the client; a
 * strike is placed by moving the pivot it hangs off, never by rebuilding it.
 */
function buildBoltGeometry(): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const span = BOLT_TOP_WORLD_Y - BOLT_BOTTOM_WORLD_Y;

  /** Emits one ribbon; `sideways` is which horizontal axis it spreads along. */
  function ribbon(sideways: 'x' | 'z'): void {
    const first = positions.length / 3;
    for (let step = 0; step <= BOLT_SEGMENTS; step++) {
      const along = step / BOLT_SEGMENTS;
      const y = BOLT_TOP_WORLD_Y - along * span;
      const jag = BOLT_JAG_WORLD_UNITS * Math.sin(step * BOLT_JAG_TURN_RADIANS);
      const halfWidth =
        (BOLT_WIDTH_WORLD_UNITS * (1 - (1 - BOLT_TIP_WIDTH_FRACTION) * along)) / 2;
      for (const edge of [-1, 1]) {
        const offset = jag + edge * halfWidth;
        positions.push(sideways === 'x' ? offset : 0, y, sideways === 'z' ? offset : 0);
      }
    }
    for (let step = 0; step < BOLT_SEGMENTS; step++) {
      const corner = first + step * 2;
      indices.push(corner, corner + 1, corner + 3);
      indices.push(corner, corner + 3, corner + 2);
    }
  }

  ribbon('x');
  ribbon('z');

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** One storm's weather, in the scene: the body, plus everything electrical. */
export interface ThunderstormRig {
  /** Put at the system's centre on the X/Z plane; never rotated. */
  readonly root: Group;
  /**
   * One frame. `elapsed` is the plugin's animation clock — which STOPS ADVANCING
   * under prefers-reduced-motion, so every drop, sheet and sway becalms from that
   * one fact — and `dt` drives only the lightning clock.
   */
  update(disc: InterpolatedDisc, elapsed: number, dt: number, reduced: boolean): void;
  /**
   * A bolt landed at this world-space offset from the system's own centre.
   * Moves the bolt and its light there and begins the flash — unless the
   * governor refuses, in which case NOTHING moves: a refused flash must not
   * leave a dark bolt sitting at the new position, waiting to be lit by the
   * next one.
   */
  strike(offsetX: number, offsetZ: number, governor: LightningGovernor): void;
  /**
   * Forgets any in-progress flash. Called by the pool before a rig re-enters the
   * free list, so a rig reused by a later storm never opens with a stale flash
   * that the LightningGovernor never approved.
   */
  reset(): void;
  dispose(): void;
}

function createThunderstormRig(
  hazeGeometry: BufferGeometry,
  boltGeometry: BufferGeometry,
  lentLight: PointLight | null,
  deck: CumulusDeck,
  applyRevealClip: (material: Material, label: string) => void,
): ThunderstormRig {
  const body: DiscRig = createDiscRig({
    hazeGeometry,
    hazeStrength: PRECIPITATION_HAZE_SCALE,
    profile: THUNDERSTORM_PROFILE,
    name: `${THUNDERSTORM_PLUGIN_NAME}:system`,
    deck,
    applyRevealClip,
  });
  const root = body.root;

  const lightning = new LightningSchedule();

  /**
   * The flash's effect on the weather itself. The haze sheets are unlit, so the
   * point light below cannot reach them; this additive sheet through the middle
   * of the bank is what makes the haze light up from inside instead of sitting
   * dead while the terrain around it flares.
   */
  const glowMaterial = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    vertexColors: true,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const glowSheet = new Mesh(hazeGeometry, glowMaterial);
  glowSheet.renderOrder = DISC_RENDER_ORDER;
  glowSheet.visible = false;
  root.add(glowSheet);

  const boltMaterial = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    // The bolt is light, not a surface: it adds to whatever is behind it.
    blending: AdditiveBlending,
    depthWrite: false,
  });
  /**
   * The bolt hangs off its own pivot so a strike is placed by moving ONE node —
   * and so its jag is authored once, in its own space, instead of being rebuilt
   * per strike.
   */
  // THE ELECTRICAL PARTS ARE CLIPPED TOO, and they are this rig's own
  // materials rather than the body's — `createDiscRig` above clipped the column
  // and the haze it built, and knows nothing about a bolt. A bolt over floor
  // this client was never sent is exactly the geometry #284 is about; the flash
  // POINT LIGHT is not geometry and cannot be clipped, which is stated in
  // ./lightning.ts.
  applyRevealClip(glowMaterial, `${THUNDERSTORM_PLUGIN_NAME} glow`);
  applyRevealClip(boltMaterial, `${THUNDERSTORM_PLUGIN_NAME} bolt`);

  const boltPivot = new Group();
  const bolt = new Mesh(boltGeometry, boltMaterial);
  bolt.visible = false;
  bolt.renderOrder = DISC_RENDER_ORDER;
  boltPivot.add(bolt);
  root.add(boltPivot);

  // BORROWED FROM THE POOL'S BANK, NOT CREATED, and NOT a child of `root`: the
  // rig's root leaves the scene when its system dissipates, and a light that
  // left with it would change the scene's light count. The bank light stays in
  // the scene at zero intensity forever; this rig only moves it and brightens
  // it. It is therefore positioned in WORLD space, and null when the bank is
  // exhausted — such a storm still draws its bolt and glow, it just does not
  // light the ground.
  const flashLight = lentLight;
  let strikeOffsetX = 0;
  let strikeOffsetZ = 0;

  return {
    root,

    update(disc, elapsed, dt, reduced): void {
      const lit = body.update(disc, elapsed);
      if (!lit) return;

      const worldRadius = disc.radius * CELL_WORLD_SIZE;

      // THE LIGHTNING. This frame only DECAYS the flash envelope — where and
      // when a bolt lands is the server's call and arrives through `strike`.
      // Reduced motion needs to disarm nothing here: the caller does not deliver
      // strikes at all under it, and the brightness is forced to zero on the
      // spot below, so a preference turned on mid-flash takes effect on the next
      // frame rather than after the tail.
      lightning.advance(dt);

      // Intensity multiplies the flash as well, so a storm dissipating mid-flash
      // takes its lightning down with it instead of leaving a bolt over ground
      // that has cleared.
      const brightness = reduced ? 0 : lightning.brightness() * disc.intensity;
      const flashing = brightness > 0;
      bolt.visible = flashing;
      glowSheet.visible = flashing;
      if (flashing) {
        boltMaterial.opacity = brightness;
        glowMaterial.opacity = brightness * FLASH_GLOW_OPACITY;
        // The glow rides the widest sheet, so the whole bank lights rather than
        // a disc in its middle.
        glowSheet.scale.setScalar(worldRadius * HAZE_LAYERS[0]!.radiusScale);
        glowSheet.position.y = HAZE_LAYERS[0]!.height;
      }
      if (flashLight !== null) {
        flashLight.intensity = brightness * FLASH_LIGHT_PEAK_INTENSITY;
        flashLight.position.set(
          root.position.x + strikeOffsetX,
          BOLT_BOTTOM_WORLD_Y,
          root.position.z + strikeOffsetZ,
        );
      }
    },

    strike(offsetX: number, offsetZ: number, governor: LightningGovernor): void {
      // The governor first, and the move only if it says yes — see the
      // interface's doc comment for why a refused flash must not reposition the
      // bolt.
      if (!lightning.strike(governor)) return;

      boltPivot.position.set(offsetX, 0, offsetZ);
      // The jag is authored once in its own space; spinning the pivot is what
      // stops every bolt in a session from being the same silhouette. Derived
      // from the strike's own offset rather than drawn at random, so the same
      // strike looks the same on every client that draws it.
      boltPivot.rotation.y = Math.atan2(offsetZ, offsetX);
      strikeOffsetX = offsetX;
      strikeOffsetZ = offsetZ;
    },

    reset(): void {
      lightning.reset();
      // The rig is going back to the pool, so its slot in the plugin's deck
      // must be put out with it — the deck is drawn from uniforms, not from
      // this rig's root, so unparenting the root leaves the cloud in the sky.
      body.park();
      // The light stays in the scene after this rig's root has left it, so a rig
      // released mid-flash must put its light out itself — nothing else will
      // update it until a later storm acquires this rig.
      if (flashLight !== null) flashLight.intensity = 0;
    },

    dispose(): void {
      body.dispose();
      glowMaterial.dispose();
      boltMaterial.dispose();
      // The haze and bolt GEOMETRIES are the pool's, shared by every rig.
      // PointLight owns no GPU resource and has no dispose(); dropping it out of
      // the graph is its whole teardown.
    },
  };
}

// ── The dry bolt ─────────────────────────────────────────────────────────────

/**
 * ONE bolt that belongs to no system — the client half of dry lightning
 * (../server/lightning.ts; owner, 2026-08-24: "randomly fire even without a
 * storm").
 *
 * A storm's bolt is a child of its rig, placed as an OFFSET from the system's
 * centre, so it moves with the front and dies with it. A dry bolt has no front:
 * it is placed at a world position and is gone in a fraction of a second. That
 * is why it cannot be a storm rig with the rain turned off — a rig is anchored
 * to a system that, here, does not exist.
 *
 * ONE, not a pool: two dry bolts inside FLASH_DURATION_SECONDS of each other
 * cannot happen, because the governor's photosensitivity floor is longer than a
 * flash and refuses the second. A second instance could never be lit.
 */
export interface DryBoltRig {
  /** Add to the plugin's layer. Positioned in world space, never re-parented. */
  readonly root: Group;
  /**
   * A bolt just landed at this world position. Begins the flash unless the
   * governor refuses, in which case NOTHING moves.
   */
  strike(worldX: number, worldZ: number, governor: LightningGovernor): void;
  /** One frame: decays the flash. `reduced` forces it dark on the spot. */
  update(dt: number, reduced: boolean): void;
  dispose(): void;
}

export function createDryBoltRig(
  boltGeometry: BufferGeometry,
  applyRevealClip: (material: Material, label: string) => void,
): DryBoltRig {
  const root = new Group();
  root.name = `${THUNDERSTORM_PLUGIN_NAME}:dry-bolt`;

  const material = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  applyRevealClip(material, `${THUNDERSTORM_PLUGIN_NAME} dry bolt`);

  const bolt = new Mesh(boltGeometry, material);
  bolt.visible = false;
  bolt.renderOrder = DISC_RENDER_ORDER;

  const pivot = new Group();
  pivot.add(bolt);
  root.add(pivot);

  // Created once and left in the graph at zero intensity, NEVER added and
  // removed per flash: the light count is baked into every material's shader
  // program key.
  const light = new PointLight(FLASH_COLOR, 0, FLASH_LIGHT_RANGE_CELLS);
  light.position.y = BOLT_BOTTOM_WORLD_Y;
  root.add(light);

  const schedule = new LightningSchedule();

  return {
    root,

    strike(worldX: number, worldZ: number, governor: LightningGovernor): void {
      if (!schedule.strike(governor)) return;
      pivot.position.set(worldX, 0, worldZ);
      // Yaw from the strike's own coordinates rather than at random, so the same
      // bolt has the same silhouette on every client that draws it.
      pivot.rotation.y = Math.atan2(worldZ, worldX);
      light.position.set(worldX, BOLT_BOTTOM_WORLD_Y, worldZ);
    },

    update(dt: number, reduced: boolean): void {
      schedule.advance(dt);
      const brightness = reduced ? 0 : schedule.brightness();
      const flashing = brightness > 0;
      bolt.visible = flashing;
      if (flashing) material.opacity = brightness;
      light.intensity = brightness * FLASH_LIGHT_PEAK_INTENSITY;
    },

    dispose(): void {
      root.clear();
      material.dispose();
      // The bolt GEOMETRY is the pool's; PointLight owns no GPU resource.
    },
  };
}

// ── The pool ─────────────────────────────────────────────────────────────────

export interface ThunderstormRigs {
  /**
   * Every storm flash light there will ever be, parked at zero intensity. Added
   * to the plugin's layer ONCE at attach and never touched again, so the scene's
   * point-light count is constant for the plugin's life.
   */
  readonly lightBank: Group;
  /** One instanced draw for every storm's cloud; parented at attach. */
  readonly deck: CumulusDeck;
  /** The world's single dry bolt — lightning that belongs to no system. */
  readonly dryBolt: DryBoltRig;
  acquire(): ThunderstormRig;
  release(rig: ThunderstormRig): void;
  dispose(): void;
}

export function createThunderstormRigs(ctx: ClientPluginCtx): ThunderstormRigs {
  const hazeGeometry = buildHazeGeometry();
  const boltGeometry = buildBoltGeometry();
  const clip = (material: Material, label: string): void => {
    ctx.applyRevealClip(material, label);
  };
  const dryBolt = createDryBoltRig(boltGeometry, clip);

  const deck = createCumulusDeck({
    maxMasses: MAX_ACTIVE_SYSTEMS,
    puffSizeFraction: THUNDERSTORM_PUFF_SIZE_FRACTION,
    color: THUNDERSTORM_DECK_COLOR,
    name: `${THUNDERSTORM_PLUGIN_NAME}:deck`,
    applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
  });

  const lightBank = new Group();
  lightBank.name = `${THUNDERSTORM_PLUGIN_NAME}:flash-lights`;
  // Every light exists from the start, dark. A rig, once created, keeps its lent
  // light for the rig's whole (pooled) life, so the lights are handed out in
  // creation order and the Nth rig beyond the bank gets none.
  const unlent: PointLight[] = [];
  for (let index = 0; index < STORM_FLASH_LIGHT_BANK_SIZE; index++) {
    const light = new PointLight(FLASH_COLOR, 0, FLASH_LIGHT_RANGE_CELLS);
    light.position.y = BOLT_BOTTOM_WORLD_Y;
    lightBank.add(light);
    unlent.push(light);
  }

  const pool = createRigPool<ThunderstormRig>(
    () =>
      createThunderstormRig(hazeGeometry, boltGeometry, unlent.pop() ?? null, deck, clip),
    // A rig re-enters the pool dark: without this, a rig freed mid-flash would
    // hand its stale LightningSchedule state to whatever system acquires it
    // next, lighting an ungoverned phantom flash at the OLD storm's bolt
    // position on the very first frame.
    (rig) => rig.reset(),
  );

  return {
    lightBank,
    deck,
    dryBolt,
    acquire: pool.acquire,
    release: pool.release,
    dispose(): void {
      pool.dispose();
      // PointLight owns no GPU resource; clearing the group is the whole of it.
      lightBank.clear();
      dryBolt.dispose();
      deck.dispose();
      hazeGeometry.dispose();
      boltGeometry.dispose();
    },
  };
}

/**
 * Draw objects one thunderstorm rig costs: SEVEN — the falling column, the four
 * haze sheets, the glow sheet and the bolt. (The flash light is a PointLight,
 * which is not a drawn object.)
 */
export const THUNDERSTORM_RIG_DRAW_OBJECTS = 7;

/** The world's single dry bolt, which belongs to no system: ONE. */
export const DRY_BOLT_DRAW_OBJECTS = 1;

/** The light bank holds PointLights, which are not drawn objects. */
export const LIGHT_BANK_DRAW_OBJECTS = 0;

/** Draw objects the whole plugin costs beyond its rigs: the deck. */
export const THUNDERSTORM_DECK_DRAW_OBJECTS = CUMULUS_DECK_DRAW_OBJECTS;

// saucers — client half. Draws whatever `saucers:state` says is in the sky, and
// nothing else.
//
// It holds no authority: it never starts an encounter, never moves a saucer,
// never decides who won, and never predicts. A saucer that stops appearing in
// the full-state list is gone — the wreck is in the ground or the winner is out
// of the frame — and the renderer turns that ABSENCE into nothing at all, which
// is what it should be, because by then the crater is drawn by the terrain and
// the flames by the fire plugin.
//
// A SAUCER FLIES, so it is NOT placed against the ground: its Y comes straight
// off the wire (`alt`, world-space, decided by the server against the terrain
// under the arena). The one thing here that IS placed on the ground is the
// crash burst, and that uses `terrainHeightAt` — the lattice height, which is
// right for a thing standing up. (The other oracle, `drawnGroundYAt`, is for
// things that lie flat ON the surface; getting the two the wrong way round is
// the water bug this codebase paid four rewrites for.)
//
// NO HUD, deliberately, and for monsters' reason: the whole point of this plugin
// is a thing you look up and NOTICE. A panel counting saucers would be the
// opposite of the feature.

import { Group, Vector3 } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import { reconcileById } from '../../../client/src/plugins/kit/viewReconcile.ts';
import { watchReducedMotion } from '../../../client/src/plugins/kit/reducedMotion.ts';
import {
  MAX_LASER_BOLTS,
  SAUCERS_PER_ENCOUNTER,
  SAUCERS_PLUGIN_NAME,
  SAUCERS_STATE_MESSAGE,
  parseSaucersPayload,
  type CrashState,
  type LaserBolt,
} from '../protocol.ts';
import {
  BURST_DRAW_OBJECTS,
  LASER_POOL_DRAW_OBJECTS,
  createCrashBurst,
  createLaserPool,
  type CrashBurst,
  type LaserPool,
} from './effects.ts';
import { SaucerInterpolator, type InterpolatedSaucer } from './interpolation.ts';
import {
  createSaucerModels,
  disposeSaucerAssets,
  preloadSaucerModels,
  SAUCER_LIGHTS_BASE_EMISSIVE,
  SAUCER_MODEL_DRAW_OBJECTS,
  type SaucerModel,
  type SaucerModels,
} from './models.ts';

/**
 * How fast the ring spins, in radians per second.
 *
 * SIX — a full turn every 1.05 s. Fast enough to read as machinery rather than
 * as a carousel, slow enough that it does not alias into a stutter or a
 * backwards spin at 60 fps (which starts around 30 rad/s for a shape with this
 * much rotational symmetry).
 */
const RING_RADIANS_PER_SECOND = 6;

/**
 * The light strip's flash: how many times a second, and how far the emissive
 * intensity swings either side of its base.
 *
 * TWO HERTZ AND ±0.8. A saucer's lights are a beacon, not a strobe: two a second
 * is the cadence of a navigation light, and holding the swing under the base
 * intensity (SAUCER_LIGHTS_BASE_EMISSIVE is 1.2) means the strip DIMS rather
 * than switching off, which is what stops it reading as a fault.
 */
const LIGHTS_FLASHES_PER_SECOND = 2;
const LIGHTS_FLASH_SWING = 0.8;

/**
 * How far the hull banks into a turn, in radians at full rate, and what "full
 * rate" is in radians of heading change per second.
 *
 * BANK 0.6 rad (34°) AT 2 rad/s of turn. A saucer on the dogfight circle turns
 * at roughly DOGFIGHT_SPEED / ARENA_RADIUS ≈ 2.5 rad/s, so it flies the fight
 * banked hard over, and levels out on the straight run-in and the exit — which
 * is exactly the read the owner asked for: zooming in flat, wheeling in the
 * middle, zooming out flat.
 */
const MAX_BANK_RADIANS = 0.6;
const BANK_FULL_TURN_RATE = 2;

/**
 * Cap on the animation clock's advance per frame, in seconds.
 *
 * `onFrame`'s dt is already capped by the host, but the animation clock is an
 * ACCUMULATOR: this keeps a pathological frame from jumping the ring a whole
 * revolution, which at RING_RADIANS_PER_SECOND is a tenth of a second's stall.
 */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

/** A saucer currently in the scene. */
interface SaucerView {
  readonly model: SaucerModel;
  /**
   * WHICH BODY this view was built from. Recorded rather than re-derived,
   * because the model cannot be asked — a SaucerModel is a root and some node
   * handles, and nothing in it remembers which file made it. The reconcile
   * compares this against the sampled state so a saucer whose variant CHANGED
   * under a live id is rebuilt rather than left wearing the wrong hull.
   */
  readonly variant: number;
  /** The heading it was drawn at last frame — the bank is the difference. */
  lastHeading: number;
}

/**
 * Module-level singletons, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin (client/src/
 * plugins/host.ts), and `attach`/`dispose` bracket their whole lifetime.
 */
let models: SaucerModels | null = null;
let container: Group | null = null;
let lasers: LaserPool | null = null;
let burst: CrashBurst | null = null;
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
const views = new Map<number, SaucerView>();
const interpolator = new SaucerInterpolator();
/** The bolts and the crash as last received — neither is interpolated. */
let bolts: readonly LaserBolt[] = [];
let crash: CrashState | null = null;
let animationSeconds = 0;
let unsubscribes: Array<() => void> = [];

/**
 * Scratch vectors for the bolt endpoints. Module scope for effects.ts's reason:
 * this runs per bolt per frame, and two `new Vector3` in there is an allocation
 * the collector pays for inside the 7.1 ms frame budget.
 */
const boltFrom = new Vector3();
const boltTo = new Vector3();

/**
 * Adds/removes scene objects so `views` matches the sampled state.
 *
 * Written as a general reconcile over a map rather than as "if there are two,
 * show two": the wire format is a list, and a client that assumed its length
 * would be a client that breaks the day SAUCERS_PER_ENCOUNTER changes — while
 * looking, until then, exactly correct.
 */
function reconcileViews(sampled: ReadonlyMap<number, InterpolatedSaucer>): void {
  if (models === null || container === null) return;
  const bank = models;
  const scene = container;

  reconcileById(sampled, views, {
    acquire: (_id, saucer) => {
      const model = bank.create(saucer.variant);
      // See renderFrame's bank note: the roll must compose in the model's own
      // frame, before the yaw, which is what 'YXZ' says.
      model.root.rotation.order = 'YXZ';
      scene.add(model.root);
      return { model, variant: saucer.variant, lastHeading: saucer.heading };
    },
    replace: (_id, saucer, existing) => {
      if (existing.variant === saucer.variant) return null;
      // A LIVE ID WHOSE HULL CHANGED. The server never does this — a variant is
      // chosen once when the encounter begins and is readonly for the saucer's
      // life (server/encounter.ts) — so this is the belt-and-suspenders half of
      // that rule rather than a mechanic. The one way it fires in practice is a
      // client watching a fight through a server upgrade. Rebuilding is the only
      // correct answer available here, and it costs what an arrival costs.
      scene.remove(existing.model.root);
      existing.model.dispose();
      const rebuilt = bank.create(saucer.variant);
      rebuilt.root.rotation.order = 'YXZ';
      scene.add(rebuilt.root);
      return { model: rebuilt, variant: saucer.variant, lastHeading: existing.lastHeading };
    },
    release: (_id, view) => {
      scene.remove(view.model.root);
      // Shared geometry and materials belong to `models` and are freed once, at
      // plugin dispose; what a view owns is its own graph and (on the authored
      // path) its own cloned lights material. `SaucerModel.dispose` frees
      // exactly that and nothing else.
      view.model.dispose();
    },
  });
}

/** World-space position of a saucer's muzzle — where its bolts leave from. */
function muzzleWorldPosition(view: SaucerView, into: Vector3): Vector3 {
  // The model's matrices were updated by the renderer's last pass over the
  // scene, and the root's own transform was written earlier THIS frame, so the
  // muzzle's world matrix is stale by one frame unless it is refreshed. One
  // update per saucer per frame, over a two-node chain.
  view.model.root.updateMatrixWorld(true);
  return into.setFromMatrixPosition(view.model.muzzle.matrixWorld);
}

/**
 * THE RENDER PATH. Runs once per animation frame.
 *
 * ORDER MATTERS: the saucers are placed first, then the bolts are drawn between
 * the positions they were just placed at. Drawing the bolts from last frame's
 * matrices would leave every beam trailing its own muzzle by one frame, which at
 * this speed is a third of a world unit.
 */
function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  // REDUCED MOTION (the design record's hard requirement): this plugin's own
  // animation clock FREEZES, which stops the ring spinning and the lights
  // flashing — both are functions of it. The saucers themselves keep flying,
  // because their positions come from the server and hiding them would be
  // hiding the world.
  if (!(reducedMotion?.matches() ?? false)) animationSeconds += step;

  interpolator.advance(dt);
  const sampled = interpolator.sample();
  reconcileViews(sampled);

  for (const [id, saucer] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;
    const root = view.model.root;

    // Cell coordinates scale to world X/Z by CELL_WORLD_SIZE; the vertical is
    // the server's own world-space `alt` and is NOT derived from the terrain
    // here — the server chose it against the ground under the arena, and a
    // second opinion computed from a client's own heightmap would put the two
    // halves in disagreement about how high a saucer is.
    root.position.set(saucer.x * CELL_WORLD_SIZE, saucer.alt, saucer.y * CELL_WORLD_SIZE);

    // Models face +X. Rotating +X about Y by θ yields (cos θ, 0, -sin θ), and
    // the saucer travels toward (cos heading, 0, sin heading) — hence the
    // negation. Same convention as every other model-bearing plugin here.
    root.rotation.y = -saucer.heading;

    // BANK INTO THE TURN, from the heading's rate of change measured across the
    // frame. Measured rather than taken from the phase because the phase does
    // not say which way it is turning, and the sign is the whole effect.
    //
    // ROLL IS ABOUT LOCAL X — the model's forward axis, since the convention is
    // forward = +X — and the Euler ORDER is what makes that true: with the
    // default 'XYZ' the roll would be composed in world space, after the yaw,
    // which pitches the saucer instead of banking it. 'YXZ' composes the roll
    // first, in the model's own frame, and the yaw about world Y after it. The
    // order is set once per view at acquire, not here: it is a property of the
    // object, not of the frame.
    const turn = step > 0 ? shortestAngle(saucer.heading - view.lastHeading) / step : 0;
    view.lastHeading = saucer.heading;
    // RESIDUAL, NAMED: the SIGN has not been verified in-world — this agent may
    // not start the app. If a saucer leans OUT of its turn, negate this one
    // expression; nothing else depends on it.
    root.rotation.x = clampSigned(turn / BANK_FULL_TURN_RATE) * MAX_BANK_RADIANS;

    if (view.model.ring !== null) {
      view.model.ring.rotation.y = animationSeconds * RING_RADIANS_PER_SECOND;
    }
    if (view.model.lights !== null) {
      view.model.lights.emissiveIntensity =
        SAUCER_LIGHTS_BASE_EMISSIVE +
        LIGHTS_FLASH_SWING *
          Math.sin(animationSeconds * LIGHTS_FLASHES_PER_SECOND * Math.PI * 2);
    }
  }

  drawBolts(sampled);
  drawCrash(ctx);
}

/** Every bolt the payload still lists, between the hulls it belongs to. */
function drawBolts(sampled: ReadonlyMap<number, InterpolatedSaucer>): void {
  const pool = lasers;
  if (pool === null) return;
  pool.begin();
  if (bolts.length === 0) return;

  for (const bolt of bolts) {
    const shooter = views.get(bolt.from);
    const target = views.get(bolt.to);
    // Both endpoints must be in the scene. The wire parse already drops a bolt
    // whose ids are not both in the same payload (../protocol.ts), so this is
    // the one-frame window where a payload has arrived and the reconcile has
    // not caught up — not a case the parse can cover.
    if (shooter === undefined || target === undefined) continue;
    if (!sampled.has(bolt.from) || !sampled.has(bolt.to)) continue;
    pool.draw(
      muzzleWorldPosition(shooter, boltFrom),
      target.model.root.getWorldPosition(boltTo),
      bolt.age,
    );
  }
}

/** The fireball, on the ground where the wreck went in. */
function drawCrash(ctx: ClientPluginCtx): void {
  const rig = burst;
  if (rig === null) return;
  if (crash === null) {
    rig.hide();
    return;
  }
  // A THING STANDING ON THE GROUND, so terrainHeightAt is the right oracle — see
  // this file's header. Null means the cell's chunk has not streamed in; the
  // burst is simply not drawn until it has, and this runs every frame so the
  // next one retries for free.
  const groundY = ctx.terrainHeightAt(crash.x, crash.y);
  if (groundY === null) {
    rig.hide();
    return;
  }
  rig.show(crash.x * CELL_WORLD_SIZE, groundY, crash.y * CELL_WORLD_SIZE, crash.age);
}

/** An angle folded into (-π, π] — the short way round. */
function shortestAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let delta = radians % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return delta;
}

/** Clamps to [-1, 1]. */
function clampSigned(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

export const clientPlugin: TerraceClientPlugin = {
  name: SAUCERS_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, written from this plugin's own caps —
   * see TerraceClientPlugin.drawBudget. Two saucers of however many surfaces
   * the installed hull actually has, the whole bolt pool, and the burst's two
   * objects. Every population cap in it is a constant the SERVER enforces
   * (SAUCERS_PER_ENCOUNTER, MAX_LASER_BOLTS), so this is the honest maximum
   * rather than a number from one measurement.
   *
   * A GETTER, for the reason boats' is one: the per-saucer figure is MEASURED at
   * preload and starts at a conservative ceiling, and the host reads this field
   * every sample — so the budget follows the measurement instead of freezing the
   * pre-load ceiling.
   */
  get drawBudget(): number {
    return (
      SAUCERS_PER_ENCOUNTER * SAUCER_MODEL_DRAW_OBJECTS +
      LASER_POOL_DRAW_OBJECTS +
      BURST_DRAW_OBJECTS
    );
  },

  /**
   * Loads the three authored hulls before attach, so `createSaucerModels` has
   * something to clone from.
   *
   * IT CANNOT REJECT — see preloadSaucerModels. A rejected preload leaves the
   * plugin unmounted for the whole session, and "the art is not finished" must
   * not mean "the mechanic does not exist".
   */
  preload(): Promise<void> {
    return preloadSaucerModels();
  },

  attach(ctx: ClientPluginCtx): void {
    models = createSaucerModels();
    reducedMotion = watchReducedMotion();
    animationSeconds = 0;
    bolts = [];
    crash = null;

    // One child Group of our own inside the host's layer: it keeps the saucers
    // under a single named node, which makes the scene graph legible in the
    // three.js inspector and gives dispose() one thing to clear.
    container = new Group();
    container.name = 'saucers:flying';
    ctx.layer.add(container);

    lasers = createLaserPool();
    ctx.layer.add(lasers.root);
    burst = createCrashBurst();
    ctx.layer.add(burst.root);

    unsubscribes = [
      ctx.onMessage(SAUCERS_STATE_MESSAGE, (payload) => {
        const state = parseSaucersPayload(payload);
        // A malformed payload is dropped WHOLE: the previous state keeps
        // rendering until the next good message, a tenth of a second away. An
        // EMPTY payload is not malformed — it is how a client learns the
        // encounter is over — and it is applied.
        if (state === null) return;
        interpolator.receive(state.saucers);
        bolts = state.lasers;
        crash = state.crash;
      }),

      ctx.onFrame((dt) => renderFrame(ctx, dt)),
    ];
  },

  dispose(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];

    for (const view of views.values()) view.model.dispose();
    views.clear();
    interpolator.clear();
    bolts = [];
    crash = null;

    lasers?.dispose();
    lasers = null;
    burst?.dispose();
    burst = null;

    container?.clear();
    container = null;

    // Shared geometries and materials are freed exactly once, here — and the
    // authored files AFTER the models built from them, which is the ordering
    // rule docs/model-assets.md states for anything sampling a file's textures.
    models?.dispose();
    models = null;
    disposeSaucerAssets();

    reducedMotion?.stop();
    reducedMotion = null;
    animationSeconds = 0;
  },
};

/** Re-exported so a harness can size a pool against the same ceiling. */
export { MAX_LASER_BOLTS };

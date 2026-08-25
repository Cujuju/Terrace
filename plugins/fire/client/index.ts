// fire — client half. Draws whatever the server says is alight, and runs it
// forward between messages.
//
// It holds no authority: it never lights anything, never spreads anything,
// never decides that a fire is over. What it DOES do that flora's client never
// has to is RUN A CLOCK — a fire's age advances locally every frame, because
// the server sends a fire once and lets both halves derive the rest from
// `fireIntensity` (../protocol.ts). That is the whole reason this plugin can
// animate a spreading wildfire on a delta stream measured in bytes.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LOCAL CLOCK, AND WHY IT IS SAFE.
//
// Between messages, every fire's age is advanced by the frame's dt, so client
// and server drift by whatever their clocks disagree about — a fraction of a
// percent, over a burn measured in tens of seconds. Two things bound it:
//
//   * the server re-anchors every fire's age on the FIRE_KEEPALIVE_SECONDS
//     snapshot (10 s, deliberately shorter than the shortest fuel's burn), so
//     drift is re-zeroed several times within one fire's life;
//   * a fire that runs past its own burn time is dropped locally rather than
//     drawn at zero intensity forever, so the worst a missed extinguish delta
//     can do is leave a dying flame for one keepalive.
//
// The alternative — streaming intensity per tick per fire — is what this design
// exists to avoid, and it would cost more per second than the entire flora
// plugin spends.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE LOOK IS BEHIND AN INTERFACE.
//
// `./flames/types.ts` defines FlameRenderer, and this file draws through it
// without knowing which candidate it holds. The look is chosen from pictures by
// the owner; the simulation half must be shippable before that choice exists.
// See that file's header for the budget rules any candidate must keep.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  FIRE_CHANGES_MESSAGE,
  FIRE_FIRES_MESSAGE,
  FIRE_PLUGIN_NAME,
  fireIntensity,
  fireKey,
  isBurnedOut,
  parseChangesPayload,
  parseFiresPayload,
  type FireCellState,
} from '../protocol.ts';
import { createFireLights, type FireLights } from './fireLights.ts';
import { FLAME_CANDIDATES } from './flames/index.ts';
import type { FireInstance, FlameRenderer } from './flames/types.ts';

/**
 * Which candidate look is shipped. ONE LINE TO CHANGE once the owner has picked
 * from the preview renders (client/preview-fire.html), and the only line in the
 * plugin that knows a choice was ever made.
 */
export const SELECTED_FLAME_CANDIDATE_INDEX = 0;

/**
 * Seconds between retries while some fire's ground is still unknown — flora's
 * FLORA_GROUND_RETRY_SECONDS, for the identical reason (a chunk's heights
 * arriving is a network event at human pace, not a per-frame one).
 *
 * A fire waiting on ground is rarer than a tree waiting on ground, since a fire
 * only ever starts where something was already standing; the retry exists for
 * the join snapshot, where every fire in the world arrives before any terrain
 * does.
 */
export const FIRE_GROUND_RETRY_SECONDS = 0.5;

/** A fire as this client holds it: the wire state, plus the ground under it. */
interface LocalFire {
  readonly cell: FireCellState;
  /** Null until this client has heights for the cell. */
  groundY: number | null;
  /** Advanced locally every frame — see the header. */
  ageSeconds: number;
}

let flames: FlameRenderer | null = null;
let lights: FireLights | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

/** Everything alight, by packed cell key. This client's whole model of fire. */
const fires = new Map<number, LocalFire>();

/** Fires whose ground was unknown at the last placement, and the retry clock. */
let pendingGround = 0;
let sinceRetrySeconds = 0;

/** Seconds since attach — the phase every flame renderer animates against. */
let elapsedSeconds = 0;

/**
 * Scratch, reused every frame: the instance list handed to the renderer and to
 * the light pool. Rebuilt in place rather than reallocated, because unlike
 * flora's trees this list changes EVERY FRAME (intensity moves), so a fresh
 * array per frame would be a per-frame allocation proportional to the fire.
 */
const instances: FireInstance[] = [];

function adoptGround(ctx: ClientPluginCtx, fire: LocalFire): void {
  if (fire.groundY !== null) return;
  const groundY = ctx.terrainHeightAt(fire.cell.x, fire.cell.y);
  if (groundY === null) {
    pendingGround++;
    return;
  }
  fire.groundY = groundY;
}

/**
 * Re-resolves ground for every fire still waiting on it. Called on the retry
 * clock and whenever the set changes — never per frame.
 */
function resolveGround(ctx: ClientPluginCtx): void {
  pendingGround = 0;
  for (const fire of fires.values()) adoptGround(ctx, fire);
  sinceRetrySeconds = 0;
}

function addFire(ctx: ClientPluginCtx, cell: FireCellState): void {
  const fire: LocalFire = { cell, groundY: null, ageSeconds: cell.ageSeconds };
  adoptGround(ctx, fire);
  fires.set(fireKey(cell.x, cell.y), fire);
}

function replaceAll(ctx: ClientPluginCtx, cells: readonly FireCellState[]): void {
  fires.clear();
  pendingGround = 0;
  for (const cell of cells) addFire(ctx, cell);
}

/**
 * Builds this frame's instance list.
 *
 * A fire over unknown ground is OMITTED rather than drawn at a guessed height —
 * flora's rule, and it matters more here: a flame at sea level is a fire
 * burning in the ocean, which is the one thing a player would be sure was a bug.
 *
 * A fire past its own burn time is DROPPED as it is passed over, not merely
 * skipped: its extinguish delta is either in flight or was missed, and either
 * way there is nothing left to draw. This is the local half of the drift bound
 * in the header.
 */
function buildInstances(): void {
  instances.length = 0;
  for (const [key, fire] of fires) {
    if (isBurnedOut(fire.ageSeconds, fire.cell.burnSeconds)) {
      fires.delete(key);
      continue;
    }
    if (fire.groundY === null) continue;

    instances.push({
      x: fire.cell.x * CELL_WORLD_SIZE,
      z: fire.cell.y * CELL_WORLD_SIZE,
      groundY: fire.groundY,
      fuelHeight: fire.cell.fuelHeight,
      intensity: fireIntensity(fire.ageSeconds, fire.cell.burnSeconds),
      ageSeconds: fire.ageSeconds,
      // The cell key: stable, unique per fire, and identical on every client —
      // which is what the renderers vary their phase and lean by instead of
      // Math.random (./flames/types.ts).
      seed: key,
    });
  }
}

export const clientPlugin: TerraceClientPlugin = {
  name: FIRE_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    // Module scope outlives an attach, so a re-attach after a rejoin would
    // otherwise open on the previous world's fires.
    fires.clear();
    pendingGround = 0;
    sinceRetrySeconds = 0;
    elapsedSeconds = 0;

    const build = FLAME_CANDIDATES[SELECTED_FLAME_CANDIDATE_INDEX] ?? FLAME_CANDIDATES[0]!;
    flames = build();
    ctx.layer.add(flames.root);

    lights = createFireLights();
    ctx.layer.add(lights.root);

    unsubscribeMessages = [
      ctx.onMessage(FIRE_FIRES_MESSAGE, (payload) => {
        const cells = parseFiresPayload(payload);
        // A malformed payload is dropped whole: what is already drawn keeps
        // burning until the next good message, at most a keepalive away.
        // Clearing every fire on a parse failure would be the one outcome
        // strictly worse than showing a slightly stale flame.
        if (cells === null) return;
        replaceAll(ctx, cells);
      }),

      ctx.onMessage(FIRE_CHANGES_MESSAGE, (payload) => {
        const changes = parseChangesPayload(payload);
        if (changes === null) return;
        // Extinguishments first, so a delta that (impossibly today, but
        // cheaply guarded) names one cell in both halves ends up ALIGHT — the
        // server can only re-light a cell it has already put out.
        for (const cell of changes.extinguished) fires.delete(fireKey(cell.x, cell.y));
        for (const cell of changes.ignited) addFire(ctx, cell);
      }),
    ];

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (flames === null || lights === null) return;

      // A world that is not on fire costs one comparison and nothing else — no
      // instance build, no renderer update, no light work.
      if (fires.size === 0) {
        lights.darken();
        return;
      }

      elapsedSeconds += dt;
      for (const fire of fires.values()) fire.ageSeconds += dt;

      if (pendingGround > 0) {
        sinceRetrySeconds += dt;
        if (sinceRetrySeconds >= FIRE_GROUND_RETRY_SECONDS) resolveGround(ctx);
      }

      buildInstances();
      // apply() every frame, unlike flora's on-change rebuild: a fire's
      // intensity moves continuously, so "what changed" is "all of it".
      flames.apply(instances);
      flames.update(dt, elapsedSeconds);
      lights.update(instances, dt);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;

    fires.clear();
    instances.length = 0;
    pendingGround = 0;
    sinceRetrySeconds = 0;

    // The host empties and removes the layer itself; what it cannot know about
    // is the GPU memory behind the flame geometry, so that is released here.
    flames?.dispose();
    flames = null;
    lights = null;
  },
};

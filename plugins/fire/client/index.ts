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
// THE TORCH. This half also owns the player's own way of starting a fire: a
// toolbar tool that sends `fire:ignite` for the cell under the click
// (../protocol.ts). It predicts NOTHING — no local flame, no optimistic
// anything. The server answers by broadcasting a fire or by staying silent, and
// the flame appearing is the whole feedback.
//
// That is why the only local affordance is a ring under the cursor
// (./torchMarker.ts): the client can honestly say WHICH CELL it will light, and
// cannot honestly say whether anything there will catch — that is the fuel
// registry's business, on the server, in a plugin this one must not import.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE LOOK IS BEHIND AN INTERFACE.
//
// `./flames/types.ts` defines FlameRenderer, and this file draws through it
// without knowing what it holds. That seam is what let the simulation ship
// while the look was still four candidates being judged from renders; it is
// what lets the shipped look today be TWO renderers crossfaded over a fire's
// life (./flames/ribbonsToPlume.ts) with nothing here needing to know; and it
// is what will let the look be re-tuned later without touching a line of the
// sim. See ./flames/types.ts for the budget rules any look must keep.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  FIRE_CHANGES_MESSAGE,
  FIRE_ENTITIES_MESSAGE,
  FIRE_FIRES_MESSAGE,
  FIRE_IGNITE_MESSAGE,
  FIRE_PLUGIN_NAME,
  fireIntensity,
  fireKey,
  isBurnedOut,
  fireEntityKey,
  parseChangesPayload,
  parseEntitiesPayload,
  parseFiresPayload,
  type FireCellState,
  type FireEntityState,
} from '../protocol.ts';
import { TorchIcon } from './TorchIcon.tsx';
import { createFireLights, type FireLights } from './fireLights.ts';
import { createTorchMarker, type TorchMarker } from './torchMarker.ts';
import { SHIPPED_FLAMES } from './flames/index.ts';
import type { FireInstance, FlameRenderer } from './flames/types.ts';

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
let marker: TorchMarker | null = null;

/** True while the player is holding the Torch rather than the sculpt brush. */
let torchHeld = false;

/** The cell under the cursor while the torch is held, or null. */
let torchCell: { x: number; y: number } | null = null;

/** Window pointer listener, live only for the plugin's lifetime. */
let onPointerMove: ((event: PointerEvent) => void) | null = null;
let unsubscribePress: (() => void) | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

/** Everything alight, by packed cell key. This client's whole model of fire. */
const fires = new Map<number, LocalFire>();

/**
 * A burning thing that MOVES, as this client holds it: the wire state plus the
 * locally advanced age. There is no position here on purpose — see
 * ../protocol.ts's "FIRE THAT WALKS": the pose is read from the plugin that
 * owns the creature, every frame, so the flame is drawn ON the body rather than
 * near where the body was last said to be.
 */
interface LocalEntityFire {
  readonly entity: FireEntityState;
  ageSeconds: number;
}

/** Everything alight that is walking around, by source#id. */
const entityFires = new Map<string, LocalEntityFire>();

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

/**
 * Appends this frame's WALKING fires to the instance list.
 *
 * THE POSE COMES FROM THE OWNER, every frame (ClientPluginCtx.moverPose). That
 * is the whole design: wildlife is already drawing this animal, interpolated
 * its own way, and asking it where the animal is means the flame is exactly
 * where the body is — not a second, independently smoothed guess at it that
 * slides off whenever the two disagree.
 *
 * A fire whose owner cannot place it is OMITTED, not drawn at its last known
 * position: an animal the client has not been told about yet, or has already
 * removed, must not leave a flame burning in mid-air. The server drops the same
 * fire on its own next tick (../server/entityBlaze.ts's VANISHED ending), so
 * this is a frame or two of silence, not a leak.
 *
 * A fire past its own burn time is dropped as it is passed over, exactly as a
 * cell fire is — the local half of the drift bound in this file's header.
 */
function buildEntityInstances(ctx: ClientPluginCtx): void {
  for (const [key, fire] of entityFires) {
    if (isBurnedOut(fire.ageSeconds, fire.entity.burnSeconds)) {
      entityFires.delete(key);
      continue;
    }

    const pose = ctx.moverPose(fire.entity.sourceName, fire.entity.id);
    if (pose === null) continue;

    instances.push({
      x: pose.x,
      z: pose.z,
      groundY: pose.y,
      fuelHeight: fire.entity.fuelHeight,
      intensity: fireIntensity(fire.ageSeconds, fire.entity.burnSeconds),
      ageSeconds: fire.ageSeconds,
      // The id, not a cell key: two animals alight on the same cell are two
      // fires and must not share a phase, and one animal's flame must not
      // change character because it walked across a cell boundary.
      seed: fire.entity.id,
    });
  }
}

/**
 * The tool's id, label and the sentence the toolbar shows on hover.
 *
 * The title says what it COSTS and what it does not promise, because neither is
 * discoverable by trying: the mana is debited server-side with no local gate,
 * and a torch on bare ground looks identical to a torch on a tree that refused
 * to catch.
 */
const TORCH_TOOL_ID = 'ignite';
const TORCH_TOOL_LABEL = 'Pyro';
const TORCH_TOOL_TITLE =
  'Set light to what grows on a cell you have unlocked. Costs mana; only living things catch, and rain will put it out.';

/**
 * The mouse button an ignite press is made with. 0 — the primary only, so a
 * middle- or right-drag still reaches the camera: holding a tool must never
 * cost the player the ability to look around. (temples/client/index.ts's rule,
 * and the same number for the same reason.)
 */
const TORCH_BUTTON = 0;

/**
 * Takes the click. Returns true whenever the torch is held so the press never
 * falls through to the sculpt brush — a player holding the torch must not dig a
 * hole by missing a tree.
 *
 * pickWorldCell, NOT pickTerrainCell: what the player is aiming at is the TREE
 * they can see, and a tree's canopy stands above its own cell — a terrain-only
 * ray goes straight past it and lands on ground several cells behind (see
 * ClientPluginCtx.pickWorldCell). The hover ring uses the same call, so the
 * ring cannot promise a cell the click would not light.
 */
function handlePress(ctx: ClientPluginCtx, event: PointerEvent): boolean {
  if (!torchHeld) return false;
  if (event.button !== TORCH_BUTTON) return false;

  const cell = ctx.pickWorldCell(event.clientX, event.clientY);
  // A press that missed the terrain entirely (sky, sea, locked territory) is
  // still CLAIMED: the tool is held, so the click was meant for it.
  if (cell === null) return true;

  ctx.send(FIRE_IGNITE_MESSAGE, { x: cell.x, y: cell.y });
  return true;
}

export const clientPlugin: TerraceClientPlugin = {
  name: FIRE_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    // Module scope outlives an attach, so a re-attach after a rejoin would
    // otherwise open on the previous world's fires.
    fires.clear();
    entityFires.clear();
    pendingGround = 0;
    sinceRetrySeconds = 0;
    elapsedSeconds = 0;

    flames = SHIPPED_FLAMES();
    ctx.layer.add(flames.root);

    lights = createFireLights();
    ctx.layer.add(lights.root);

    marker = createTorchMarker();
    ctx.layer.add(marker.mesh);

    ctx.registerTool({
      id: TORCH_TOOL_ID,
      label: TORCH_TOOL_LABEL,
      title: TORCH_TOOL_TITLE,
      icon: TorchIcon,
      onSelected: (selected) => {
        torchHeld = selected;
        if (!selected) {
          // Dropped the tool: the ring goes with it THIS INSTANT rather than on
          // the next frame, so putting the brush back never leaves an ember ring
          // sitting under the cursor.
          torchCell = null;
          marker?.hide();
        }
      },
    });

    // HOVER on the window, not the canvas: a plugin is handed no canvas
    // (ClientPluginCtx has none by design) and pickWorldCell takes CLIENT
    // coordinates, so a window listener answers the same question. The pick only
    // runs while the torch is actually held — temples/client/index.ts's
    // arrangement, for its reasons.
    onPointerMove = (event: PointerEvent): void => {
      if (!torchHeld) return;
      torchCell = ctx.pickWorldCell(event.clientX, event.clientY);
    };
    window.addEventListener('pointermove', onPointerMove);

    unsubscribePress = ctx.onCanvasPress((event) => handlePress(ctx, event));

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

      ctx.onMessage(FIRE_ENTITIES_MESSAGE, (payload) => {
        const entities = parseEntitiesPayload(payload);
        // Same rule as the fire snapshot: a malformed payload changes nothing,
        // and what is already drawn keeps burning until the next good message.
        if (entities === null) return;
        // THE WHOLE SET REPLACES THE WHOLE SET (../protocol.ts). Anything the
        // server no longer lists has stopped burning — which is what makes it
        // impossible for this client to hold a flame the server has forgotten,
        // the one failure mode a delta stream cannot rule out.
        //
        // The server's age wins outright, for every fire, every time: this
        // message IS the re-anchor, and a local clock that has drifted is
        // exactly what it exists to correct.
        entityFires.clear();
        for (const entity of entities) {
          entityFires.set(fireEntityKey(entity.sourceName, entity.id), {
            entity,
            ageSeconds: entity.ageSeconds,
          });
        }
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

      elapsedSeconds += dt;

      // THE TORCH RING, before the early-out below: it is drawn while the player
      // is aiming, which is precisely when nothing is burning yet.
      if (torchHeld && torchCell !== null && marker !== null) {
        const groundY = ctx.terrainHeightAt(torchCell.x, torchCell.y);
        if (groundY === null) marker.hide();
        else {
          marker.showAt(torchCell.x * CELL_WORLD_SIZE, groundY, torchCell.y * CELL_WORLD_SIZE);
          marker.update(elapsedSeconds);
        }
      } else {
        marker?.hide();
      }

      // A world that is not on fire costs two comparisons and nothing else — no
      // instance build, no renderer update, no light work.
      if (fires.size === 0 && entityFires.size === 0) {
        lights.darken();
        return;
      }

      for (const fire of fires.values()) fire.ageSeconds += dt;
      for (const fire of entityFires.values()) fire.ageSeconds += dt;

      if (pendingGround > 0) {
        sinceRetrySeconds += dt;
        if (sinceRetrySeconds >= FIRE_GROUND_RETRY_SECONDS) resolveGround(ctx);
      }

      buildInstances();
      // ONE renderer, one light pool, both kinds of fire: a flame on an animal
      // must look like a flame on a tree, because it is the same fire. The only
      // difference between the two lists is where the position came from.
      buildEntityInstances(ctx);
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
    unsubscribePress?.();
    unsubscribePress = null;
    if (onPointerMove !== null) window.removeEventListener('pointermove', onPointerMove);
    onPointerMove = null;
    torchHeld = false;
    torchCell = null;

    fires.clear();
    entityFires.clear();
    instances.length = 0;
    pendingGround = 0;
    sinceRetrySeconds = 0;

    // The host empties and removes the layer itself; what it cannot know about
    // is the GPU memory behind the flame geometry, so that is released here.
    flames?.dispose();
    flames = null;
    lights = null;
    marker?.dispose();
    marker = null;
  },
};

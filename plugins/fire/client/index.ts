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
//
// ─────────────────────────────────────────────────────────────────────────────
// SMOKE IS NOT ONE OF THOSE LOOKS (./smoke.ts). Every flame renderer is a
// function of what is burning RIGHT NOW, which is why one interface and one
// instance list serve all of them. Smoke is a function of what burned — it keeps
// its own decay and goes on drawing a fire this file has already dropped — so it
// sits alongside the flame rather than inside it, and this file's frame callback
// is where the difference is visible: smoke's clock is advanced on frames the
// flame's is not.
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
import { createFireSmoke, type FireSmoke } from './smoke.ts';
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
  /** This fire's identity in the drawn list (./flames/types.ts's key). */
  readonly drawKey: number;
}

let flames: FlameRenderer | null = null;
let smoke: FireSmoke | null = null;
let lights: FireLights | null = null;
let marker: TorchMarker | null = null;

/** True while the player is holding the Torch rather than the sculpt brush. */
let torchHeld = false;

/** The cell under the cursor while the torch is held, or null. */
let torchCell: { x: number; y: number } | null = null;

/** Last cursor position seen while the torch was held, and whether it is new. */
let pointerX = 0;
let pointerY = 0;
let pointerMoved = false;

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
  /** This fire's identity in the drawn list (./flames/types.ts's key). */
  readonly drawKey: number;
}

/** Everything alight that is walking around, by source#id. */
const entityFires = new Map<string, LocalEntityFire>();

/**
 * Hands out ./flames/types.ts's `key`.
 *
 * A COUNTER RATHER THAN THE WIRE IDENTIFIERS, because there are two wire
 * identifier spaces — a packed cell (fireKey) and a source#id pair — and
 * nothing stops a cell key and a creature id from being the same number. The
 * key's whole job is to be unique across everything drawn in one frame, so it
 * is minted here, where both kinds are known, rather than derived from either.
 * Monotonic and never reused, so a light can never follow a key onto a
 * different fire.
 */
let nextDrawKey = 1;

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

function addFire(ctx: ClientPluginCtx, cell: FireCellState, inheritedKey?: number): void {
  const fire: LocalFire = {
    cell,
    groundY: null,
    ageSeconds: cell.ageSeconds,
    drawKey: inheritedKey ?? nextDrawKey++,
  };
  adoptGround(ctx, fire);
  fires.set(fireKey(cell.x, cell.y), fire);
}

/**
 * Takes the keepalive snapshot: the whole burning set replaces the whole
 * burning set, and the server's ages win outright.
 *
 * THE DRAW KEY SURVIVES THE REPLACEMENT, exactly as it does on the entity
 * snapshot above — and for a reason that only became visible when something
 * finally remembered a fire between frames. `key` is contracted to be stable
 * for as long as the fire burns (./flames/types.ts), and this message arrives
 * every FIRE_KEEPALIVE_SECONDS (10 s) during a burn that can last 22. Minting a
 * fresh key here would present a still-burning tree to ./smoke.ts as a fire
 * that had died and a different fire that had just caught, several times per
 * burn: the column over it would start retiring while a second column climbed
 * from nothing in the same spot. Nothing had noticed before because the light
 * pool re-ranks from scratch every frame, so a re-keyed fire cost it a frame.
 */
function replaceAll(ctx: ClientPluginCtx, cells: readonly FireCellState[]): void {
  const previous = new Map(fires);
  fires.clear();
  pendingGround = 0;
  for (const cell of cells) {
    addFire(ctx, cell, previous.get(fireKey(cell.x, cell.y))?.drawKey);
  }
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
      key: fire.drawKey,
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
      key: fire.drawKey,
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

    // Smoke is a SIBLING of the flame, not one of its looks: it keeps its own
    // lifetime and goes on drawing fires this map has already forgotten
    // (./smoke.ts). That is why it is built here rather than inside the flame
    // compositor, and why it is handed the same instance list separately.
    smoke = createFireSmoke();
    ctx.layer.add(smoke.root);

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
    //
    // ONE PICK PER FRAME, NOT ONE PER EVENT. Pointer events arrive several
    // times per frame, and a pick costs the whole declared world
    // (ClientPluginCtx.pickWorldCell) — a mature forest measured at 2.28 ms a
    // call, which a moving cursor was paying repeatedly for a ring that is only
    // drawn once. So the handler does nothing but remember where the cursor is;
    // the frame callback below resolves it.
    onPointerMove = (event: PointerEvent): void => {
      if (!torchHeld) return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerMoved = true;
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
        // THE DRAW KEY SURVIVES THE RE-ANCHOR. The set is replaced wholesale,
        // but a fire that is in both the old set and the new one is the SAME
        // fire — and this message arrives several times during one burn
        // (../server/index.ts's ENTITY_REPAIRS_PER_BURN), so minting a fresh
        // key here would drop the light off a burning animal every couple of
        // seconds for no reason the player could see.
        const previous = new Map(entityFires);
        entityFires.clear();
        for (const entity of entities) {
          const key = fireEntityKey(entity.sourceName, entity.id);
          entityFires.set(key, {
            entity,
            ageSeconds: entity.ageSeconds,
            drawKey: previous.get(key)?.drawKey ?? nextDrawKey++,
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
      if (flames === null || smoke === null || lights === null) return;

      elapsedSeconds += dt;

      // The one pick per frame the pointer handler defers to us.
      if (torchHeld && pointerMoved) {
        pointerMoved = false;
        torchCell = ctx.pickWorldCell(pointerX, pointerY);
      }

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
      //
      // EXCEPT ON THE FRAME IT STOPS BURNING, which this early-out used to
      // swallow (bug, 2026-08-24). `flames.apply` is the only writer of the
      // drawn set, so returning here with instances still applied left a
      // full-brightness flame standing over — most visibly — the hole the
      // player had just dug under the last burning tree, frozen because
      // `update` was skipped too, until something else caught fire anywhere in
      // the world. The renderer now reports what it is drawing
      // (./flames/types.ts's drawnCount), so "nothing is burning" is not
      // treated as "nothing is drawn" until it actually is.
      // SMOKE OUTLIVES THE FIRE, so "nothing is burning" is emphatically not
      // "nothing is drawn" — the frame the world stops burning is the frame
      // smoke's whole reason for existing begins. Its clock is therefore
      // advanced here, on precisely the frames the flame's is not, until its
      // last column has retired and it too reports nothing drawn.
      if (fires.size === 0 && entityFires.size === 0) {
        lights.darken();
        if (flames.drawnCount > 0 || smoke.drawnCount > 0) {
          instances.length = 0;
          flames.apply(instances);
          smoke.apply(instances);
          smoke.update(dt, elapsedSeconds);
        }
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
      // The SAME list, and the same keys: what smoke does with it is decide
      // which of its columns are still being fed (./smoke.ts's `apply`).
      smoke.apply(instances);
      smoke.update(dt, elapsedSeconds);
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
    pointerMoved = false;

    fires.clear();
    entityFires.clear();
    instances.length = 0;
    pendingGround = 0;
    sinceRetrySeconds = 0;

    // The host empties and removes the layer itself; what it cannot know about
    // is the GPU memory behind the flame geometry, so that is released here.
    flames?.dispose();
    flames = null;
    smoke?.dispose();
    smoke = null;
    lights = null;
    marker?.dispose();
    marker = null;
  },
};

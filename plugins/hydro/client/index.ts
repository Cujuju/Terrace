// hydro — client half. Draws whatever the server says is wet, and runs it
// forward between messages.
//
// It holds no authority: it never pours anything, never douses anything, never
// decides that a patch has dried. What it DOES do is RUN A CLOCK — a patch's
// age advances locally every frame, because the server sends a patch once and
// lets both halves derive the rest from `hydroWetness` (../protocol.ts). That
// is fire's design, and it is why this whole feature costs a few hundred bytes.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LOCAL CLOCK, AND WHY IT IS SAFE.
//
// Between messages every patch's age is advanced by the frame's dt, so client
// and server drift by whatever their clocks disagree about — a fraction of a
// percent, over a life measured in tens of seconds. Two things bound it:
//
//   * the server re-anchors every patch on the HYDRO_KEEPALIVE_SECONDS
//     snapshot, which is HYDRO_PATCH_SECONDS / HYDRO_REPAIRS_PER_PATCH and
//     therefore always several times within one patch's life;
//   * a patch that runs past its own life is dropped locally rather than drawn
//     at zero wetness forever, so the worst a missed dry-out delta can do is
//     leave a nearly-invisible film for one keepalive.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BUCKET. This half owns the player's only way of pouring: a toolbar tool
// that sends `hydro:pour` for the cell under the click. It predicts NOTHING —
// no local puddle, no optimistic anything. The server answers by broadcasting a
// patch or by staying silent, and the water appearing is the whole feedback.
// That is why the only local affordance is a ring under the cursor
// (./pourMarker.ts): the client can honestly say WHICH CELL it will pour on,
// and cannot honestly say whether the hillside there will let go.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO WAYS THE WATER IS SEEN, and they are not the same picture.
//
//   THE FILM   ./puddles.ts — one instanced decal per patch, drawn on the
//              terrain's own drawn surface. It is what the water looks like.
//   THE SHADE  `publishGroundShade` — one disc per patch, which the terrain and
//              water shaders darken THEMSELVES under (client/src/render/
//              groundShade.ts). It is what the water does to the light.
//
// The film alone would be a sticker; the shade alone would be a bruise with no
// cause. Both are published from the same patch, at the same wetness, with the
// same `hydroFalloff` edge, so they cannot disagree about where the water is.
//
// THE SHADE GOES OUT AT NIGHT and the film does not, which is correct rather
// than a defect: the shade is a projection along the SUN and switches off below
// GROUND_SHADE_MIN_SUN_Y, at which point there is no direct sunlight for wet
// ground to be failing to reflect. The film is the half that carries the patch
// through the dark.

import type {
  ClientPluginCtx,
  GroundShadeDisc,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  HYDRO_CHANGES_MESSAGE,
  HYDRO_PATCHES_MESSAGE,
  HYDRO_PATCH_CAP,
  HYDRO_PATCH_CORE_FRACTION,
  HYDRO_PATCH_RADIUS_WORLD_UNITS,
  HYDRO_PLUGIN_NAME,
  HYDRO_POUR_MESSAGE,
  hydroKey,
  hydroWetness,
  isDried,
  parseChangesPayload,
  parsePatchesPayload,
  type HydroPatchState,
} from '../protocol.ts';
import { WaterIcon } from './WaterIcon.tsx';
import { createPourMarker, type PourMarker } from './pourMarker.ts';
import { createPuddles, type PuddleInstance, type Puddles } from './puddles.ts';

/**
 * Seconds between retries while some patch's ground is still unknown — fire's
 * FIRE_GROUND_RETRY_SECONDS, for the identical reason (a chunk's heights
 * arriving is a network event at human pace, not a per-frame one).
 *
 * It matters most on the join snapshot, where every patch in the world arrives
 * before any terrain does.
 */
const HYDRO_GROUND_RETRY_SECONDS = 0.5;

/** A patch as this client holds it: the wire state, plus the ground under it. */
interface LocalPatch {
  readonly cell: HydroPatchState;
  /** Null until this client has DRAWN heights for the cell (./puddles.ts). */
  drawnY: number | null;
  /** Advanced locally every frame — see the header. */
  ageSeconds: number;
}

let puddles: Puddles | null = null;
let marker: PourMarker | null = null;

/** True while the player is holding Hydro rather than the sculpt brush. */
let bucketHeld = false;

/** The cell under the cursor while the bucket is held, or null. */
let pourCell: { x: number; y: number } | null = null;

/** Last cursor position seen while the bucket was held, and whether it is new. */
let pointerX = 0;
let pointerY = 0;
let pointerMoved = false;

/** Where the cursor was the last time a pick actually ran. */
let pickedAtX = 0;
let pickedAtY = 0;

/**
 * How far the cursor must travel, in CSS pixels, before the bucket re-picks.
 *
 * THE PICK ONLY ANSWERS A CELL, and a cell is a quarter of a world unit: at any
 * camera distance the player can aim from, that is several pixels across. So a
 * two-pixel drift cannot change the answer, and re-picking on it spends a cell
 * march to be told the same cell again. Four pixels is under half a cell at the
 * closest zoom the camera allows, so the ring still follows the cursor without
 * a visible step. (fire's TORCH_REPICK_TRAVEL_PX, the same number for the same
 * reason — it is a property of the pick, not of either tool.)
 */
const POUR_REPICK_TRAVEL_PX = 4;

/** Window pointer listener, live only for the plugin's lifetime. */
let onPointerMove: ((event: PointerEvent) => void) | null = null;
let unsubscribePress: (() => void) | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;
let unpublishShade: (() => void) | null = null;

/** Every patch, by packed cell key. This client's whole model of the water. */
const patches = new Map<number, LocalPatch>();

/** Patches whose ground was unknown at the last placement, and the retry clock. */
let pendingGround = 0;
let sinceRetrySeconds = 0;

/** Seconds since attach — the phase the ring and the ripples animate against. */
let elapsedSeconds = 0;

/**
 * Scratch, reused every frame: the instance list handed to the renderer, and
 * the shade list core reads during the frame it draws.
 *
 * REUSED, NEVER REALLOCATED. Both change every frame (wetness moves), so a
 * fresh array per frame would be garbage for nothing — rain's rule for its own
 * shade list, and fire's for its instances. The element objects are literals
 * rather than a pool because the lists are at most HYDRO_PATCH_CAP long: twelve
 * short-lived objects a frame is below the churn a pool is worth.
 */
const instances: PuddleInstance[] = [];
const shade: GroundShadeDisc[] = [];

/**
 * The tool's id, label and the phrase the toolbar shows on hover.
 *
 * `<Name>: <what a press does>`, in the four or five words the bar's other
 * tools use ('Pyro: set unlocked growth alight', 'Sculpt: drag to shape land').
 * The landslide is deliberately left out: a tooltip is a label, not a manual,
 * and a sentence twice the length of its neighbours' reads as the odd one out.
 */
const POUR_TOOL_ID = 'pour';
const POUR_TOOL_LABEL = 'Hydro';
const POUR_TOOL_TITLE = 'Hydro: douse unlocked ground';

/**
 * The mouse button a pour is made with. 0 — the primary only, so a middle- or
 * right-drag still reaches the camera: holding a tool must never cost the
 * player the ability to look around. (temples/client/index.ts's rule, and
 * fire's, and the same number for the same reason.)
 */
const POUR_BUTTON = 0;

/**
 * How much of the light wet ground takes out from under itself.
 *
 * LIGHTER THAN A RAIN CLOUD'S 0.25 (rain's RAIN_SHADE_DARKNESS), because the
 * two are shading for different reasons: a cloud is BLOCKING the sun and a
 * puddle is only failing to bounce it back. It is also multiplied by wetness,
 * so a drying patch releases the ground it darkened.
 */
const HYDRO_SHADE_DARKNESS = 0.18;

/** How many surfaces this plugin draws. See TerraceClientPlugin.drawBudget. */
const PUDDLE_DRAW_OBJECTS = 1;
const POUR_MARKER_DRAW_OBJECTS = 1;

function adoptGround(ctx: ClientPluginCtx, patch: LocalPatch): void {
  if (patch.drawnY !== null) return;
  const drawnY = ctx.drawnGroundYAt(patch.cell.x, patch.cell.y);
  if (drawnY === null) {
    pendingGround++;
    return;
  }
  patch.drawnY = drawnY;
}

/** Re-resolves ground for every patch still waiting on it. Never per frame. */
function resolveGround(ctx: ClientPluginCtx): void {
  pendingGround = 0;
  sinceRetrySeconds = 0;
  for (const patch of patches.values()) adoptGround(ctx, patch);
}

function addPatch(ctx: ClientPluginCtx, cell: HydroPatchState): void {
  const patch: LocalPatch = { cell, drawnY: null, ageSeconds: cell.ageSeconds };
  patches.set(hydroKey(cell.x, cell.y), patch);
  adoptGround(ctx, patch);
}

/**
 * THE WHOLE SET REPLACES THE WHOLE SET (../protocol.ts). Anything the server no
 * longer lists has dried — which is what makes it impossible for this client to
 * hold water the server has forgotten, the one failure mode a delta stream
 * cannot rule out. The server's age wins outright for every patch, every time:
 * this message IS the re-anchor, and a local clock that has drifted is exactly
 * what it exists to correct.
 */
function replaceAll(ctx: ClientPluginCtx, cells: readonly HydroPatchState[]): void {
  patches.clear();
  pendingGround = 0;
  for (const cell of cells) addPatch(ctx, cell);
}

/**
 * Rebuilds both per-frame lists from the local set, dropping anything that has
 * run past its own life or has no drawn ground yet.
 *
 * ONE PASS FOR BOTH, because they are two views of one patch: building them
 * separately would be two walks of the same map and, worse, two places a future
 * change could make the film and the shade disagree.
 */
function buildLists(): void {
  instances.length = 0;
  shade.length = 0;

  for (const patch of patches.values()) {
    if (patch.drawnY === null) continue;
    const wetness = hydroWetness(patch.ageSeconds);
    if (wetness <= 0) continue;

    const x = patch.cell.x * CELL_WORLD_SIZE;
    const z = patch.cell.y * CELL_WORLD_SIZE;
    instances.push({ x, z, drawnY: patch.drawnY, wetness });
    shade.push({
      x,
      z,
      // THE DISC'S OWN HEIGHT IS THE GROUND IT LIES ON, which is what makes the
      // sun projection in client/src/render/groundShade.ts a no-op for the very
      // ground under the patch: `(disc.y - p.y) / sun.y` is zero there, so the
      // shade lands exactly where the water is rather than being cast sideways
      // like a cloud's. Ground at a DIFFERENT height nearby is still projected,
      // which is right — that ground is not where the water is.
      y: patch.drawnY,
      radius: HYDRO_PATCH_RADIUS_WORLD_UNITS,
      darkness: HYDRO_SHADE_DARKNESS * wetness,
      // The protocol's own edge, so the darkened ground and the doused ground
      // are one shape (../protocol.ts's `hydroFalloff`).
      inner: HYDRO_PATCH_CORE_FRACTION,
    });
  }
}

/**
 * Takes the click. Returns true whenever the bucket is held so the press never
 * falls through to the sculpt brush — a player holding water must not dig a
 * hole by missing.
 *
 * pickWorldCell, NOT pickTerrainCell: what the player is aiming at is the
 * BURNING TREE they can see, and a canopy stands above its own cell — a
 * terrain-only ray goes straight past it and lands on ground several cells
 * behind. The hover ring uses the same call, so the ring cannot promise a cell
 * the click would not wet.
 */
function handlePress(ctx: ClientPluginCtx, event: PointerEvent): boolean {
  if (!bucketHeld) return false;
  if (event.button !== POUR_BUTTON) return false;

  const cell = ctx.pickWorldCell(event.clientX, event.clientY);
  // A press that missed the terrain entirely (sky, sea, locked territory) is
  // still CLAIMED: the tool is held, so the click was meant for it.
  if (cell === null) return true;

  ctx.send(HYDRO_POUR_MESSAGE, { x: cell.x, y: cell.y });
  return true;
}

export const clientPlugin: TerraceClientPlugin = {
  name: HYDRO_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget. FIXED whatever is on the ground: every
   * patch in the world is one instance of the single mesh in ./puddles.ts.
   */
  drawBudget: PUDDLE_DRAW_OBJECTS + POUR_MARKER_DRAW_OBJECTS,

  /**
   * One shade disc per patch, so the budget IS the patch cap — an expression of
   * this plugin's own cap, exactly as `drawBudget` above is. It is also the
   * constraint that SIZED that cap; see ../protocol.ts's HYDRO_PATCH_CAP.
   */
  groundShadeBudget: HYDRO_PATCH_CAP,

  attach(ctx: ClientPluginCtx): void {
    // Module scope outlives an attach, so a re-attach after a rejoin would
    // otherwise open on the previous world's water.
    patches.clear();
    pendingGround = 0;
    sinceRetrySeconds = 0;
    elapsedSeconds = 0;

    puddles = createPuddles();
    ctx.layer.add(puddles.root);

    marker = createPourMarker();
    ctx.layer.add(marker.mesh);

    unpublishShade = ctx.publishGroundShade(() => shade);

    ctx.registerTool({
      id: POUR_TOOL_ID,
      label: POUR_TOOL_LABEL,
      title: POUR_TOOL_TITLE,
      icon: WaterIcon,
      onSelected: (selected) => {
        bucketHeld = selected;
        if (!selected) {
          // Dropped the tool: the ring goes with it THIS INSTANT rather than on
          // the next frame, so putting the brush back never leaves a ring
          // sitting under the cursor.
          pourCell = null;
          marker?.hide();
        }
      },
    });

    // HOVER on the window, not the canvas: a plugin is handed no canvas
    // (ClientPluginCtx has none by design) and pickWorldCell takes CLIENT
    // coordinates, so a window listener answers the same question.
    //
    // ONE PICK PER FRAME, NOT ONE PER EVENT. Pointer events arrive several
    // times per frame and the ring is drawn once, so the handler does nothing
    // but remember where the cursor is; the frame callback below resolves it,
    // and only when the cursor has moved far enough to mean a different cell.
    onPointerMove = (event: PointerEvent): void => {
      if (!bucketHeld) return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerMoved = true;
    };
    window.addEventListener('pointermove', onPointerMove);

    unsubscribePress = ctx.onCanvasPress((event) => handlePress(ctx, event));

    unsubscribeMessages = [
      ctx.onMessage(HYDRO_PATCHES_MESSAGE, (payload) => {
        const cells = parsePatchesPayload(payload);
        // A malformed payload is dropped whole: what is already drawn stays wet
        // until the next good message, at most a keepalive away. Clearing every
        // patch on a parse failure would be the one outcome strictly worse than
        // showing a slightly stale puddle.
        if (cells === null) return;
        replaceAll(ctx, cells);
      }),

      ctx.onMessage(HYDRO_CHANGES_MESSAGE, (payload) => {
        const changes = parseChangesPayload(payload);
        if (changes === null) return;
        // Dry-outs first, so a delta that names one cell in both halves ends up
        // WET — the server can only re-pour a cell it has already dried, which
        // is exactly what an eviction followed by a pour looks like.
        for (const cell of changes.dried) patches.delete(hydroKey(cell.x, cell.y));
        for (const cell of changes.poured) addPatch(ctx, cell);
      }),
    ];

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (puddles === null) return;

      elapsedSeconds += dt;

      // The one pick per frame the pointer handler defers to us — and only when
      // the cursor has actually travelled far enough to be pointing at a
      // different cell (POUR_REPICK_TRAVEL_PX). `pointerMoved` is left set when
      // the travel is too small, so a slow drift still picks once it adds up
      // rather than never.
      if (bucketHeld && pointerMoved) {
        const travelX = pointerX - pickedAtX;
        const travelY = pointerY - pickedAtY;
        const farEnough =
          travelX * travelX + travelY * travelY >=
          POUR_REPICK_TRAVEL_PX * POUR_REPICK_TRAVEL_PX;
        if (pourCell === null || farEnough) {
          pointerMoved = false;
          pickedAtX = pointerX;
          pickedAtY = pointerY;
          pourCell = ctx.pickWorldCell(pointerX, pointerY);
        }
      }

      // THE RING, before the early-out below: it is drawn while the player is
      // aiming, which is precisely when there is no water anywhere yet.
      if (bucketHeld && pourCell !== null && marker !== null) {
        const groundY = ctx.terrainHeightAt(pourCell.x, pourCell.y);
        if (groundY === null) marker.hide();
        else {
          marker.showAt(pourCell.x * CELL_WORLD_SIZE, groundY, pourCell.y * CELL_WORLD_SIZE);
          marker.update(elapsedSeconds);
        }
      } else {
        marker?.hide();
      }

      // A dry world costs one comparison and nothing else — no list build, no
      // renderer update, no shade.
      //
      // EXCEPT ON THE FRAME IT DRIES OUT, which an early-out here used to
      // swallow in fire (bug, 2026-08-24) and would swallow identically: the
      // lists are the only writers of what is drawn and what is shaded, so
      // returning with the last frame's lists still applied would leave a
      // puddle frozen on the ground forever. Emptying them is the whole of the
      // work, and it is done once rather than every dry frame.
      if (patches.size === 0) {
        if (instances.length > 0 || shade.length > 0) {
          instances.length = 0;
          shade.length = 0;
          puddles.apply(instances);
        }
        return;
      }

      for (const patch of patches.values()) patch.ageSeconds += dt;
      // A patch that has run past its own life is dropped rather than drawn at
      // zero forever: the delta that would have removed it may have been missed,
      // and `hydroWetness` says it is gone either way.
      for (const [key, patch] of patches) {
        if (isDried(patch.ageSeconds)) patches.delete(key);
      }

      if (pendingGround > 0) {
        sinceRetrySeconds += dt;
        if (sinceRetrySeconds >= HYDRO_GROUND_RETRY_SECONDS) resolveGround(ctx);
      }

      buildLists();
      puddles.apply(instances);
      puddles.update(elapsedSeconds);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;
    unsubscribePress?.();
    unsubscribePress = null;
    unpublishShade?.();
    unpublishShade = null;
    if (onPointerMove !== null) window.removeEventListener('pointermove', onPointerMove);
    onPointerMove = null;
    bucketHeld = false;
    pourCell = null;
    pointerMoved = false;
    pickedAtX = 0;
    pickedAtY = 0;

    patches.clear();
    instances.length = 0;
    shade.length = 0;
    pendingGround = 0;
    sinceRetrySeconds = 0;

    // The host empties and removes the layer itself; what it cannot know about
    // is the GPU memory behind the decal and the ring, so those are released
    // here.
    puddles?.dispose();
    puddles = null;
    marker?.hide();
    marker?.dispose();
    marker = null;
  },
};

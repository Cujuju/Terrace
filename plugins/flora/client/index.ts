// flora — client half. Draws whatever the server's forest, crop and grass
// messages say is standing, and nothing else.
//
// It holds no authority: it never plants, never fells, never predicts. A tree
// does not move and does not animate, so unlike wildlife there is nothing to
// interpolate between messages either — which is exactly why the server can send
// deltas instead of a stream (see ../protocol.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHEN THE SCENE IS REBUILT, AND WHY THAT IS ALL OF IT.
//
// Every instance matrix is recomputed whenever the tree list changes. The
// obvious alternative — patching only the changed instances — needs a free-list
// mapping cell → instance slot per mesh, plus compaction when a tree in the
// middle is felled, plus a way to keep two meshes' slots consistent. That is
// real bookkeeping to save work that measures as follows:
//
//   3000 trees × (one compose + two setMatrixAt) ≈ tens of microseconds,
//   plus a 192 KB instance-matrix upload per mesh.
//
// A rebuild happens on a growth delta (once per 5 s at most), on a fell (up to
// the sculpt rate, ~10 Hz while a player is actively digging), and on the 60 s
// keepalive. The worst case is therefore a few milliseconds per second during
// sustained sculpting, on the CPU side of a frame that is drawing a thousand
// terrain chunks. Bookkeeping loses.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  FLORA_CHANGES_MESSAGE,
  FLORA_CROPS_MESSAGE,
  FLORA_CROP_CHANGES_MESSAGE,
  FLORA_FOREST_MESSAGE,
  FLORA_GRASS_MESSAGE,
  FLORA_GRASS_CHANGES_MESSAGE,
  FLORA_FRINGE_MESSAGE,
  FLORA_FRINGE_CHANGES_MESSAGE,
  FLORA_PLUGIN_NAME,
  cropKey,
  fringeCellOf,
  fringeKey,
  grassKey,
  parseChangesPayload,
  parseCropChangesPayload,
  parseCropsPayload,
  parseForestPayload,
  parseFringeChangesPayload,
  parseFringePayload,
  parseGrassChangesPayload,
  parseGrassPayload,
  treeKey,
  type CropCell,
  type FringeBySpecies,
  type FringeCell,
  type FringeSpecies,
  type GrassCell,
  type TreeCell,
} from '../protocol.ts';
import { createCropModels, type CropModels } from './cropModels.ts';
import { cropPlacementsFor } from './cropPlacement.ts';
import { createFringeModels, type FringeModels } from './fringeModels.ts';
import { fringePlacementsFor } from './fringePlacement.ts';
import { createGrassModels, type GrassModels } from './grassModels.ts';
import { grassPlacementsFor } from './grassPlacement.ts';
import { createFloraModels, type FloraModels } from './models.ts';
import { placementsFor } from './placement.ts';

/**
 * Seconds between retries while some tree's ground is still unknown.
 *
 * The condition resolves when a chunk's heights arrive — a network event at
 * human pace (someone unlocking territory, or the join snapshot landing), never
 * a per-frame one. Half a second is imperceptible for a tree appearing and costs
 * at most two rebuilds a second, and only while at least one tree is waiting; a
 * fully-streamed world does no work here at all.
 *
 * The alternative — re-checking every tree every frame — is 3000 height lookups
 * and a full matrix upload per frame, forever, to catch an event that happens a
 * handful of times per session.
 */
export const FLORA_GROUND_RETRY_SECONDS = 0.5;

/**
 * Module-level singletons, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin, and
 * `attach`/`dispose` bracket their whole lifetime.
 */
let models: FloraModels | null = null;
let cropModels: CropModels | null = null;
let grassModels: GrassModels | null = null;
let fringeModels: FringeModels | null = null;
let unsubscribeMessages: Array<() => void> = [];
/** Withdraws this plugin's aimable objects from the host's pick set. */
let unmarkPickable: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

/** Standing trees by packed cell key. The client's whole model of the world. */
const trees = new Map<number, TreeCell>();

/** Standing crops by packed cell key (card 28) — the crop analogue of `trees`. */
const crops = new Map<number, CropCell>();

/** Standing grass tufts by packed cell key — the same map, a third time. */
const grass = new Map<number, GrassCell>();

/**
 * Standing fringe plants by packed cell key — the same map a fourth time, with
 * a VALUE this time: the species, which the other three populations have no
 * equivalent of. Keyed by cell, which is what lets a species change arrive as a
 * bare sprout with no matching wither (server/fringe.ts's advance says why).
 */
const fringe = new Map<number, FringeSpecies>();

/** Trees whose ground was unknown at the last rebuild, and the retry clock. */
let pendingGround = 0;
let sinceRetrySeconds = 0;

/** Crops whose ground was unknown at the last rebuild — its own counter, since it is a different map on the same retry clock. */
let pendingCropGround = 0;

/** Tufts whose ground was unknown at the last rebuild. Third map, third counter, same clock. */
let pendingGrassGround = 0;

/** Fringe plants whose ground was unknown at the last rebuild. Fourth map, fourth counter, same clock. */
let pendingFringeGround = 0;

function rebuild(ctx: ClientPluginCtx): void {
  if (models === null) return;
  const result = placementsFor(trees.values(), (x, y) => ctx.terrainHeightAt(x, y));
  models.apply(result.placements);
  pendingGround = result.pendingGround;
  sinceRetrySeconds = 0;
}

/**
 * REBUILDS ARE WHOLESALE HERE TOO, and this is the population where that
 * deserves a number rather than a shrug. The header's argument is
 * "3000 trees × one compose is tens of microseconds"; the meadow is up to
 * FLORA_GRASS_CAP × GRASS_BLADES_PER_TUFT ≈ 205k matrices, i.e. roughly
 * seventy times that — low single-digit milliseconds on a fully unlocked 512²
 * world, and only on a message that actually changed something.
 *
 * The frequency is what keeps it affordable: a survey delta at most every 5 s,
 * a sculpt delta at the sculpt rate, and the 60 s keepalive. It is the SCULPT
 * case that is worth naming — digging near grass rebuilds the whole meadow at
 * up to 10 Hz — and it is bounded by the same thing that bounds the cap: a
 * client only ever holds the grass on ground it has unlocked.
 */
function rebuildGrass(ctx: ClientPluginCtx): void {
  if (grassModels === null) return;
  const result = grassPlacementsFor(grass.values(), (x, y) => ctx.terrainHeightAt(x, y));
  grassModels.apply(result.placements);
  pendingGrassGround = result.pendingGround;
  sinceRetrySeconds = 0;
}

/**
 * REBUILDS ARE WHOLESALE HERE TOO, for rebuildGrass' reasons and at a quarter
 * of its worst case: FLORA_FRINGE_CAP × FRINGE_MAX_STEMS_PER_PLANT is under
 * 60k matrices against the meadow's ≈ 205k.
 */
function rebuildFringe(ctx: ClientPluginCtx): void {
  if (fringeModels === null) return;
  const plants = Array.from(
    fringe,
    ([key, species]): readonly [FringeCell, FringeSpecies] => [fringeCellOf(key), species],
  );
  const result = fringePlacementsFor(plants, (x, y) => ctx.terrainHeightAt(x, y));
  fringeModels.apply(result.placements);
  pendingFringeGround = result.pendingGround;
  sinceRetrySeconds = 0;
}

function rebuildCrops(ctx: ClientPluginCtx): void {
  if (cropModels === null) return;
  const result = cropPlacementsFor(crops.values(), (x, y) => ctx.terrainHeightAt(x, y));
  cropModels.apply(result.placements);
  pendingCropGround = result.pendingGround;
  // Shares the tree retry clock (sinceRetrySeconds) rather than keeping a
  // second one: both populations retry on the identical condition (a chunk's
  // heights just streamed in), and one onFrame subscription already checks
  // "is EITHER pending count non-zero" below — see the FLORA_GROUND_RETRY_SECONDS
  // subscription at the bottom of attach().
  sinceRetrySeconds = 0;
}

function replaceForest(cells: readonly TreeCell[]): void {
  trees.clear();
  for (const cell of cells) trees.set(treeKey(cell.x, cell.y), cell);
}

function replaceCrops(cells: readonly CropCell[]): void {
  crops.clear();
  for (const cell of cells) crops.set(cropKey(cell.x, cell.y), cell);
}

function replaceGrass(cells: readonly GrassCell[]): void {
  grass.clear();
  for (const cell of cells) grass.set(grassKey(cell.x, cell.y), cell);
}

/** replaceGrass' contract for the fringe: the two per-species lists ARE the whole state. */
function replaceFringe(bySpecies: FringeBySpecies): void {
  fringe.clear();
  for (const cell of bySpecies.reed) fringe.set(fringeKey(cell.x, cell.y), 'reed');
  for (const cell of bySpecies.heather) fringe.set(fringeKey(cell.x, cell.y), 'heather');
}

/**
 * Applies one delta. Fells are processed BEFORE growths so that a message which
 * (impossibly today, but cheaply guarded) lists the same cell in both ends up
 * with the tree present — matching the server, where a cell can only be replanted
 * by a survey that ran after the fell.
 */
function applyChanges(grown: readonly TreeCell[], felled: readonly TreeCell[]): void {
  for (const cell of felled) trees.delete(treeKey(cell.x, cell.y));
  for (const cell of grown) trees.set(treeKey(cell.x, cell.y), cell);
}

/** applyChanges' shape, restated for crops: withers before sprouts, same reasoning. */
function applyCropChanges(sprouted: readonly CropCell[], withered: readonly CropCell[]): void {
  for (const cell of withered) crops.delete(cropKey(cell.x, cell.y));
  for (const cell of sprouted) crops.set(cropKey(cell.x, cell.y), cell);
}

/** The same, a third time, for the meadow. */
function applyGrassChanges(sprouted: readonly GrassCell[], withered: readonly GrassCell[]): void {
  for (const cell of withered) grass.delete(grassKey(cell.x, cell.y));
  for (const cell of sprouted) grass.set(grassKey(cell.x, cell.y), cell);
}

/**
 * The same, a fourth time. Withers first for applyChanges' reason, and a sprout
 * OVERWRITES rather than inserts — which is what makes a species change a
 * one-sided delta.
 */
function applyFringeChanges(sprouted: FringeBySpecies, withered: readonly FringeCell[]): void {
  for (const cell of withered) fringe.delete(fringeKey(cell.x, cell.y));
  for (const cell of sprouted.reed) fringe.set(fringeKey(cell.x, cell.y), 'reed');
  for (const cell of sprouted.heather) fringe.set(fringeKey(cell.x, cell.y), 'heather');
}

export const clientPlugin: TerraceClientPlugin = {
  name: FLORA_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    // Module scope outlives an attach, so a re-attach after a rejoin would
    // otherwise open on the previous world's forest (and crop field).
    trees.clear();
    crops.clear();
    grass.clear();
    fringe.clear();
    pendingGround = 0;
    pendingCropGround = 0;
    pendingGrassGround = 0;
    pendingFringeGround = 0;
    sinceRetrySeconds = 0;

    models = createFloraModels();
    ctx.layer.add(models.root);
    // A TREE IS SOMETHING YOU CAN POINT AT. Without this, a ray through a
    // canopy carries on to the ground several cells behind it, and the torch
    // lights bare dirt behind the wood the player was aiming at
    // (ClientPluginCtx.pickWorldCell).
    unmarkPickable.push(ctx.markPickable(models.root));

    cropModels = createCropModels();
    ctx.layer.add(cropModels.root);
    // Crops too: knee-high, so the parallax is small, but a field is exactly
    // the sort of thing a player sets light to on purpose.
    unmarkPickable.push(ctx.markPickable(cropModels.root));

    grassModels = createGrassModels();
    ctx.layer.add(grassModels.root);
    // DELIBERATELY NOT PICKABLE, unlike the trees and the crops above. Grass
    // covers a third of every green cell in the world, so registering it would
    // put a ribbon of geometry between the camera and almost every point of
    // ground a player could aim at — every sculpt click would land on a blade
    // of grass instead of on the terrain. markPickable is opt-in precisely so
    // that a plugin can say "this is scenery, not part of the solid world",
    // which is exactly what grass is: you dig THROUGH it, not at it.

    fringeModels = createFringeModels();
    ctx.layer.add(fringeModels.root);
    // DELIBERATELY NOT PICKABLE either, for grass's reason and one more of its
    // own: reeds stand exactly where a player aims when shaping a coastline, so
    // making them pickable would put a ribbon between the cursor and the one
    // piece of ground the fringe exists to decorate.

    unsubscribeMessages = [
      ctx.onMessage(FLORA_FOREST_MESSAGE, (payload) => {
        const cells = parseForestPayload(payload);
        // A malformed payload is dropped whole: the previous forest keeps
        // rendering until the next good message, which is at most one keepalive
        // away. Clearing the world on a parse failure would be the one outcome
        // strictly worse than showing slightly stale trees.
        if (cells === null) return;
        replaceForest(cells);
        rebuild(ctx);
      }),

      ctx.onMessage(FLORA_CHANGES_MESSAGE, (payload) => {
        const changes = parseChangesPayload(payload);
        if (changes === null) return;
        applyChanges(changes.grown, changes.felled);
        rebuild(ctx);
      }),

      // Card 28's crops, on their own message pair — same malformed-payload
      // and rebuild-on-apply shape as the two handlers above.
      ctx.onMessage(FLORA_CROPS_MESSAGE, (payload) => {
        const cells = parseCropsPayload(payload);
        if (cells === null) return;
        replaceCrops(cells);
        rebuildCrops(ctx);
      }),

      ctx.onMessage(FLORA_CROP_CHANGES_MESSAGE, (payload) => {
        const changes = parseCropChangesPayload(payload);
        if (changes === null) return;
        applyCropChanges(changes.sprouted, changes.withered);
        rebuildCrops(ctx);
      }),

      // The meadow, on its own message pair — same shape a third time.
      ctx.onMessage(FLORA_GRASS_MESSAGE, (payload) => {
        const cells = parseGrassPayload(payload);
        if (cells === null) return;
        replaceGrass(cells);
        rebuildGrass(ctx);
      }),

      ctx.onMessage(FLORA_GRASS_CHANGES_MESSAGE, (payload) => {
        const changes = parseGrassChangesPayload(payload);
        if (changes === null) return;
        applyGrassChanges(changes.sprouted, changes.withered);
        rebuildGrass(ctx);
      }),

      // The fringe, on its own message pair — same shape a fourth time, with
      // the per-species payload the other three have no equivalent of.
      ctx.onMessage(FLORA_FRINGE_MESSAGE, (payload) => {
        const bySpecies = parseFringePayload(payload);
        if (bySpecies === null) return;
        replaceFringe(bySpecies);
        rebuildFringe(ctx);
      }),

      ctx.onMessage(FLORA_FRINGE_CHANGES_MESSAGE, (payload) => {
        const changes = parseFringeChangesPayload(payload);
        if (changes === null) return;
        applyFringeChanges(changes.sprouted, changes.withered);
        rebuildFringe(ctx);
      }),
    ];

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (
        pendingGround === 0 &&
        pendingCropGround === 0 &&
        pendingGrassGround === 0 &&
        pendingFringeGround === 0
      ) {
        return;
      }
      sinceRetrySeconds += dt;
      if (sinceRetrySeconds < FLORA_GROUND_RETRY_SECONDS) return;
      if (pendingGround !== 0) rebuild(ctx);
      if (pendingCropGround !== 0) rebuildCrops(ctx);
      if (pendingGrassGround !== 0) rebuildGrass(ctx);
      if (pendingFringeGround !== 0) rebuildFringe(ctx);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    for (const unmark of unmarkPickable) unmark();
    unmarkPickable = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;

    trees.clear();
    crops.clear();
    grass.clear();
    fringe.clear();
    pendingGround = 0;
    pendingCropGround = 0;
    pendingGrassGround = 0;
    pendingFringeGround = 0;
    sinceRetrySeconds = 0;

    fringeModels?.dispose();
    fringeModels = null;

    grassModels?.dispose();
    grassModels = null;

    cropModels?.dispose();
    cropModels = null;

    // The host empties and removes the layer itself; what it cannot know about
    // is the GPU memory behind the instanced meshes, so that is released here.
    models?.dispose();
    models = null;
  },
};

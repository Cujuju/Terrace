// flora — client half. Draws whatever the server's forest, crop, grass, fringe
// and stump messages say is standing, and nothing else.
//
// It holds no authority: it never plants, never fells, never predicts, and it
// runs no clock of its own — not even for the stumps, which are the one thing
// here with a lifetime (see `stumps` below). A tree does not move and does not
// animate, so unlike wildlife there is nothing to interpolate between messages
// either — which is exactly why the server can send deltas instead of a stream
// (see ../protocol.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHEN THE SCENE IS REBUILT, AND WHERE THAT STOPPED BEING ALL OF IT.
//
// THE FOREST, THE CROPS AND THE STUMPS still recompute every instance matrix
// whenever their list changes. The obvious alternative — patching only the
// changed instances — needs a free list mapping cell → instance slot per mesh,
// plus compaction when a tree in the middle is felled, plus a way to keep two
// meshes' slots consistent. That is real bookkeeping to save work that measures
// as follows:
//
//   3000 trees × (one compose + two setMatrixAt) ≈ tens of microseconds,
//   plus a 192 KB instance-matrix upload per mesh.
//
// A rebuild happens on a growth delta (once per 5 s at most), on a fell (up to
// the sculpt rate, ~10 Hz while a player is actively digging), and on the 60 s
// keepalive. The worst case is therefore a few milliseconds per second during
// sustained sculpting, on the CPU side of a frame that is drawing a thousand
// terrain chunks. At THIS population, bookkeeping loses.
//
// THE MEADOW AND THE FRINGE DO NOT (GH #256, #260). Reread the arithmetic above
// at their populations and it inverts: the meadow is FLORA_GRASS_CAP ×
// GRASS_BLADES_PER_TUFT ≈ 205 000 matrices and a 28 MB upload, the fringe
// 164 000 and 10.5 MB — measured at 5.4 ms for one uprooted cell on a
// 4 293-tuft world and 12.6 ms at 10 846, arriving at the same ~10 Hz sculpt
// rate against a 7.1 ms frame budget. So those two carry exactly the slot table
// the paragraph above declined to build, and their CHANGES messages take a
// delta path (applyGrassDelta, applyFringeDelta) that touches only the cells
// named. One uprooted tuft is 0.003 ms and 640 B.
//
// Their FULL messages — join, unlock, the FLORA_KEEPALIVE_SECONDS repair —
// still rebuild wholesale, which is also what resyncs the slot table.
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
  FLORA_STUMP_MESSAGE,
  FLORA_STUMP_CHANGES_MESSAGE,
  FLORA_PLUGIN_NAME,
  cropKey,
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
  parseStumpChangesPayload,
  parseStumpsPayload,
  stumpKey,
  treeKey,
  type CropCell,
  type FringeBySpecies,
  type FringeCell,
  type FringeSpecies,
  type GrassCell,
  type StumpCell,
  type TreeCell,
} from '../protocol.ts';
import { createCropModels, type CropModels } from './cropModels.ts';
import { cropPlacementsFor } from './cropPlacement.ts';
import { createFringeModels, type FringeModels } from './fringeModels.ts';
import { fringePlacementsFor } from './fringePlacement.ts';
import { createGrassModels, type GrassModels } from './grassModels.ts';
import { grassPlacementsFor } from './grassPlacement.ts';
import { createFloraModels, type FloraModels } from './models.ts';
import { cropOccupancy, treeOccupancy } from './occupancy.ts';
import { placementsFor } from './placement.ts';
import { createStumpModels, type StumpModels } from './stumpModels.ts';
import { stumpPlacementsFor } from './stumpPlacement.ts';

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
let stumpModels: StumpModels | null = null;
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

/**
 * Standing stumps by packed cell key — the same map a fifth time (GH #195).
 *
 * NO LIFETIME HERE, deliberately. A stump rots on the server's simulated clock
 * and arrives as a `rotted` delta like any other removal; a client-side
 * countdown would be a second clock that has to agree with the first, and it
 * would be wrong for exactly the players whose connection dropped over the
 * three minutes it was counting.
 */
const stumps = new Map<number, StumpCell>();

/** Trees whose ground was unknown at the last rebuild, and the retry clock. */
let pendingGround = 0;
let sinceRetrySeconds = 0;

/** Crops whose ground was unknown at the last rebuild — its own counter, since it is a different map on the same retry clock. */
let pendingCropGround = 0;

/**
 * Tufts whose ground was unknown when they were last placed — the third map's
 * retry state, on the same clock, but a SET rather than a counter.
 *
 * Because grass is now placed a delta at a time (GH #256), nothing walks the
 * whole meadow to recount. A set is maintained by the same delta that placed
 * the tufts: a sprout over unknown ground joins it, a sprout that resolves or a
 * wither leaves it, and a full rebuild refills it from scratch. A bare counter
 * cannot do that — it would double-count a cell that sprouts twice without an
 * intervening wither.
 */
const pendingGrassGround = new Set<number>();

/** Fringe plants whose ground was unknown when they were last placed. Fourth map, same clock, same set-not-counter reason. */
const pendingFringeGround = new Set<number>();

/** Stumps whose ground was unknown at the last rebuild. Fifth map, fifth counter, same clock. */
let pendingStumpGround = 0;

function rebuild(ctx: ClientPluginCtx): void {
  if (models === null) return;
  const result = placementsFor(trees.values(), (x, y) => ctx.terrainHeightAt(x, y));
  models.apply(result.placements);
  pendingGround = result.pendingGround;
  sinceRetrySeconds = 0;
}

/** The one ground lookup every placement pass shares — hoisted so each pass allocates one closure, not one per cell. */
function groundLookup(ctx: ClientPluginCtx): (x: number, y: number) => number | null {
  return (x, y) => ctx.terrainHeightAt(x, y);
}

/**
 * THE WHOLESALE REBUILD, and it is now the RARE path (GH #256): a full grass
 * message — the join snapshot, an unlock, the FLORA_KEEPALIVE_SECONDS repair —
 * replaces the meadow outright, because that message IS the whole population
 * and there is nothing to diff it against.
 *
 * It is the expensive one and it stays expensive: up to FLORA_GRASS_CAP ×
 * GRASS_BLADES_PER_TUFT ≈ 205k matrices, measured at 3.93 ms for 4 293 tufts
 * and 64 ms at the cap. What changed is that it no longer runs on every
 * one-cell uproot — see applyGrassDelta, which is what the sculpt rate hits.
 *
 * It is also the RESYNC: the delta path's slot table, its conservative culling
 * box and its over-cap drops are all repaired here, so any divergence lasts at
 * most one keepalive.
 */
function rebuildGrass(ctx: ClientPluginCtx): void {
  if (grassModels === null) return;
  const result = grassPlacementsFor(grass.values(), groundLookup(ctx));
  grassModels.apply(result.placements);
  pendingGrassGround.clear();
  for (const key of result.pendingCells) pendingGrassGround.add(key);
  sinceRetrySeconds = 0;
}

/**
 * THE DELTA PATH — what a sculpt actually hits, and the reason this plugin
 * stopped costing a whole meadow per dug cell (GH #256).
 *
 * Correct only because a standing tuft's ground CANNOT move: the server uproots
 * the grass on every cell it edits (server/index.ts's reactToTerrain) and
 * `terrainHeightAt` is a per-cell lattice read, so a tuft that survives a
 * sculpt has exactly the height it was placed at. Nothing else here needs
 * re-placing, which is the whole licence for touching only the delta.
 */
function applyGrassDelta(
  ctx: ClientPluginCtx,
  sprouted: readonly GrassCell[],
  withered: readonly GrassCell[],
): void {
  if (grassModels === null) return;
  for (const cell of withered) pendingGrassGround.delete(grassKey(cell.x, cell.y));

  const result = grassPlacementsFor(sprouted, groundLookup(ctx));
  // A sprout that resolved CLEARS an earlier pending mark for the same cell:
  // the retry clock must stop for a tuft that is now standing.
  for (const placement of result.placements) {
    pendingGrassGround.delete(grassKey(placement.cellX, placement.cellY));
  }
  for (const key of result.pendingCells) pendingGrassGround.add(key);

  grassModels.applyDelta(result.placements, withered);
  sinceRetrySeconds = 0;
}

/**
 * THE WHOLESALE REBUILD, rebuildGrass' rare path at a quarter of its worst case
 * (FLORA_FRINGE_CAP × FRINGE_MAX_STEMS_PER_PLANT is under 60k matrices against
 * the meadow's ≈ 205k), and the same resync for the same reasons.
 *
 * The map goes STRAIGHT IN. It is already `Map<fringeKey, FringeSpecies>`,
 * which is exactly what fringePlacementsFor now takes, so the array of decoded
 * cells this used to build per rebuild is gone (GH #260).
 */
function rebuildFringe(ctx: ClientPluginCtx): void {
  if (fringeModels === null) return;
  const result = fringePlacementsFor(fringe, groundLookup(ctx));
  fringeModels.apply(result.placements);
  pendingFringeGround.clear();
  for (const key of result.pendingCells) pendingFringeGround.add(key);
  sinceRetrySeconds = 0;
}

/** applyGrassDelta, for the fringe — same licence, same server rule (reactToEdit strips the fringe on an edited cell). */
function applyFringeDelta(
  ctx: ClientPluginCtx,
  sprouted: FringeBySpecies,
  withered: readonly FringeCell[],
): void {
  if (fringeModels === null) return;
  for (const cell of withered) pendingFringeGround.delete(fringeKey(cell.x, cell.y));

  // Delta-sized, not population-sized: the two per-species lists flattened into
  // the [key, species] pairs fringePlacementsFor reads.
  const plants: Array<readonly [number, FringeSpecies]> = [];
  for (const cell of sprouted.reed) plants.push([fringeKey(cell.x, cell.y), 'reed']);
  for (const cell of sprouted.heather) plants.push([fringeKey(cell.x, cell.y), 'heather']);

  const result = fringePlacementsFor(plants, groundLookup(ctx));
  for (const placement of result.placements) {
    pendingFringeGround.delete(fringeKey(placement.cellX, placement.cellY));
  }
  for (const key of result.pendingCells) pendingFringeGround.add(key);

  fringeModels.applyDelta(result.placements, withered);
  sinceRetrySeconds = 0;
}

/**
 * REBUILDS ARE WHOLESALE HERE TOO, and this is the population where it costs
 * least: FLORA_STUMP_CAP is 4096 matrices — the same order as the forest's, and
 * a fiftieth of the meadow's — and it is only ever reached by a world that has
 * burned down. On a world that is not on fire this runs over an empty map.
 */
function rebuildStumps(ctx: ClientPluginCtx): void {
  if (stumpModels === null) return;
  const result = stumpPlacementsFor(stumps.values(), (x, y) => ctx.terrainHeightAt(x, y));
  stumpModels.apply(result.placements);
  pendingStumpGround = result.pendingGround;
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

function replaceStumps(cells: readonly StumpCell[]): void {
  stumps.clear();
  for (const cell of cells) stumps.set(stumpKey(cell.x, cell.y), cell);
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

/**
 * The same, a fifth time. Rots first for applyChanges' reason — and here the
 * guarded case is real rather than theoretical: a cell can be cleared by a
 * sculpt and burned again later, and the two would arrive in one message only
 * if the server ever batched them, which it does not today.
 */
function applyStumpChanges(left: readonly StumpCell[], rotted: readonly StumpCell[]): void {
  for (const cell of rotted) stumps.delete(stumpKey(cell.x, cell.y));
  for (const cell of left) stumps.set(stumpKey(cell.x, cell.y), cell);
}

/**
 * Flora draws every population through InstancedMesh pools, so its cost is a
 * FIXED number of surfaces for the whole world rather than one per plant —
 * FLORA_TREE_CAP, FLORA_CROP_CAP, FLORA_GRASS_CAP, FLORA_STUMP_CAP and
 * FLORA_FRINGE_CAP bound the INSTANCES inside these, not the draw calls.
 * Measured 2026-08-29, per rig: trees 3, crops 2, grass 3, stumps 2, fringe 4.
 */
const TREE_DRAW_OBJECTS = 3;
const CROP_DRAW_OBJECTS = 2;
const GRASS_DRAW_OBJECTS = 3;
const STUMP_DRAW_OBJECTS = 2;
const FRINGE_DRAW_OBJECTS = 4;

export const clientPlugin: TerraceClientPlugin = {
  name: FLORA_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: TREE_DRAW_OBJECTS +
    CROP_DRAW_OBJECTS +
    GRASS_DRAW_OBJECTS +
    STUMP_DRAW_OBJECTS +
    FRINGE_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    // Module scope outlives an attach, so a re-attach after a rejoin would
    // otherwise open on the previous world's forest (and crop field).
    trees.clear();
    crops.clear();
    grass.clear();
    fringe.clear();
    stumps.clear();
    pendingGround = 0;
    pendingCropGround = 0;
    pendingGrassGround.clear();
    pendingFringeGround.clear();
    pendingStumpGround = 0;
    sinceRetrySeconds = 0;

    models = createFloraModels();
    ctx.layer.add(models.root);
    // A TREE IS SOMETHING YOU CAN POINT AT. Without this, a ray through a
    // canopy carries on to the ground several cells behind it, and the torch
    // lights bare dirt behind the wood the player was aiming at
    // (ClientPluginCtx.pickWorldCell).
    // WITH AN OCCUPANCY LOOKUP, so the pick never raycasts the forest: three
    // walks every live instance of an InstancedMesh, which at the cap is eight
    // thousand per-instance tests for one pointer position (GH #252). The
    // lookup answers the same question from the cells the plugin was handed.
    unmarkPickable.push(
      ctx.markPickable(models.root, treeOccupancy(trees, groundLookup(ctx))),
    );

    cropModels = createCropModels();
    ctx.layer.add(cropModels.root);
    // Crops too: knee-high, so the parallax is small, but a field is exactly
    // the sort of thing a player sets light to on purpose.
    unmarkPickable.push(
      ctx.markPickable(
        cropModels.root,
        cropOccupancy(crops, groundLookup(ctx), cropModels.plotReach),
      ),
    );

    grassModels = createGrassModels();
    ctx.layer.add(grassModels.root);
    // DELIBERATELY NOT PICKABLE, unlike the trees and the crops above. Grass
    // covers a third of every green cell in the world, so registering it would
    // put a ribbon of geometry between the camera and almost every point of
    // ground a player could aim at — every sculpt click would land on a blade
    // of grass instead of on the terrain. markPickable is opt-in precisely so
    // that a plugin can say "this is scenery, not part of the solid world",
    // which is exactly what grass is: you dig THROUGH it, not at it.

    stumpModels = createStumpModels();
    ctx.layer.add(stumpModels.root);
    // DELIBERATELY NOT PICKABLE, for grass's reason. A stump is knee-high and
    // sits in exactly the ground a player wants to re-sculpt after a fire, so
    // registering it would put geometry between the cursor and the burnt patch
    // the player is trying to dig out. There is nothing to aim AT here either:
    // stumps are not fuel (server/index.ts's floraFuelAt lists three
    // populations, and this is not one of them — a stump has already burned).

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
        // The DELTA, not a rebuild: this is the message a sculpt produces, at
        // up to the sculpt rate, and it names one or two cells (GH #256).
        applyGrassDelta(ctx, changes.sprouted, changes.withered);
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
        // The DELTA, for rebuildGrass' handler's reason (GH #260).
        applyFringeDelta(ctx, changes.sprouted, changes.withered);
      }),

      // The stumps, on their own message pair — same shape a fifth time.
      ctx.onMessage(FLORA_STUMP_MESSAGE, (payload) => {
        const cells = parseStumpsPayload(payload);
        if (cells === null) return;
        replaceStumps(cells);
        rebuildStumps(ctx);
      }),

      ctx.onMessage(FLORA_STUMP_CHANGES_MESSAGE, (payload) => {
        const changes = parseStumpChangesPayload(payload);
        if (changes === null) return;
        applyStumpChanges(changes.left, changes.rotted);
        rebuildStumps(ctx);
      }),
    ];

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (
        pendingGround === 0 &&
        pendingCropGround === 0 &&
        pendingGrassGround.size === 0 &&
        pendingFringeGround.size === 0 &&
        pendingStumpGround === 0
      ) {
        return;
      }
      sinceRetrySeconds += dt;
      if (sinceRetrySeconds < FLORA_GROUND_RETRY_SECONDS) return;
      if (pendingGround !== 0) rebuild(ctx);
      if (pendingCropGround !== 0) rebuildCrops(ctx);
      // The WHOLESALE rebuilds, deliberately: a chunk's heights have just
      // arrived, so this is exactly the event the delta path cannot see.
      if (pendingGrassGround.size !== 0) rebuildGrass(ctx);
      if (pendingFringeGround.size !== 0) rebuildFringe(ctx);
      if (pendingStumpGround !== 0) rebuildStumps(ctx);
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
    stumps.clear();
    pendingGround = 0;
    pendingCropGround = 0;
    pendingGrassGround.clear();
    pendingFringeGround.clear();
    pendingStumpGround = 0;
    sinceRetrySeconds = 0;

    stumpModels?.dispose();
    stumpModels = null;

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

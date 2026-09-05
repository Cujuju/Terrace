// Wires the mirror, the meshes and the network together: one object that owns
// "the world as this client knows it".
//
// CRITICAL CODE — the message → mirror → dirty chunks → patched meshes chain
// lives here, and it is the only path by which terrain changes.
//
// The world size is not known until the join snapshot arrives, and the mirror
// and mesh set are sized from it, so both are created lazily and replaced
// wholesale on a (re)join. Everything downstream reads them through accessors
// for that reason — a stale direct reference would silently keep drawing the
// previous session's terrain.

import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEFAULT_WORLD_SIZE,
  bandOf,
  cellIndex,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  quantizeToBand,
  spanAt,
  spanCapHeight,
  spanCount,
  spanUndersideHeight,
} from '@terrace/shared';
import type {
  ChunkUnlockMessage,
  JoinSnapshotMessage,
  SculptAppliedMessage,
  SculptDeniedMessage,
  SculptIntent,
  TerrainDiffMessage,
} from '@terrace/shared';
import type { Material, Mesh } from 'three';
import {
  applyChunkUnlock,
  applySnapshot,
  createTerrainMirror,
  isCellReceived,
  sampleHeight,
  type TerrainMirror,
} from './terrain/mirror.ts';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from './config.ts';
import { setServerVersion, setWorldIdentity } from './state/hudState.ts';
import { noteBuildIdentity } from './net/buildReload.ts';
import {
  setPendingRestartSeconds,
  setPendingSwitch,
  setWorldLoaded,
} from './state/worldsState.ts';
import {
  createPredictionStore,
  type PredictionStore,
} from './terrain/prediction.ts';
import { createTerrainMeshes, type TerrainMeshes } from './render/terrainMeshes.ts';
import { createWorkerChunkBuildSource } from './render/chunkBuildSource.ts';
import { createLayerEdgeOverlay, type LayerEdgeOverlay } from './render/layerEdgeOverlay.ts';
import { createFrontierFog, type FrontierFog } from './render/frontierFog.ts';
import { createRiverRig, RIVER_RIG_DRAW_OBJECTS, type RiverRig } from './render/riverRig.ts';
import { createDrawnGround, type DrawnGround } from './terrain/drawnGround.ts';
import { createWorkerRiverNetworkSource } from './render/water/riverNetworkSource.ts';
import type { TerrainSink } from './net/connection.ts';
import type { Viewport } from './render/scene.ts';
import { createWater, WATER_DRAW_OBJECTS, type Water } from './render/water.ts';
import {
  createRevealMask,
  revealedAtCell,
  type RevealClipUniforms,
  type RevealMask,
} from './render/revealMask.ts';
import type { ChartSource } from './terrain/chart.ts';
import {
  pickPointedCellByRay,
  pickTerrainCellByRay,
  type CellOccupancy,
  type PointedCellPick,
  type TerrainRayPick,
  type Vec3,
} from './terrain/picking.ts';

/**
 * How `highlightLayerEdge` should light the lip it finds — the parts of that
 * decision the WORLD cannot make for itself.
 *
 * An options object rather than positional arguments because both fields are
 * about the HIGHLIGHT and neither is about the pick, and a caller reading
 * `{ litSpanWorldUnits: … }` at the call site cannot transpose them.
 */
export interface LayerEdgeLight {
  /**
   * How much of the lip lights up either side of the aimed point, in world
   * units.
   *
   * THE BRUSH RADIUS, in world units, and that is the point of it (owner,
   * 2026-08-27): the lit stretch is then exactly the run of lip a press would
   * move, so the pointer stops being a mark the player has to intersect with
   * the highlight by eye. Passed in because the brush is the HUD's state
   * (state/hudState.ts) and this module knows nothing about the HUD.
   */
  readonly litSpanWorldUnits: number;
  /**
   * A band to light INSTEAD of the one this pick names — a live stroke's
   * frozen grab (input/sculptInput.ts's `heldBand`).
   *
   * WHY IT OVERRIDES THE PICK. A pull drags the pointer OFF the riser it
   * grabbed within the first cell of travel, and the pick-derived band is null
   * everywhere but on a riser — so the lip the player was holding went dark
   * while they were still holding it. What is held is a fact about the STROKE,
   * not about the current ray, and only the stroke knows it.
   *
   * The overlay's membership guard still applies: it asks whether that band's
   * contour runs beside the cell now under the pointer, and if the answer is no
   * then there is no nearby segment to light in the first place.
   */
  readonly heldBand?: number | null;
}

export interface World extends TerrainSink {
  /**
   * Applies the local player's sculpt immediately, before the server has
   * answered (design doc client-side prediction). Call this ONLY for an intent
   * that actually went out on the wire — see main.tsx.
   */
  predictSculpt(intent: SculptIntent): void;
  /** 0 until the first snapshot arrives. */
  worldSize(): number;
  pickables(): Mesh[];
  /**
   * Is cell (x, y) in a chunk the server has sent us, and inside the world?
   *
   * PROMOTED FROM `chartSource`'s CLOSURE (2026-09-02, #284): the chart was
   * not the only caller any more — every plugin that draws over the ground
   * wants the same question answered, and the GPU reveal mask below is built
   * from the same predicate. One definition (render/revealMask.ts's
   * `revealedAtCell`) is what makes the chart, the mask and a plugin's own CPU
   * test incapable of disagreeing. False before the first snapshot.
   */
  revealedAt(x: number, y: number): boolean;
  /**
   * Clips a stock material to the received map and the world edge — the
   * backing for `ClientPluginCtx.applyRevealClip`; see its doc comment.
   */
  applyRevealClip(material: Material, label: string): void;
  /** The shared reveal-clip uniform object, for a plugin's ShaderMaterial. */
  revealClipUniforms(): RevealClipUniforms;
  /**
   * The first terrain cell a world-space ray meets, or null. THE pick: both
   * the sculpt brush (input/sculptInput.ts) and plugin clicks
   * (plugins/host.ts) go through here, so there is one answer to "which cell
   * is under this ray" rather than one per caller.
   *
   * Marched over the height mirror, not raycast against the meshes — see
   * terrain/picking.ts's pickTerrainCellByRay for why. Null before the first
   * snapshot, and for a ray that meets no revealed terrain.
   */
  pickCell(origin: Vec3, direction: Vec3): TerrainRayPick | null;
  /**
   * The first cell a ray meets that has either something STANDING on it or
   * terrain under it — `pickCell`'s question with the world's contents
   * included, for plugins/host.ts's pickWorldCell (GH #252).
   *
   * `occupants` is what the plugins have declared standing on the ground; each
   * is asked once per cell the march crosses. An empty list makes this
   * `pickCell` with a distance attached.
   */
  pickPointedCell(
    origin: Vec3,
    direction: Vec3,
    occupants: readonly CellOccupancy[],
  ): PointedCellPick | null;
  /**
   * Lights up the terrace lip this PICK is pointing at and returns the band a
   * pull starting there would grab, or null when there is none
   * (render/layerEdgeOverlay.ts).
   *
   * ONLY A RISER HIT HAS A LIP TO GRAB: the band is the one whose slab contains
   * the height the ray struck, and the overlay is asked only whether that
   * band's contour actually bounds this cell or a neighbour — a guard, not a
   * search. A pick on a tread or on a roof underside returns null.
   *
   * It takes the whole pick, not just its cell, because a ray that struck a
   * riser names WHICH of the lips stacked on that face is meant — the thing a
   * plan-view distance cannot answer. See the derivation in the implementation.
   */
  highlightLayerEdge(pick: TerrainRayPick | null, light: LayerEdgeLight): number | null;
  /**
   * The terrace band of the terrain at cell (x, y) — `bandOf` the mirrored
   * height, in BAND units, not world units.
   *
   * Lives here, beside the other pick derivations, because it is a question
   * about the height mirror and the mirror is this module's. Its caller
   * (input/sculptInput.ts's seed) has no heightmap, no `bandOf`, and its only
   * height accessor is in world units — deriving a band there would be a unit
   * trap. Read twice, before and after a seed, it says whether the seed
   * actually raised the ground; an absolute read cannot, because `send`
   * reports true for intents that predict nothing.
   *
   * Null before the first snapshot.
   */
  bandAtCell(x: number, y: number): number | null;
  /**
   * The band a stroke starting at this PICK has hold of — `SculptIntent`'s
   * `spanBand`, or null to mean the topmost span.
   *
   * NULL FOR EVERY ORDINARY COLUMN, which is the whole of why step 4.3 changes
   * no behaviour: a column of one span has one surface, the server already
   * moves it, and naming it would only be a chance for the two sides to
   * disagree. The field appears on the wire exactly when the cell picked holds
   * more than one span.
   *
   * Derived here rather than asked of the caller, for the reason
   * `highlightLayerEdge` gives above: two callers deriving the same aim two
   * ways is how they end up grabbing different layers.
   */
  graspSpanBand(pick: TerrainRayPick | null): number | null;
  /**
   * The band a CARVE starting at this pick cuts from — `SculptIntent`'s
   * `spanBand` for the one tool that needs it on ordinary ground too.
   *
   * THE SAME DERIVATION AS `graspSpanBand`, WITHOUT ITS ONE-SPAN SHORTCUT, and
   * that difference is the whole reason it is a second method. `graspSpanBand`
   * says nothing about a column of one span because every other tool moves
   * that column's only surface whatever band is named. A carve does not move a
   * surface: it removes a range, and the range has to start SOMEWHERE, so a
   * carve into a virgin cliff face — the very first cut of any tunnel, when no
   * layered column exists anywhere in the world — needs the band the ray
   * actually struck. Folding this into `graspSpanBand` instead would put a
   * `spanBand` on every stamp and smooth intent over ordinary ground, which is
   * exactly the byte-identity step 4.3 was built to keep.
   *
   * Null only when there is no pick or no world yet.
   */
  carveBand(pick: TerrainRayPick | null): number | null;
  /**
   * World-space Y of the RENDERED terrain surface at cell (x, y): the
   * band-quantised height the terrain mesh actually draws, which is where
   * anything standing on the ground belongs. Cells in never-received chunks
   * read as band 0, exactly like the mesh renders them. Null before the first
   * snapshot. Consumed by the client plugin host (plugins/host.ts).
   * — SUPERSEDED FOR NEVER-RECEIVED CELLS (2026-09-02): those now answer null
   * too, for the reason given at the implementation. The mesh does not render
   * them at all (mirror.ts, invariant 1), so "band 0" was never what the
   * player saw there.
   */
  terrainHeightAt(x: number, y: number): number | null;
  /**
   * AN OPAQUE COUNTER THAT CHANGES WHENEVER THE RENDERED TERRAIN NEAR (x, y)
   * MAY HAVE CHANGED — the cache key for anything derived from the ground.
   *
   * WHAT IT IS FOR. A reader that computes something from a patch of terrain (a
   * settlement's site classification, say) has no cheap way to ask "is my
   * answer still good?", so it either recomputes on every event that might have
   * touched the ground or goes stale. This answers exactly that question, in
   * one array read: equal values mean the chunk holding this cell has not been
   * rewritten since; a different value means it may have been.
   *
   * PER CHUNK, NOT PER CELL, and deliberately: the dirty sets this file already
   * derives to patch the terrain meshes are chunk sets, so a chunk-granular
   * counter is a re-use of work rather than a second derivation of "what
   * changed" that could disagree with the meshes. A reader whose patch spans
   * several chunks asks about each of them.
   *
   * CONSERVATIVE IN THE SAFE DIRECTION: a chunk is marked whenever the meshes
   * are, which includes a predicted sculpt and its authoritative echo, and a
   * chunk's back-neighbours across a shared border. It may therefore report a
   * change where a particular reader would have seen none; it never misses one.
   *
   * COMPARE FOR EQUALITY ONLY. The value is monotonic within a session, but its
   * magnitude, its step size and its behaviour across a rejoin are not part of
   * the contract. 0 before the first snapshot.
   */
  terrainRevisionAt(x: number, y: number): number;
  /**
   * World-space Y of the cap of ONE span — the `spanIndex` a pick reported —
   * at cell (x, y), or null when that span no longer exists (the column was
   * carved, welded or the chunk left). The surface a cached pick must be
   * refreshed against on a LAYERED column: `terrainHeightAt` is the TOPMOST
   * span's cap, and reading it for a pick that struck a lower span lifted the
   * pointer onto the roof (owner report 2026-08-27, "it jumps up several
   * bands" — a tread hit at 1.5 wu on the floor of a carved notch was rewritten
   * to the roof's 2.75 wu).
   */
  spanCapAt(x: number, y: number, spanIndex: number): number | null;
  /**
   * How many spans the column at (x, y) holds right now — 0 off the world or
   * before the first snapshot.
   *
   * THE LENGTH OF THE LIST A `spanIndex` INDEXES, which is state (columns.ts's
   * `spanIndexCoveringBand`): a carve that splits a column, or a raise that
   * welds two of its spans, renumbers every span above the change. A cached
   * pick can only keep its index while this count is the one it was taken
   * under; past that the index names a different span, not a moved one.
   */
  spanCountAt(x: number, y: number): number;
  /**
   * Whether the span `spanIndex` of the column at (x, y) still DRAWS the
   * world-space height `worldY` — i.e. `worldY` lies in the slab the renderer
   * fills for it, from its underside (columns.ts `spanUndersideHeight`) to its
   * cap. False when the cell, the index or the height is outside that.
   *
   * The test a cached RISER hit has to survive: `bandOfPick` clamps a struck
   * height into the span's drawn range, which is right for a hit that landed on
   * a slab boundary but turns a hit at a height the span no longer reaches into
   * a silent claim about the band at the end of the clamp. A pick that fails
   * this is not refreshable — it must be re-picked.
   */
  spanContainsHeight(x: number, y: number, spanIndex: number, worldY: number): boolean;
  /**
   * World-space Y of the cap the terrain ACTUALLY DRAWS at a (fractional) cell
   * coordinate — terrain/drawnGround.ts's `capYAt`, read from the plan the
   * terrain meshes published when they last drew that chunk.
   *
   * DISTINCT FROM `terrainHeightAt`, and the difference is the whole reason
   * drawnGround.ts exists: `terrainHeightAt` answers "which band does the CELL
   * LATTICE put this cell in", while a band's cap is drawn over the region
   * enclosed by the SMOOTHED MARCHED CONTOUR at that band's threshold. On the
   * `fork` fixture the two disagreed by a full band on 430 of 6745 probes
   * (drawnGround.ts's header), and a full band is a whole world unit of
   * relief. Anything LAID FLAT ON the drawn surface — a decal, a sheet of
   * water — must ask this one; anything merely STANDING on the ground can
   * afford the lattice answer, because a thing standing up is not seen against
   * the surface it stands on.
   *
   * Null before the first snapshot, exactly as `terrainHeightAt` is.
   */
  drawnGroundYAt(cellX: number, cellZ: number): number | null;
  /**
   * A read-only window onto the mirror for the Cartographer (ui/Cartographer):
   * the world size, raw heights, and which cells sit in received chunks. Null
   * before the first snapshot. The returned source closes over the CURRENT
   * mirror, so a chart being drawn stays internally consistent even if a
   * rejoin replaces the world mid-draw — it charts the world it was opened on.
   */
  chartSource(): ChartSource | null;
  /**
   * Core's terrain-side share of the frame's draw budget: the terrain
   * super-meshes, the frontier fog, the sea, the river rig and the layer-edge
   * overlay (part B of docs/plans/frame-budget-growth-and-draw-calls.md).
   *
   * HERE BECAUSE THE RIGS ARE HERE — `createWorld` is what builds all five,
   * and a budget assembled anywhere else would be a list to keep in sync with
   * this file. main.tsx adds the two rigs it owns (the brush preview and, when
   * it exists, the pick-debug overlay) and hands the total to the plugin host.
   *
   * LIVE, not a constant: the terrain's and the fog's counts are their
   * super-mesh counts, and the layer-edge overlay's is one per chunk with lips
   * — all three grow as a world is revealed. Zero for the terrain-side rigs
   * before the first snapshot, when there are none.
   */
  drawBudget(): number;
  dispose(): void;
}

/**
 * Monotonic clock for prediction deadlines. `performance.now()` rather than
 * `Date.now()`: these timestamps are only ever compared to each other, and a
 * wall-clock adjustment (NTP step, DST) must not be able to expire — or
 * indefinitely postpone — a pending prediction.
 */
const nowMs = (): number => performance.now();

/**
 * The empty dirty set, for the callers that tick a throttled consumer without
 * naming any chunk. Shared and never written: every consumer that takes a
 * dirty set only iterates it.
 */
const NO_CHUNKS: ReadonlySet<number> = new Set<number>();

export function createWorld(viewport: Viewport): World {
  // One sea for the whole session, like the fog and rivers below. It draws
  // NOTHING until the first snapshot's `water.sync`: since the surface covers
  // the received chunks and nothing else (render/water.ts), a client that has
  // received no chunks has no sea — which replaces the old "the disconnected
  // boot state is a plausible empty ocean rather than a void" behaviour, that
  // ocean being the very thing the owner asked to be rid of (2026-08-24).
  const water: Water = createWater(viewport.scene, DEFAULT_WORLD_SIZE);
  // One fog curtain for the whole session, like water — its segments are
  // synced (added/disposed) against whatever mirror currently exists rather
  // than being torn down and recreated on every rejoin.
  const fog: FrontierFog = createFrontierFog(viewport.scene, viewport.onFrame);
  // THE REVEAL MASK, and it belongs beside the fog rather than anywhere else
  // because it is the SAME fact: the frontier mist and the mask are both
  // derived from `received`, they are synced at the same two call sites, and a
  // mask that disagreed with the mist would draw a plugin's cloud over the
  // very seam the mist exists to cover. One for the whole session, like water
  // and fog, resized in place on a rejoin into a different world.
  const revealMask: RevealMask = createRevealMask(DEFAULT_WORLD_SIZE);
  // Rivers, pools and waterfalls (mechanics cards 27 & 40) — a third derived
  // layer alongside water and fog, same lifetime, same "one instance for the
  // whole session" shape. Its own refresh() is throttled internally, so
  // calling it from applyDirty below (the one place terrain changes) is free
  // on every call that lands inside the throttle window.
  // The network recompute is GLOBAL by nature (a scan for local maxima over
  // every active cell, then a trace from every spring it finds) and measured at
  // ~24 ms on a revealed 512² world — over the whole 7.1 ms frame budget on its
  // own — so it runs in a worker. Where one cannot be started (an old browser, a
  // CSP that forbids module workers), the source falls back to this thread:
  // slower, never wrong.
  const rivers: RiverRig = createRiverRig(viewport.scene, viewport.onFrame, {
    networkSource: createWorkerRiverNetworkSource() ?? undefined,
  });

  /**
   * The chunk-geometry worker pool, or null where no Worker could be started
   * (an old browser, a CSP that forbids module workers) — in which case
   * `createTerrainMeshes` falls back to building on this thread: slower, never
   * wrong. One pool for the whole session, like the water and river rigs.
   */
  const chunkBuildSource = createWorkerChunkBuildSource();

  /**
   * The one-element dirty set `onChunkDrawn` hands the river rig. Reused across
   * splices — see the subscription in `resetWorld` for why that is safe.
   */
  const drawnChunkScratch = new Set<number>();

  let mirror: TerrainMirror | null = null;
  /**
   * The drawn-surface oracle over the CURRENT mirror.
   *
   * IT NEEDS NO INVALIDATION ANY MORE, and that is the point of the 2026-08-26
   * contract fix. It used to memoise a chunk plan of its own, which "MUST NOT
   * outlive a terrain edit" — so four separate places in this file had to
   * remember to null it, and a fifth that forgot would have laid decals on
   * pre-edit contours. It is now a pure reader over the store the terrain
   * meshes publish into as they draw (terrain/drawnGroundStore.ts): an entry is
   * replaced by the very act that redraws its chunk, so this may live exactly
   * as long as the mirror it reads. It is replaced with the mirror, in
   * `resetWorld`, and nowhere else.
   */
  let drawnGround: DrawnGround | null = null;
  let meshes: TerrainMeshes | null = null;
  let layerEdges: LayerEdgeOverlay | null = null;
  let predictions: PredictionStore | null = null;

  /**
   * PER-CHUNK TERRAIN-CHANGE COUNTERS — the cheap "has the ground here moved?"
   * question, for readers that cache something derived from terrain and need to
   * know when to throw it away (`terrainRevisionAt` below is the only way to
   * read them).
   *
   * ONE COUNTER PER CHUNK, BUMPED WHEREVER THE DIRTY SET IS ALREADY KNOWN —
   * `applyDirty`, the snapshot and the chunk unlock, which are the three places
   * this file changes rendered heights. Every one of them already computes the
   * chunks that moved (a dirty set is what patches the meshes), so this adds an
   * increment per dirty chunk and no new derivation that could disagree with
   * the meshes about what changed.
   *
   * MONOTONIC, NEVER RESET IN PLACE. Readers are contracted to compare values
   * for equality only, and several of them fingerprint a NEIGHBOURHOOD by
   * summing the counters of the chunks it covers — which is only collision-free
   * because a counter can never come back down. A rejoin therefore reallocates
   * the array AND bumps `terrainEpoch`, so every chunk of the new world reads
   * higher than any value the old one ever showed rather than restarting at 0.
   */
  let chunkRevisions: Int32Array | null = null;
  let terrainEpoch = 0;

  /** Marks a dirty set's chunks as changed. Safe with an empty set. */
  const noteTerrainRevisions = (dirty: ReadonlySet<number>): void => {
    if (chunkRevisions === null) return;
    for (const idx of dirty) {
      if (idx >= 0 && idx < chunkRevisions.length) chunkRevisions[idx]++;
    }
  };

  /**
   * World size the camera has already been aimed at — framed OR restored from
   * a saved pose; 0 before the first snapshot.
   */
  let framedWorldSize = 0;
  /** One-shot timer armed for the moment the oldest prediction expires. */
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The band a ray AIMED AT, as a number: the one derivation `graspSpanBand`
   * and `carveBand` share, written once so the two can never disagree about
   * which layer the player is pointing at. What differs between them is only
   * WHEN they ask it — see their docs on the World interface.
   */
  const bandOfPick = (pick: TerrainRayPick): number | null => {
    if (mirror === null) return null;
    // A RISER HIT NAMES THE BAND WHOSE SLAB CONTAINS THE STRUCK HEIGHT (owner,
    // 2026-08-26: "if you're grabbing the side of a band, then that is the band
    // that should apply. I would never grab the band below"). The slab the
    // renderer draws for band k occupies [(k−1)·BAND_HEIGHT, k·BAND_HEIGHT]
    // (columns.ts `spanUndersideHeight`), so the band containing a height is
    // its CEILING in band units — the whole face of band k, top to bottom, is
    // band k's handle.
    //
    // NOT `round` (which is what this was): rounding made the bottom half of
    // every face grab the band below the one being pointed at. NOT the span's
    // cap band either: a column is drawn solid from its own cap down to its
    // neighbour's, so a cliff that drops five bands at once is ONE span with
    // one five-band-tall riser face carrying five lips, and the cap band would
    // name the clifftop for every one of them (the 2026-08-24 report).
    //
    // CLAMPED TO THE STRUCK SPAN'S DRAWN RANGE so a hit landing exactly on a
    // slab boundary — where `ceil` is exact and could name the band above the
    // face — still resolves to a band this span actually draws.
    //
    // A horizontal face (a tread, or a cave roof seen from below) has no stack
    // to disambiguate, so the band of the span the march itself reported is the
    // answer.
    const span = spanAt(mirror.map, pick.x, pick.y, pick.spanIndex);
    if (pick.hitRiser) {
      const struck = Math.ceil(pick.hitY / (HEIGHT_WORLD_SCALE * BAND_HEIGHT));
      const lowestDrawn = bandOf(spanUndersideHeight(span)) + 1;
      const highestDrawn = bandOf(spanCapHeight(span));
      if (struck < lowestDrawn) return lowestDrawn;
      if (struck > highestDrawn) return highestDrawn;
      return struck;
    }
    return bandOf(spanCapHeight(span));
  };

  const clearExpiryTimer = (): void => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  };

  /**
   * Schedules the prediction sweep for the exact moment the oldest outstanding
   * prediction times out — no polling interval, and therefore no timer at all
   * while nothing is pending.
   *
   * The sweep is what covers the intents the server answers with SILENCE: an
   * intent rejected by the unlock mask or vetoed by a plugin produces no diff
   * by design (see the server's intent pipeline), so nothing else would ever
   * take that prediction back off the screen.
   */
  /**
   * The one door every HEIGHT change goes through on its way to the screen:
   * patches the dirty chunks' terrain meshes, rewrites the frontier-fog
   * segments standing on them, rewrites the sea's depth-alpha texels over
   * them (render/water.ts — a sculpt that breaks the surface or digs deeper
   * must be visible through the water the same frame it lands, not only
   * after the next rejoin), and ticks the river rig's throttle. Events that
   * change `received` (snapshot, chunkUnlock) call fog.sync afterwards as
   * well; that is about WHICH segments exist, not their heights.
   *
   * IT NAMES CHUNKS ONLY TO MIRROR READERS. Anything that reads a chunk's
   * published chart is driven by `onChunkDrawn` instead — see the guard
   * comments below and the subscription in `resetWorld`.
   */
  const applyDirty = (dirty: Set<number>): void => {
    // AN EMPTY SET IS NOT A CHEAP CALL, so nothing below is asked to make it.
    // Every mirror consumer here is written to iterate the set, which reads as
    // "nothing dirty costs nothing" — and is false for `water.refresh`, which
    // re-uploads its whole world-sized texture per call whatever the set holds
    // (render/water.ts: an empty dirty set names no upload ranges, and a
    // range-less `needsUpdate` is three's full-image path). Once the prediction journal stops reporting chunks
    // whose rendered state did not change, the authoritative echo of a
    // correctly predicted sculpt arrives with an empty set several times a
    // second, and this guard is what makes that echo free.
    if (dirty.size > 0) {
      noteTerrainRevisions(dirty);
      meshes?.update(dirty);
      // WHAT THIS SET IS GOOD FOR, and what it is not. `fog` and `water` read
      // the MIRROR — heights and `received` — which the caller has already
      // written, so they are correct the instant the set exists. The lips, the
      // rivers and the sea's curtains read the per-chunk CHART instead
      // (terrain/drawnGroundStore.ts), and `meshes.update` above only ENQUEUES:
      // the chart is published one build later, in the splice. Chart readers
      // are therefore driven by build completion (`onChunkDrawn`, wired in
      // resetWorld) and never from here — driving them from this set has them
      // reading the pre-edit chart, or the blocky MISSING-CHUNKS fallback, for
      // every chunk whose build has not landed yet.
      if (mirror !== null) {
        fog.refresh(mirror, dirty);
        water.refresh(mirror, dirty);
      }
    }
    // RIVERS TICK ON EVERY CALL, EMPTY SET INCLUDED, and they are handed no
    // chunks: the chunks reach them from `onChunkDrawn`. Their refresh is
    // throttled on ELAPSED TIME and accumulates whatever chunks it has been
    // handed while inside the window (render/riverRig.ts), so the rebuild
    // happens on the first call AFTER the window passes, whatever that call's
    // own set holds. Skipping the empty-set calls would strand the last chunks
    // of a stroke in `pendingDirty` until some unrelated later edit flushed
    // them. An empty-set call is genuinely cheap — an elapsed-time compare,
    // and, when the window has passed, the rebuild the ACCUMULATED set has
    // already earned.
    if (mirror !== null && drawnGround !== null) {
      rivers.refresh(mirror, NO_CHUNKS, drawnGround);
    }
  };

  const armExpiryTimer = (): void => {
    clearExpiryTimer();
    const dueAt = predictions?.nextExpiryAtMs();
    if (dueAt === null || dueAt === undefined) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        if (meshes === null || predictions === null) return;
        applyDirty(predictions.expire(nowMs()));
        armExpiryTimer(); // predictions may remain that expire later
      },
      Math.max(0, dueAt - nowMs()),
    );
  };

  /**
   * Rebuilds the local world for a newly reported size. Called on every
   * snapshot: a snapshot is by definition the authoritative starting state for
   * this session, so any terrain from a previous session must go, even if the
   * size is unchanged (a server restart can hand back a different world).
   */
  const resetWorld = (
    worldSize: number,
  ): {
    mirror: TerrainMirror;
    meshes: TerrainMeshes;
    predictions: PredictionStore;
    ground: DrawnGround;
  } => {
    meshes?.dispose();
    // A NEW WORLD IS ENTIRELY NEW TERRAIN. Fresh counters, and an epoch bump so
    // no chunk of it can read equal to a value the previous world published —
    // see chunkRevisions' declaration for why that matters to a reader summing
    // several of them.
    terrainEpoch++;
    chunkRevisions = new Int32Array(chunksPerEdge(worldSize) ** 2);
    const nextMirror = createTerrainMirror(worldSize);
    // The frame hook is what turns chunk meshing into a multi-frame job
    // (render/terrainMeshes.ts, issue #47): heavy chunks queue instead of
    // rebuilding a whole brush footprint inside one `update` call. Wrapped
    // rather than passed by reference so the viewport keeps ownership of how
    // its frame callbacks are registered.
    const nextMeshes = createTerrainMeshes(
      viewport.terrainGroup,
      nextMirror,
      { onFrame: (handler) => viewport.onFrame(handler) },
      // The chunk build itself runs off this thread where a Worker can be
      // started (render/chunkBuildSource.ts): a chunk is ~6 ms on a developed
      // world against a 7.1 ms frame budget, and the contour pipeline is not
      // resumable mid-chunk, so no frame budget can make one chunk cost less
      // than one chunk. The pool outlives the mesh set — a rejoin replaces the
      // meshes and must not terminate and respawn two threads — so it is
      // created once, above, and disposed with the world.
      chunkBuildSource ?? undefined,
    );
    // A new session's snapshot is the authoritative starting state, so any
    // prediction still outstanding against the OLD session is meaningless: the
    // store is replaced along with the mirror it shadows, which drops them.
    const nextPredictions = createPredictionStore(nextMirror);
    layerEdges?.dispose();
    const nextLayerEdges = createLayerEdgeOverlay(
      viewport.terrainGroup,
      nextMirror,
      worldSize,
      nextMeshes.drawnGround(),
    );
    mirror = nextMirror;
    // The oracle closes over the mirror it was built on AND over that mirror's
    // mesh store, so a replaced mirror takes both with it. This is the only
    // place it is ever replaced — see its declaration.
    const nextGround = createDrawnGround(nextMirror, nextMeshes.drawnGround());
    drawnGround = nextGround;
    // EVERY CHART READER IS DRIVEN FROM HERE, chunk by chunk, on the event that
    // publishes the chart it reads — the lips (layerEdgeOverlay.ts) and the
    // rivers rig, whose curtains cut the sea and the river tiles from the drawn
    // contours (render/water/waterCurtain.ts). `meshes.update` only enqueues a
    // build; the chart lands one build later, in the splice, and `onChunkDrawn`
    // fires after both the publish and the vertices (render/terrainMeshes.ts).
    // A reader driven by the dirty set instead reads the pre-edit chart, or the
    // blocky MISSING-CHUNKS fallback, for every chunk still in the queue.
    //
    // Subscribed here rather than passed into `createTerrainMeshes` because the
    // meshes have to exist before the overlay and the oracle that read their
    // store do, and a callback closing over a not-yet-assigned reader is a way
    // to get that ordering wrong silently. The subscription dies with the
    // meshes, which are disposed at the top of the next reset.
    nextMeshes.onChunkDrawn((chunkIdx) => {
      nextLayerEdges.refreshChunk(chunkIdx);
      // The rig copies the set's elements into its own `pendingDirty` before
      // returning (render/riverRig.ts), so one scratch set serves every chunk
      // rather than allocating one per splice. Its time throttle coalesces a
      // burst of drawn chunks into a single rebuild.
      drawnChunkScratch.clear();
      drawnChunkScratch.add(chunkIdx);
      rivers.refresh(nextMirror, drawnChunkScratch, nextGround);
    });
    meshes = nextMeshes;
    layerEdges = nextLayerEdges;
    predictions = nextPredictions;
    clearExpiryTimer();
    water.setWorldSize(worldSize);

    // Point the camera only at a world we have not pointed it at before. A
    // snapshot also arrives on every reconnect, and re-aiming there would yank
    // the camera out from under a player who had just lined up a shot.
    //
    // "Pointed at" covers both outcomes of restoreOrFocus: restoring the pose
    // saved for this server + world size, and framing the world from scratch
    // when there is no usable saved pose. A restored pose therefore counts as
    // framed — a rejoin at the same size leaves it alone, exactly as it leaves
    // a framed camera alone, and a rejoin at a NEW size runs the same restore
    // path afresh against that size's own key.
    if (worldSize !== framedWorldSize) {
      viewport.restoreOrFocus(worldSize);
      framedWorldSize = worldSize;
    }

    return {
      mirror: nextMirror,
      meshes: nextMeshes,
      predictions: nextPredictions,
      ground: nextGround,
    };
  };

  return {
    onSnapshot(msg: JoinSnapshotMessage): void {
      // World identity (name + difficulty) travels on the snapshot and only on
      // the snapshot, so it is published to the HUD here — on a REJOIN too,
      // which matters: the client may have been pointed at a different world
      // while it was away, and the header must follow the terrain it is over.
      // Writing hudState from the imperative layer is the documented pattern
      // (see state/hudState.ts's header), not a shortcut around Solid.
      setWorldIdentity({
        name: msg.worldName ?? null,
        difficulty: msg.difficulty ?? null,
      });
      // A snapshot IS the proof that a world is loaded, and it is the only
      // proof that arrives without being asked for. It clears the "no world is
      // loaded" banner on a world SWITCH as well as on a first join, because
      // the switch re-sends every client exactly this message (multi-world,
      // 2026-08-22 — see WorldManager.openInto step 7).
      setWorldLoaded(true);
      // Belt-and-braces against a lost terminal switch notice (reconnect
      // mid-countdown): the snapshot proves the new world landed, so whatever
      // countdown the client still believes in is over. Normally this arrives
      // after the server's secondsRemaining: 0 notice has already cleared it,
      // making this a no-op — see worldsState.applyWorldSwitchNotice.
      setPendingSwitch(null);
      // Same, for a restart: the server is demonstrably back, so whatever
      // "restarting" notice is on screen has been overtaken by events. There
      // is no terminal message that could clear it instead — the restart's own
      // last word is sent as the process goes down.
      setPendingRestartSeconds(null);
      // Build identity travels with world identity, and matters on a REJOIN
      // for the same reason: the server may have been restarted onto a new
      // commit while this client's bundle stayed put — which is exactly the
      // skew the watermark exists to expose.
      setServerVersion(msg.serverVersion);
      // AND THE RELOAD DECISION, which is a different question from the
      // watermark's: the watermark asks "are these two halves in step?", this
      // asks "is the code the server came back on different from the code this
      // page is running?" — and only the second one may navigate. Keyed on
      // buildIdentity, never on serverVersion; see net/buildReload.ts.
      noteBuildIdentity(msg.buildIdentity);

      const fresh = resetWorld(msg.worldSize);
      // Through the prediction store like every authoritative message, so the
      // store's authoritative copy is seeded from the snapshot rather than from
      // the empty map the mirror was allocated with.
      const snapshotDirty = fresh.predictions.applyAuthoritative(
        (m) => {
          // The arch fixture used to be carved into the mirror right here
          // (#129 step 3, `?arch=1`), because the wire could only carry one
          // height per cell. Step 4.2 gave it a span, so the fixture is
          // authored SERVER-SIDE at genesis instead (ARCH_FIXTURE=1,
          // server/src/world/arch-fixture.ts) and arrives by the ordinary
          // path. Two authoring routes for one mound would be two things to
          // keep in agreement, and the client-only one became untestable the
          // moment the wire could carry the real thing.
          return applySnapshot(m, msg);
        },
        nowMs(),
      );
      noteTerrainRevisions(snapshotDirty);
      fresh.meshes.update(snapshotDirty);
      // No lip refresh here: the overlay follows build completion, and these
      // chunks have only just been queued (see applyDirty's note).
      // The frontier is a fact about `received`, which the snapshot just
      // changed — sync unconditionally, whether this is a first join (empty
      // -> starter footprint) or a rejoin (old world's segments dropped, this
      // session's rebuilt).
      fog.sync(fresh.mirror);
      // Derived from the same `received` the mist above is, at the same call
      // site, so the two can never describe different frontiers.
      revealMask.sync(fresh.mirror);
      // The sea is drawn over the received chunks and nowhere else (see
      // render/water.ts's header), so it answers to `received` exactly as the
      // mist above does — same call site, same reason.
      water.sync(fresh.mirror);
      // The depth-alpha texture water.setWorldSize just reallocated (inside
      // resetWorld) is baseline-filled but otherwise empty — this is what
      // actually paints in every texel the newly-unlocked chunks need, same
      // dirty set the meshes above were just built from.
      water.refresh(fresh.mirror, snapshotDirty);
      // Same reasoning as fog.sync above, and forceRefresh rather than
      // refresh for the same reason `meshes`/`mirror` are replaced wholesale
      // on every snapshot rather than patched: a rejoin's mirror belongs to a
      // possibly brand-new world, and rivers.refresh's own throttle (tuned
      // for coalescing a HELD STROKE's terrainDiff bursts — see riverRig.ts)
      // would otherwise leave the PREVIOUS session's tiles on screen for up
      // to RIVER_RECOMPUTE_INTERVAL_MS after a rejoin that happens to land
      // inside its window.
      rivers.forceRefresh(fresh.mirror, fresh.ground);
    },

    onChunkUnlock(msg: ChunkUnlockMessage): void {
      // Guard, not an expected path: the snapshot always arrives first, so
      // this can only fire if that ordering contract is broken.
      //
      // The contract is real and was worth pinning down, because Colyseus
      // makes it easy to violate: `Room._onJoin` pushes the client into
      // `this.clients` BEFORE awaiting the room's `onJoin`, so a client is
      // broadcast-reachable before its snapshot has been sent, and the tick
      // loop (which may carry a plugin's chunkUnlock) is a separate
      // macrotask. Verified with the Phase 1 server agent against a running
      // server: their `onJoin` sends the snapshot with nothing awaited before
      // it, and its `: void` return type now makes marking it `async` a
      // compile error — so the ordering is enforced at the source rather than
      // merely observed.
      //
      // We still drop rather than guess: without a snapshot there is no world
      // size, so the mirror cannot be allocated and the chunk has nowhere to
      // go. Dropping loses one reveal; guessing would render the world at the
      // wrong scale.
      if (meshes === null || predictions === null || mirror === null) return;
      const unlockDirty = predictions.applyAuthoritative(
        (m) => applyChunkUnlock(m, msg),
        nowMs(),
      );
      // THE SECOND PLACE TERRAIN CHANGES, and the reason this line is not
      // covered by applyDirty's: this handler updates the meshes itself rather
      // than routing through it, because a newly-revealed chunk needs fog,
      // water and the depth texels resynced as well.
      //
      // IT USED TO DROP THE DRAWN-GROUND CACHE HERE TOO, and the reason it no
      // longer has to is the point of the 2026-08-26 contract fix: the oracle
      // held a per-chunk memo that "MUST NOT outlive a terrain edit", and
      // `capYAt` would happily plan a chunk that had NOT arrived — a plan over
      // empty ground — so a memo that survived an unlock went on placing decals
      // on the sea floor of terrain that is now dry land. Nothing is memoised
      // any more: the oracle reads what the meshes published.
      //
      // WHAT `meshes.update` ON THE NEXT LINE ACTUALLY DOES is queue these
      // chunks for a build; the chart each one is read through is published
      // later, when its finished job is spliced (render/terrainMeshes.ts). So
      // nothing here may read the oracle for these chunks — every chart reader
      // (lips, rivers, the sea's curtains) is driven per chunk by
      // `onChunkDrawn`, wired in resetWorld. The exception is the direct build
      // source, where `update` flushes and the publish happens inside the call;
      // that is what the tests and the preview harnesses run on.
      noteTerrainRevisions(unlockDirty);
      meshes.update(unlockDirty);
      // Same as the snapshot path: the lips follow the builds, not the queue.
      // Territory just crept outward — move the mist with it. `received`
      // changed, which is the only thing the frontier is defined from.
      fog.sync(mirror);
      // ...and the mask creeps outward with it, same as on the snapshot path.
      revealMask.sync(mirror);
      // ...and the sea creeps outward with it, same as on the snapshot path.
      water.sync(mirror);
      // Newly-unlocked chunks need their depth-alpha texels painted in too —
      // the texture only holds WATER_DEPTH_ALPHA_DEFAULT_BYTE for a chunk
      // until something writes real depths into it, same as the snapshot
      // path above.
      water.refresh(mirror, unlockDirty);
      // Newly unlocked ground can carry its own springs/rivers that were
      // never active before (rivers.ts's isActive bound follows `received`
      // exactly like this — see riverRig.ts). The ordinary throttle is right
      // here (unlike the snapshot path below): this is the SAME session's
      // world growing, not a different one replacing it, so there is no
      // stale "previous world" tile to worry about outliving.
      //
      // NO CHUNKS ARE NAMED, for applyDirty's reason: these chunks have only
      // just been queued and have no chart yet. They reach the rig from
      // `onChunkDrawn` as each one is drawn. This call is the throttle tick.
      if (drawnGround !== null) rivers.refresh(mirror, NO_CHUNKS, drawnGround);
      armExpiryTimer();
    },

    onTerrainDiff(msg: TerrainDiffMessage): void {
      if (meshes === null || predictions === null) return;
      // The hot path: write cells (against authoritative state, with local
      // predictions rolled off and any the server has now confirmed retired),
      // then patch only the chunk meshes those cells touch — including
      // neighbours across a shared border.
      applyDirty(
        predictions.applyCellDiff(msg, nowMs()),
      );
      armExpiryTimer();
    },

    predictSculpt(intent: SculptIntent): void {
      if (meshes === null || predictions === null) return;
      applyDirty(predictions.predict(intent, nowMs()));
      armExpiryTimer();
    },

    onSculptDenied(msg: SculptDeniedMessage): void {
      if (meshes === null || predictions === null) return;
      // The denied stroke comes off the screen the moment the nack lands —
      // one round trip — instead of at the prediction deadline.
      applyDirty(predictions.resolveSeq(msg.seq));
      armExpiryTimer();
    },

    onSculptApplied(msg: SculptAppliedMessage): void {
      if (meshes === null || predictions === null) return;
      // The ack arrives AFTER the terrainDiff it acknowledges (the ordering
      // contract on SculptAppliedMessage), so the authoritative map already
      // holds the server's version of this edit and dropping our own copy of
      // it changes nothing on screen — which is exactly the point: keeping it
      // would draw the same edit twice until the deadline (issue #21).
      applyDirty(predictions.resolveSeq(msg.seq));
      armExpiryTimer();
    },

    worldSize(): number {
      return mirror?.map.size ?? 0;
    },

    terrainHeightAt(x: number, y: number): number | null {
      if (mirror === null) return null;
      // NULL FOR GROUND THIS CLIENT WAS NEVER SENT (2026-09-02), not band 0.
      // The mirror stores a never-received cell as SEA_LEVEL, and band 0 is the
      // plane the sea is drawn on — so a reader that took the highest sample
      // under a body (wildlife's swimmerSeabedY, a whale's nose ten cells past
      // the fog frontier) read "seabed at the waterline" and floated the whale
      // on top of the sea. Every consumer already handles null (the
      // pre-snapshot case); "I don't know this cell" is the same answer.
      if (!isCellReceived(mirror, x, y)) return null;
      return quantizeToBand(sampleHeight(mirror, x, y)) * HEIGHT_WORLD_SCALE;
    },

    terrainRevisionAt(x: number, y: number): number {
      if (mirror === null || chunkRevisions === null) return 0;
      // CLAMPED EXACTLY AS `sampleHeight` CLAMPS, so that a caller sampling one
      // cell past the world border gets the revision of the very chunk that
      // answered its height query. Asking the two for different cells is the
      // one way this could report "unchanged" over ground that had moved.
      const max = mirror.map.size - 1;
      const cx = x < 0 ? 0 : x > max ? max : x;
      const cy = y < 0 ? 0 : y > max ? max : y;
      return terrainEpoch + chunkRevisions[chunkIndexOfCell(mirror.map.size, cx, cy)];
    },

    spanCapAt(x: number, y: number, spanIndex: number): number | null {
      if (mirror === null) return null;
      if (x < 0 || y < 0 || x >= mirror.map.size || y >= mirror.map.size) return null;
      if (spanIndex < 0 || spanIndex >= spanCount(mirror.map, x, y)) return null;
      return spanCapHeight(spanAt(mirror.map, x, y, spanIndex)) * HEIGHT_WORLD_SCALE;
    },

    spanCountAt(x: number, y: number): number {
      if (mirror === null) return 0;
      if (x < 0 || y < 0 || x >= mirror.map.size || y >= mirror.map.size) return 0;
      return spanCount(mirror.map, x, y);
    },

    spanContainsHeight(x: number, y: number, spanIndex: number, worldY: number): boolean {
      if (mirror === null) return false;
      if (x < 0 || y < 0 || x >= mirror.map.size || y >= mirror.map.size) return false;
      if (spanIndex < 0 || spanIndex >= spanCount(mirror.map, x, y)) return false;
      // THE SAME BOUNDS `bandOfPick` CLAMPS INTO, in world units: the slab the
      // renderer fills for this span runs from its underside to its cap, and
      // those two heights are what the band range there is derived from. Read
      // through the same helpers so the two can never disagree about how tall
      // a span is drawn.
      const span = spanAt(mirror.map, x, y, spanIndex);
      const underside = spanUndersideHeight(span) * HEIGHT_WORLD_SCALE;
      const cap = spanCapHeight(span) * HEIGHT_WORLD_SCALE;
      return worldY >= underside && worldY <= cap;
    },

    drawnGroundYAt(cellX: number, cellZ: number): number | null {
      if (drawnGround === null || mirror === null) return null;
      // Same contract as terrainHeightAt: a never-received chunk has no drawn
      // ground (the renderer draws only received chunks), so its cap is not a
      // height, it is the mirror's storage zero. Null, like every other
      // "no ground here yet" answer in this file.
      if (!isCellReceived(mirror, cellX, cellZ)) return null;
      return drawnGround.capYAt(cellX, cellZ);
    },

    highlightLayerEdge(pick: TerrainRayPick | null, light: LayerEdgeLight): number | null {
      // THE AIMED BAND IS DERIVED HERE, not asked of the caller. Both callers
      // — the frame loop that lights the lip and the press that grabs it —
      // must agree about which layer the cursor is on, and a parameter either
      // of them could forget to pass is a way for them to disagree. They hand
      // over the pick; this turns it into the aim.
      //
      // ONLY A RISER HIT NAMES A BAND, and it names it outright: the face under
      // the cursor is the thing the player gets (owner, 2026-08-26). A ray that
      // landed on a tread — or on a cave roof's underside — has no face to
      // grab, so there is nothing to light and nothing to pull; the tread's own
      // gesture is the seed (input/sculptInput.ts).
      //
      // THE OVERLAY IS NO LONGER ASKED WHICH BAND. It used to search: nearest
      // lip in plan within a grab radius, tie-broken by the aimed band. A
      // search is not a function of the pixel under the cursor, so the two
      // derivations of "what am I aiming at" could disagree. Now `bandOfPick`
      // decides and the overlay only answers yes/no about that one band.
      if (layerEdges === null) return null;
      // A LIVE STROKE'S GRAB WINS over the current ray — see LayerEdgeLight's
      // `heldBand`. `?? null` rather than a truthiness test: band 0 is a real
      // band (the waterline), and it is held like any other.
      const band =
        light.heldBand ?? (pick !== null && pick.hitRiser ? bandOfPick(pick) : null);
      // CALLED EVEN WITH NOTHING TO LIGHT, because the overlay holds the
      // highlight from the last call: returning early on a null pick would
      // leave the previous frame's lip lit after the pointer had left it.
      //
      // THE POINT THE LIP IS MEASURED FROM. On a RISER hit it is where the ray
      // actually met the face — the better point the phase-1 note above said a
      // caller could supply, and now does: the pointer is drawn there
      // (render/brushPreview.ts), so measuring the lit stretch from anywhere
      // else would light a run of lip that is not centred on the mark the
      // player is aiming with.
      //
      // Everywhere else it stays the cell's own lattice position, which is
      // where the contour vertices live (the marcher samples the height field
      // at integer cell coordinates and scales by CELL_WORLD_SIZE) — a
      // horizontal face has no meeting point more meaningful than the cell.
      // Ignored entirely when there is no pick, which is why the cell doubles
      // as the "is there anything here" flag.
      const atX = pick === null ? 0 : pick.hitRiser ? pick.hitX : pick.x * CELL_WORLD_SIZE;
      const atZ = pick === null ? 0 : pick.hitRiser ? pick.hitZ : pick.y * CELL_WORLD_SIZE;
      return layerEdges.lightBand(pick, band, atX, atZ, light.litSpanWorldUnits) ? band : null;
    },
    bandAtCell(x: number, y: number): number | null {
      if (mirror === null) return null;
      return bandOf(sampleHeight(mirror, x, y));
    },
    graspSpanBand(pick: TerrainRayPick | null): number | null {
      if (pick === null || mirror === null) return null;
      // One span, one surface: say nothing, and the server moves the only
      // thing it could have moved anyway. This is what keeps every stroke on
      // ordinary terrain byte-identical to before the field existed.
      if (spanCount(mirror.map, pick.x, pick.y) < 2) return null;
      // WHICH span, said as a band — the shared derivation.
      return bandOfPick(pick);
    },
    carveBand(pick: TerrainRayPick | null): number | null {
      if (pick === null) return null;
      return bandOfPick(pick);
    },
    pickCell(origin: Vec3, direction: Vec3): TerrainRayPick | null {
      if (mirror === null) return null;
      return pickTerrainCellByRay(mirror, origin, direction);
    },
    pickPointedCell(
      origin: Vec3,
      direction: Vec3,
      occupants: readonly CellOccupancy[],
    ): PointedCellPick | null {
      if (mirror === null) return null;
      return pickPointedCellByRay(mirror, origin, direction, occupants);
    },

    drawBudget(): number {
      return (
        (meshes?.drawCallCount() ?? 0) +
        fog.drawCallCount() +
        WATER_DRAW_OBJECTS +
        RIVER_RIG_DRAW_OBJECTS +
        (layerEdges?.drawCallCount() ?? 0)
      );
    },
    chartSource(): ChartSource | null {
      const m = mirror;
      if (m === null) return null;
      return {
        size: m.map.size,
        heightAt: (x: number, y: number): number =>
          m.map.cells[cellIndex(m.map, x, y)],
        // "Revealed" for the chart is exactly the renderer's own notion of
        // what exists: the cell's owning chunk is in `received` (mirror.ts
        // invariant 1). No reveal-plugin knowledge leaks in here.
        //
        // IT USED TO RE-DERIVE THAT INLINE, which was the only copy of the
        // predicate until #284 needed it on the GPU as well; it now calls the
        // one definition, so the chart and the reveal mask cannot drift apart.
        revealedAt: (x: number, y: number): boolean => revealedAtCell(m, x, y),
      };
    },

    pickables(): Mesh[] {
      return meshes?.pickables() ?? [];
    },

    revealedAt(x: number, y: number): boolean {
      const m = mirror;
      return m === null ? false : revealedAtCell(m, x, y);
    },

    applyRevealClip(material: Material, label: string): void {
      revealMask.applyRevealClip(material, label);
    },

    revealClipUniforms(): RevealClipUniforms {
      return revealMask.uniforms();
    },

    dispose(): void {
      clearExpiryTimer();
      meshes?.dispose();
      meshes = null;
      mirror = null;
      drawnGround = null;
      predictions = null;
      water.dispose();
      fog.dispose();
      revealMask.dispose();
      rivers.dispose();
      // The pool outlives every mesh set in the session, so this is the only
      // place it is terminated.
      chunkBuildSource?.dispose();
    },
  };
}

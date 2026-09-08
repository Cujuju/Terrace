// Wires the mirror, the meshes and the network together: one object that owns "the world as this
// client knows it".

import {
  CHUNK_SIZE,
  DEFAULT_WORLD_SIZE,
  bandOf,
  cellIndex,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  quantizeToBand,
  spanCount,
} from '@terrace/shared';
import type {
  ChunkUnlockMessage,
  JoinSnapshotMessage,
  SculptAppliedMessage,
  SculptDeniedMessage,
  SculptIntent,
  SculptTool,
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
  setWorldViewScope,
} from './state/worldsState.ts';
import {
  createPredictionStore,
  type PredictionStore,
} from './terrain/prediction.ts';
import { createTerrainMeshes, type TerrainMeshes } from './render/terrainMeshes.ts';
import { createWorkerChunkBuildSource } from './render/chunkBuildSource.ts';
import {
  createLayerEdgeOverlay,
  type LayerEdgeOverlay,
  type LayerEdgeStyle,
} from './render/layerEdgeOverlay.ts';
import { createEffect } from 'solid-js';
import { createFrontierFog, type FrontierFog } from './render/frontierFog.ts';
import { createFrontierLine, type FrontierLine } from './render/frontierLine.ts';
import { frontierMistMode } from './state/frontierMistPrefs.ts';
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
  bandOfPick as bandOfPickIn,
  carveBandOfPick as carveBandOfPickIn,
} from './terrain/pickBand.ts';
import {
  carveReachCell,
  pickPointedCellByRay,
  pickTerrainCellByRay,
  pickTerrainInColumn,
  type CellOccupancy,
  type PointedCellPick,
  type TerrainRayPick,
  type Vec3,
} from './terrain/picking.ts';

/**
 * How `highlightLayerEdge` should light the lip it finds — the parts of that decision the WORLD
 * cannot make for itself.
 */
export interface LayerEdgeLight {
  /**
   * How much of the lip lights up either side of the aimed point, in world units.
   */
  readonly litSpanWorldUnits: number;
  /**
   * A band to light INSTEAD of the one this pick names — a live stroke's frozen grab
   * (input/sculptInput.ts's `heldBand`), which overrides the pick.
   */
  readonly heldBand?: number | null;
  /**
   * The tool a press would use RIGHT NOW (state/hudState.ts's `brushTool`). The drag grabs risers
   * only, so a tread under its cursor lights nothing and means "seed".
   */
  readonly tool?: SculptTool;
}

export interface World extends TerrainSink {
  /**
   * Applies the local player's sculpt immediately, before the server has answered (design doc
   * client-side prediction).
   */
  predictSculpt(intent: SculptIntent): void;
  /** 0 until the first snapshot arrives. */
  worldSize(): number;
  pickables(): Mesh[];
  /**
   * Is cell (x, y) in a chunk the server has sent us, and inside the world?
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
   * The first terrain cell a world-space ray meets, or null.
   */
  pickCell(origin: Vec3, direction: Vec3): TerrainRayPick | null;
  /**
   * THE SAME RAY, RE-ASKED OF ONE PINNED COLUMN — `pickCell` with the march removed, for the hover
   * cache (input/sculptInput.ts's `hoverTarget`).
   */
  pickInColumn(x: number, y: number, origin: Vec3, direction: Vec3): TerrainRayPick | null;
  /**
   * The first cell a ray meets that has either something STANDING on it or terrain under it —
   * `pickCell`'s question with the world's contents included, for plugins/host.ts's pickWorldCell
   * (GH #252).
   */
  pickPointedCell(
    origin: Vec3,
    direction: Vec3,
    occupants: readonly CellOccupancy[],
  ): PointedCellPick | null;
  /**
   * Lights up the terrace lip this PICK is pointing at and returns the band a drag starting there
   * would grab, or null when there is none (render/layerEdgeOverlay.ts).
   */
  highlightLayerEdge(pick: TerrainRayPick | null, light: LayerEdgeLight): number | null;
  /**
   * How the resting terrace lips are drawn — the player's choice (state/layerEdgePrefs.ts, applied
   * by main.tsx; render/layerEdgeOverlay.ts owns what each style looks like).
   */
  setLayerEdgeStyle(style: LayerEdgeStyle): void;
  /**
   * Reddens the lit lip on a refused press. Written every frame, so nothing is
   * remembered here — a rejoin's fresh overlay is right on the next frame.
   */
  setBrushRefused(refused: boolean): void;
  /**
   * The terrace band of the terrain at cell (x, y) — `bandOf` the mirrored height, in BAND units,
   * not world units.
   */
  bandAtCell(x: number, y: number): number | null;
  /**
   * The band a stroke starting at this PICK has hold of — `SculptIntent`'s `spanBand`, or null to
   * mean the topmost span.
   */
  graspSpanBand(pick: TerrainRayPick | null): number | null;
  /**
   * The band a CARVE starting at this pick cuts from — `SculptIntent`'s `spanBand` for the one tool
   * that needs it on ordinary ground too.
   */
  carveBand(pick: TerrainRayPick | null): number | null;
  /**
   * WHERE A HELD CARVE CUTS NEXT: the first cell along this ray that still has material at `band`
   * (terrain/picking.ts's `carveReachCell`).
   */
  carveReach(origin: Vec3, direction: Vec3, band: number): { x: number; y: number } | null;
  /**
   * World-space Y of the band the cell LATTICE puts (x, y) in. FOR LOGIC, NOT FOR A DRAWN Y:
   * anything drawn at ground level asks `drawnGroundYAt`.
   */
  terrainHeightAt(x: number, y: number): number | null;
  /**
   * AN OPAQUE COUNTER THAT CHANGES WHENEVER THE RENDERED TERRAIN NEAR (x, y) MAY HAVE CHANGED — the
   * cache key for anything derived from the ground. Compare for equality only.
   */
  terrainRevisionAt(x: number, y: number): number;
  /**
   * World-space Y of the cap the terrain ACTUALLY DRAWS at a (fractional) cell. THE ONLY ORACLE FOR
   * ANYTHING DRAWN AT GROUND LEVEL, flat on it or standing on it.
   */
  drawnGroundYAt(cellX: number, cellZ: number): number | null;
  /**
   * A read-only window onto the mirror for the Cartographer (ui/Cartographer): the world size, raw
   * heights, and which cells sit in received chunks. Null before the first snapshot.
   */
  chartSource(): ChartSource | null;
  /**
   * Core's terrain-side share of the frame's draw budget: the terrain super-meshes, the frontier
   * fog, the sea, the river rig and the layer-edge overlay (part B of
   * docs/plans/frame-budget-growth-and-draw-calls.md).
   */
  drawBudget(): number;
  dispose(): void;
}

/**
 * Monotonic clock for prediction deadlines.
 */
const nowMs = (): number => performance.now();

/**
 * The empty dirty set, for the callers that tick a throttled consumer without
 * naming any chunk. Shared and never written: every consumer that takes a
 * dirty set only iterates it.
 */
const NO_CHUNKS: ReadonlySet<number> = new Set<number>();

export function createWorld(viewport: Viewport): World {
  // One sea for the whole session, like the fog and rivers below.
  const water: Water = createWater(viewport.scene, DEFAULT_WORLD_SIZE);
  // One fog curtain for the whole session, like water — its segments are
  // synced (added/disposed) against whatever mirror currently exists rather
  // than being torn down and recreated on every rejoin.
  const fog: FrontierFog = createFrontierFog(viewport.scene, viewport.onFrame);
  // The red boundary line, and its own layer rather than a third mist profile: it is a marker laid
  // on the ground, not a veil standing on it.
  const frontierLine: FrontierLine = createFrontierLine(viewport.scene);
  // ONE CHOICE (state/frontierMistPrefs.ts), TWO LAYERS: both are handed the same mode and each
  // shows itself for its own value, so the panel can never leave both drawn.
  createEffect(() => {
    const mode = frontierMistMode();
    fog.setMode(mode);
    frontierLine.setVisible(mode === 'line');
  });
  // THE REVEAL MASK, and it belongs beside the fog rather than anywhere else because it is the SAME
  // fact: the frontier mist and the mask are both derived from `received`.
  const revealMask: RevealMask = createRevealMask(DEFAULT_WORLD_SIZE);
  // Rivers, pools and waterfalls (mechanics cards 27 & 40) — a third derived layer alongside water
  // and fog, same lifetime, same "one instance for the whole session" shape.
  const rivers: RiverRig = createRiverRig(viewport.scene, viewport.onFrame, {
    networkSource: createWorkerRiverNetworkSource() ?? undefined,
  });

  /**
   * The chunk-geometry worker pool, or null where no Worker could be started (an old browser, a CSP
   * that forbids module workers).
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
   */
  let drawnGround: DrawnGround | null = null;
  let meshes: TerrainMeshes | null = null;
  let layerEdges: LayerEdgeOverlay | null = null;
  /**
   * The live value of `setLayerEdgeStyle`, kept so a rejoin's fresh overlay is created into the
   * same choice.
   */
  let layerEdgeStyle: LayerEdgeStyle = 'debug';
  let predictions: PredictionStore | null = null;

  /**
   * PER-CHUNK TERRAIN-CHANGE COUNTERS — the cheap "has the ground here moved?" question.
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
   * The band a ray AIMED AT — `terrain/pickBand.ts`'s derivation against the LIVE map.
   */
  const bandOfPick = (pick: TerrainRayPick): number | null =>
    mirror === null ? null : bandOfPickIn(mirror.map, pick);

  /**
   * The band a CARVE press starting at this pick would cut from, measured from the ray's own
   * meeting point — where the pointer is drawn, not the cell's lattice position.
   */
  const carveBandOfPick = (pick: TerrainRayPick): number | null => {
    const edges = layerEdges;
    if (mirror === null || edges === null) return null;
    return carveBandOfPickIn(mirror.map, pick, (band) =>
      edges.lipNear({ x: pick.x, y: pick.y }, band, pick.hitX, pick.hitZ),
    );
  };

  const clearExpiryTimer = (): void => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  };

  /**
   * The one door every HEIGHT change goes through: the dirty chunks' meshes, the fog segments on
   * them, the sea's depth-alpha texels, and the river rig's throttle.
   */
  const applyDirty = (dirty: Set<number>): void => {
    // AN EMPTY SET IS NOT A CHEAP CALL, so nothing below is asked to make it.
    if (dirty.size > 0) {
      noteTerrainRevisions(dirty);
      meshes?.update(dirty);
      // WHAT THIS SET IS GOOD FOR: `fog` and `water` read the MIRROR, which the caller has already
      // written. Chart readers are driven by build completion instead, never from here.
      if (mirror !== null) {
        fog.refresh(mirror, dirty);
        frontierLine.refresh(mirror, dirty);
        water.refresh(mirror, dirty);
      }
    }
    // RIVERS TICK ON EVERY CALL, EMPTY SET INCLUDED, and they are handed no chunks: the chunks
    // reach them from `onChunkDrawn`.
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
   * Rebuilds the local world for a newly reported size.
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
    // A NEW WORLD IS ENTIRELY NEW TERRAIN.
    terrainEpoch++;
    chunkRevisions = new Int32Array(chunksPerEdge(worldSize) ** 2);
    const nextMirror = createTerrainMirror(worldSize);
    // The frame hook is what turns chunk meshing into a multi-frame job (render/terrainMeshes.ts,
    // issue #47): heavy chunks queue instead of rebuilding a whole brush footprint inside one
    // `update` call.
    const nextMeshes = createTerrainMeshes(
      viewport.terrainGroup,
      nextMirror,
      { onFrame: (handler) => viewport.onFrame(handler) },
      // The chunk build itself runs off this thread where a Worker can be started
      // (render/chunkBuildSource.ts): a chunk is ~6 ms on a developed world against a 7.1 ms frame
      // budget.
      chunkBuildSource ?? undefined,
    );
    // A new session's snapshot is the authoritative starting state, so any prediction still
    // outstanding against the OLD session is meaningless: the store is replaced along with the
    // mirror it shadows.
    const nextPredictions = createPredictionStore(nextMirror);
    layerEdges?.dispose();
    const nextLayerEdges = createLayerEdgeOverlay(
      viewport.terrainGroup,
      nextMirror,
      worldSize,
      nextMeshes.drawnGround(),
    );
    nextLayerEdges.setStyle(layerEdgeStyle);
    mirror = nextMirror;
    // The oracle closes over the mirror it was built on AND over that mirror's mesh store, so a
    // replaced mirror takes both with it.
    const nextGround = createDrawnGround(nextMirror, nextMeshes.drawnGround());
    drawnGround = nextGround;
    // EVERY CHART READER IS DRIVEN FROM HERE, chunk by chunk, on the event that publishes the chart
    // it reads — the lips (layerEdgeOverlay.ts) and the rivers rig.
    nextMeshes.onChunkDrawn((chunkIdx) => {
      nextLayerEdges.refreshChunk(chunkIdx);
      // The rig copies the set's elements into its own `pendingDirty` before returning
      // (render/riverRig.ts), so one scratch set serves every chunk rather than allocating one per
      // splice.
      drawnChunkScratch.clear();
      drawnChunkScratch.add(chunkIdx);
      rivers.refresh(nextMirror, drawnChunkScratch, nextGround);
    });
    meshes = nextMeshes;
    layerEdges = nextLayerEdges;
    predictions = nextPredictions;
    clearExpiryTimer();
    water.setWorldSize(worldSize);

    // Point the camera only at a world we have not pointed it at before.
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
      // World identity (name + difficulty) travels on the snapshot and only on the snapshot, so it
      // is published to the HUD here — on a REJOIN too, which matters.
      setWorldIdentity({
        name: msg.worldName ?? null,
        difficulty: msg.difficulty ?? null,
      });
      // A snapshot IS the proof that a world is loaded, and it is the only proof that arrives
      // without being asked for.
      setWorldLoaded(true);
      // A snapshot is by definition "here is the world you may see", and every unasked-for one —
      // rejoin, rollback, world switch — carries this token's own chunks.
      setWorldViewScope('mine');
      // Belt-and-braces against a lost terminal switch notice (reconnect mid-countdown): the
      // snapshot proves the new world landed, so whatever countdown the client still believes in is
      // over.
      setPendingSwitch(null);
      // Same, for a restart: the server is demonstrably back, so whatever "restarting" notice is on
      // screen has been overtaken by events.
      setPendingRestartSeconds(null);
      // Build identity travels with world identity, and matters on a REJOIN for the same reason.
      setServerVersion(msg.serverVersion);
      // AND THE RELOAD DECISION, which is a different question from the watermark's: the watermark
      // asks "are these two halves in step?".
      noteBuildIdentity(msg.buildIdentity);

      const fresh = resetWorld(msg.worldSize);
      // Through the prediction store like every authoritative message, so the
      // store's authoritative copy is seeded from the snapshot rather than from
      // the empty map the mirror was allocated with.
      const snapshotDirty = fresh.predictions.applyAuthoritative(
        (m) => {
          // The arch fixture is authored SERVER-SIDE at genesis (ARCH_FIXTURE=1,
          // server/src/world/arch-fixture.ts) and arrives by the ordinary path.
          return applySnapshot(m, msg);
        },
        nowMs(),
      );
      noteTerrainRevisions(snapshotDirty);
      fresh.meshes.update(snapshotDirty);
      // No lip refresh here: the overlay follows build completion, and these chunks have only just
      // been queued (see applyDirty's note).
      fog.sync(fresh.mirror);
      // Same fact, same call site — see fog.sync above.
      frontierLine.sync(fresh.mirror);
      // Derived from the same `received` the mist above is, at the same call
      // site, so the two can never describe different frontiers.
      revealMask.sync(fresh.mirror);
      // The sea is drawn over the received chunks and nowhere else (see render/water.ts's header),
      // so it answers to `received` exactly as the mist above does — same call site.
      water.sync(fresh.mirror);
      // The depth-alpha texture water.setWorldSize just reallocated (inside resetWorld) is
      // baseline-filled but otherwise empty — this is what actually paints in every texel the
      // newly-unlocked chunks need.
      water.refresh(fresh.mirror, snapshotDirty);
      // Same reasoning as fog.sync above, and forceRefresh rather than refresh for the same reason
      // `meshes`/`mirror` are replaced wholesale on every snapshot rather than patched.
      rivers.forceRefresh(fresh.mirror, fresh.ground);
    },

    onChunkUnlock(msg: ChunkUnlockMessage): void {
      // Guard, not an expected path: the snapshot always arrives first, so this can only fire if
      // that ordering contract is broken.
      if (meshes === null || predictions === null || mirror === null) return;
      const unlockDirty = predictions.applyAuthoritative(
        (m) => applyChunkUnlock(m, msg),
        nowMs(),
      );
      // THE SECOND PLACE TERRAIN CHANGES, and the reason this line is not covered by applyDirty's:
      // this handler updates the meshes itself rather than routing through it.
      noteTerrainRevisions(unlockDirty);
      meshes.update(unlockDirty);
      // Same as the snapshot path: the lips follow the builds, not the queue. Territory just crept
      // outward — move the mist with it.
      fog.sync(mirror);
      // ...and the boundary line creeps outward with it.
      frontierLine.sync(mirror);
      // ...and the mask creeps outward with it, same as on the snapshot path.
      revealMask.sync(mirror);
      // ...and the sea creeps outward with it, same as on the snapshot path.
      water.sync(mirror);
      // Newly-unlocked chunks need their depth-alpha texels painted in too — the texture only holds
      // WATER_DEPTH_ALPHA_DEFAULT_BYTE for a chunk until something writes real depths into it.
      water.refresh(mirror, unlockDirty);
      // Newly unlocked ground can carry its own springs/rivers that were never active before
      // (rivers.ts's isActive bound follows `received` exactly like this — see riverRig.ts).
      if (drawnGround !== null) rivers.refresh(mirror, NO_CHUNKS, drawnGround);
      armExpiryTimer();
    },

    onTerrainDiff(msg: TerrainDiffMessage): void {
      if (meshes === null || predictions === null) return;
      // The hot path: write cells (against authoritative state, with local predictions rolled off
      // and any the server has now confirmed retired).
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
      // The ack arrives AFTER the terrainDiff it acknowledges (the ordering contract on
      // SculptAppliedMessage).
      applyDirty(predictions.resolveSeq(msg.seq));
      armExpiryTimer();
    },

    worldSize(): number {
      return mirror?.map.size ?? 0;
    },

    terrainHeightAt(x: number, y: number): number | null {
      if (mirror === null) return null;
      // The mirror stores a never-received cell as SEA_LEVEL, and band 0 is the plane the sea is
      // drawn on.
      if (!isCellReceived(mirror, x, y)) return null;
      return quantizeToBand(sampleHeight(mirror, x, y)) * HEIGHT_WORLD_SCALE;
    },

    terrainRevisionAt(x: number, y: number): number {
      if (mirror === null || chunkRevisions === null) return 0;
      // CLAMPED EXACTLY AS `sampleHeight` CLAMPS, so that a caller sampling one cell past the world
      // border gets the revision of the very chunk that answered its height query.
      const max = mirror.map.size - 1;
      const cx = x < 0 ? 0 : x > max ? max : x;
      const cy = y < 0 ? 0 : y > max ? max : y;
      return terrainEpoch + chunkRevisions[chunkIndexOfCell(mirror.map.size, cx, cy)];
    },

    drawnGroundYAt(cellX: number, cellZ: number): number | null {
      if (drawnGround === null || mirror === null) return null;
      // Same contract as terrainHeightAt: a never-received chunk has no drawn ground (the renderer
      // draws only received chunks), so its cap is not a height, it is the mirror's storage zero.
      if (!isCellReceived(mirror, cellX, cellZ)) return null;
      // The chunk builder drains its queue under a frame budget, and `applyDirty` above bumps the
      // terrain revision when a chunk is DIRTIED, not when it is drawn.
      if (!drawnGround.isDrawnAt(cellX, cellZ)) return null;
      return drawnGround.capYAt(cellX, cellZ);
    },

    highlightLayerEdge(pick: TerrainRayPick | null, light: LayerEdgeLight): number | null {
      // THE AIMED BAND IS DERIVED HERE, not asked of the caller.
      if (layerEdges === null) return null;
      // A LIVE STROKE'S GRAB WINS over the current ray — see LayerEdgeLight's `heldBand`.
      const carving = light.tool === 'carve';
      const band =
        light.heldBand ??
        (pick === null
          ? null
          : carving
            ? carveBandOfPick(pick)
            : pick.hitRiser
              ? bandOfPick(pick)
              : null);
      // CALLED EVEN WITH NOTHING TO LIGHT, because the overlay holds the highlight from the last
      // call.
      const useHitPoint = carving || (pick !== null && pick.hitRiser);
      const atX = pick === null ? 0 : useHitPoint ? pick.hitX : pick.x * CELL_WORLD_SIZE;
      const atZ = pick === null ? 0 : useHitPoint ? pick.hitZ : pick.y * CELL_WORLD_SIZE;
      return layerEdges.lightBand(pick, band, atX, atZ, light.litSpanWorldUnits) ? band : null;
    },
    setLayerEdgeStyle(style: LayerEdgeStyle): void {
      layerEdgeStyle = style;
      layerEdges?.setStyle(style);
    },
    setBrushRefused(refused: boolean): void {
      layerEdges?.setRefused(refused);
    },
    bandAtCell(x: number, y: number): number | null {
      if (mirror === null) return null;
      return bandOf(sampleHeight(mirror, x, y));
    },
    graspSpanBand(pick: TerrainRayPick | null): number | null {
      if (pick === null || mirror === null) return null;
      // One span, one surface: say nothing, and the server moves the only thing it could have moved
      // anyway.
      if (spanCount(mirror.map, pick.x, pick.y) < 2) return null;
      // WHICH span, said as a band — the shared derivation.
      return bandOfPick(pick);
    },
    carveBand(pick: TerrainRayPick | null): number | null {
      if (pick === null) return null;
      return carveBandOfPick(pick);
    },
    carveReach(origin: Vec3, direction: Vec3, band: number): { x: number; y: number } | null {
      if (mirror === null) return null;
      return carveReachCell(mirror, origin, direction, band);
    },
    pickCell(origin: Vec3, direction: Vec3): TerrainRayPick | null {
      if (mirror === null) return null;
      // THE DRAWN FACES, so a riser pick names the band the player can see rather than the band the
      // cell's box face happens to cross first (terrain/picking.ts's `DrawnRisers`).
      return pickTerrainCellByRay(mirror, origin, direction, layerEdges);
    },
    pickInColumn(x: number, y: number, origin: Vec3, direction: Vec3): TerrainRayPick | null {
      if (mirror === null) return null;
      return pickTerrainInColumn(mirror, x, y, origin, direction, layerEdges);
    },
    pickPointedCell(
      origin: Vec3,
      direction: Vec3,
      occupants: readonly CellOccupancy[],
    ): PointedCellPick | null {
      if (mirror === null) return null;
      return pickPointedCellByRay(mirror, origin, direction, occupants, layerEdges);
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
        // "Revealed" for the chart is exactly the renderer's own notion of what exists: the cell's
        // owning chunk is in `received` (mirror.ts invariant 1). No reveal-plugin knowledge leaks
        // in here.
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
      frontierLine.dispose();
      revealMask.dispose();
      rivers.dispose();
      // The pool outlives every mesh set in the session, so this is the only
      // place it is terminated.
      chunkBuildSource?.dispose();
    },
  };
}

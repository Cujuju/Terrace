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
import { createGpuTerrainMeshes } from './render/gpuTerrain.ts';
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

export interface LayerEdgeLight {
  readonly litSpanWorldUnits: number;
  readonly heldBand?: number | null;
  readonly tool?: SculptTool;
}

export interface World extends TerrainSink {
  predictSculpt(intent: SculptIntent): void;
  worldSize(): number;
  pickables(): Mesh[];
  revealedAt(x: number, y: number): boolean;
  applyRevealClip(material: Material, label: string): void;
  revealClipUniforms(): RevealClipUniforms;
  pickCell(origin: Vec3, direction: Vec3): TerrainRayPick | null;
  pickInColumn(x: number, y: number, origin: Vec3, direction: Vec3): TerrainRayPick | null;
  pickPointedCell(
    origin: Vec3,
    direction: Vec3,
    occupants: readonly CellOccupancy[],
  ): PointedCellPick | null;
  highlightLayerEdge(pick: TerrainRayPick | null, light: LayerEdgeLight): number | null;
  setLayerEdgeStyle(style: LayerEdgeStyle): void;
  setBrushRefused(refused: boolean): void;
  bandAtCell(x: number, y: number): number | null;
  graspSpanBand(pick: TerrainRayPick | null): number | null;
  carveBand(pick: TerrainRayPick | null): number | null;
  carveReach(origin: Vec3, direction: Vec3, band: number): { x: number; y: number } | null;
  terrainHeightAt(x: number, y: number): number | null;
  terrainRevisionAt(x: number, y: number): number;
  drawnGroundYAt(cellX: number, cellZ: number): number | null;
  chartSource(): ChartSource | null;
  drawBudget(): number;
  dispose(): void;
}

const nowMs = (): number => performance.now();

const NO_CHUNKS: ReadonlySet<number> = new Set<number>();

const GPU_TERRAIN_QUERY_FLAG = 'gpuTerrain';

const gpuTerrainRequested = (): boolean =>
  new URLSearchParams(window.location.search).get(GPU_TERRAIN_QUERY_FLAG) === '1';

export function createWorld(viewport: Viewport): World {
  const water: Water = createWater(viewport.scene, DEFAULT_WORLD_SIZE);
  const fog: FrontierFog = createFrontierFog(viewport.scene, viewport.onFrame);
  const frontierLine: FrontierLine = createFrontierLine(viewport.scene);
  createEffect(() => {
    const mode = frontierMistMode();
    fog.setMode(mode);
    frontierLine.setVisible(mode === 'line');
  });
  const revealMask: RevealMask = createRevealMask(DEFAULT_WORLD_SIZE);
  const rivers: RiverRig = createRiverRig(viewport.scene, viewport.onFrame, {
    networkSource: createWorkerRiverNetworkSource() ?? undefined,
  });

  const chunkBuildSource = createWorkerChunkBuildSource();

  const drawnChunkScratch = new Set<number>();

  let mirror: TerrainMirror | null = null;
  let drawnGround: DrawnGround | null = null;
  let meshes: TerrainMeshes | null = null;
  let layerEdges: LayerEdgeOverlay | null = null;
  let layerEdgeStyle: LayerEdgeStyle = 'debug';
  let predictions: PredictionStore | null = null;

  let chunkRevisions: Int32Array | null = null;
  let terrainEpoch = 0;

  const noteTerrainRevisions = (dirty: ReadonlySet<number>): void => {
    if (chunkRevisions === null) return;
    for (const idx of dirty) {
      if (idx >= 0 && idx < chunkRevisions.length) chunkRevisions[idx]++;
    }
  };

  let framedWorldSize = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const bandOfPick = (pick: TerrainRayPick): number | null =>
    mirror === null ? null : bandOfPickIn(mirror.map, pick);

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

  const applyDirty = (dirty: Set<number>): void => {
    if (dirty.size > 0) {
      noteTerrainRevisions(dirty);
      meshes?.update(dirty);
      if (mirror !== null) {
        fog.refresh(mirror, dirty);
        frontierLine.refresh(mirror, dirty);
        water.refresh(mirror, dirty);
      }
    }
    if (mirror !== null && drawnGround !== null) {
      rivers.refresh(mirror, NO_CHUNKS);
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
        armExpiryTimer();
      },
      Math.max(0, dueAt - nowMs()),
    );
  };

  const resetWorld = (
    worldSize: number,
  ): {
    mirror: TerrainMirror;
    meshes: TerrainMeshes;
    predictions: PredictionStore;
    ground: DrawnGround;
  } => {
    meshes?.dispose();
    terrainEpoch++;
    chunkRevisions = new Int32Array(chunksPerEdge(worldSize) ** 2);
    const nextMirror = createTerrainMirror(worldSize);
    const nextMeshes = gpuTerrainRequested()
      ? createGpuTerrainMeshes(viewport.terrainGroup, nextMirror)
      : createTerrainMeshes(
          viewport.terrainGroup,
          nextMirror,
          { onFrame: (handler) => viewport.onFrame(handler) },
          chunkBuildSource ?? undefined,
        );
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
    const nextGround = createDrawnGround(nextMirror, nextMeshes.drawnGround());
    drawnGround = nextGround;
    nextMeshes.onChunkDrawn((chunkIdx) => {
      nextLayerEdges.refreshChunk(chunkIdx);
      drawnChunkScratch.clear();
      drawnChunkScratch.add(chunkIdx);
      rivers.refresh(nextMirror, drawnChunkScratch);
    });
    meshes = nextMeshes;
    layerEdges = nextLayerEdges;
    predictions = nextPredictions;
    clearExpiryTimer();
    water.setWorldSize(worldSize);

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
      setWorldIdentity({
        name: msg.worldName ?? null,
        difficulty: msg.difficulty ?? null,
      });
      setWorldLoaded(true);
      setWorldViewScope('mine');
      setPendingSwitch(null);
      setPendingRestartSeconds(null);
      setServerVersion(msg.serverVersion);
      noteBuildIdentity(msg.buildIdentity);

      const fresh = resetWorld(msg.worldSize);
      const snapshotDirty = fresh.predictions.applyAuthoritative(
        (m) => {
          return applySnapshot(m, msg);
        },
        nowMs(),
      );
      noteTerrainRevisions(snapshotDirty);
      fresh.meshes.update(snapshotDirty);
      fog.sync(fresh.mirror);
      frontierLine.sync(fresh.mirror);
      revealMask.sync(fresh.mirror);
      water.sync(fresh.mirror);
      water.refresh(fresh.mirror, snapshotDirty);
      rivers.forceRefresh(fresh.mirror);
    },

    onChunkUnlock(msg: ChunkUnlockMessage): void {
      if (meshes === null || predictions === null || mirror === null) return;
      const unlockDirty = predictions.applyAuthoritative(
        (m) => applyChunkUnlock(m, msg),
        nowMs(),
      );
      noteTerrainRevisions(unlockDirty);
      meshes.update(unlockDirty);
      fog.sync(mirror);
      frontierLine.sync(mirror);
      revealMask.sync(mirror);
      water.sync(mirror);
      water.refresh(mirror, unlockDirty);
      if (drawnGround !== null) rivers.refresh(mirror, NO_CHUNKS);
      armExpiryTimer();
    },

    onTerrainDiff(msg: TerrainDiffMessage): void {
      if (meshes === null || predictions === null) return;
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
      applyDirty(predictions.resolveSeq(msg.seq));
      armExpiryTimer();
    },

    onSculptApplied(msg: SculptAppliedMessage): void {
      if (meshes === null || predictions === null) return;
      applyDirty(predictions.resolveSeq(msg.seq));
      armExpiryTimer();
    },

    worldSize(): number {
      return mirror?.map.size ?? 0;
    },

    terrainHeightAt(x: number, y: number): number | null {
      if (mirror === null) return null;
      if (!isCellReceived(mirror, x, y)) return null;
      return quantizeToBand(sampleHeight(mirror, x, y)) * HEIGHT_WORLD_SCALE;
    },

    terrainRevisionAt(x: number, y: number): number {
      if (mirror === null || chunkRevisions === null) return 0;
      const max = mirror.map.size - 1;
      const cx = x < 0 ? 0 : x > max ? max : x;
      const cy = y < 0 ? 0 : y > max ? max : y;
      return terrainEpoch + chunkRevisions[chunkIndexOfCell(mirror.map.size, cx, cy)];
    },

    drawnGroundYAt(cellX: number, cellZ: number): number | null {
      if (drawnGround === null || mirror === null) return null;
      if (!isCellReceived(mirror, cellX, cellZ)) return null;
      if (!drawnGround.isDrawnAt(cellX, cellZ)) return null;
      return drawnGround.capYAt(cellX, cellZ);
    },

    highlightLayerEdge(pick: TerrainRayPick | null, light: LayerEdgeLight): number | null {
      if (layerEdges === null) return null;
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
      if (spanCount(mirror.map, pick.x, pick.y) < 2) return null;
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
      return pickTerrainCellByRay(mirror, origin, direction);
    },
    pickInColumn(x: number, y: number, origin: Vec3, direction: Vec3): TerrainRayPick | null {
      if (mirror === null) return null;
      return pickTerrainInColumn(mirror, x, y, origin, direction);
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
      chunkBuildSource?.dispose();
    },
  };
}
